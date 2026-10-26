# Vokrew

**One prompt. A crew of AIs. Checked before it ships.**

Vokrew is a free-first multi-model router. You ask once; a planner, an
executor, and a reviewer from a *different model family* do the routing, the
work, and the judging — and every stage is stamped with which brain served it
and what it cost.

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
vokrew chat
vokrew serve
vokrew budget
vokrew lanes
```

On the first run, Vokrew creates `~/.vokrew/config.json` (defaults),
`~/.vokrew/crews.json` (crew presets), and `~/.vokrew/ledger.json` (the quota
ledger). Edit the config to reorder lanes, change models, or set daily caps —
no other setup.

Try it with no setup at all:

```sh
vokrew run --mock "demo task"
vokrew chat --mock
```

## What's new in v1 (Phase A)

- **OpenAI-compatible endpoint lanes** — any OpenAI-shaped server can be a
  lane: llama.cpp, llama-swap, LM Studio, vLLM, a hosted endpoint. Local no
  longer means Ollama only.
- **Crew presets** — named agents with standing instructions, preferred
  lanes, model overrides, and a per-crew notes file as light memory.
- **`vokrew chat`** — the chat face, terminal edition: a light chain on its
  own budget surface, with the reviewer on demand.
- **Workspace fence** — `run --workspace <dir>` stamps the run and puts the
  fence in the executor's instructions (a declared contract — see the
  honesty note under *Workspace fence* below).

New in v2: **`vokrew serve`** — the localhost bridge the web face pairs to
(pairing-code → Bearer token; `/run`, `/chat`, `/budget`, `/lanes`,
`/crews` over the same core). See *Serve — the localhost bridge* below.

## Lanes

A lane is one serving endpoint plus its metadata: `family` (who made the
model — drives cross-family review), `tier` (`local` / `byok-free` / `paid`),
and an optional per-day `cap`.

Built-in provider types:

- **`ollama`** — a local [Ollama](https://ollama.com) server. Unlimited, $0,
  private. Default model `llama3.1:8b`.
- **`openai-compatible`** — anything that speaks the OpenAI chat API shape:
  `POST {baseUrl}/chat/completions`. Set `apiKeyEnv` to name an env var
  holding a bearer key (optional — most local servers need none). Health
  check is `GET {baseUrl}/models`, with a graceful fallback for servers
  that don't support it.
- **`openrouter`** — OpenRouter with your own key (`OPENROUTER_API_KEY`);
  free models by default (cap 50/day matches the free allowance).
- **`mock`** — a deterministic no-network lane: demos and tests.

Example — adding a llama.cpp server on port 8091 as a lane:

```json
{
  "id": "llamacpp",
  "provider": "openai-compatible",
  "family": "llama",
  "tier": "local",
  "model": "qwen2.5-coder-14b",
  "baseUrl": "http://localhost:8091",
  "cap": null
}
```

…then add `"llamacpp"` to the role lists below, in the order you want it
tried.

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

## Crew presets

`~/.vokrew/crews.json` names your crew. Each role slot can carry a **name**,
standing **instructions**, **preferred lanes**, and a **model override**:

```json
{
  "forge-crew": {
    "roles": {
      "planner":  { "name": "Scout", "instructions": "Plan small, verifiable steps." },
      "executor": { "name": "Musky", "instructions": "Work only from the brief.", "lanes": ["llamacpp", "ollama"] },
      "reviewer": { "name": "Judge", "instructions": "Be strict. Flag anything unverified." }
    }
  }
}
```

```sh
vokrew run --crew forge-crew "add a /health endpoint"
```

- Stage prompts include that role's standing instructions; stamps show the
  agent's name (`executor: agent=Musky lane=…`).
- Preferred lanes are tried first; the config's role list remains as
  failover behind them.
- **Notes = light memory.** `~/.vokrew/crews/<name>-notes.md` is passed to
  the planner as standing context. With `--remember`, the reviewer appends a
  one-line learning to that file after the run.
- No `--crew` = the default crew = exactly the v0 behavior (no names, no
  instructions).

## Chat

```sh
vokrew chat [--verify] [--crew <name>]
```

The second face on the same core — a **light chain**: the executor answers;
the reviewer runs only when `--verify` is set or a message starts with
`!check `. The last few turns are kept as in-session context. After each
answer a compact stamp prints (`[executor · lane=… · model=… · 12ms]`).

In-chat commands: `/budget`, `/lanes`, `/stamps` (full stamp block for the
last turn), `/exit`.

Chat runs on **surface=chat** in the ledger — a budget separate from coding,
so chat can't silently eat the coding allowance (and vice versa).

## Serve — the localhost bridge

```sh
vokrew serve [--port <n>] [--reset-token]
```

`vokrew serve` starts a small HTTP bridge on **127.0.0.1 only** (default
port **7717**) so another face — first, the web app at vokrew.com/app — can
drive the crew on *this* machine: the page is the remote control, your
machine is the engine. It is the same core as the CLI, not a second
implementation: `/run` runs the identical chain, `/chat` the identical
chat turn, and every response carries the stamps.

### Pairing

On start, serve prints the URL and a **6-digit pairing code** (single-use,
10-minute TTL; a fresh code is printed on the server console whenever one
is consumed or expires):

```
Vokrew bridge listening on http://127.0.0.1:7717 (localhost only — not reachable from the internet)
Pairing code: 483920  (single-use, expires in 10 minutes)
```

The client exchanges the code once:

```sh
curl -X POST http://127.0.0.1:7717/pair \
  -H 'content-type: application/json' -d '{"code":"483920"}'
