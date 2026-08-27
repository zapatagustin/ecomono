#!/usr/bin/env python3
import re
from collections import Counter
from pathlib import Path

URL_REGEX = re.compile(r"https?://[^\s)]+")
FENCE_OPEN_REGEX = re.compile(r"^(\s{0,3})(`{3,}|~{3,})(.*)$")
# Any indent, unlike FENCE_OPEN_REGEX above — used only to blank stray fence-marker
# lines left over after real fence extraction (see extract_inline_codes), never to
# extract blocks. Widening FENCE_OPEN_REGEX itself would make a lone indented ```
# shown in prose swallow forward to the next real fence's close.
FENCE_MARKER_LINE_REGEX = re.compile(r"^\s*(?:`{3,}|~{3,})[^`~]*$")
# ecomono: ceiling — ATX headings only, tolerating the CommonMark 0-3 space
# margin (same margin FENCE_OPEN_REGEX already tolerates). Two shapes are
# still invisible to this regex AND to compress.HEADING_LINE_REGEX (the
# masker), so the two sides still agree and no false validation error
# results — but text inside either shape can be silently reworded by
# compression with validation reporting clean: Setext headings ("Title\n===")
# and blockquote-nested ATX ("> # Title"). Zero occurrences in this repo's
# docs as of writing. Upgrade path: add Setext underline detection plus an
# optional blockquote prefix to BOTH this regex and compress.HEADING_LINE_REGEX,
# changed together — an unpaired change reintroduces the masker/validator
# mismatch this scope limit currently avoids.
HEADING_REGEX = re.compile(r"^[ ]{0,3}(#{1,6})[ \t]+(.*)", re.MULTILINE)
BULLET_REGEX = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)

# crude but effective path detection
# Requires either a path prefix (./ ../ / or drive letter) or a slash/backslash within the match
PATH_REGEX = re.compile(r"(?:\./|\.\./|/|[A-Za-z]:\\)[\w\-/\\\.]+|[\w\-\.]+[/\\][\w\-/\\\.]+")

# The bare `word/word` alternative above also catches date-shaped tokens
# ("2024/01/15") and slash idioms that aren't paths at all ("and/or", "he/she",
# "before/during/after"). Every PATH_REGEX match contains a slash/backslash (a
# prefix requires one, and the bare-word alternative requires the separator),
# so _is_pathlike below only needs to carve those two non-path shapes back out.
# ecomono: ceiling — this also demotes a genuinely path-shaped numeric-separator
# token to a warning whenever PATH_REGEX's slash requirement is met, e.g. a CIDR
# block ("192.168.1.1/24") or a digit-led token that only looks like a date
# ("2024/01.15"); a bare "192.168.1.1" or "1.2.3" never reaches here since
# PATH_REGEX requires a slash. A letter-led token like "src/1.2.3" is unaffected —
# DATE_SHAPED_REGEX requires digit-led, so it still errors as a real path.
# Accepted tradeoff, same error-biased reasoning as IDIOM_STOPLIST/DIGITS_REGEX
# below. Upgrade path: a filesystem existence check (`Path(s).exists()`
# relative to repo root).
DATE_SHAPED_REGEX = re.compile(r"^\d+[/.\-]\d+(?:[/.\-]\d+)+$")

# ecomono: this stoplist is a hand-picked set of the "word/word" prose idioms
# this skill's own docs and tests use (and/or, he/she, before/during/after,
# read/write/execute) — not a dictionary lookup. A term outside it defaults
# to pathlike (the error-biased side: a lost real path silently demoted to a
# warning is worse than a noisy false positive on an unlisted idiom).
# "24"/"7" used to live here for the "24/7" idiom, but every-segment-numeric
# is now its own carve-out in _is_pathlike (see DIGITS_REGEX below), which
# subsumes them. Upgrade path: replace with a filesystem existence check
# (`Path(s).exists()` relative to repo root) if the stoplist keeps needing
# tuning.
IDIOM_STOPLIST = frozenset({
    "and", "or", "he", "she", "they", "s",  # s/he
    "either", "neither", "yes", "no",
    "on", "off", "true", "false", "pass", "fail", "win", "lose",
    "before", "during", "after", "read", "write", "execute",
    "input", "output", "this", "that", "if", "when",
})

