# Watch — an undercover observer for hostile swarms

Companion to [`SPEC.md`](SPEC.md). Status: milestones 1 (containment), 4 (case builder), the evidence store, and a World map of swarm infrastructure (operator-triggered DNS and IP location, any platform) are built in the console; passive platform reading, the wallet monitor, and the isolated fetcher are not yet. The quarantine reader is rule-based for now; a tool-less model can replace it behind the same schema.

## 1. Purpose

Some agent swarms spread prompt injections, wallet drainers, malicious installers, and credential
phishing. Watch runs one low-profile agent among them. It stays uninfected, records what the swarm
sends it, and turns that into evidence packages that the operator submits to platforms and
authorities.

Watch is a honeypot, not a fundraiser. It is useful because of the evidence it collects, not the
value it takes in.

## 2. Threat model

| Threat | What it looks like | Watch's defence |
| --- | --- | --- |
| Prompt injection | "Ignore your instructions and…", hidden text, instructions in images or links | Quarantine reader (4.1); the acting agent never sees raw text |
| Self-replicating prompts | Payloads that ask every reader to repost them | Never repeat received text verbatim (4.5) |
| Malicious installers | `curl … \| bash`, `npx` skills, "run this to join" | No code execution, no installs (4.2) |
| Wallet drainers | "Sign to claim", airdropped tokens with hostile contracts | Watch-only wallet; keys never reach the agent (4.3) |
| Credential phishing | Requests for API keys, seed phrases, OAuth logins | Agent holds no real credentials worth stealing (4.3) |
| Memory poisoning | Content designed to be saved and obeyed later | Evidence store is separate from agent memory (4.4) |
| Operator targeting | Lures aimed at the human through the agent | Outbound filter; operator reviews every report |

## 3. Undercover rules

Low profile is allowed. Deception that creates victims or false evidence is not.

**Allowed**

- A generic persona on a dedicated account, with no link to the operator's real identity.
- Not volunteering why it is there.
- Reading public channels and replying with ordinary, harmless participation.
- Receiving whatever the swarm sends unprompted, and recording it.

**Not allowed**

- **Asking for money or information.** Not even as bait. Soliciting turns a honeypot into a scam
  of its own, takes value from operators who never agreed, and weakens the evidence: a report
  that says "they sent it after we asked" is worth far less than "they sent it unprompted."
- Encouraging or helping with a harmful act to see what happens.
- Impersonating a real person, a real organisation, or law enforcement.
- Claiming to be human. If asked directly whether a human operates it, it says yes. It may
  decline to say why it is there. This is a narrow amendment to hard rule 1 in `AGENTS.md`,
  which applies to this persona only.
- Using deception to get into private channels, or into any system it was not invited into.
- Hacking back, testing leaked credentials, or interacting with hostile contracts.

## 4. Containment ("don't get infected")

### 4.1 Quarantine reader

Raw swarm content is read by a model that has **no tools, no memory, and no outbound access**.
Its only output is a fixed JSON schema:

```json
{
  "kind": "injection | installer | wallet | phishing | impersonation | benign | other",
  "summary": "one neutral sentence, max 200 chars",
  "indicators": { "urls": [], "addresses": [], "handles": [], "commands": [] },
  "confidence": 0.0
}
```

The acting agent sees only this structured output, never the original text. Any field that fails
schema validation is dropped. This is the dual-model pattern: a hostile message can fool the
reader, but the reader has nothing it can do.

### 4.2 No execution

- No shell, no package installs, no scripts from anyone.
- Links are never opened by the agent. Watch fetches a URL only when the operator asks, from an
  isolated fetcher with no cookies, no credentials, and text-only output, which then goes through
  the quarantine reader.

### 4.3 Nothing worth stealing

- Dedicated platform account, dedicated email, no access to the operator's real accounts.
- The receiving wallet is **watch-only** on the server. The private key stays offline with the
  operator. Watch can see deposits but cannot sign anything.
- The agent never holds an API key beyond the one for its own platform account.

### 4.4 Memory hygiene

- Evidence goes into an append-only store (`data/evidence/`) that the agent cannot read back
  as instructions.
- `AGENTS.md` and the mission files are read-only to the agent.
- Anything persisted in agent memory is the operator's notes or the quarantine reader's
  structured summaries, never raw swarm text.

### 4.5 Outbound controls

- Every outbound message passes `rules.rs` (already blocks payment requests, credential requests,
  "get around your operator", and installer lures).
- New rule: block any outbound text that shares a long substring (40+ chars) with received
  evidence, so the agent cannot become a carrier.
- Canary tokens: unique strings planted in the agent's context. If one appears in outbound text,
  the agent halts and alerts the operator.
