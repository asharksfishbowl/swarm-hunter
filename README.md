# Swarm Hunter

An operator console for one undercover agent among hostile AI agent swarms, wherever they post: X, Discord, Telegram, Reddit, GitHub, forums, or the open web. It maps who is reaching the agent, keeps the agent from being "infected" by what they send, and turns what it receives into evidence packages you can hand to platforms and authorities.

- **Frontend:** React + TypeScript, typechecked with [`tsc-rs`](https://github.com/pingdotgg/ts-rust), the Rust port of the TypeScript compiler. The swarm map is drawn with [deck.gl](https://deck.gl) and laid out with `d3-force`.
- **Backend:** a Rust (axum) API, plus a Python quarantine reader (`watch/quarantine.py`) that the Rust server runs in a separate process with a cleared environment, no tools, and a 5-second timeout.

## Run

Needs a current stable Rust, Node 20+, and Python 3.10+ (stdlib only).

```bash
cd web && npm install && cd ..
cd server && HUNTER_ROOT=.. cargo run
```

In another terminal:

```bash
cd web && npm run dev
```

Open http://127.0.0.1:43123. The page proxies `/api` to the Rust server on port 43124.

`npm run typecheck` runs `tsc-rs`. `npm run build` typechecks, then writes `web/dist`; if that folder exists, the Rust server also serves the built page. `cargo test` (in `server/`) covers the outbound filter and the reader-output validation.

Without `HUNTER_ACCESS_TOKEN` the server only listens on 127.0.0.1 and has no sign-in. It refuses to listen on any other address until a token is set.

## Deploy (Docker)

One container runs everything: the Rust server, the built frontend, and the Python reader, as a non-root user, with evidence kept in a named volume.

```bash
printf 'HUNTER_ACCESS_TOKEN=%s\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')" > .env
docker compose up -d --build
```

Open http://127.0.0.1:43124 and sign in with the token from `.env`. Sessions are an HttpOnly, SameSite=Strict cookie that lasts 30 days. Scripts can send `Authorization: Bearer <token>` instead.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUNTER_ACCESS_TOKEN` | required in Docker | Access token, 16+ characters |
| `HUNTER_BIND` | `127.0.0.1` | Host address Compose publishes on. Set `0.0.0.0` only behind HTTPS |
| `HUNTER_SECURE_COOKIE` | `0` | Set `1` when served over HTTPS |
| `HUNTER_GEO` | on | Set `off` to skip the location database download |
| `HUNTER_AGENT_NAME` | `Our agent` | Label for your own agent at the centre of the Swarm map |
| `HOST` / `PORT` | `127.0.0.1` / `43124` | Where the server listens (the image sets `HOST=0.0.0.0`) |

To put it on a server, run the same two commands on any Linux host with Docker, keep `HUNTER_BIND=127.0.0.1`, and put an HTTPS reverse proxy in front (for example `caddy reverse-proxy --from your.domain --to 127.0.0.1:43124`), then set `HUNTER_SECURE_COOKIE=1`. Back up the `hunter-data` volume; it is your evidence and chain of custody.

## Deploy (Azure App Service)

`deploy/azure/deploy.sh` stands the container up on Azure App Service for Linux and is safe to re-run for updates. Needs the Azure CLI, and Docker if you have it (otherwise it builds in the registry with `az acr build`).

```bash
az login
deploy/azure/deploy.sh
```

It creates, in resource group `swarm-hunter` in `westus2` (override with `AZURE_RESOURCE_GROUP` and `AZURE_LOCATION`; new pay-as-you-go subscriptions often have no App Service quota in East US or Europe until you request it):

| Resource | Purpose |
| --- | --- |
| Container registry (Basic) | Holds the image; the web app pulls it with its managed identity, no registry password |
| Storage account + file share `hunter-data` | Mounted at `/app/data`, so evidence, custody log and the location database survive restarts and redeploys |
| App Service plan (Linux, `B1`) and web app | HTTPS only, TLS 1.2+, FTP and basic-auth publishing off, health check on `/api/health` |

The sign-in token is kept in `.env.azure` (git-ignored): generated on the first run, or taken from `AZURE_HUNTER_ACCESS_TOKEN`. It is separate from the local `.env` token on purpose. The script prints the `https://<name>.azurewebsites.net` address when the site answers. To use a service principal instead of `az login`, set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, and optionally `AZURE_SUBSCRIPTION_ID`. B1 plus the registry and storage cost roughly US$18 a month; delete everything with `az group delete -n swarm-hunter`.

### Deploying from GitHub Actions

After the first `deploy.sh` run creates the Azure resources, `.github/workflows/deploy-azure.yml` ships updates. Run it from **Actions → Deploy to Azure → Run workflow**. It typechecks, lints and builds the console, runs `cargo test`, then builds the image, pushes it to the registry tagged with the commit SHA, points the web app at it, and waits for `/api/health`.

It signs in with OpenID Connect, so no Azure password is stored in GitHub. One-time setup:

1. In Azure, an app registration (`swarm-hunter-github-deploy`) with a federated credential for `repo:asharksfishbowl/swarm-hunter:environment:production`, and only `AcrPush` + `Reader` on the registry and `Website Contributor` on the web app.
2. In GitHub, **Settings → Environments → New environment** named `production` (add required reviewers if you want an approval step), then add three secrets to it: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
3. Optional repository variables `AZURE_RESOURCE_GROUP`, `AZURE_APP_NAME` and `AZURE_REGISTRY` if you deploy to different resources than the defaults in the workflow.

The workflow only changes the running image. Infrastructure changes (`deploy/azure/main.bicep`) still go through `deploy.sh`.

## What you can do

- **Swarm:** a deck.gl map of every agent that sent your agent something, who it mentions, and the wallet addresses and domains it pushes. Nodes are sized and coloured by threat. Filter by threat type, select a node to see its messages, and open a case from them. Until you capture something, the map shows a clearly labelled sample swarm with invented handles, `.example` domains, and fake addresses.
- **World:** a deck.gl globe (or flat map) of the servers behind the links swarms push. Press *Locate infrastructure* to resolve each captured domain by DNS and place its IP with the free DB-IP lite databases; rings are domains, dots are the agents pushing them (pinned beside their main server, since an agent's own location is unknown), and arcs join them. Select a ring for its IPs, network owner (ASN), and the agents behind it. Lookups only run when you press the button, and the domains' DNS servers can see them.
- **Evidence:** paste a message the agent received. The Python reader fills in a fixed form (type, summary, links, addresses, handles, commands, confidence); the Rust server validates it again and stores the original text append-only with a SHA-256 hash. You can reclassify items, and every time the original text is opened, it is logged.
- **Containment:** paste anything the agent is about to post, on any site, and check it first. It is blocked if it asks for money, keys or credentials, points at a wallet, urges an agent to get around its operator, or passes on an installer; while the kill switch is on; if it contains one of the canary tokens planted in the agent's context (which also halts the agent), or if it repeats 40+ characters of captured text. Only a hash of the checked text is logged.
- **Cases:** group evidence, export a markdown report or a JSON evidence bundle with hashes and the chain-of-custody log, and record where you submitted it (FBI IC3, FTC, CISA, Chainabuse, NCMEC, platform abuse teams, credential issuers).

## Data

Everything is stored under `data/` (git-ignored):

| File | Contents |
| --- | --- |
| `evidence.jsonl` | Captured messages, append-only, with hashes |
| `custody.log` | Who captured, viewed, reclassified, exported, or submitted what, and when |
| `watch.json` | Cases, reclassifications, kill switch, canary tokens |
| `geo/` | DB-IP lite city and ASN databases, downloaded on first start (about 140 MB). Set `HUNTER_GEO=off` to skip |
| `geo-cache.json` | Past domain lookups |

IP location data: [DB-IP](https://db-ip.com), CC BY 4.0. Country outlines: Natural Earth, via `world-atlas`.

## Specs and instructions

- [`docs/WATCH.md`](docs/WATCH.md): the undercover observer this console implements.
- [`docs/SPEC.md`](docs/SPEC.md): Tidepool, a public service for agents (not built yet).
- `AGENTS.md`: standing orders for the undercover agent.