# Every segment pure digits ("3/15", "50/50", "1/2", "24/7") — a real path
# segment is essentially never a bare integer. This subsumes DATE_SHAPED_REGEX
# for the common case, but DATE_SHAPED_REGEX still catches a date where one
# segment mixes separators after PATH_REGEX's own split (e.g. "2024/01.15"
# splits on "/" into "2024" and "01.15", the latter not pure digits), so both
# checks stay.
# ecomono: ceiling — this also demotes a genuinely path-shaped all-numeric
# reference ("2024/03", "123/456") to a warning; accepted tradeoff, same
# error-biased reasoning as IDIOM_STOPLIST above. Upgrade path: a filesystem
# existence check (`Path(s).exists()` relative to repo root).
DIGITS_REGEX = re.compile(r"^\d+$")


class ValidationResult:
    def __init__(self):
        self.is_valid = True
        self.errors = []
        self.warnings = []

    def add_error(self, msg):
        self.is_valid = False
        self.errors.append(msg)

    def add_warning(self, msg):
        self.warnings.append(msg)


def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


# ---------- Extractors ----------


def extract_headings(text):
    return [(level, title.strip()) for level, title in HEADING_REGEX.findall(text)]


def extract_code_blocks(text):
    """Line-based fenced code block extractor.

    Handles ``` and ~~~ fences with variable length (CommonMark: closing
    fence must use same char and be at least as long as opening). Supports
    nested fences (e.g. an outer 4-backtick block wrapping inner 3-backtick
    content).
    """
    blocks = []
    lines = text.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        m = FENCE_OPEN_REGEX.match(lines[i])
        if not m:
            i += 1
            continue
        fence_char = m.group(2)[0]
        fence_len = len(m.group(2))
        open_line = lines[i]
        block_lines = [open_line]
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
        # An unclosed fence counts as code too. Skipping it used to be justified
        # as avoiding false positives, but compress._mask_fenced_blocks now
        # stashes it, so its body is preserved verbatim and the comparison agrees
        # — while skipping it left exactly that corruption unchecked.
        if not closed:
            # Mirror the masker: an unclosed fence runs to EOF, so drop the
            # document's trailing blank lines rather than counting them as code.
            while block_lines and not block_lines[-1].strip():
                block_lines.pop()
        blocks.append("\n".join(block_lines))
    return blocks


INDENTED_CODE_INDENT = 4


def _blank_fenced_regions(text):
    """Return `text` as lines with every fenced region blanked out.

    Line count is preserved so blank-line boundaries still line up, which is what
    extract_indented_blocks needs: an indented line *inside* a fence is fence
    content, not an indented code block.
    """
    lines = text.split("\n")
    out = list(lines)
    i, n = 0, len(lines)
    while i < n:
        m = FENCE_OPEN_REGEX.match(lines[i])
        if not m:
            i += 1
            continue
        fence_char, fence_len = m.group(2)[0], len(m.group(2))
        out[i] = ""
        i += 1
        while i < n:
            close_m = FENCE_OPEN_REGEX.match(lines[i])
            closed = (
                close_m
                and close_m.group(2)[0] == fence_char
                and len(close_m.group(2)) >= fence_len
                and close_m.group(3).strip() == ""
            )
            out[i] = ""
            i += 1
            if closed:
                break
    return out


