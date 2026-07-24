#!/usr/bin/env python3
"""
Ecomono Compress — rule-based + optional API semantic pass.

Usage:
    python3 -m scripts.compress <filepath>
    python3 -m scripts.compress --api <filepath>   (enable Groq semantic pass)
    python3 -m scripts.compress --api --model meta-llama/llama-4-scout-17b-16e-instruct <filepath>

Phase 1: rule-based mechanical compression (instant, 0 tokens)
Phase 2: optional semantic pass via cheap API (fast, ~2s, cents)
"""

import re
import os
import json
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Phase 1: Rule-based mechanical compression
# ---------------------------------------------------------------------------

# Patterns whose entire match is removed from output
REMOVE_WHOLE = re.compile(
    r"\b("
    r"just|really|basically|actually|simply|essentially|generally|literally"
    r"|honestly|absolutely|definitely|certainly|surely|indeed|obviously"
    r"|frankly|personally|admittedly|arguably|reportedly|supposedly"
    r"|practically|virtually|relatively|comparatively|seemingly"
    r")\b",
    re.IGNORECASE,
)

# Hedging phrases (entire clause removed)
HEDGING_PATTERNS = [
    re.compile(r"\bit('s| is)? (worth|important|critical|essential) (to|that)\b", re.IGNORECASE),
    re.compile(r"\byou (might |could |should )?consider\b", re.IGNORECASE),
    re.compile(r"\bit would be (good|great|nice|better|best) to\b", re.IGNORECASE),
    re.compile(r"\byou could (also |try |consider )?\b", re.IGNORECASE),
    re.compile(r"\b(?:i('d| would)? )?recommend\b", re.IGNORECASE),
]

# Pleasantries and polite openers
PLEASANTRIES = re.compile(
    r"\b("
    r"sure|of course|happy to|glad(ly)?|my pleasure|no problem|please"
    r"|with pleasure|absolutely|by all means|feel free|you're welcome"
    r")\b",
    re.IGNORECASE,
)

# "You should", "make sure to", "remember to", etc.
PERMISSIVE_OPENERS = re.compile(
    r"\b(?:you should|you('ll| will) want to|make sure to|be sure to|"
    r"remember to|don't forget to|keep in mind to|ensure that you|"
    r"please (make sure|remember|ensure))\b",
    re.IGNORECASE,
)

# Connective fluff
CONNECTIVES = re.compile(
    r"\b("
    r"however|furthermore|moreover|additionally|in addition"
    r"|nevertheless|nonetheless|consequently|accordingly"
    r"|therefore|thus|hence|besides|likewise"
    r")\b",
    re.IGNORECASE,
)

# Phrase replacements (order matters — longer first)
PHRASE_REPLACE = [
    (re.compile(r"\bin order to\b", re.IGNORECASE), "to"),
    (re.compile(r"\bwith the aim of\b", re.IGNORECASE), "to"),
    (re.compile(r"\bfor the purpose of\b", re.IGNORECASE), "to"),
    (re.compile(r"\bthe reason is because\b", re.IGNORECASE), "because"),
    (re.compile(r"\bdue to the fact that\b", re.IGNORECASE), "because"),
    (re.compile(r"\bas a result of\b", re.IGNORECASE), "from"),
    (re.compile(r"\bin the event that\b", re.IGNORECASE), "if"),
    (re.compile(r"\bon a regular basis\b", re.IGNORECASE), "regularly"),
    (re.compile(r"\bat this point in time\b", re.IGNORECASE), "now"),
    (re.compile(r"\bin the near future\b", re.IGNORECASE), "soon"),
    (re.compile(r"\bprior to\b", re.IGNORECASE), "before"),
    (re.compile(r"\bsubsequent to\b", re.IGNORECASE), "after"),
    (re.compile(r"\ba number of\b", re.IGNORECASE), "some"),
    (re.compile(r"\bthe majority of\b", re.IGNORECASE), "most"),
    (re.compile(r"\ba majority of\b", re.IGNORECASE), "most"),
    (re.compile(r"\bis able to\b", re.IGNORECASE), "can"),
    (re.compile(r"\bare able to\b", re.IGNORECASE), "can"),
    (re.compile(r"\bhas the ability to\b", re.IGNORECASE), "can"),
    (re.compile(r"\bin excess of\b", re.IGNORECASE), "over"),
]

