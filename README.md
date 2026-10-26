# Vokrew

**One prompt. A crew of AIs. Checked before it ships.**

Vokrew is a free-first multi-model router for coding work. You ask once; a
planner, an executor, and a reviewer from a *different model family* do the
routing, the work, and the judging — and every stage is stamped with which
brain served it and what it cost.

No account, no sign-up, no telemetry. Your keys stay yours; your local models
are first-class.

## Install

Requires Node.js ≥ 18. Zero runtime dependencies.

```sh
git clone https://github.com/vokrew/vokrew.git
cd vokrew
npm link        # puts `vokrew` on your PATH
# …or just run it in place: node src/cli.js --help
```

## Quickstart

```sh
vokrew run "add a retry with backoff to the fetch helper"
vokrew budget
vokrew lanes
```

On the first run, Vokrew creates `~/.vokrew/config.json` (defaults) and
`~/.vokrew/ledger.json` (the quota ledger). Edit the config to reorder lanes,
change models, or set daily caps — no other setup.

Two lanes work out of the box:

- **Ollama (local)** — if you run [Ollama](https://ollama.com) locally, it's
  the first lane tried: unlimited, $0, private. Default model
  `llama3.1:8b` (set your own in config).
- **OpenRouter (BYOK)** — set `OPENROUTER_API_KEY` to your own key and the
  free models become a lane (default cap 50/day, matching OpenRouter's free
  allowance).
- **Mock** — a deterministic no-network lane, always last: demos and tests.

Try it with no setup at all:

```sh
vokrew run --mock "demo task"
```

## How routing works

Each role — **planner**, **executor**, **reviewer** — has an ordered lane
list in the config, free-first. For `vokrew run "<task>"`:

1. The planner lane writes a short plan.
2. The executor lane does the work, following the plan.
3. The reviewer lane judges it: **APPROVED** or **CHANGES**, with notes.

Rules the router enforces:

- **Failover** — if a lane errors (host down, no key, HTTP error), the next
  lane for that role serves instead, and the failure is recorded in the stamp.
- **Cross-family review** — the reviewer prefers a lane from a *different
  model family* than the executor that produced the work, whenever such a
  lane is available. A model never grades its own homework when an
  alternative exists.
- **Caps** — a lane at its daily cap is skipped, and the skip is stamped.
- **CHANGES is never hidden** — if the reviewer says CHANGES, the output
  leads with a prominent banner. Vokrew never auto-overrides a reviewer.

## Stamps

Every run ends with a stamp block — one line per stage:

```
--- STAMPS ---
planner: lane=ollama provider=ollama model=llama3.1:8b family=llama tier=local latency=812ms
executor: lane=mock provider=mock model=mock-1 family=mock tier=local latency=0ms  [attempts: ollama failed (fetch failed); failover]
reviewer: lane=openrouter-free provider=openrouter model=deepseek/deepseek-chat-v3.1:free family=deepseek tier=byok-free latency=1930ms
surface=coding cross-family=yes (executor family=mock, reviewer family=deepseek)
```

Role, provider, model, family, tier, latency, and every attempt that didn't
serve (failed / skipped-cap) — no mystery spend, ever.

## The quota ledger

`~/.vokrew/ledger.json` counts every served call per day, per lane, **per
surface** — `coding` and `chat` budgets are kept separate from day one, so
one surface can't silently eat the other. `vokrew budget` prints today's
usage, each lane's configured cap, and what's left:

```
Vokrew budget — 2026-10-26 (surface: coding)

ollama: 0 used today · cap: unlimited · remaining: unlimited
openrouter-free: 4 used today · cap: 50/day · remaining: 46
mock: 3 used today · cap: unlimited · remaining: unlimited
```

## Configuration

`~/.vokrew/config.json`:

- `lanes[]` — `id`, `provider` (`ollama` / `openrouter` / `mock`), `family`,
  `tier` (`local` / `byok-free` / `paid`), `model`, `cap` (per-day, `null` =
  unlimited), `baseUrl` (Ollama).
- `roles` — ordered lane ids for `planner` / `executor` / `reviewer`.

Env overrides: `OPENROUTER_API_KEY`, `OLLAMA_HOST`, `VOKREW_HOME`.

## Tests

```sh
npm test
```

Five tests (node:test, mock + deliberately failing providers): stage order,
failover with stamped attempts, cross-family reviewer selection, ledger
increments + cap skipping, and CHANGES surfacing.

## What's not in v0

- Chat face (web) — planned next, on this same core, with its own budget
  surface (the ledger already keeps it separate).
- Conductor voice mode — speak to the whole crew at once.
- Hosted demo, accounts, Pro bundle/payments.
- VS Code extension.

The core (`src/core.js`) is deliberately separate from the CLI face
(`src/cli.js`) so those can build on it without a rewrite.
