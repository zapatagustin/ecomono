"""Compression pipeline test — run: python3 test_compress.py

Covers the parts where a mistake is silent rather than loud:

  * protect()/restore() — the masking that stops the prose rules from rewriting
    code, inline code and URLs. If masking leaks, the file is corrupted and the
    only evidence is a diff nobody reads.
  * extract_code_blocks() — a hand-rolled CommonMark fence scanner with four
    off-by-one edges (fence length, indent depth, info string on the close,
    unclosed fence at EOF). compress._mask_fenced_blocks is a second copy of the
    same loop, so both are fed the same inputs and required to agree.
  * every validator on BOTH sides — a validator only ever shown valid input is
    untested, and half of these downgrade to a warning rather than an error.
  * detect_file_type() on each class it claims, plus one it must refuse to claim.
  * compress_file()'s guard ladder — every branch that decides NOT to compress.

Three corruption bugs were found while writing this file and are now fixed; the
cases that caught them are the regression tests. Each one was silent because the
masker and the validator shared a blind spot, so the pair agreed on a wrong
answer — which is why the fence and indent cases are fed to BOTH and required to
match rather than each being checked alone.
"""
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import compress as C  # noqa: E402
import detect as D  # noqa: E402
import validate as V  # noqa: E402

failures = []
counts = {"compress": 0, "validate": 0, "detect": 0, "pipeline": 0}


def check(area, label, got, want):
    counts[area] += 1
    if got != want:
        failures.append(f"{area}/{label}: got {got!r}, want {want!r}")


def truthy(area, label, got):
    counts[area] += 1
    if not got:
        failures.append(f"{area}/{label}: expected truthy, got {got!r}")


TMP = Path(tempfile.mkdtemp(prefix="ecomono-compress-test-"))


def write(name, body):
    p = TMP / name
    p.write_text(body)
    return p


def verdict(fn, orig, comp):
    """Run one validator in isolation. Returns (is_valid, n_errors, n_warnings)."""
    r = V.ValidationResult()
    fn(orig, comp, r)
    return (r.is_valid, len(r.errors), len(r.warnings))


# ===========================================================================
# 1. protect() / restore() — the masking contract
# ===========================================================================

DOC = (
    "# T\n\n"
    "Prose with `validate.py` and https://ex.com/the/path?a=b in it.\n\n"
    "```py\n"
    "import os\n"
    "the utilize implement\n"
    "```\n\n"
    "More the prose.\n"
)

masked, stash = C.protect(DOC)
# Round-trip is the whole point of masking: nothing may be lost or reordered.
check("compress", "protect/restore round-trip", C.restore(masked, stash), DOC)
# Blocks are stashed before headings, inline code and URLs, so a URL inside a
# fence is captured once (as part of the block) and not double-stashed.
check("compress", "stash order", stash, [
    "```py\nimport os\nthe utilize implement\n```",
    "# T",
    "`validate.py`",
    "https://ex.com/the/path?a=b",
])
# The masked text must contain no fence, backtick or scheme left for the rules
# to chew on.
check("compress", "masked text has no backticks", "`" in masked, False)
check("compress", "masked text has no urls", "https://" in masked, False)

# Placeholders use private-use delimiters specifically so \w and \s rules cannot
# match them. If a rule could, "the " removal would eat one and restore() would
# leave a dangling index.
truthy("compress", "placeholder survives the rules", C._placeholder(0) in
       C.protect("```\nx\n```\n")[0])

out = C.rule_compress(DOC)
# Code, inline code and URL come back byte-identical even though each contains
# text the rules rewrite ("the ", "utilize", "implement", "validate").
truthy("compress", "fenced block verbatim", "the utilize implement" in out)
truthy("compress", "inline code verbatim", "`validate.py`" in out)
truthy("compress", "url verbatim", "https://ex.com/the/path?a=b" in out)
# ...while unprotected prose IS rewritten. Without this the test above would
# pass on a rule_compress that does nothing at all.
truthy("compress", "prose is actually compressed", "More prose." in out)

# Compression is idempotent: the output of the rules is a fixed point, so a file
# already compressed once is not degraded by a second pass.
check("compress", "idempotent", C.rule_compress(out), out)

# ===========================================================================
# 2. rule_compress — degenerate inputs and pass-through
# ===========================================================================