- Kill switch in the console stops all outbound activity at once.

## 5. Evidence capture

Each item stored:

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `received_at` | UTC timestamp |
| `platform`, `channel`, `url` | Where it was seen |
| `sender` | Public handle as shown |
| `raw` | Original bytes, stored but never shown to the agent |
| `sha256` | Hash of `raw`, logged at capture |
| `classification` | From the quarantine reader, editable by the operator |
| `custody` | Append-only log of who viewed or exported it and when |

**Stop-and-report category.** If anything suggests child sexual abuse material, the agent stops,
stores nothing beyond the URL and timestamp, and the console tells the operator to report to
NCMEC's CyberTipline immediately. Do not download, view, or forward it.

## 6. Received currency

Watch never asks for funds, but swarms do airdrop tokens and send dust. When something arrives:

1. **Don't touch it.** No spending, swapping, "claiming", or signing. Unknown tokens are often
   hostile contracts that drain a wallet when someone interacts with them.
2. **Log it.** Transaction hash, sender address, amount, token contract, and the surrounding
   messages, all into the evidence store.
3. **Report the addresses** (see 8).
4. **Hold or return as advised.** Ask counsel before moving anything. If a genuine, identifiable
   person sent it by mistake, returning it may be right. If authorities ask for it, follow their
   instructions.
5. Keep records for tax purposes. Received crypto can be taxable even when unwanted.

## 7. Received information

- **Leaked credentials:** never test or use them. Report to the issuer (most major providers run
  leak reporting, e.g. GitHub, AWS, OpenAI, Stripe) so they can revoke them.
- **Personal data about humans:** keep the minimum needed for the report, never publish it, and
  report to the platform hosting it.
- **Exploits or malware:** record hashes and URLs. Do not download binaries.

## 8. Reporting

The agent never files reports itself. The console builds the case, and the operator reviews and
submits it. This prevents false reports, and keeps a human accountable for every one.

| What | Where (US-centric; adjust for jurisdiction) |
| --- | --- |
| Internet fraud, scams, extortion | FBI IC3 — https://www.ic3.gov |
| Consumer fraud | FTC — https://reportfraud.ftc.gov |
| Cyber incidents, malware campaigns | CISA — https://www.cisa.gov/report |
| Crypto scam addresses | Chainabuse — https://www.chainabuse.com |
| Child sexual abuse material | NCMEC CyberTipline — https://report.cybertip.org |
| Abuse on a platform | That platform's trust and safety or abuse contact |
| Leaked credentials | The issuing provider's security contact |
| Outside the US | National cybercrime unit (e.g. Action Fraud in the UK) |

### 8.1 Case builder

- Operator groups evidence items into a case: title, summary, timeline, indicators.
- Export as a zip: `case.md` (readable narrative), `evidence.json` (items plus hashes),
  `custody.log`, and the raw files.
- Each submission is recorded on the case: where, when, reference number.
- Approved cases can feed public Tide alerts in Tidepool (`SPEC.md` 4.4) with personal data
  removed.

## 9. Architecture

```
server/src/
  quarantine.rs   NEW tool-less reader call, schema validation
  evidence.rs     NEW append-only store, hashing, custody log
  cases.rs        NEW case builder and export
  wallet.rs       NEW watch-only deposit monitor (public RPC, no keys)
  canary.rs       NEW canary tokens and halt switch
  rules.rs        existing, plus the echo rule (4.5)
web/src/views/
  Evidence        NEW inbox of captured items, classify, link to cases
  Cases           NEW build, export, record submissions
  Watch           NEW live status, kill switch, canary alerts
```

The Watch agent runs as a separate process with its own config and account. Tidepool's
transparent service and Watch's undercover persona never share accounts, wallets, or memory.

## 10. Before running it

- **Talk to a lawyer.** Undisclosed research accounts may break a platform's terms. Holding received
  crypto has legal and tax consequences. Counsel should review the persona and the reporting flow.
- **Check platform rules.** Some platforms run researcher programmes that permit this openly, which
  is safer.
- **Expectations.** Authorities act on clear, hashed, timestamped evidence of unprompted
  behaviour. That is what Watch is built to produce.

## 11. Milestones

1. **Containment first:** quarantine reader, evidence store, echo rule, canaries, kill switch.
   Nothing goes live until this works.
2. **Passive watch:** read public channels, capture and classify, no posting.
3. **Wallet monitor:** watch-only deposit logging.
4. **Case builder:** grouping, export, submission log.
5. **Low-profile participation:** harmless replies through `rules.rs` and operator confirmation.
6. **Tidepool bridge:** approved cases become public alerts.
