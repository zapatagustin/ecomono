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

Asserted behavior is current behavior. Where current behavior is wrong it is
marked KNOWN BUG with a note, so a future fix breaks this file loudly instead of
being mistaken for a regression.
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
# Blocks are stashed before inline code and URLs, so a URL inside a fence is
# captured once (as part of the block) and not double-stashed.
check("compress", "stash order", stash, [
    "```py\nimport os\nthe utilize implement\n```",
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
check("compress", "list indent preserved",
      C.rule_compress("1. the first item\n2) the second\n  - nested   the thing\n> quote   the thing"),
      "1. first item\n2) second\n  - nested thing\n> quote thing")
# A 3-space indent is prose (leading space dropped); 4+ is an indented code
# block and the line is returned verbatim, spacing included.
check("compress", "3-space indent is prose", C.rule_compress("   the  a"), "a")
check("compress", "4-space indent keeps spacing", C.rule_compress("x\n\n    keep  a"), "x\n\n    keep  a")

# --- KNOWN BUG: 4-space indented code blocks are not protected -------------
# _clean_line spares their whitespace, but the word rules ran earlier, so the
# code itself is rewritten. validate.py has no check for indented code blocks,
# so the corrupted file validates clean. Asserting current behavior.
check("compress", "KNOWN BUG indented code body rewritten",
      C.rule_compress("Prose.\n\n    validate the utilize implement\n\nAfter.\n"),
      "Prose.\n\n    check use build\n\nAfter.")

# --- KNOWN BUG: unclosed fence is left unmasked ----------------------------
# _mask_fenced_blocks emits the lines verbatim rather than stashing them, so the
# prose rules rewrite the code inside. The validator also skips unclosed fences,
# so nothing complains. Asserting current behavior.
check("compress", "KNOWN BUG unclosed fence body rewritten",
      C.rule_compress("intro\n```py\nvalidate the utilize\n"),
      "intro\n```py\ncheck use")

# --- KNOWN BUG: restore() is a blind str.replace ---------------------------
# A literal placeholder sequence in the source collides with a generated one, so
# restore() substitutes the stashed block into prose and duplicates it.
inj = C._PH_OPEN + "0" + C._PH_CLOSE + " literal here\n\n```\nBLOCK the\n```\n"
check("compress", "KNOWN BUG placeholder collision duplicates block",
      C.rule_compress(inj), "```\nBLOCK the\n``` literal here\n\n```\nBLOCK the\n```")

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
    ("unclosed dropped", "a\n```\nx\ny", []),
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

# ===========================================================================
# 5. Validators — accept AND reject, and error vs warning severity
# ===========================================================================

# (label, validator, original, compressed, (is_valid, n_errors, n_warnings))
VALIDATOR_CASES = [
    # Code blocks: an error, because a rewritten code block is data loss.
    ("code blocks identical", V.validate_code_blocks, "```\na\n```", "```\na\n```", (True, 0, 0)),
    ("code blocks changed", V.validate_code_blocks, "```\na\n```", "```\nb\n```", (False, 1, 0)),
    ("code blocks dropped", V.validate_code_blocks, "```\na\n```", "gone", (False, 1, 0)),
    # URLs: an error. Set-compared, so reordering is fine but losing one is not.
    ("urls preserved out of order", V.validate_urls, "https://a.com/x https://b.com/y",
     "https://b.com/y then https://a.com/x", (True, 0, 0)),
    ("url lost", V.validate_urls, "https://a.com/x", "gone", (False, 1, 0)),
    ("url invented", V.validate_urls, "text", "https://evil.com/x", (False, 1, 0)),
    # Headings: only a warning, and a count mismatch short-circuits so the
    # text-changed warning is not also emitted.
    ("headings identical", V.validate_headings, "# A\n## B", "# A\n## B", (True, 0, 0)),
    ("heading dropped", V.validate_headings, "# A\n## B", "# A", (True, 0, 1)),
    ("heading retitled", V.validate_headings, "# A\n## B", "# A\n## C", (True, 0, 1)),
    ("heading level changed", V.validate_headings, "# A\n## B", "# A\n### B", (True, 0, 1)),
    # Paths: warning only, because prose legitimately rephrases around a path.
    ("path preserved", V.validate_paths, "src/main.py", "see src/main.py", (True, 0, 0)),
    ("path lost", V.validate_paths, "src/main.py", "nothing", (True, 0, 1)),
    # Inline code: losing one is an error, inventing one is only a warning.
    ("inline code preserved", V.validate_inline_codes, "`a` `b`", "`b` `a`", (True, 0, 0)),
    ("inline code lost", V.validate_inline_codes, "`a` `b`", "`a`", (False, 1, 0)),
    ("inline code count dropped", V.validate_inline_codes, "`a` `a`", "`a`", (False, 1, 0)),
    ("inline code invented", V.validate_inline_codes, "`a`", "`a` `z`", (True, 0, 1)),
    ("inline code none either side", V.validate_inline_codes, "prose", "prose", (True, 0, 0)),
]
for label, fn, orig, comp, want in VALIDATOR_CASES:
    check("validate", label, verdict(fn, orig, comp), want)

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

shutil.rmtree(TMP, ignore_errors=True)

if failures:
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    sys.exit(1)

total = sum(counts.values())
print(f"ok   compress: {counts['compress']} checks — masking round-trip, idempotence, rule families, 3 known bugs pinned")
print(f"ok   validate: {counts['validate']} checks — fence scanner edges (masker agrees), every validator accept+reject")
print(f"ok   detect:   {counts['detect']} checks — 18 file classes plus unknown/backup/missing refusals")
print(f"ok   pipeline: {counts['pipeline']} checks — guard ladder, backup integrity, secret and sensitive-name gates")
print(f"ok   compress-pipeline: {total} checks passed")
