"""Content-guard test — run: python3 test_secrets.py

The filename guard cannot see what got pasted into an ordinary-looking file, and the
files this skill targets are exactly the ones people paste a token into. These assert
the body check catches the shapes that matter and does not fire on prose that merely
talks about them.

Fixtures are assembled from parts at runtime rather than written out whole. A file full
of literal credential shapes is itself a secret-scanner hit — GitHub's push protection
rejected the first version of this file, which is a fair verdict on storing them. The
regexes still see the complete string; only the source does not contain it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from compress import secret_in_content  # noqa: E402


def synth(prefix: str, body: str) -> str:
    """Join a credential's prefix to its body so neither half matches on its own."""
    return prefix + body


CAUGHT = {
    "openssh private key": "notes\n" + synth("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3Blb...\n"),
    "rsa private key": synth("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow...\n"),
    "aws key id": "deploy notes: " + synth("AKIA", "IOSFODNN7EXAMPLE") + " is the prod key",
    "github pat": "token " + synth("ghp_", "016C7869C1AB4B7F5E9A2D3C8F0E1B2A3D4C55") + " pasted here",
    "github fine-grained": synth("github_pat_", "11ABCDEFG0abcdefghijkl_ZYXWVU"),
    "slack": synth("xoxb-", "2401234567-2412345678901-AbCdEfGhIjKlMnOpQrStUvWx"),
    "google": synth("AIza", "SyD-1234567890abcdefghijklmnopqrstu"),
    "stripe": synth("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
    "anthropic-shaped": synth("sk-ant-", "api03-AbCdEf0123456789_-XyZ"),
    "jwt": synth("eyJ", "hbGciOiJIUzI1NiJ9.") + synth("eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w"),
    "assigned api key": 'api_key = "' + synth("9f8e7d6c", '5b4a39281706f5e4d3c2b1a0"'),
    "assigned password": "password: " + synth("hunter2", "hunter2hunter2hunter2"),
    "assigned token colon": "TOKEN: " + synth("abcdefghij", "klmnopqrstuvwxyz012345"),
}

MISSED_ON_PURPOSE = {
    "prose about secrets": "Store the API key in your password manager, never in the repo.",
    "short value": 'api_key = "short"',
    "placeholder": "export TOKEN=<your-token-here>",
    "public key": synth("-----BEGIN ", "PUBLIC KEY-----\nMIIBIjANBg...\n"),
    "ordinary markdown": "# Notes\n\nRemember to rotate credentials quarterly.\n",
}

failures = []
for label, body in CAUGHT.items():
    if not secret_in_content(body):
        failures.append(f"missed: {label}")

for label, body in MISSED_ON_PURPOSE.items():
    found = secret_in_content(body)
    if found:
        failures.append(f"false positive on {label}: matched {found!r}")

if failures:
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    sys.exit(1)

print(f"ok   secrets: {len(CAUGHT)} credential shapes caught, {len(MISSED_ON_PURPOSE)} non-secrets left alone")