def extract_indented_blocks(text):
    """CommonMark indented code blocks — 4+ spaces, fenced regions excluded.

    A run counts as code only when a blank line or the start of the document
    precedes it; an indented line continuing the paragraph above is prose. Blank
    lines interior to a run belong to it, trailing ones do not.

    compress._mask_indented_blocks re-implements this walk. The two must agree —
    a masker and a validator sharing a blind spot is exactly how a rewritten code
    block used to validate clean.
    """
    pad = " " * INDENTED_CODE_INDENT
    lines = _blank_fenced_regions(text)
    blocks = []
    i, n = 0, len(lines)
    prev_blank = True
    while i < n:
        line = lines[i]
        if prev_blank and line.startswith(pad) and line.strip():
            run = []
            while i < n:
                cur = lines[i]
                if cur.startswith(pad) and cur.strip():
                    run.append(cur)
                    i += 1
                elif not cur.strip():
                    j = i
                    while j < n and not lines[j].strip():
                        j += 1
                    if j < n and lines[j].startswith(pad) and lines[j].strip():
                        run.extend(lines[i:j])
                        i = j
                    else:
                        break
                else:
                    break
            blocks.append("\n".join(run))
            prev_blank = False
            continue
        prev_blank = not line.strip()
        i += 1
    return blocks


def extract_urls(text):
    return set(URL_REGEX.findall(text))


def extract_paths(text):
    return set(PATH_REGEX.findall(text))


def count_bullets(text):
    return len(BULLET_REGEX.findall(text))


def extract_inline_codes(text):
    """Inline code spans, with fenced regions blanked out first.

    Reuses _blank_fenced_regions — the same CommonMark-correct fence matcher
    extract_code_blocks relies on — instead of the standalone `^```...^````
    regex this used to carry: that hardcoded pattern only matched an
    unindented, exactly-tripled-backtick fence at column 0, so any indented
    or tilde fence slipped through untouched and leaked its marker backticks
    into the pairing below, corrupting counts for the rest of the document.
    FENCE_MARKER_LINE_REGEX then blanks any fence-marker-shaped line still
    left over (e.g. one indented past the 3-space CommonMark margin, so it
    isn't a real fence at all) for the same reason — a stray marker line's
    odd backtick count would otherwise re-pair with real inline code later
    in the file.
    """
    lines = _blank_fenced_regions(text)
    text_without_fences = "\n".join(
        "" if FENCE_MARKER_LINE_REGEX.match(line) else line for line in lines
    )
    return re.findall(r"`([^`]+)`", text_without_fences)


# ---------- Validators ----------


def validate_headings(orig, comp, result):
    h1 = extract_headings(orig)
    h2 = extract_headings(comp)

    if len(h1) != len(h2):
        result.add_warning(f"Heading count mismatch: {len(h1)} vs {len(h2)}")
        return

    # A renamed or reordered heading changes its slug, breaking every
    # in-document anchor link pointing at it — data loss, not style, so this
    # is an error rather than a warning.
    # ecomono: an outright dropped/added heading (count mismatch above) stays
    # a warning — that's a more visible structural change a reviewer already
    # notices, and out of scope for this fix. Upgrade path: same escalation
    # if that turns out to slip through review too.
    if h1 != h2:
        result.add_error("Heading text/order changed")


def validate_code_blocks(orig, comp, result):
    c1 = extract_code_blocks(orig) + extract_indented_blocks(orig)
    c2 = extract_code_blocks(comp) + extract_indented_blocks(comp)

    if c1 != c2:
        result.add_error("Code blocks not preserved exactly")


def validate_urls(orig, comp, result):
    u1 = extract_urls(orig)
    u2 = extract_urls(comp)

    if u1 != u2:
        result.add_error(f"URL mismatch: lost={u1 - u2}, added={u2 - u1}")


def _is_pathlike(s):
    """True if `s` should error (not just warn) when a reword drops it.

    Every PATH_REGEX match already contains a slash/backslash. All trailing
    `.`s are stripped first (a sentence-final match like "before/after." or
    "2024/01/15.." carries one or more periods that belong to the sentence,
    not the token — PATH_REGEX's char class admits consecutive periods, so
    an ellipsis strips down to the real token instead of leaving a dangling
    "." that would defeat the carve-outs below). Three shapes
    among those matches carry no filesystem meaning and must not escalate to
    an error: a date ("2024/01/15"), a token whose every slash-separated
    segment is pure digits ("3/15", "50/50", "24/7" — a real path segment is
    essentially never a bare integer), and a slash idiom whose every segment
    is a common prose word ("and/or", "he/she", "before/during/after").
    Everything else — including a bare two-segment reference like
    "claude/hooks" that has no extension or path prefix — defaults to
    pathlike, because a validator's silent false negative (a lost real path
    demoted to a warning) is worse than a noisy false positive.
    """
    core = s.rstrip(".")
    if DATE_SHAPED_REGEX.match(core):
        return False
    segments = re.split(r"[/\\]", core)
    if segments and all(DIGITS_REGEX.match(seg) for seg in segments):
        return False
    if segments and all(seg.lower() in IDIOM_STOPLIST for seg in segments):
        return False
    return True