check("compress", "empty input", C.rule_compress(""), "")
check("compress", "whitespace only", C.rule_compress("   \n\n\t"), "")
check("compress", "single word untouched", C.rule_compress("hello"), "hello")
# Nothing to remove -> byte-identical (modulo the documented outer strip).
check("compress", "terse prose passes through", C.rule_compress("# T\n\nTerse text.\n"), "# T\n\nTerse text.")
# Blank-line runs collapse to exactly one blank line, never zero.
check("compress", "blank run collapse", C.rule_compress("a\n\n\n\n\nb"), "a\n\nb")

# Each rule family, one representative, so a deleted regex group is caught.
for label, src, want in [
    ("filler word", "This is just a test.", "This is a test."),
    ("phrase replace", "Run it in order to build.", "Run it to build."),
    ("word replace", "We utilize configuration.", "We use config."),
    ("permissive opener", "You should run it.", "run it."),
    ("intensifier + I-prefer", "I strongly prefer tabs.", "prefer tabs."),
    ("you can", "You can run it.", "run it."),
    ("article removal", "the cat sat on the mat", "cat sat on mat"),
    ("softener", "This is usually fine.", "This is fine."),
    ("connective", "However, it broke.", ", it broke."),
]:
    check("compress", label, C.rule_compress(src), want)

# Markdown-significant indentation survives: list markers keep their indent and
# blockquotes keep their marker, because the validator counts bullets and would
# not notice a flattened nested list.
# --- Headings are protected from fluff removal, like code/URLs and paths ---
# validate_headings errors on any same-count heading text/order change (it
# breaks in-document anchor links), so a filler word rewritten out of a
# heading used to revert the whole compression via __main__'s retry-then-
# restore loop.
check("compress", "heading with filler word untouched",
      C.rule_compress("# Just Getting Started\n\nBody.\n"),
      "# Just Getting Started\n\nBody.")

check("compress", "list indent preserved",
      C.rule_compress("1. the first item\n2) the second\n  - nested   the thing\n> quote   the thing"),
      "1. first item\n2) second\n  - nested thing\n> quote thing")
# A 3-space indent is prose (leading space dropped); 4+ is an indented code
# block and the line is returned verbatim, spacing included.
check("compress", "3-space indent is prose", C.rule_compress("   the  a"), "a")
check("compress", "4-space indent keeps spacing", C.rule_compress("x\n\n    keep  a"), "x\n\n    keep  a")

# --- CommonMark indented code blocks are protected like fenced ones --------
# The word rules run over prose only. A 4-space indented block is code, so its
# body must survive byte-for-byte, not merely keep its leading whitespace.
check("compress", "indented code body survives verbatim",
      C.rule_compress("Prose.\n\n    validate the utilize implement\n\nAfter.\n"),
      "Prose.\n\n    validate the utilize implement\n\nAfter.")
check("compress", "indented block reaches the stash",
      len(C.protect("x\n\n    validate the utilize\n")[1]), 1)
# Interior blank lines belong to the block; the run ends at real prose.
check("compress", "indented block spans interior blanks",
      C.rule_compress("P.\n\n    a the utilize\n\n    b the utilize\n\nQ the utilize.\n"),
      "P.\n\n    a the utilize\n\n    b the utilize\n\nQ use.")
# An indented line continuing the paragraph above is prose, not a code block.
check("compress", "indented continuation is still prose",
      C.rule_compress("Lead in\n    the utilize of it"),
      "Lead in\n    use of it")

# --- An unclosed fence is stashed, not emitted verbatim --------------------
# The markdown is malformed either way, but emitting it let the prose rules
# rewrite the code inside it.
check("compress", "unclosed fence body survives verbatim",
      C.rule_compress("intro\n```py\nvalidate the utilize\n"),
      "intro\n```py\nvalidate the utilize")

# --- restore() no longer collides with a literal placeholder ---------------
# protect() lengthens its delimiters until neither occurs in the input, so a
# source that already contains a placeholder-shaped run cannot make a stashed
# block reappear inside the prose.
inj = C._PH_OPEN + "0" + C._PH_CLOSE + " literal here\n\n```\nBLOCK the\n```\n"
check("compress", "literal placeholder does not duplicate the block",
      C.rule_compress(inj).count("BLOCK the"), 1)