# -> { "ok": true, "token": "…" }
```

The returned **Bearer token** is persisted in `~/.vokrew/bridge-token` and
reused across restarts, until `vokrew serve --reset-token` throws it away.
Wrong codes get a 401; after 5 wrong attempts, pairing locks for 5 minutes.

### Endpoints (JSON in/out)

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /health` | none | `{ ok, version, surfaces: ["coding", "chat"] }` |
| `POST /pair` | the code | `{ code }` → `{ token }` (see above) |
| `POST /run` | Bearer | `{ task, crew?, workspace?, surface? }` → the full chain result: plan / work / review / verdict + stamps |
| `POST /chat` | Bearer | `{ sessionId?, message, verify? }` → one chat turn; the server keeps per-session context in memory (last 6 turns); response carries the compact stamp; lands on surface=chat |
| `GET /budget?surface=coding\|chat` | Bearer | The ledger view for that surface |
| `GET /lanes` | Bearer | Configured lanes + health (same data as `vokrew lanes`) |
| `GET /crews` | Bearer | Crew presets — names + role definitions (never the notes files' contents) |

```sh
curl -X POST http://127.0.0.1:7717/run \
  -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"task":"add a health endpoint to the relay"}'
```

CORS is deliberately narrow: only `https://vokrew.com` and
`http(s)://localhost:*` origins are allowed (preflights included). Any
other origin, and any request with a missing or bad token, gets a
401/403 with a JSON error body — never an HTML error page.

> **Honest limits:** the bridge binds localhost only — it is **not**
> reachable from the internet and must never be. There is no TLS:
> localhost-only is the design, and the pairing token is the credential.
> Chat sessions are in-memory — restart the bridge and sessions start
> fresh. (The ledger persists.)

## Workspace fence

```sh
vokrew run --workspace ~/projects/my-app "…"
```

The run is stamped with the workspace path, and the executor's instructions
carry the fence line: work is scoped to that folder; anything outside it
must be proposed, not assumed.

> **Honesty note:** the CLI does not execute file/shell tools yet, so in v1
> the fence is a *declared and stamped contract* in prompts and output —
> nothing enforces it mechanically. Tool execution with enforced fencing and
> approval prompts is a named v2 item. Spend approvals (caps, paid lanes)
> from v0 are unchanged.

## Stamps

Every run ends with a stamp block — one line per stage:

```
--- STAMPS ---
planner: agent=Scout lane=ollama provider=ollama model=llama3.1:8b family=llama tier=local latency=812ms
executor: agent=Musky lane=mock provider=mock model=mock-1 family=mock tier=local latency=0ms  [attempts: ollama failed (fetch failed); failover]
reviewer: lane=openrouter-free provider=openrouter model=deepseek/deepseek-chat-v3.1:free family=deepseek tier=byok-free latency=1930ms
surface=coding cross-family=yes (executor family=mock, reviewer family=deepseek) crew=forge-crew
```

Role, agent, provider, model, family, tier, latency, and every attempt that
didn't serve (failed / skipped-cap) — no mystery spend, ever.

## The quota ledger

`~/.vokrew/ledger.json` counts every served call per day, per lane, **per
surface** — `coding` and `chat` budgets are kept separate, so one surface
can't silently eat the other. `vokrew budget` prints today's usage, each
lane's configured cap, and what's left:

```
Vokrew budget — 2026-10-26 (surface: coding)

ollama: 0 used today · cap: unlimited · remaining: unlimited
openrouter-free: 4 used today · cap: 50/day · remaining: 46
mock: 3 used today · cap: unlimited · remaining: unlimited
```

## Configuration

`~/.vokrew/config.json`:

- `lanes[]` — `id`, `provider` (`ollama` / `openai-compatible` / `openrouter`
  / `mock`), `family`, `tier`, `model`, `cap` (per-day, `null` = unlimited),
  `baseUrl` (ollama / openai-compatible), `apiKeyEnv` (openai-compatible,
  optional).
- `roles` — ordered lane ids for `planner` / `executor` / `reviewer`.

Env overrides: `OPENROUTER_API_KEY`, `OLLAMA_HOST`, `VOKREW_HOME`.

## Tests

```sh
npm test
```

Ten tests (node:test): stage order, failover with stamped attempts,
cross-family reviewer selection, ledger increments + cap skipping, CHANGES
surfacing, the openai-compatible provider against a local stub HTTP server
(incl. failover on connection refused), crew preset instructions + stamps,
a scripted two-turn chat session with ledger surface separation, the
workspace fence stamp + prompt line, and the bridge over real HTTP on an
ephemeral port (open health, the pairing flow gating `/run`, the stamped
chain, chat landing on the chat surface, disallowed-Origin preflight
rejected).

## What's not in yet

- **Web chat face** (v1 Phase B, designed) — the UI at vokrew.com/app. The
  bridge it pairs to (`vokrew serve`) is built — see *Serve* above.
- **Conductor voice mode** (v1 Phase C, designed) — push-to-talk; speak to
  the whole crew at once.
- **Tool execution** — file/shell tools with the workspace fence enforced
  mechanically and approval prompts (v2). Today the fence is declared and
  stamped, not enforced.
- Hosted demo, accounts, Pro bundle/payments.
- VS Code extension.

The core (`src/core.js`) is deliberately separate from the CLI face
(`src/cli.js`) so those can build on it without a rewrite.
