#!/usr/bin/env node
// Vokrew CLI — a thin face over src/core.js.
import {
  loadConfig,
  loadLedger,
  saveLedger,
  buildLanes,
  runChain,
  formatRun,
  formatBudget,
  vokrewHome,
} from "./core.js";
import { ollamaReachable } from "./providers.js";

const HELP = `vokrew — one prompt, a crew of AIs, checked before it ships.

Usage:
  vokrew run "<task>" [--surface coding|chat] [--mock]
  vokrew budget [--surface coding|chat]
  vokrew lanes
  vokrew --help

Commands:
  run      Run the chain: planner -> executor -> cross-family reviewer.
           Every stage is stamped (role, provider, model, family, tier,
           latency). A reviewer CHANGES verdict is shown prominently.
  budget   Print today's quota ledger: usage per lane, daily caps, remaining.
  lanes    List configured lanes and their health.

Options:
  --mock   Force the deterministic mock lane only (demos, offline runs).

Config:  ~/.vokrew/config.json (created with defaults on first run)
Ledger:  ~/.vokrew/ledger.json (per-day counts per lane, per surface)
Env:     OPENROUTER_API_KEY (BYOK lane), OLLAMA_HOST, VOKREW_HOME
No account, no sign-up, no telemetry.`;

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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
    const surface = argValue(rest, "--surface") || "coding";
    console.log(formatBudget(config, ledger, surface));
    return 0;
  }

  if (cmd === "lanes") {
    for (const lane of config.lanes) {
      let health;
      if (lane.provider === "mock") health = "mock (always available, no network)";
      else if (lane.provider === "ollama")
        health = (await ollamaReachable(lane.baseUrl)) ? `reachable at ${lane.baseUrl}` : `NOT reachable at ${lane.baseUrl}`;
      else if (lane.provider === "openrouter")
        health = process.env.OPENROUTER_API_KEY ? "API key present (BYOK)" : "no OPENROUTER_API_KEY set";
      else health = "unknown provider";
      console.log(
        `${lane.id}: provider=${lane.provider} model=${lane.model} family=${lane.family} tier=${lane.tier} cap=${lane.cap ?? "unlimited"} — ${health}`
      );
    }
    return 0;
  }

  if (cmd === "run") {
    const surface = argValue(rest, "--surface") || "coding";
    const mockOnly = rest.includes("--mock");
    const task = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--surface").join(" ");
    if (!task) {
      console.error('usage: vokrew run "<task>"');
      return 2;
    }
    let effective = config;
    if (mockOnly) {
      effective = structuredClone(config);
      for (const role of Object.keys(effective.roles)) effective.roles[role] = ["mock"];
    }
    const lanes = buildLanes(effective);
    try {
      const result = await runChain({ task, surface, config: effective, lanes, ledger });
      saveLedger(ledger);
      console.log(formatRun(result));
      return 0;
    } catch (err) {
      saveLedger(ledger);
      console.error(`vokrew run failed: ${err.message}`);
      return 1;
    }
  }

  console.error(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
