#!/usr/bin/env python3
import re
from collections import Counter
from pathlib import Path

URL_REGEX = re.compile(r"https?://[^\s)]+")
FENCE_OPEN_REGEX = re.compile(r"^(\s{0,3})(`{3,}|~{3,})(.*)$")
HEADING_REGEX = re.compile(r"^(#{1,6})\s+(.*)", re.MULTILINE)
BULLET_REGEX = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)

# crude but effective path detection
# Requires either a path prefix (./ ../ / or drive letter) or a slash/backslash within the match
PATH_REGEX = re.compile(r"(?:\./|\.\./|/|[A-Za-z]:\\)[\w\-/\\\.]+|[\w\-\.]+[/\\][\w\-/\\\.]+")


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
    text_without_fences = re.sub(r"^```[\s\S]*?^```", "", text, flags=re.MULTILINE)
    text_without_fences = re.sub(r"^~~~[\s\S]*?^~~~", "", text_without_fences, flags=re.MULTILINE)
    return re.findall(r"`([^`]+)`", text_without_fences)


# ---------- Validators ----------


def validate_headings(orig, comp, result):
    h1 = extract_headings(orig)
    h2 = extract_headings(comp)

    if len(h1) != len(h2):
        result.add_warning(f"Heading count mismatch: {len(h1)} vs {len(h2)}")
        return

    if h1 != h2:
        result.add_warning("Heading text/order changed")


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


def validate_paths(orig, comp, result):
    p1 = extract_paths(orig)
    p2 = extract_paths(comp)

    if p1 != p2:
        result.add_warning(f"Path mismatch: lost={p1 - p2}, added={p2 - p1}")


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
