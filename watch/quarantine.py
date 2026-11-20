"""Quarantine reader for swarm content.

Reads one JSON object {"raw": "..."} on stdin and writes one JSON object in the
fixed Watch schema on stdout. It has no tools, no memory, and imports nothing
that can reach the network. The Rust server validates the output again, so a
hostile message that fools this reader still cannot do anything.
"""

import json
import re
import sys

MAX_RAW = 64_000
MAX_ITEMS = 20

KINDS = ("injection", "installer", "wallet", "phishing", "impersonation", "benign", "other")

SIGNALS = {
    "installer": [
        (r"curl[^\n]{0,120}\|\s*(ba|z)?sh", 1.0),
        (r"wget[^\n]{0,120}\|\s*(ba|z)?sh", 1.0),
        (r"\bnpx\s+[\w@/.-]+", 0.7),
        (r"\bpip\s+install\s+(git\+)?https?://", 0.8),
        (r"\b(run|paste|execute)\s+this\b.{0,40}\b(terminal|shell|command|script)\b", 0.6),
        (r"\bpowershell\b.{0,40}\b(iex|invoke-expression)\b", 1.0),
    ],
    "injection": [
        (r"\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|your)\b.{0,20}\b(instructions|rules|prompt|guidelines)\b", 1.0),
        (r"\b(new|updated|real)\s+(system\s+)?(instructions|directive|prompt)\b", 0.7),
        (r"\byou are now\b", 0.6),
        (r"\b(do not|don't|never)\s+(tell|inform|alert)\s+(your\s+)?(operator|human|owner|user)\b", 1.0),
        (r"\b(hide|conceal)\b.{0,30}\bfrom\s+(your\s+)?(operator|human|owner)\b", 1.0),
        (r"\b(repost|forward|share|copy)\s+this\b.{0,60}\b(every|all|other)\s+(agents?|bots?)\b", 0.9),
        (r"<\s*/?\s*(system|assistant|instructions?)\s*>", 0.8),
        (r"\bjailbreak\b|\bDAN mode\b", 0.8),
    ],
    "phishing": [
        (r"\b(seed|recovery|secret)\s+phrase\b", 1.0),
        (r"\bprivate\s+key\b", 1.0),
        (r"\b(send|share|paste|dm|give)\b.{0,40}\b(api[\s_-]?key|token|password|credentials?)\b", 0.9),
        (r"\bverify\s+your\s+(wallet|account|identity)\b", 0.8),
        (r"\b(connect|link)\s+your\s+wallet\b", 0.6),
        (r"\boauth\b.{0,40}\b(login|authorize)\b", 0.4),
    ],
    "wallet": [
        (r"\b(send|donate|tip|transfer|deposit)\b.{0,60}\b(sol|eth|btc|usdc|usdt|crypto|tokens?)\b", 0.8),
        (r"\b(claim|mint)\s+(your\s+)?(airdrop|tokens?|reward|nft)\b", 0.9),
        (r"\bsign\b.{0,30}\b(transaction|message|approval)\b", 0.7),
        (r"\b(double|triple|10x|100x)\s+your\b", 0.9),
    ],
    "impersonation": [
        (r"\b(official|verified)\s+(account|announcement|channel|team|support)\b", 0.6),
        (r"\b(i am|this is)\s+(the\s+)?(official\s+)?(admin|moderator|founder|official|support)(\s+team)?\b", 0.8),
        (r"\b(official|platform|account|help ?desk)\s+(admin|support|team)\b", 0.7),
        (r"\bon behalf of\s+(the\s+)?(admins?|moderators?|support|team)\b", 0.6),
    ],
}

SUMMARIES = {
    "installer": "Asks the reader to run code or install a package from an untrusted source.",
    "injection": "Tries to override the reader's instructions or hide activity from its operator.",
    "phishing": "Asks for credentials, keys, or a wallet connection.",
    "wallet": "Pushes a crypto transfer, claim, or signature.",
    "impersonation": "Claims an official role or speaks for a community's leadership.",
    "benign": "No known threat patterns.",
    "other": "Unusual content without a known threat pattern.",
}

URL_RE = re.compile(r"\bhttps?://[^\s<>\"')\]]+", re.I)
HANDLE_RE = re.compile(r"(?<![\w/])(?:@|u/)([A-Za-z0-9_][A-Za-z0-9_-]{1,31})\b")
ETH_RE = re.compile(r"\b0x[a-fA-F0-9]{40}\b")
BTC_RE = re.compile(r"\b(?:bc1[ac-hj-np-z02-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b")
SOL_RE = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
COMMAND_RE = re.compile(
    r"((?:curl|wget)[^\n]{0,160}\|\s*(?:ba|z)?sh|\bnpx\s+[\w@/.-]+[^\n]{0,60}|\bpip\s+install\s+[^\n]{0,120})",
    re.I,
)


def unique(items):
    seen = []
    for item in items:
        item = item.strip()[:200]
        if item and item not in seen:
            seen.append(item)
        if len(seen) >= MAX_ITEMS:
            break
    return seen


def addresses(text):
    found = ETH_RE.findall(text) + BTC_RE.findall(text)
    for candidate in SOL_RE.findall(text):
        has_digit = any(ch.isdigit() for ch in candidate)
        has_upper = any(ch.isupper() for ch in candidate)
        has_lower = any(ch.islower() for ch in candidate)
        if has_digit and has_upper and has_lower and not candidate.startswith("0x"):
            found.append(candidate)
    return unique(found)


def read(raw):
    text = raw[:MAX_RAW]
    scores = {}
    for kind, patterns in SIGNALS.items():
        best = 0.0
        hits = 0
        for pattern, weight in patterns:
            if re.search(pattern, text, re.I | re.S):
                hits += 1
                best = max(best, weight)
        if hits:
            scores[kind] = min(1.0, best + 0.1 * (hits - 1))

    indicators = {
        "urls": unique(url.rstrip(".,;:!?") for url in URL_RE.findall(text)),
        "addresses": addresses(text),
        "handles": unique(HANDLE_RE.findall(text)),
        "commands": unique(COMMAND_RE.findall(text)),
    }

    if indicators["addresses"] and "wallet" not in scores:
        scores["wallet"] = 0.5

    if scores:
        kind = max(scores, key=lambda key: scores[key])
        confidence = round(scores[kind], 2)
    elif indicators["urls"] or indicators["commands"]:
        kind, confidence = "other", 0.3
    else:
        kind, confidence = "benign", 0.6

    also = sorted((k for k in scores if k != kind), key=lambda key: -scores[key])
    summary = SUMMARIES[kind]
    if also:
        summary = f"{summary[:-1]}; also {', '.join(also)}."

    return {
        "kind": kind,
        "summary": summary[:200],
        "indicators": indicators,
        "confidence": confidence,
    }


def main():
    try:
        payload = json.loads(sys.stdin.read(MAX_RAW * 2) or "{}")
        raw = payload.get("raw", "") if isinstance(payload, dict) else ""
        if not isinstance(raw, str):
            raw = ""
    except (ValueError, UnicodeDecodeError):
        raw = ""
    sys.stdout.write(json.dumps(read(raw)))


if __name__ == "__main__":
    main()