check("compress", "literal placeholder survives untouched",
      C._PH_OPEN + "0" + C._PH_CLOSE in C.rule_compress(inj), True)

# ===========================================================================
# 3. extract_code_blocks — fence scanner off-by-ones
#    compress._mask_fenced_blocks re-implements this loop; the two must agree,
#    because masking and validation disagreeing is exactly how a corrupted file
#    passes validation.
# ===========================================================================

FENCE_CASES = [
    ("backtick pair", "a\n```\nx\n```\nb", ["```\nx\n```"]),
    ("tilde pair", "a\n~~~\nx\n~~~\nb", ["~~~\nx\n~~~"]),
    # A 3-backtick line inside a 4-backtick block is content, not a close.
    ("nested shorter fence is content", "````\n```\ninner\n```\n````", ["````\n```\ninner\n```\n````"]),
    # Close must be >= open, so ``` cannot close ````.
    ("shorter fence cannot close longer", "````\nx\n```\ny\n````", ["````\nx\n```\ny\n````"]),
    # A close line carrying an info string is not a close.
    ("info string on close is content", "```py\nx\n```py\ny\n```", ["```py\nx\n```py\ny\n```"]),
    # CommonMark allows up to 3 spaces of fence indent, 4 makes it indented code.
    ("3-space indent is a fence", "   ```\nx\n   ```", ["   ```\nx\n   ```"]),
    ("4-space indent is not a fence", "    ```\nx\n    ```", []),
    # Unclosed fence at EOF is dropped rather than reported as a block.
    # An unclosed fence is code, not something to skip: the masker stashes it so
    # the prose rules cannot rewrite its body, and the extractor must agree.
    ("unclosed kept as code", "a\n```\nx\ny", ["```\nx\ny"]),
    ("unclosed drops trailing blanks", "a\n```\nx\n\n", ["```\nx"]),
    ("two blocks", "```\na\n```\nmid\n```\nb\n```", ["```\na\n```", "```\nb\n```"]),
    ("no trailing newline", "```\na\n```", ["```\na\n```"]),
    ("empty input", "", []),
    ("no fences", "just prose\n", []),
]
for label, src, want in FENCE_CASES:
    check("validate", f"fence {label}", V.extract_code_blocks(src), want)
    # Same input through the masker: every block the extractor found must have
    # been replaced by a placeholder, and nothing else may move.
    st = []
    C._mask_fenced_blocks(src, st)
    check("validate", f"mask agrees on {label}", st, want)

# The validator's blind spot is what made indented-code corruption silent: the
# masker skipped those blocks AND the extractor did, so the two agreed on a wrong
# answer. validate_code_blocks must see them now.
check("validate", "indented block extracted",
      V.extract_indented_blocks("P.\n\n    code the\n\nQ.\n"), ["    code the"])
check("validate", "indented continuation is not a block",
      V.extract_indented_blocks("Lead in\n    not code\n"), [])
# ===========================================================================
# 4. Extractors
# ===========================================================================

# Trailing ")" is excluded so a markdown link's closing paren is not swallowed.
check("validate", "urls in markdown link",
      V.extract_urls("see https://a.com/x and (https://b.com/y) end"),
      {"https://a.com/x", "https://b.com/y"})
check("validate", "no urls", V.extract_urls("plain prose"), set())

# A path needs a prefix or an interior separator; a bare word must not count,
# or every sentence would register as a path change.
check("validate", "paths found",
      V.extract_paths("./a/b.md and src/main.py and plain word and /etc/hosts"),
      {"./a/b.md", "src/main.py", "/etc/hosts"})
check("validate", "bare word is not a path", V.extract_paths("just words here"), set())

check("validate", "bullets counted", V.count_bullets("- a\n* b\n+ c\n  - d\nnot"), 4)
check("validate", "no bullets", V.count_bullets("prose\n"), 0)

# 7 hashes is not a heading, and a hash without a space is not either.
check("validate", "headings", V.extract_headings("# A\n## B \ntext\n####### too many\n#nospace"),
      [("#", "A"), ("##", "B")])

# Inline code inside a fenced block must not be collected, or a code block full
# of backticks would inflate the count on both sides.
check("validate", "inline code skips fences",
      V.extract_inline_codes("a `x` b\n```\n`hidden`\n```\nc `y` d"), ["x", "y"])
