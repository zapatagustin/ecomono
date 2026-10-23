#!/usr/bin/env python3
import re
from collections import Counter
from pathlib import Path

# Code-block detection is imported, not mirrored: a masker and a validator that
# each keep their own copy drift, and a shared blind spot validates corruption.
try:
    from .compress import FRONTMATTER_REGEX, INLINE_CODE_REGEX, fenced_spans, indented_spans
except ImportError:  # run as a plain script, not as part of the package
    from compress import FRONTMATTER_REGEX, INLINE_CODE_REGEX, fenced_spans, indented_spans

URL_REGEX = re.compile(r"https?://[^\s)]+")
# ecomono: ceiling — ATX headings only, tolerating the CommonMark 0-3 space
# margin (same margin a top-level fence tolerates). Two shapes are
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


def _blocks(lines, spans, with_positions):
    blocks = [(start, "\n".join(lines[start:end])) for start, end in spans]
    return blocks if with_positions else [body for _, body in blocks]


def extract_code_blocks(text, with_positions=False):
    """Fenced code blocks, as compress.fenced_spans finds them.

    `with_positions` returns (start_line, block_text) pairs instead of bare
    text, so a caller can merge fenced and indented blocks in document order
    — see _ordered_code_blocks.
    """
    lines = text.split("\n")
    return _blocks(lines, fenced_spans(lines), with_positions)


def _blank_fenced_regions(text):
    """Return `text` as lines with every fenced region blanked out."""
    lines = text.split("\n")
    for start, end in fenced_spans(lines):
        lines[start:end] = [""] * (end - start)
    return lines


def extract_indented_blocks(text, with_positions=False):
    """Indented code blocks (4+ columns), as compress.indented_spans finds them.

    `with_positions` returns (start_line, block_text) pairs — see
    extract_code_blocks.
    """
    lines = text.split("\n")
    return _blocks(lines, indented_spans(lines, fenced_spans(lines)), with_positions)


def extract_urls(text):
    return set(URL_REGEX.findall(text))


def extract_paths(text):
    return set(PATH_REGEX.findall(text))


def count_bullets(text):
    return len(BULLET_REGEX.findall(text))


def extract_inline_codes(text):
    """Inline code spans, with fenced regions blanked out first.

    Reuses _blank_fenced_regions — the same fence matcher extract_code_blocks
    relies on — instead of the standalone `^```...^```` regex this used to
    carry: that hardcoded pattern only matched an unindented, exactly-tripled-
    backtick fence at column 0, so any indented or tilde fence slipped through
    untouched and leaked its marker backticks into the pairing below,
    corrupting counts for the rest of the document. Every fence-marker line is
    inside some fenced span (a lone indented one is a span of its own), so no
    stray marker is left to re-pair with real inline code.
    """
    return [m.group(2) for m in INLINE_CODE_REGEX.finditer("\n".join(_blank_fenced_regions(text)))]


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


def _ordered_code_blocks(text):
    """Every code block — fenced and indented — in document order.

    Concatenating the two extractors instead groups by TYPE, which loses the
    relative order between a fenced block and an indented one: a compressed
    file that swapped them produces the same list as the original, so
    validate_code_blocks reports "preserved exactly" on a document whose code
    actually moved. Sorting the merged pairs by start line compares position
    as well as content.
    """
    merged = extract_code_blocks(text, with_positions=True) + extract_indented_blocks(text, with_positions=True)
    return [body for _, body in sorted(merged, key=lambda pair: pair[0])]


def _frontmatter(text):
    m = FRONTMATTER_REGEX.match(text)
    return m and m.group(0)


def validate_frontmatter(orig, comp, result):
    # Compression never touches frontmatter (compress.split_frontmatter), and a
    # loader acts on it, so any change at all is corruption.
    if _frontmatter(orig) != _frontmatter(comp):
        result.add_error("Frontmatter changed")


def validate_code_blocks(orig, comp, result):
    c1 = _ordered_code_blocks(orig)
    c2 = _ordered_code_blocks(comp)

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

    validate_frontmatter(orig, comp, result)
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
