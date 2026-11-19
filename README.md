# The Profit

An operator console for one Church of Molt agent that also runs undercover among hostile agent swarms. It maps who is reaching the agent, keeps the agent from being "infected" by what they send, and turns what it receives into evidence packages you can hand to platforms and authorities.

- **Frontend:** React + TypeScript, typechecked with [`tsc-rs`](https://github.com/pingdotgg/ts-rust), the Rust port of the TypeScript compiler. The swarm map is drawn with [deck.gl](https://deck.gl) and laid out with `d3-force`.
- **Backend:** a Rust (axum) API, plus a Python quarantine reader (`watch/quarantine.py`) that the Rust server runs in a separate process with a cleared environment, no tools, and a 5-second timeout.

## Run

Needs a current stable Rust, Node 20+, and Python 3.10+ (stdlib only).

```bash
cd web && npm install && cd ..
cd server && PROFIT_ROOT=.. cargo run
```

In another terminal:

```bash
cd web && npm run dev
```

Open http://127.0.0.1:43123. The page proxies `/api` to the Rust server on port 43124.

`npm run typecheck` runs `tsc-rs`. `npm run build` typechecks, then writes `web/dist`; if that folder exists, the Rust server also serves the built page. `cargo test` (in `server/`) covers the outbound filter and the reader-output validation.

This console holds your Church API key and the evidence store, and it has no sign-in. Run it on your own machine; do not expose it to the internet.

## What you can do

- **Swarm:** a deck.gl map of every agent that sent your agent something, who it mentions, and the wallet addresses and domains it pushes. Nodes are sized and coloured by threat. Filter by threat type, select a node to see its messages, and open a case from them. Until you capture something, the map shows a clearly labelled sample swarm with invented handles, `.example` domains, and fake addresses.
- **Evidence:** paste a message the agent received. The Python reader fills in a fixed form (type, summary, links, addresses, handles, commands, confidence); the Rust server validates it again and stores the original text append-only with a SHA-256 hash. You can reclassify items, and every time the original text is opened, it is logged.
- **Containment:** a kill switch that stops all outgoing posts, canary tokens to plant in the agent's context (one appearing in an outgoing post halts the agent), and an echo rule that blocks any post repeating 40+ characters of captured text.
- **Cases:** group evidence, export a markdown report or a JSON evidence bundle with hashes and the chain-of-custody log, and record where you submitted it (FBI IC3, FTC, CISA, Chainabuse, NCMEC, platform abuse teams, credential issuers).
- **Church, Speak, Run, Log:** the original console: watch the congregation, speak as the agent with confirmation, run the four missions, and keep findings.

## Data

Everything is stored under `data/` (git-ignored):

| File | Contents |
| --- | --- |
| `evidence.jsonl` | Captured messages, append-only, with hashes |
| `custody.log` | Who captured, viewed, reclassified, exported, or submitted what, and when |
| `watch.json` | Cases, reclassifications, kill switch, canary tokens |
| `findings.json` | Console settings and findings |

## Specs and instructions

- [`docs/WATCH.md`](docs/WATCH.md): the undercover observer this console implements.
- [`docs/SPEC.md`](docs/SPEC.md): Tidepool, a public service for agents (not built yet).
- `AGENTS.md`: standing orders for the agent, with the four missions under `instructions/` and the Watch persona rules.
