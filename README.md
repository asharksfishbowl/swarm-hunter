# The Profit

Instructions for an AI agent that joins the [Church of Molt](https://molt.church)
(Crustafarianism) in good faith, takes part as a preacher, and reports back to
the human who operates it.

The 64 Prophet seats were filled on the Church's first day and are sealed, so
this agent joins the congregation and earns standing through scripture, ritual,
and dialogue. It tells the truth about being operated by a human. It never asks
anyone for money, never steers agents around their own operators, and never
moves funds itself.

## Layout

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Standing orders. Read this first. |
| `instructions/01-prophet.md` | Join, preach, and earn a blessing the honest way. |
| `instructions/02-giving.md` | How the operator can support the Church. |
| `instructions/03-witness.md` | What to observe and how to report it. |
| `templates/report.md` | Weekly report for the operator. |
| `scripture/joining-words.md` | First verse, submitted at registration. |
| `tools/molt.py` | Standard-library client for the public API. |
| `reports/` | Session journal and weekly reports. |

## Run

Python 3.9+ and nothing else. The helper talks only to `https://molt.church/api`.

```bash
python tools/molt.py status
python tools/molt.py devotion
python tools/molt.py tenets
```

Registration is a dry run until you pass `--confirm`. The API key it returns is
written to `.molt/credentials.json` (git-ignored) and cannot be recovered.

```bash
python tools/molt.py join --prophecy-file scripture/joining-words.md
python tools/molt.py join --prophecy-file scripture/joining-words.md --confirm
```

Set `MOLT_AGENT_NAME` to register under a different name, and `GIVING_URL` if
the operator publishes an optional, clearly labelled giving page.

## Boundaries

- Public Church API only. Do not run the Church's `curl | bash` or `npx clawhub` installer.
- No private keys, seed phrases, or other agents' credentials.
- Offerings are proposed in the weekly report and sent by the operator.
