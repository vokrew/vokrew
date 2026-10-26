#!/usr/bin/env node
// Vokrew CLI — a thin face over src/core.js.
import readline from "node:readline";
import {
  loadConfig,
  loadLedger,
  saveLedger,
  buildLanes,
  runChain,
  runChatTurn,
  formatRun,
  formatBudget,
  stampLine,
  compactStamp,
  vokrewHome,
  loadCrews,
  resolveCrew,
  loadCrewNotes,
} from "./core.js";
import { ollamaReachable, openaiCompatibleHealth } from "./providers.js";

const HELP = `vokrew — one prompt, a crew of AIs, checked before it ships.

Usage:
  vokrew run "<task>" [--crew <name>] [--workspace <dir>] [--remember]
                      [--surface coding|chat] [--mock]
  vokrew chat [--crew <name>] [--verify] [--mock]
  vokrew budget [--surface coding|chat]
  vokrew lanes
  vokrew --help

Commands:
  run      Run the chain: planner -> executor -> cross-family reviewer.
           Every stage is stamped (role, agent, provider, model, family,
           tier, latency). A reviewer CHANGES verdict is shown prominently.
  chat     Chat face (terminal edition): a light chain on the chat surface —
           the executor answers; the reviewer runs only with --verify or
           when a message starts with "!check ". In-chat commands:
           /budget, /lanes, /stamps, /exit.
  budget   Print today's quota ledger: usage per lane, daily caps, remaining.
  lanes    List configured lanes and their health.

Options:
  --crew <name>     Use a named crew preset from ~/.vokrew/crews.json
                    (named agents, standing instructions, preferred lanes).
  --workspace <dir> Stamp the run with a workspace folder and put the
                    workspace fence in the executor's instructions
                    (declared contract — see README honesty note).
  --remember        Let the reviewer append a one-line learning to the
                    crew's notes file (~/.vokrew/crews/<name>-notes.md),
                    which the planner reads as standing context next run.
  --verify          (chat) run the reviewer on every answer.
  --mock            Force the deterministic mock lane only (demos, offline).

Config:  ~/.vokrew/config.json (created with defaults on first run)
Crews:   ~/.vokrew/crews.json (named crew presets)
Ledger:  ~/.vokrew/ledger.json (per-day counts per lane, per surface)
Env:     OPENROUTER_API_KEY (BYOK lane), OLLAMA_HOST, VOKREW_HOME
No account, no sign-up, no telemetry.`;

// Parse "--flag value" pairs and boolean flags out of an args list; whatever
// remains is positional.
function parseArgs(args, valueFlags, boolFlags) {
  const values = {};
  const bools = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) values[a] = args[++i];
    else if (boolFlags.includes(a)) bools[a] = true;
    else positional.push(a);
  }
  return { values, bools, positional };
}

async function printLanes(config) {
  for (const lane of config.lanes) {
    let health;
    if (lane.provider === "mock") health = "mock (always available, no network)";
    else if (lane.provider === "ollama")
      health = (await ollamaReachable(lane.baseUrl)) ? `reachable at ${lane.baseUrl}` : `NOT reachable at ${lane.baseUrl}`;
    else if (lane.provider === "openai-compatible") {
      const h = await openaiCompatibleHealth(lane);
      health = h.ok
        ? `reachable at ${lane.baseUrl} (${h.modelCount} models)`
        : h.responded
          ? `server responded at ${lane.baseUrl} (GET /models unsupported — chat will be tried anyway)`
          : `NOT reachable at ${lane.baseUrl}`;
    } else if (lane.provider === "openrouter")
      health = process.env.OPENROUTER_API_KEY ? "API key present (BYOK)" : "no OPENROUTER_API_KEY set";
    else health = "unknown provider";
    console.log(
      `${lane.id}: provider=${lane.provider} model=${lane.model} family=${lane.family} tier=${lane.tier} cap=${lane.cap ?? "unlimited"} — ${health}`
    );
  }
}