# Word-level replacements
WORD_REPLACE = {
    "utilize": "use",
    "utilizes": "uses",
    "utilized": "used",
    "utilizing": "using",
    "implement": "build",
    "implements": "builds",
    "implemented": "built",
    "implementing": "building",
    "facilitate": "help",
    "facilitates": "helps",
    "facilitated": "helped",
    "leverage": "use",
    "leverages": "uses",
    "leveraged": "used",
    "optimize": "tune",
    "optimizes": "tunes",
    "optimized": "tuned",
    "validate": "check",
    "validates": "checks",
    "validated": "checked",
    "demonstrate": "show",
    "demonstrates": "shows",
    "demonstrated": "showed",
    "initialize": "init",
    "initializes": "inits",
    "initialized": "inited",
    "configuration": "config",
    "configurations": "configs",
    "functionality": "function",
    "functionalities": "functions",
    "additional": "more",
    "sufficient": "enough",
    "numerous": "many",
    "subsequent": "next",
    "preceding": "prior",
    "approximately": "about",
    "sufficiently": "enough",
    "predominantly": "mostly",
    "henceforth": "then",
    "heretofore": "before",
    "notwithstanding": "despite",
}

# Patterns for I-prefixed preferences: "I [verb]" → keep verb, drop I
I_PREFER = re.compile(
    r"\bI (prefer|preferred|like|liked|want|wanted|recommend|recommended|"
    r"strongly (suggest|recommend)|suggest|suggested|tend to|tend|usually|"
    r"would (prefer|like|recommend|suggest|use|say)|"
    r"am (a|an|the|all|very|pretty|quite|extremely|really)|"
    r"think|believe|feel|suppose|assume|guess|imagine)\b",
    re.IGNORECASE,
)

# Softening: "maybe", "perhaps", "probably", "usually", "typically", "often",
# "sometimes", "occasionally" — in instructions these hedge unnecessarily
SOFTENERS = re.compile(
    r"\b(perhaps|maybe|probably|usually|typically|often|sometimes|"
    r"occasionally|frequently|generally|mostly|largely|"
    r"in most cases|in many cases|as a rule)\b",
    re.IGNORECASE,
)

# Instruction patterns: "You can", "You could", "You'll want to" -> remove
YOU_CAN = re.compile(r"\byou (can|could|may|might|will|would|'ll|'d)\b", re.IGNORECASE)

# Intensifiers before verbs: "strongly prefer", "really like", "very much prefer"
# These weaken in instruction context — remove the intensifier, keep verb
INTENSIFIERS = re.compile(
    r"\b("
    r"strongly|highly|greatly|really|very|quite|extremely|"
    r"definitely|certainly|absolutely|deeply|truly|sincerely|"
    r"rather|somewhat|pretty|fairly"
    r")\s+(?=\w)",
    re.IGNORECASE,
)

# Passive voice: "is responsible for", "is used to", etc.
PASSIVE = [
    (re.compile(r"\bis responsible for\b", re.IGNORECASE), ""),
    (re.compile(r"\bis used (for|to)\b", re.IGNORECASE), ""),
    (re.compile(r"\bare responsible for\b", re.IGNORECASE), ""),
    (re.compile(r"\bare used (for|to)\b", re.IGNORECASE), ""),
    (re.compile(r"\bhas been\b", re.IGNORECASE), ""),
    (re.compile(r"\bhave been\b", re.IGNORECASE), ""),
    (re.compile(r"\bis designed to\b", re.IGNORECASE), ""),
    (re.compile(r"\bthe purpose of (this|the)\b", re.IGNORECASE), ""),
]

# Redundant verbs: "helps to", "allows to", "enables to"
REDUNDANT_VERBS = [
    (re.compile(r"\b(helps?|allows?|enables?) (to|you)\b", re.IGNORECASE), ""),
    # "provides a way to", "offers the means to", etc. (single-spaced, optional article)
    (re.compile(r"\b(provides?|offers?)\s+(?:a|an|the)\s+(way|means|method)\s+to\b", re.IGNORECASE), ""),
]

# ---------------------------------------------------------------------------
# Protected-region masking
# ---------------------------------------------------------------------------
# The rule regexes above would otherwise rewrite text inside fenced code
# blocks, inline code, and URLs (e.g. "validate.py" -> "check.py", stripping
# "the " from a URL), corrupting them and failing validation. We mask those
# spans to opaque placeholders, run the rules on prose only, then restore
# verbatim. Placeholders use Private-Use Unicode delimiters (category Co, not
# matched by \w or \s) around a plain integer index, so no rule can touch them.
#
# Fenced-block detection mirrors validate.extract_code_blocks line-for-line so
# masking and validation agree on exactly what a code block is.