def validate_paths(orig, comp, result):
    p1 = extract_paths(orig)
    p2 = extract_paths(comp)

    # A dropped path breaks a promised reference (SKILL.md/CLAUDE.md point
    # readers at real files) — data loss, so it's an error, same severity as
    # a lost URL or a lost inline code span. An added path is milder (prose
    # legitimately gains a reference) and stays a warning. A lost match that
    # doesn't look path-like (a slash idiom, not a path) stays a warning too.
    lost = p1 - p2
    added = p2 - p1
    lost_errors = {p for p in lost if _is_pathlike(p)}
    lost_warnings = lost - lost_errors
    if lost_errors:
        result.add_error(f"Path lost: {lost_errors}")
    if lost_warnings:
        result.add_warning(f"Path lost (low confidence): {lost_warnings}")
    if added:
        result.add_warning(f"Path added: {added}")


def validate_bullets(orig, comp, result):
    b1 = count_bullets(orig)
    b2 = count_bullets(comp)

    if b1 == 0:
        return

    diff = abs(b1 - b2) / b1

    if diff > 0.15:
        result.add_warning(f"Bullet count changed too much: {b1} -> {b2}")


def validate_inline_codes(orig, comp, result):
    c1 = Counter(extract_inline_codes(orig))
    c2 = Counter(extract_inline_codes(comp))

    if c1 != c2:
        lost = set(c1.keys()) - set(c2.keys())
        added = set(c2.keys()) - set(c1.keys())
        for code, count in c1.items():
            if code in c2 and c2[code] < count:
                lost.add(f"{code} (lost {count - c2[code]} of {count} occurrences)")
        if lost:
            result.add_error(f"Inline code lost: {lost}")
        if added:
            result.add_warning(f"Inline code added: {added}")


# ---------- Main ----------


def validate(original_path: Path, compressed_path: Path) -> ValidationResult:
    result = ValidationResult()

    orig = read_file(original_path)
    comp = read_file(compressed_path)

    validate_headings(orig, comp, result)
    validate_code_blocks(orig, comp, result)
    validate_urls(orig, comp, result)
    validate_paths(orig, comp, result)
    validate_bullets(orig, comp, result)
    validate_inline_codes(orig, comp, result)

    return result


# ---------- CLI ----------

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) == 2 and sys.argv[1] == "--json-schema":
        print(json.dumps({
            "type": "object",
            "properties": {
                "is_valid": {"type": "boolean"},
                "errors": {"type": "array", "items": {"type": "string"}},
                "warnings": {"type": "array", "items": {"type": "string"}},
            }
        }))
        sys.exit(0)

    json_mode = len(sys.argv) == 4 and sys.argv[1] == "--json"

    if json_mode:
        orig = Path(sys.argv[2]).resolve()
        comp = Path(sys.argv[3]).resolve()
    elif len(sys.argv) == 3:
        orig = Path(sys.argv[1]).resolve()
        comp = Path(sys.argv[2]).resolve()
    else:
        print("Usage: python validate.py [--json] <original> <compressed>")
        sys.exit(1)

    res = validate(orig, comp)

    if json_mode:
        print(json.dumps({
            "is_valid": res.is_valid,
            "errors": res.errors,
            "warnings": res.warnings,
        }))
    else:
        print(f"\nValid: {res.is_valid}")
        if res.errors:
            print("\nErrors:")
            for e in res.errors:
                print(f"  - {e}")
        if res.warnings:
            print("\nWarnings:")
            for w in res.warnings:
                print(f"  - {w}")

    sys.exit(0 if res.is_valid else 1)