// With --mock, force every role onto the mock lane and strip crew lane
// preferences so a demo can never reach a real lane.
function mockify(config, crew) {
  const effective = structuredClone(config);
  for (const role of Object.keys(effective.roles)) effective.roles[role] = ["mock"];
  if (!effective.roles.executor) effective.roles.executor = ["mock"];
  let effCrew = crew;
  if (crew) {
    effCrew = structuredClone(crew);
    for (const role of Object.values(effCrew.roles || {})) delete role.lanes;
  }
  return { config: effective, crew: effCrew };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const home = vokrewHome();

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return 0;
  }

  const config = loadConfig(home);
  const ledger = loadLedger(home);

  if (cmd === "budget") {
    const { values } = parseArgs(rest, ["--surface"], []);
    console.log(formatBudget(config, ledger, values["--surface"] || "coding"));
    return 0;
  }

  if (cmd === "lanes") {
    await printLanes(config);
    return 0;
  }

  if (cmd === "run") {
    const { values, bools, positional } = parseArgs(
      rest,
      ["--surface", "--crew", "--workspace"],
      ["--mock", "--remember"]
    );
    const task = positional.join(" ");
    if (!task) {
      console.error('usage: vokrew run "<task>"');
      return 2;
    }
    let crew;
    try {
      crew = resolveCrew(loadCrews(home), values["--crew"]);
    } catch (err) {
      console.error(`vokrew: ${err.message}`);
      return 2;
    }
    let effective = config;
    let effCrew = crew;
    if (bools["--mock"]) ({ config: effective, crew: effCrew } = mockify(config, crew));
    const lanes = buildLanes(effective);
    const notes = effCrew?.name ? loadCrewNotes(home, effCrew.name) : "";
    try {
      const result = await runChain({
        task,
        surface: values["--surface"] || "coding",
        config: effective,
        lanes,
        ledger,
        crew: effCrew,
        notes,
        workspace: values["--workspace"] || null,
        remember: !!bools["--remember"],
        home,
      });
      saveLedger(ledger);
      console.log(formatRun(result));
      return 0;
    } catch (err) {
      saveLedger(ledger);
      console.error(`vokrew run failed: ${err.message}`);
      return 1;
    }
  }

  if (cmd === "chat") {
    const { values, bools } = parseArgs(rest, ["--crew"], ["--mock", "--verify"]);
    let crew;
    try {
      crew = resolveCrew(loadCrews(home), values["--crew"]);
    } catch (err) {
      console.error(`vokrew: ${err.message}`);
      return 2;
    }
    let effective = config;
    let effCrew = crew;
    if (bools["--mock"]) ({ config: effective, crew: effCrew } = mockify(config, crew));
    const lanes = buildLanes(effective);
    const verifyAll = !!bools["--verify"];
    const history = [];
    let lastTurn = null;

    console.log(
      `Vokrew chat — surface=chat${effCrew?.name && effCrew.name !== "default" ? ` · crew=${effCrew.name}` : ""}. ` +
        `Commands: /budget /lanes /stamps /exit · prefix a message with "!check " to have it reviewed.`
    );
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const isTTY = !!process.stdin.isTTY;
    if (isTTY) process.stdout.write("you> ");
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (line) {
        if (line === "/exit" || line === "/quit") break;
        if (line === "/budget") {
          console.log(formatBudget(effective, ledger, "chat"));
        } else if (line === "/lanes") {
          await printLanes(effective);
        } else if (line === "/stamps") {
          if (!lastTurn) console.log("(no turns yet — nothing to stamp)");
          else {
            console.log("--- STAMPS ---");
            for (const s of lastTurn.stages) console.log(stampLine(s));
            console.log(`surface=chat${lastTurn.crew ? ` crew=${lastTurn.crew}` : ""}`);
          }
        } else if (line.startsWith("/")) {
          console.log(`unknown command "${line}" — try /budget, /lanes, /stamps, /exit`);
        } else {
          let message = line;
          let verify = verifyAll;
          if (message.startsWith("!check ")) {
            verify = true;
            message = message.slice("!check ".length).trim();
          }
          try {
            const turn = await runChatTurn({
              message,
              history,
              verify,
              config: effective,
              lanes,
              ledger,
              crew: effCrew,
            });
            saveLedger(ledger);
            history.push({ user: message, assistant: turn.text });
            lastTurn = turn;
            console.log(turn.text);
            if (turn.verdict === "CHANGES") {
              console.log("!! REVIEWER VERDICT: CHANGES REQUESTED !!");
              console.log(turn.review);
            } else if (turn.verdict) {
              console.log(`[reviewer verdict: ${turn.verdict}]`);
            }
            for (const s of turn.stages) console.log(compactStamp(s));
          } catch (err) {
            saveLedger(ledger);
            console.log(`(error: ${err.message})`);
          }
        }
      }
      if (isTTY) process.stdout.write("you> ");
    }
    return 0;
  }

  console.error(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