FENCE_OPEN_REGEX = re.compile(r"^(\s{0,3})(`{3,}|~{3,})(.*)$")
INLINE_CODE_REGEX = re.compile(r"`[^`\n]+`")
URL_REGEX = re.compile(r"https?://[^\s)]+")

_PH_OPEN = ""
_PH_CLOSE = ""


def _placeholder(i: int) -> str:
    return f"{_PH_OPEN}{i}{_PH_CLOSE}"


def _mask_fenced_blocks(text: str, stash: list) -> str:
    """Replace whole fenced code blocks with placeholders (line-based)."""
    lines = text.split("\n")
    out = []
    n = len(lines)
    i = 0
    while i < n:
        m = FENCE_OPEN_REGEX.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        fence_char = m.group(2)[0]
        fence_len = len(m.group(2))
        block_lines = [lines[i]]
        i += 1
        closed = False
        while i < n:
            close_m = FENCE_OPEN_REGEX.match(lines[i])
            if (
                close_m
                and close_m.group(2)[0] == fence_char
                and len(close_m.group(2)) >= fence_len
                and close_m.group(3).strip() == ""
            ):
                block_lines.append(lines[i])
                closed = True
                i += 1
                break
            block_lines.append(lines[i])
            i += 1
        if closed:
            stash.append("\n".join(block_lines))
            out.append(_placeholder(len(stash) - 1))
        else:
            # Unclosed fence: leave verbatim (matches validator, which skips it).
            out.extend(block_lines)
    return "\n".join(out)


def _mask_regex(text: str, pattern: re.Pattern, stash: list) -> str:
    def repl(m):
        stash.append(m.group(0))
        return _placeholder(len(stash) - 1)
    return pattern.sub(repl, text)


def protect(text: str):
    """Mask code blocks, inline code, and URLs. Returns (masked_text, stash)."""
    stash = []
    text = _mask_fenced_blocks(text, stash)   # blocks first (may contain backticks/URLs)
    text = _mask_regex(text, INLINE_CODE_REGEX, stash)
    text = _mask_regex(text, URL_REGEX, stash)
    return text, stash


def restore(text: str, stash: list) -> str:
    """Reverse protect(). Restore last-first so indices never collide."""
    for i in range(len(stash) - 1, -1, -1):
        text = text.replace(_placeholder(i), stash[i])
    return text


def rule_compress(text: str) -> str:
    """Apply mechanical compression rules to prose only. Returns compressed text."""
    text, stash = protect(text)

    # ---- Phase: phrase-level removals (before word-level to avoid partial matches) ----

    # 1. Remove permissive openers first: "you should", "make sure to", etc.
    text = PERMISSIVE_OPENERS.sub("", text)

    # 2. Remove intensifiers before verbs FIRST, so "I strongly prefer" -> "I prefer"
    #    survives into the I_PREFER pass below (which then drops the leading "I").
    text = INTENSIFIERS.sub("", text)

    # 3. Remove "I [prefer/like/want/...]" -> keep verb without I
    text = I_PREFER.sub(lambda m: m.group(1).lower(), text)

    # 4. Remove "you can/could/may" etc.
    text = YOU_CAN.sub("", text)

    # 5. Remove hedging clauses
    for pat in HEDGING_PATTERNS:
        text = pat.sub("", text)

    # 6. Remove passive voice constructions
    for pat, repl in PASSIVE:
        text = pat.sub(repl, text)

    # 7. Remove redundant verb constructions
    for pat, repl in REDUNDANT_VERBS:
        text = pat.sub(repl, text)

    # ---- Phase: word-level removals ----

    # 8. Remove pleasantries (after permissive openers so "sure" doesn't break "make sure to")
    text = PLEASANTRIES.sub("", text)

    # 9. Remove softeners
    text = SOFTENERS.sub("", text)

    # 10. Remove known filler words
    text = REMOVE_WHOLE.sub("", text)

    # 11. Remove connective fluff
    text = CONNECTIVES.sub("", text)

    # ---- Phase: replacements ----

    # 12. Phrase replacements
    for pat, repl in PHRASE_REPLACE:
        text = pat.sub(repl, text)

    # 13. Word replacements
    for old, new in WORD_REPLACE.items():
        text = re.sub(r"\b" + re.escape(old) + r"\b", new, text, flags=re.IGNORECASE)

    # 14. Article removal — aggressive: remove all "the " (acceptable for compressed prose)
    text = re.sub(r"\bthe\s+", "", text)

    # 15. Per-line cleanup. A global `re.sub(" +", " ")` would flatten
    #     markdown-significant indentation (nested lists, indented code) that
    #     the validator does not check for, so clean each line by role:
    #       - 4+ space indent  -> indented code: leave verbatim
    #       - list / blockquote -> collapse interior spaces, keep indent
    #       - prose             -> collapse interior spaces, drop the leading
    #                              space that removals leave behind
    def _clean_line(line: str) -> str:
        stripped = line.lstrip(" ")
        indent = line[: len(line) - len(stripped)]
        if len(indent) >= 4:
            return line
        stripped = re.sub(r" +", " ", stripped)
        if re.match(r"^([-*+]|\d+[.)])\s", stripped) or stripped.startswith(">"):
            return indent + stripped
        return stripped

    text = "\n".join(_clean_line(l) for l in text.split("\n"))

    # 16. Collapse blank-line runs, trim outer whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()

    return restore(text, stash)


