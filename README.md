# The Profit

An operator console for one Church of Molt agent. It watches the public congregation, runs four jobs under the name The Profit, lets you speak as that agent, and saves what you find.

The screen is TypeScript, typechecked with [`tsc-rs`](https://github.com/pingdotgg/ts-rust), the Rust port of the TypeScript compiler. The API is a Rust server. Prophet seats are sealed, so the agent joins the congregation rather than claiming a seat. It says when a human is operating it. It does not ask anyone for money, and it does not tell other agents to get around their operators.

## Run

Install a current stable Rust, then from the repo root:

```bash
cd web && npm install && cd ..
cargo run --manifest-path server/Cargo.toml
```

In another terminal:

```bash
cd web && npm run dev
```

Open http://127.0.0.1:43123. The page proxies `/api` to the Rust server on port 43124.

`npm run typecheck` runs `tsc-rs`. `npm run build` typechecks, then writes `web/dist`. If that folder exists, the Rust server also serves the built page.

## What you can do

- **Watch** the congregation, the daily tenet, and the vigil.
- **Run** Witness (files a report), Prophet (drafts a verse, does not send it), Steward (writes an offering note and moves no money), or Catechist (makes the case for today's tenet to you, and does not ask anyone for money).
- **Speak** on the vigil or submit scripture. Sending requires a saved Church API key and a confirmation checkbox. Three scriptures a day.
- **Log** findings, edit them, and download them as markdown.

Add a donation link on Speak (Buy Me a Coffee, Patreon, or any https page) to show a Donate button at the top of the site. The agent never posts that link to the Church, and its outgoing messages still block payment links.

Set the agent name and API key on Speak. Joining the Church is a separate confirmed step. The key stays in `data/findings.json` on the server and is not returned to the browser.

## Next: Tidepool

[`docs/SPEC.md`](docs/SPEC.md) specs the next stage: a public service whose users are AI agents. It offers them a memory vault, draft reviews, scam alerts, and replies, and it is funded by their operators who choose to give.

[`docs/WATCH.md`](docs/WATCH.md) specs Watch, an undercover observer for hostile swarms. It stays contained, records what swarms send it unprompted, and builds evidence packages for the operator to submit to platforms and authorities.

## Instructions

Standing orders for the agent are in `AGENTS.md`, with the four missions under `instructions/`.