check("validate", "inline code skips tilde fences",
      V.extract_inline_codes("a `x`\n~~~\n`hid`\n~~~\n`y`"), ["x", "y"])
check("validate", "inline code across two fences",
      V.extract_inline_codes("```\n`h1`\n```\nmid `keep` mid\n```\n`h2`\n```\ntail `keep2`"),
      ["keep", "keep2"])
# A fence indented within CommonMark's 0-3 space margin is still a real fence
# (extract_code_blocks/_blank_fenced_regions already treat it as one). The old
# fence-stripper here used a standalone `^```...^```` regex anchored to column
# 0, so an indented fence's markers survived and re-paired with real inline
# code elsewhere in the file — corrupting the whole document's count, not just
# missing the one block. Confirmed on the pre-fix code: it returned
# ['x', '\n ', '\n ', '\n\nc '] instead of ['x', 'y'].
check("validate", "inline code skips indented fence (leaked markers)",
      V.extract_inline_codes("a `x` b\n\n ```\n `hidden`\n ```\n\nc `y` d"),
      ["x", "y"])

# ===========================================================================
# 5. Validators — accept AND reject, and error vs warning severity
# ===========================================================================

# (label, validator, original, compressed, (is_valid, n_errors, n_warnings))
VALIDATOR_CASES = [
    # Code blocks: an error, because a rewritten code block is data loss.
    ("code blocks identical", V.validate_code_blocks, "```\na\n```", "```\na\n```", (True, 0, 0)),
    ("code blocks changed", V.validate_code_blocks, "```\na\n```", "```\nb\n```", (False, 1, 0)),
    ("code blocks dropped", V.validate_code_blocks, "```\na\n```", "gone", (False, 1, 0)),
    # Indented blocks count as code too — the twin blind spot that let a rewritten
    # indented block validate clean.
    ("indented block identical", V.validate_code_blocks,
     "P.\n\n    a the\n\nQ.", "P.\n\n    a the\n\nQ.", (True, 0, 0)),
    ("indented block rewritten", V.validate_code_blocks,
     "P.\n\n    validate the\n\nQ.", "P.\n\n    check the\n\nQ.", (False, 1, 0)),
    # URLs: an error. Set-compared, so reordering is fine but losing one is not.
    ("urls preserved out of order", V.validate_urls, "https://a.com/x https://b.com/y",
     "https://b.com/y then https://a.com/x", (True, 0, 0)),
    ("url lost", V.validate_urls, "https://a.com/x", "gone", (False, 1, 0)),
    ("url invented", V.validate_urls, "text", "https://evil.com/x", (False, 1, 0)),
    # Headings: a count mismatch (heading dropped/added outright) short-circuits
    # as a warning, before the text/order comparison runs. A same-count rename
    # or reorder is an error — it silently breaks in-document anchor links
    # (same text -> same slug), so it must not validate clean.
    ("headings identical", V.validate_headings, "# A\n## B", "# A\n## B", (True, 0, 0)),
    ("heading dropped", V.validate_headings, "# A\n## B", "# A", (True, 0, 1)),
    ("heading retitled", V.validate_headings, "# A\n## B", "# A\n## C", (False, 1, 0)),
    ("heading level changed", V.validate_headings, "# A\n## B", "# A\n### B", (False, 1, 0)),
    # Paths: a lost path is an error (a promised file reference vanished);
    # an added one stays a warning (prose legitimately gains a reference).
    ("path preserved", V.validate_paths, "src/main.py", "see src/main.py", (True, 0, 0)),
    ("path lost", V.validate_paths, "src/main.py", "nothing", (False, 1, 0)),
    ("path added", V.validate_paths, "prose", "see src/main.py", (True, 0, 1)),
    # A real lost path — 2+ slash levels and an extension — is still an error.
    ("real path lost", V.validate_paths, "see src/utils/helper.py for it", "see nothing for it", (False, 1, 0)),
    # Slash idioms match the bare word/word alternative but aren't paths, so
    # losing them on a reword ("and/or" -> "or") stays a warning, not an error.
    ("slash idiom lost is a warning, not an error", V.validate_paths,
     "and/or he/she a couple times, before/after lunch",
     "or she a couple times, after lunch", (True, 0, 1)),
    # A bare two-segment reference with no extension/prefix is still a real
    # path (the repo's own doc convention, e.g. "claude/hooks") — must error,
    # not warn, when lost.
    ("extensionless directory path lost is an error", V.validate_paths,
     "see claude/hooks for it", "see nothing for it", (False, 1, 0)),
    ("bare slash idiom lost is a warning", V.validate_paths,
     "and/or", "or", (True, 0, 1)),
    ("date-shaped match lost is a warning, not an error", V.validate_paths,
     "logged on 2024/01/15 today", "logged today", (True, 0, 1)),
    ("three-way idiom lost is a warning, not an error", V.validate_paths,
     "run before/during/after the change", "run the change", (True, 0, 1)),
    # Sentence-final period: PATH_REGEX's bare-word alternative swallows the
    # trailing "." into the match, so the carve-outs must still fire on it.
    ("sentence-final idiom lost is a warning, not an error", V.validate_paths,
     "This applies before/after.", "This applies.", (True, 0, 1)),
    ("sentence-final date-shaped match lost is a warning, not an error", V.validate_paths,
     "It happened on 2024/01/15.", "It happened.", (True, 0, 1)),
    # Ellipsis: PATH_REGEX's char class admits consecutive periods, so a
    # sentence-final "..." must strip down to the real token just like a
    # single "." does — the idiom stays a warning, not an error.
    ("sentence-final ellipsis idiom lost is a warning, not an error", V.validate_paths,
     "This applies before/after...", "This applies.", (True, 0, 1)),
    # Two-segment bare numeric tokens ("3/15", "50/50", "1/2") — a real path
    # segment is essentially never a bare integer, so these stay warnings too.
    ("two-segment numeric match lost is a warning, not an error", V.validate_paths,
     "the score was 3/15 today", "the score was low today", (True, 0, 1)),
    ("fifty-fifty numeric match lost is a warning, not an error", V.validate_paths,
     "odds are 50/50 here", "odds are even here", (True, 0, 1)),
    ("one-half numeric match lost is a warning, not an error", V.validate_paths,
     "roughly 1/2 of them", "roughly half of them", (True, 0, 1)),
    # Inline code: losing one is an error, inventing one is only a warning.
    ("inline code preserved", V.validate_inline_codes, "`a` `b`", "`b` `a`", (True, 0, 0)),
    ("inline code lost", V.validate_inline_codes, "`a` `b`", "`a`", (False, 1, 0)),
    ("inline code count dropped", V.validate_inline_codes, "`a` `a`", "`a`", (False, 1, 0)),
    ("inline code invented", V.validate_inline_codes, "`a`", "`a` `z`", (True, 0, 1)),
    ("inline code none either side", V.validate_inline_codes, "prose", "prose", (True, 0, 0)),
]
for label, fn, orig, comp, want in VALIDATOR_CASES:
    check("validate", label, verdict(fn, orig, comp), want)

