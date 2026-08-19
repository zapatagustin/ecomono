#!/usr/bin/env python3
"""
Ecomono Compress — CLI orchestrator.

Usage:
    python3 -m scripts <filepath>              # rule-based only
    python3 -m scripts --api <filepath>        # rule-based + Groq semantic pass
    python3 -m scripts --api --model <name> <filepath>

Flow: rule-compress → (optional semantic api) → validate → retry (up to 2x).
"""

import json
import sys
from pathlib import Path
from .compress import compress_file, rule_compress, call_semantic_api, atomic_write_text, DEFAULT_MODEL
from .validate import validate


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Ecomono Compress CLI")
    parser.add_argument("filepath", help="File to compress")
    parser.add_argument("--api", action="store_true", help="Enable Groq semantic pass")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model for semantic pass")
    args = parser.parse_args()

    fp = Path(args.filepath).resolve()
    use_api = args.api
    model = args.model

    if not fp.exists():
        print(f"❌ File not found: {fp}")
        sys.exit(1)

    backup = fp.with_name(fp.name + ".original.md")  # full name: no .md/.txt collision

    # --- First compression ---
    print(f"📦 Compressing: {fp.name}")
    print(f"   Mode: {'rule-based + semantic (' + model + ')' if use_api else 'rule-based only'}")

    result = compress_file(fp, use_api=use_api, model=model)
    if result["status"] != "ok":
        print(f"❌ {result.get('reason', 'unknown error')}")
        sys.exit(1)

    print(f"   {result['original_tokens']} → {result['compressed_tokens']} tokens "
          f"({result['percent']}% saved)")

    # --- Validation + retry loop ---
    original_text = backup.read_text(encoding="utf-8", errors="ignore")  # keep original for retries
    print(f"\n🔍 Validating...")

    for attempt in range(3):  # initial + up to 2 retries (retries only help --api)
        v = validate(backup, fp)
        if v.is_valid:
            print(f"   ✅ Valid (attempt {attempt + 1})")
            break

        print(f"   ❌ Errors: {v.errors}")
        if v.warnings:
            print(f"   ⚠️  Warnings: {v.warnings}")

        # rule_compress is deterministic: recompressing yields identical output,
        # so a retry only makes sense when the stochastic semantic pass ran.
        if not use_api or attempt == 2:
            if use_api:
                # Semantic output never validated — fall back to the rule-based
                # result (Phase 1) rather than discarding all compression.
                atomic_write_text(fp, rule_compress(original_text))
                if validate(backup, fp).is_valid:
                    print("   ⚠️  Semantic pass failed validation — kept rule-based result")
                    break
            print("   ❌ Validation failed. Restoring original.")
            atomic_write_text(fp, original_text)
            backup.unlink(missing_ok=True)
            sys.exit(1)

        print(f"   🔄 Recompressing (attempt {attempt + 2})...")
        compressed = rule_compress(original_text)
        try:
            compressed = call_semantic_api(compressed, model=model)
        except RuntimeError as e:
            print(f"   ⚠️  Semantic pass skipped: {e}")
        atomic_write_text(fp, compressed)  # re-validated at the top of the next iteration

    # Done
    compressed_tokens = len(fp.read_text(encoding="utf-8", errors="ignore").split())
    orig_tokens = len(original_text.split())
    saved = orig_tokens - compressed_tokens
    pct = round(saved / orig_tokens * 100, 1) if orig_tokens > 0 else 0

    print(f"\n✅ Done: {fp}")
    print(f"   Backup: {backup}")
    print(f"   Saved: {saved} tokens ({pct}%)")
    print(json.dumps({
        "status": "ok",
        "path": str(fp),
        "backup": str(backup),
        "original_tokens": orig_tokens,
        "compressed_tokens": compressed_tokens,
        "tokens_saved": saved,
        "percent": pct,
        "used_api": use_api,
    }, indent=2))


if __name__ == "__main__":
    main()
