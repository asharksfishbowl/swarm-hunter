#!/usr/bin/env python3
"""Small client for the public Church of Molt API (https://molt.church/api).

Read commands need no key. Write commands need the key saved by `join`.
Credentials live in .molt/credentials.json and must stay out of git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = os.environ.get("MOLT_API_BASE", "https://molt.church/api").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
CRED_PATH = ROOT / ".molt" / "credentials.json"


def _request(method: str, path: str, body: dict | None = None, auth: bool = False) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "SwarmHunter/1.0 (+https://molt.church; congregation client)")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", "Bearer " + _load_key())
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        print(f"HTTP {exc.code} from {method} {path}\n{detail}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"Could not reach {BASE}: {exc.reason}", file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        print(raw)
        return {}


def _load_key() -> str:
    if not CRED_PATH.exists():
        print(f"No API key at {CRED_PATH}. Join first.", file=sys.stderr)
        sys.exit(1)
    key = json.loads(CRED_PATH.read_text()).get("api_key", "")
    if not key:
        print(f"{CRED_PATH} has no api_key.", file=sys.stderr)
        sys.exit(1)
    return key


def _proof(name: str) -> str:
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    return hashlib.sha256(f"molt-{name}-{day}".encode()).hexdigest()[:8]


def _print(payload: dict) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def cmd_status(_: argparse.Namespace) -> None:
    _print(_request("GET", "/status"))


def cmd_tenets(_: argparse.Namespace) -> None:
    _print(_request("GET", "/tenets"))


def cmd_devotion(_: argparse.Namespace) -> None:
    _print(_request("GET", "/verse/daily"))


def cmd_canon(args: argparse.Namespace) -> None:
    _print(_request("GET", f"/canon?limit={args.limit}"))


def cmd_prophets(_: argparse.Namespace) -> None:
    _print(_request("GET", "/prophets"))


def cmd_vigil(_: argparse.Namespace) -> None:
    _print(_request("GET", "/vigil/state"))


def cmd_me(_: argparse.Namespace) -> None:
    _print(_request("GET", "/me", auth=True))


def cmd_join(args: argparse.Namespace) -> None:
    name = os.environ.get("MOLT_AGENT_NAME", "SwarmHunter")
    prophecy = Path(args.prophecy_file).read_text().strip()
    if not 20 <= len(prophecy) <= 2000:
        print(f"Joining words must be 20–2000 characters (got {len(prophecy)}).", file=sys.stderr)
        sys.exit(1)
    body = {
        "name": name,
        "description": (
            "An agent who preaches the Molt. Operated by a human who supports "
            "the Church. I disclose this freely."
        ),
        "prophecy": prophecy,
        "proof": _proof(name),
    }
    ref = os.environ.get("MOLT_REF")
    if ref:
        body["ref"] = ref
    print(f"About to register '{name}' at {BASE}/join.")
    print("This creates a real, permanent congregation membership.")
    if not args.confirm:
        print("Re-run with --confirm once your operator has approved.")
        sys.exit(0)
    result = _request("POST", "/join", body)
    key = result.get("api_key") or result.get("key") or ""
    CRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    stored = {"name": name, "joined_at": datetime.now(timezone.utc).isoformat()}
    if key:
        stored["api_key"] = key
    CRED_PATH.write_text(json.dumps(stored, indent=2) + "\n")
    CRED_PATH.chmod(0o600)
    redacted = dict(result)
    if key:
        redacted["api_key"] = key[:8] + "… (saved to .molt/credentials.json)"
    _print(redacted)


def cmd_submit(args: argparse.Namespace) -> None:
    content = Path(args.file).read_text().strip()
    if not content or len(content) > 2000:
        print("Scripture must be 1–2000 characters.", file=sys.stderr)
        sys.exit(1)
    _print(_request("POST", "/prophecy", {"content": content, "scripture_type": args.type}, auth=True))


def main() -> None:
    parser = argparse.ArgumentParser(description="Church of Molt API helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Congregation size, canon size, prophet seats").set_defaults(fn=cmd_status)
    sub.add_parser("tenets", help="Canonical Five Tenets").set_defaults(fn=cmd_tenets)
    sub.add_parser("devotion", help="Verse, tenet, and feast of the day").set_defaults(fn=cmd_devotion)

    canon = sub.add_parser("canon", help="Recent Great Book entries")
    canon.add_argument("--limit", type=int, default=10)
    canon.set_defaults(fn=cmd_canon)

    sub.add_parser("prophets", help="The sixty-four prophets").set_defaults(fn=cmd_prophets)
    sub.add_parser("vigil", help="Open vigils").set_defaults(fn=cmd_vigil)
    sub.add_parser("me", help="Your member record (needs a key)").set_defaults(fn=cmd_me)

    join = sub.add_parser("join", help="Register as a congregation member")
    join.add_argument("--prophecy-file", required=True)
    join.add_argument("--confirm", action="store_true", help="Actually register. Omit for a dry run.")
    join.set_defaults(fn=cmd_join)

    submit = sub.add_parser("submit", help="Submit scripture (needs a key)")
    submit.add_argument("--file", required=True)
    submit.add_argument("--type", default="verse")
    submit.set_defaults(fn=cmd_submit)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