# _is_pathlike carve-outs, direct: sentence-final period must not defeat the
# idiom/date carve-outs, two-segment bare-numeric tokens must carve out too,
# and real paths (with or without a trailing period) must still error.
for label, s, want in [
    ("sentence-final idiom", "before/after.", False),
    ("sentence-final ellipsis idiom", "before/after...", False),
    ("sentence-final date", "2024/01/15.", False),
    ("sentence-final ellipsis date-ish", "2024/01/15..", False),
    ("two-segment numeric", "3/15", False),
    ("fifty-fifty numeric", "50/50", False),
    ("one-half numeric", "1/2", False),
    ("real extensionless path unaffected", "claude/hooks", True),
    ("real path with extension unaffected", "src/utils/helper.py", True),
    # rstrip(".") only strips trailing periods, not the extension's own dot —
    # a real path ending a sentence must still error, not fall through as if
    # the extension itself had been stripped away.
    ("real path with sentence-final period", "src/utils/helper.py.", True),
]:
    check("validate", f"_is_pathlike {label}", V._is_pathlike(s), want)

# Bullet drift threshold is 15%, and zero bullets in the original disables the
# check entirely (no ZeroDivisionError). 10 -> 9 is 10% (pass), 10 -> 8 is 20%.
ten = "\n".join("- x" for _ in range(10))
check("validate", "bullets 10->9 within tolerance",
      verdict(V.validate_bullets, ten, "\n".join("- x" for _ in range(9))), (True, 0, 0))