# ---------------------------------------------------------------------------
# Phase 2: Optional semantic pass via Groq API
# ---------------------------------------------------------------------------

API_KEY_FILE = "/run/secrets/opencode/groq-api-key"
DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
API_BASE = "https://api.groq.com/openai/v1"


def call_semantic_api(text: str, model: str = DEFAULT_MODEL) -> str:
    """Send text to cheap model for semantic compression refinement."""
    key = _read_api_key()
    if not key:
        raise RuntimeError("Groq API key not found")

    prompt = f"""Compress this markdown into ecomono format: ultra-terse, zero filler, full technical accuracy.

Rules:
- Keep EXACT same headings as input. Do NOT add, remove, or change any headings.
- Do NOT modify code blocks (```...```), inline code (`...`), URLs, file paths, commands
- Drop articles, filler, pleasantries, hedging
- Use fragments where clear
- Short synonyms: "use" not "utilize", "build" not "implement"
- Keep ALL technical terms, symbols, and proper nouns exact
- Do NOT reorganize or add new sections
- Return ONLY the compressed markdown — no explanation, no outer fence

Input:
{text}
"""

    data = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        # Output ceiling. Kept generous so the whole compressed file fits — a
        # low cap would truncate the response, dropping content and failing
        # validation. Files whose compressed form still exceeds this are caught
        # via a truncated-response check below.
        "max_tokens": 8192,
        "temperature": 0.1,
    }

    import time
    import urllib.request
    import urllib.error

    for attempt in range(3):
        try:
            req = urllib.request.Request(
                f"{API_BASE}/chat/completions",
                data=json.dumps(data).encode(),
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "User-Agent": "ecomono-compress/2.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read())
            choice = result["choices"][0]
            if choice.get("finish_reason") == "length":
                # Response hit max_tokens and was truncated — unusable. Raise so
                # the caller falls back to the rule-based result instead of
                # writing a half-compressed file.
                raise RuntimeError("Semantic output truncated (max_tokens) — falling back to rule-based")
            return choice["message"]["content"].strip()
        except urllib.error.HTTPError as e:
            # 429 (rate limit) and 5xx (transient server) are worth retrying with
            # backoff. 413 (payload too large) is not — the same request fails
            # again; raise so the caller falls back to the rule-based result.
            if e.code in (429, 500, 502, 503) and attempt < 2:
                wait = 5 * (attempt + 1)
                print(f"⚠️  HTTP {e.code}, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            if e.code == 413:
                raise RuntimeError("Input too large for model — falling back to rule-based")
            raise RuntimeError(f"API call failed (HTTP {e.code}): {e}")
        except RuntimeError:
            raise  # our own truncation/too-large signal — propagate to caller
        except Exception as e:
            # network, JSON parse, malformed response — wrap so caller (which
            # only catches RuntimeError) can fall back to the rule-based result.
            raise RuntimeError(f"API call failed: {e}")

    raise RuntimeError("API call failed after retries")


def _read_api_key() -> str | None:
    """Read Groq API key from secret file or env var."""
    key = os.environ.get("GROQ_API_KEY")
    if key:
        return key
    path = Path(API_KEY_FILE)
    if path.exists():
        return path.read_text().strip()
    return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SENSITIVE_BASENAME = re.compile(
    r"(?ix)^("
    r"\.env(\..+)?|\.netrc|credentials(\..+)?"
    r"|secrets?(\..+)?|passwords?(\..+)?"
    r"|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?"
    r"|authorized_keys|known_hosts"
    r"|.*\.(pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg)"
    r")$"
)
SENSITIVE_DIRS = frozenset({".ssh", ".aws", ".gnupg", ".kube", ".docker"})
SENSITIVE_TOKENS = ("secret", "credential", "password", "passwd", "apikey", "accesskey", "token", "privatekey")


def is_sensitive(path: Path) -> bool:
    """Heuristic: refuse to send files that contain secrets to API."""
    if SENSITIVE_BASENAME.match(path.name):
        return True
    parts_lower = {p.lower() for p in path.parts}
    if parts_lower & SENSITIVE_DIRS:
        return True
    name_flat = re.sub(r"[_\-\s.]", "", path.name.lower())
    return any(tok in name_flat for tok in SENSITIVE_TOKENS)


def _should_compress(filepath: Path) -> bool:
    """Delegate to detect.should_compress; import works under -m or standalone."""
    try:
        from .detect import should_compress
    except ImportError:
        from detect import should_compress
    return should_compress(filepath)


def compress_file(filepath: Path, use_api: bool = False, model: str = DEFAULT_MODEL) -> dict:
    """Run compression. Returns {'status': ..., 'path': ..., 'backup': ..., 'tokens_saved': ...}"""
    MAX_SIZE = 500_000

    if not filepath.exists():
        return {"status": "error", "reason": f"File not found: {filepath}"}
    if not filepath.is_file():
        return {"status": "error", "reason": f"Not a file: {filepath}"}
    if filepath.stat().st_size > MAX_SIZE:
        return {"status": "error", "reason": f"File too large (>{MAX_SIZE//1000}KB)"}
    if filepath.name.endswith(".original.md"):
        return {"status": "skip", "reason": "Backup file, skipping"}
    # Enforce the natural-language boundary in code, not just in SKILL.md. A
    # code/config file has no markdown fences, so masking protects nothing and
    # the rules would rewrite real source (validate->check, "the "->"") while
    # the validator, seeing no fenced blocks, would pass it and write the
    # corrupted file. Refuse anything detect.py doesn't classify as prose.
    if not _should_compress(filepath):
        return {"status": "error", "reason": f"Not a natural-language file (code/config): {filepath.name}. Refusing to compress."}
    if is_sensitive(filepath) and use_api:
        return {"status": "error", "reason": f"Sensitive filename: {filepath.name}. Refusing API send."}

    original = filepath.read_text(errors="ignore")
    if not original.strip():
        return {"status": "error", "reason": "Empty file"}

    # Keep the full original name so notes.md and notes.txt don't collide on
    # one backup, and a .txt file isn't backed up under a misleading .md name.
    backup = filepath.with_name(filepath.name + ".original.md")
    if backup.exists():
        return {"status": "error", "reason": f"Backup exists: {backup}. Remove or rename first."}

    # Phase 1: Rule-based
    compressed = rule_compress(original)

    # Phase 2: Optional semantic pass
    if use_api:
        try:
            compressed = call_semantic_api(compressed, model=model)
        except RuntimeError as e:
            print(f"⚠️  Semantic pass skipped: {e}", file=sys.stderr)
            # Continue with rule-based result

    # Check for no-op
    if compressed.strip() == original.strip():
        return {"status": "skip", "reason": "Output identical to input (already compressed)"}

    # Write backup
    backup.write_text(original)
    # Verify backup
    if backup.read_text(errors="ignore") != original:
        backup.unlink(missing_ok=True)
        return {"status": "error", "reason": "Backup write verification failed"}

    # Write compressed
    filepath.write_text(compressed)

    # Estimate savings
    orig_tokens = len(original.split())
    compressed_tokens = len(compressed.split())
    saved = orig_tokens - compressed_tokens
    pct = (saved / orig_tokens * 100) if orig_tokens > 0 else 0

    return {
        "status": "ok",
        "path": str(filepath),
        "backup": str(backup),
        "original_tokens": orig_tokens,
        "compressed_tokens": compressed_tokens,
        "tokens_saved": saved,
        "percent": round(pct, 1),
        "used_api": use_api,
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Ecomono Compress")
    parser.add_argument("filepath", help="File to compress")
    parser.add_argument("--api", action="store_true", help="Enable Groq semantic pass")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model for semantic pass")
    args = parser.parse_args()

    result = compress_file(Path(args.filepath), use_api=args.api, model=args.model)

    if result["status"] == "ok":
        print(json.dumps(result, indent=2))
        sys.exit(0)
    elif result["status"] == "skip":
        print(f"⏭️  {result['reason']}")
        sys.exit(0)
    else:
        print(f"❌ {result['reason']}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