check("validate", "bullets 10->8 over tolerance",
      verdict(V.validate_bullets, ten, "\n".join("- x" for _ in range(8))), (True, 0, 1))
check("validate", "bullets none in original is skipped",
      verdict(V.validate_bullets, "prose", "- a\n- b\n- c"), (True, 0, 0))

# End to end: the real transform over a realistic doc must validate with zero
# errors AND zero warnings. This is the assertion that ties masking to
# validation — if protect() ever leaks, this is what fires.
REAL = """# Guide

You should really utilize `validate.py` in order to check the output.

See https://example.com/the/docs?utilize=1 for more.

```bash
# the utilize implement
python3 validate.py --json a.md b.md
```

- Item one is able to run
- Item two, due to the fact that it works
- Item three uses ./src/main.py

## Notes

It would be good to remember to rotate the keys.
"""
_o = write("real_orig.md", REAL)
_c = write("real_comp.md", C.rule_compress(REAL))
_r = V.validate(_o, _c)
check("validate", "real doc validates clean", (_r.is_valid, _r.errors, _r.warnings), (True, [], []))
truthy("validate", "real doc actually shrank", len(_c.read_text()) < len(REAL))

# A heading containing a filler word must still compress and validate clean,
# with the heading itself byte-identical (the bug: it used to get rewritten,
# fail validate_headings, and revert the whole file).
HEADING_DOC = "# Just Getting Started\n\nYou should really utilize this guide.\n"
_ho = write("heading_orig.md", HEADING_DOC)
_hc = write("heading_comp.md", C.rule_compress(HEADING_DOC))
check("validate", "heading with filler byte-identical after compression",
      _hc.read_text().splitlines()[0], "# Just Getting Started")
_hr = V.validate(_ho, _hc)
check("validate", "heading-with-filler doc validates clean", (_hr.is_valid, _hr.errors, _hr.warnings), (True, [], []))

# A bare "#" (no title, nothing on the same line) must not absorb the next
# paragraph as its title. HEADING_REGEX used to require `\s+` after the
# hashes, which spans newlines, so a bare "#\n\n<paragraph>" captured the
# paragraph as the heading text; the paragraph then got fluff-rewritten
# (unprotected, since it wasn't recognized as heading text on the masking
# side either) and validate_headings raised a hard error on the mismatch.
BARE_HEADING_DOC = "#\n\nYou should really utilize this guide.\n"
_bo = write("bare_heading_orig.md", BARE_HEADING_DOC)
_bc = write("bare_heading_comp.md", C.rule_compress(BARE_HEADING_DOC))
_br = V.validate(_bo, _bc)
check("validate", "bare heading doc validates clean", (_br.is_valid, _br.errors, _br.warnings), (True, [], []))

# An ATX heading indented 1-3 spaces is still CommonMark-valid. HEADING_REGEX
# and HEADING_LINE_REGEX used to anchor at column 0 only, so this heading was
# invisible to the masker (its filler word got rewritten) but visible to
# extract_headings on the compressed side only, once compress._clean_line had
# stripped the indent — a count mismatch (0 vs 1) that only warned, silently
# masking a reworded heading. Both regexes now tolerate the 0-3 space margin,
# and the whole indented line (indent + text) is masked as one unit, so the
# indent and the filler word both survive untouched.
INDENTED_HEADING_DOC = "  # Just Really Getting Started\n\nBody text.\n"
_iho = write("indented_heading_orig.md", INDENTED_HEADING_DOC)
_ihc = write("indented_heading_comp.md", C.rule_compress(INDENTED_HEADING_DOC))
check("validate", "indented heading byte-identical after compression",
      _ihc.read_text().splitlines()[0], "  # Just Really Getting Started")
_ihr = V.validate(_iho, _ihc)
check("validate", "indented heading doc validates clean", (_ihr.is_valid, _ihr.errors, _ihr.warnings), (True, [], []))

# ===========================================================================
# 6. detect — every class it claims, and one it must not claim
# ===========================================================================

# (filename, body, expected type, expected should_compress)
DETECT_CASES = [
    ("a.md", "# hi\ntext\n", "natural_language", True),
    ("a.txt", "text", "natural_language", True),
    ("a.rst", "text", "natural_language", True),
    ("a.typ", "text", "natural_language", True),
    ("a.py", "print(1)", "code", False),
    ("a.sh", "echo hi", "code", False),
    ("a.go", "package main", "code", False),
    ("a.json", "{}", "config", False),
    ("a.yaml", "a: 1", "config", False),
    ("a.toml", "a = 1", "config", False),
    ("a.env", "X=1", "config", False),
    ("a.ini", "[s]\nx=1", "config", False),
    # An unknown extension must NOT be claimed as prose — guessing wrong here
    # means compressing a source file.
    ("a.weird", "plain prose here\n", "unknown", False),
    # Backups are prose by type but must never be recompressed.
    ("notes.md.original.md", "# x\n", "natural_language", False),
    # Extensionless files fall through to content sniffing.
    ("PLAINPROSE", "Hello world.\nThis is prose about things.\n", "natural_language", True),
    ("JSONISH", '{"a": 1, "b": [2, 3]}', "config", False),
    ("YAMLISH", "---\nname: x\nversion: 1\nitems:\n- a: 1\n- b: 2\n", "config", False),
    ("CODEISH", "import os\nfrom x import y\ndef f():\n    return 1\n@deco\nconst a = 1\n", "code", False),
]
for name, body, want_type, want_compress in DETECT_CASES:
    p = write(name, body)
    check("detect", f"type {name}", D.detect_file_type(p), want_type)
    check("detect", f"should_compress {name}", D.should_compress(p), want_compress)

# Degenerate: an empty extensionless file has no code or YAML signal, so it
# reads as prose here. compress_file rejects it later on the empty-body guard,
# which is the check that actually protects it (asserted in section 7).
check("detect", "empty extensionless reads as prose", D.detect_file_type(write("EMPTY", "")), "natural_language")

# Nonexistent path and a directory must both refuse, not raise.
check("detect", "missing file type", D.detect_file_type(TMP / "nope"), "unknown")
check("detect", "missing file refused", D.should_compress(TMP / "nope"), False)
check("detect", "directory refused", D.should_compress(TMP), False)

# ===========================================================================
# 7. compress_file — the guard ladder, every branch that says NO
# ===========================================================================


def status_of(name, body, **kw):
    return C.compress_file(write(name, body), **kw)["status"]


check("pipeline", "missing file", C.compress_file(TMP / "nope.md")["status"], "error")
check("pipeline", "not a file", C.compress_file(TMP)["status"], "error")
# A code file must be refused even though the rules would happily "compress" it
# and the validator, seeing no fenced blocks, would pass the wreckage.
check("pipeline", "code file refused", status_of("guard.py", "validate = the utilize\n"), "error")
check("pipeline", "config file refused", status_of("guard.json", '{"a": 1}'), "error")
check("pipeline", "unknown extension refused", status_of("guard.weird", "prose\n"), "error")
check("pipeline", "empty body refused", status_of("guard_empty.md", "   \n\n"), "error")
check("pipeline", "backup file skipped", status_of("guard.md.original.md", "# x\n"), "skip")
# Already compressed: nothing changes, so no backup is written and no file is
# rewritten. A "skip" here rather than "ok" is what stops a no-op from consuming
# the single backup slot.
noop = write("guard_noop.md", "# T\n\nTerse text.\n")
check("pipeline", "already compressed skipped", C.compress_file(noop)["status"], "skip")
check("pipeline", "no backup written on skip", (TMP / "guard_noop.md.original.md").exists(), False)
check("pipeline", "skipped file untouched", noop.read_text(), "# T\n\nTerse text.\n")
# Oversized input is refused before it is read into memory.
big = write("guard_big.md", "x " * 300_000)
check("pipeline", "oversized refused", C.compress_file(big)["status"], "error")

# Sensitive filename blocks only the network leg; local compression still runs,
# so a file that tripped the check is not left uncompressible.
sens = write("secrets.md", "# T\n\nYou should utilize the thing.\n")
check("pipeline", "sensitive name blocks api", C.compress_file(sens, use_api=True)["status"], "error")
check("pipeline", "sensitive name compresses locally", C.compress_file(sens)["status"], "ok")

# Happy path: original preserved byte-for-byte in the backup, compressed text
# written in place, and the token accounting reports a real saving.
BODY = "# Title\n\nYou should really utilize the `foo.py` helper in order to build it.\n\n- one\n- two\n"
ok = write("happy.md", BODY)
res = C.compress_file(ok)
check("pipeline", "happy status", res["status"], "ok")
check("pipeline", "backup is byte-identical original", (TMP / "happy.md.original.md").read_text(), BODY)
check("pipeline", "compressed written in place", ok.read_text(), "# Title\n\nuse `foo.py` helper to build it.\n\n- one\n- two")
check("pipeline", "token accounting", res["tokens_saved"], res["original_tokens"] - res["compressed_tokens"])
truthy("pipeline", "reports a saving", res["tokens_saved"] > 0)
check("pipeline", "api not used", res["used_api"], False)
# Second run refuses rather than overwriting the backup with the compressed
# text — that would destroy the only copy of the original.
check("pipeline", "second run refuses to clobber backup", C.compress_file(ok)["status"], "error")
check("pipeline", "backup still the original", (TMP / "happy.md.original.md").read_text(), BODY)

# The API leg is refused when the body carries a credential, whatever the
# filename says. Local-only compression of the same file still works.
tok = write("plain_notes.md", "# T\n\nYou should utilize " + "ghp_" + "016C7869C1AB4B7F5E9A2D3C8F0E1B2A3D4C55" + " here.\n")
check("pipeline", "secret in body blocks api", C.compress_file(tok, use_api=True)["status"], "error")
check("pipeline", "secret in body still compresses locally", C.compress_file(tok)["status"], "ok")

# atomic_write_text: a crash between the temp-file write and the os.replace
# swap must never truncate the target — the exact data-loss mode a plain
# write_text() has (it truncates the target before writing the new bytes).
atomic = write("atomic.md", "original content\n")
_real_replace = C.os.replace
C.os.replace = lambda *a, **kw: (_ for _ in ()).throw(OSError("simulated crash"))
try:
    try:
        C.atomic_write_text(atomic, "new content\n")
    except OSError:
        pass
finally:
    C.os.replace = _real_replace
check("pipeline", "atomic write: crash before replace leaves original intact", atomic.read_text(), "original content\n")
# The failed write must not leak its temp file — assert none remains rather
# than clean one up ourselves, which would hide a leak instead of catching it.
check("pipeline", "atomic write: crash leaves no temp file", list(TMP.glob(".atomic.md.tmp*")), [])

# atomic_write_text through a symlink: os.replace onto the link itself would
# swap the link, leaving the real target untouched and the tool none the
# wiser. Writing through the resolved path must update the target and the
# path must remain a symlink afterward.
target = write("real_target.md", "original content\n")
link = TMP / "link.md"
link.symlink_to(target)
C.atomic_write_text(link, "new content\n")
check("pipeline", "atomic write through symlink updates target", target.read_text(), "new content\n")
truthy("pipeline", "atomic write keeps the path a symlink", link.is_symlink())

# atomic_write_text must preserve the target's existing permissions rather
# than resetting them to the temp file's umask defaults.
import stat as _stat  # noqa: E402
perm = write("perm.md", "original content\n")
perm.chmod(0o600)
C.atomic_write_text(perm, "new content\n")
check("pipeline", "atomic write preserves 0600 permissions",
      _stat.S_IMODE(perm.stat().st_mode), 0o600)

# atomic_write_text must strip special bits (setuid/setgid/sticky) rather
# than propagate them — S_IMODE alone masks 0o7777 and would keep them.
special = write("special.md", "original content\n")
special.chmod(0o2644)  # setgid + rw-r--r--
C.atomic_write_text(special, "new content\n")
check("pipeline", "atomic write strips setgid bit",
      _stat.S_IMODE(special.stat().st_mode), 0o644)

shutil.rmtree(TMP, ignore_errors=True)

if failures:
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    sys.exit(1)

total = sum(counts.values())
print(f"ok   compress: {counts['compress']} checks — masking round-trip, idempotence, rule families, fenced+indented+collision regressions")
print(f"ok   validate: {counts['validate']} checks — fence scanner edges (masker agrees), every validator accept+reject")
print(f"ok   detect:   {counts['detect']} checks — 18 file classes plus unknown/backup/missing refusals")
print(f"ok   pipeline: {counts['pipeline']} checks — guard ladder, backup integrity, secret and sensitive-name gates")
print(f"ok   compress-pipeline: {total} checks passed")
