// Vokrew core: config, quota ledger, role router, and the plan -> work ->
// review chain. The CLI (cli.js) is a thin face over this module; later faces
// (chat UI, voice) build on the same core.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLanes } from "./providers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  lanes: [
    {
      id: "ollama",
      provider: "ollama",
      family: "llama",
      tier: "local",
      model: "llama3.1:8b",
      baseUrl: "http://localhost:11434",
      cap: null, // null = unlimited
    },
    {
      id: "openrouter-free",
      provider: "openrouter",
      family: "deepseek",
      tier: "byok-free",
      model: "deepseek/deepseek-chat-v3.1:free",
      cap: 50, // OpenRouter free accounts: ~50 req/day
    },
    {
      id: "mock",
      provider: "mock",
      family: "mock",
      tier: "local",
      model: "mock-1",
      cap: null,
    },
  ],
  // Free-first order per role. The reviewer list is additionally re-sorted at
  // run time so a different family than the executor's goes first.
  roles: {
    planner: ["ollama", "openrouter-free", "mock"],
    executor: ["ollama", "openrouter-free", "mock"],
    reviewer: ["openrouter-free", "ollama", "mock"],
  },
};

export function vokrewHome(env = process.env) {
  return env.VOKREW_HOME || path.join(os.homedir(), ".vokrew");
}

export function loadConfig(home = vokrewHome()) {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "config.json");
  let config;
  if (fs.existsSync(file)) {
    config = { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } else {
    config = structuredClone(DEFAULT_CONFIG);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  }
  // Env overrides (never persisted back over the user's file on load).
  const ollama = config.lanes.find((l) => l.provider === "ollama");
  if (ollama && process.env.OLLAMA_HOST) {
    ollama.baseUrl = process.env.OLLAMA_HOST.startsWith("http")
      ? process.env.OLLAMA_HOST
      : `http://${process.env.OLLAMA_HOST}`;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Quota ledger: per-day counts per lane, per surface (coding / chat kept
// separate from day one even though v0 ships the coding surface only).
// ---------------------------------------------------------------------------

export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function loadLedger(home = vokrewHome()) {
  const file = path.join(home, "ledger.json");
  if (fs.existsSync(file)) {
    try {
      return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { file, data: { days: {} } };
    }
  }
  return { file, data: { days: {} } };
}

export function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
  fs.writeFileSync(ledger.file, JSON.stringify(ledger.data, null, 2) + "\n");
}

export function countFor(ledger, laneId, surface = "coding", day = todayKey()) {
  return ledger.data.days?.[day]?.[surface]?.[laneId] || 0;
}

export function increment(ledger, laneId, surface = "coding", day = todayKey()) {
  ledger.data.days ||= {};
  ledger.data.days[day] ||= {};
  ledger.data.days[day][surface] ||= {};
  ledger.data.days[day][surface][laneId] = countFor(ledger, laneId, surface, day) + 1;
}

export function isCapped(lane, ledger, surface = "coding") {
  if (lane.cap === null || lane.cap === undefined) return false;
  return countFor(ledger, lane.id, surface) >= lane.cap;
}

// ---------------------------------------------------------------------------
// Router + chain
// ---------------------------------------------------------------------------

function roleLanes(config, lanesById, role, executorFamily) {
  const ids = config.roles?.[role] || [];
  let lanes = ids.map((id) => lanesById.get(id)).filter(Boolean);
  if (role === "reviewer" && executorFamily) {
    // Cross-family rule: a reviewer from a DIFFERENT family than the
    // executor goes first when such a lane is available.
    const diff = lanes.filter((l) => l.family !== executorFamily);
    const same = lanes.filter((l) => l.family === executorFamily);
    if (diff.length) lanes = [...diff, ...same];
  }
  return lanes;
}

async function runStage({ role, prompt, task, config, lanesById, ledger, surface, executorFamily }) {
  const candidates = roleLanes(config, lanesById, role, executorFamily);
  const attempts = [];
  for (const lane of candidates) {
    if (isCapped(lane, ledger, surface)) {
      attempts.push({ lane: lane.id, status: "skipped-cap" });
      continue;
    }
    try {
      const out = await lane.chat(prompt, { role, task });
      increment(ledger, lane.id, surface);
      attempts.push({ lane: lane.id, status: "served" });
      return {
        role,
        lane: lane.id,
        provider: lane.provider,
        model: out.model,
        family: lane.family,
        tier: lane.tier,
        latencyMs: out.latencyMs,
        text: out.text,
        attempts,
        failover: attempts.some((a) => a.status === "failed"),
      };
    } catch (err) {
      attempts.push({ lane: lane.id, status: "failed", error: String(err.message || err) });
    }
  }
  const tried = attempts.map((a) => `${a.lane}:${a.status}`).join(", ");
  throw new Error(`no lane could serve role "${role}" (${tried})`);
}

export function parseVerdict(text) {
  if (/\bCHANGES\b/.test(text)) return "CHANGES";
  if (/\bAPPROVED\b/.test(text)) return "APPROVED";
  return "UNKNOWN";
}

/**
 * Run the chain: planner -> executor -> reviewer.
 * Returns stage results in order plus the full stamp/attempt record.
 */
export async function runChain({ task, surface = "coding", config, lanes, ledger }) {
  const lanesById = new Map(lanes.map((l) => [l.id, l]));
  const stages = [];
  const order = [];

  const planner = await runStage({
    role: "planner",
    task,
    surface,
    config,
    lanesById,
    ledger,
    prompt: `You are the planner. Write a short plan (3-5 steps) for this coding task:\n\n${task}`,
  });
  stages.push(planner);
  order.push("planner");

  const executor = await runStage({
    role: "executor",
    task,
    surface,
    config,
    lanesById,
    ledger,
    prompt: `You are the executor. Do the work for this task, following the plan.\n\nTask: ${task}\n\nPlan:\n${planner.text}`,
  });
  stages.push(executor);
  order.push("executor");

  const reviewer = await runStage({
    role: "reviewer",
    task,
    surface,
    config,
    lanesById,
    ledger,
    executorFamily: executor.family,
    prompt: `You are the reviewer. Judge the work against the task and plan. Reply starting with APPROVED or CHANGES, then brief notes.\n\nTask: ${task}\n\nPlan:\n${planner.text}\n\nWork:\n${executor.text}`,
  });
  stages.push(reviewer);
  order.push("reviewer");

  return {
    task,
    surface,
    order,
    stages,
    plan: planner.text,
    work: executor.text,
    review: reviewer.text,
    verdict: parseVerdict(reviewer.text),
    executorFamily: executor.family,
    reviewerFamily: reviewer.family,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function stampLine(stage) {
  const bits = stage.attempts
    .filter((a) => a.status !== "served")
    .map((a) => `${a.lane} ${a.status}${a.error ? ` (${a.error})` : ""}`);
  const suffix = bits.length ? `  [attempts: ${bits.join("; ")}${stage.failover ? "; failover" : ""}]` : "";
  return `${stage.role}: lane=${stage.lane} provider=${stage.provider} model=${stage.model} family=${stage.family} tier=${stage.tier} latency=${stage.latencyMs}ms${suffix}`;
}

export function formatRun(result) {
  const lines = [];
  if (result.verdict === "CHANGES") {
    lines.push("============================================================");
    lines.push("!!  REVIEWER VERDICT: CHANGES REQUESTED — read the review  !!");
    lines.push("============================================================");
    lines.push("");
  }
  lines.push("## Plan");
  lines.push(result.plan);
  lines.push("");
  lines.push("## Work");
  lines.push(result.work);
  lines.push("");
  lines.push(`## Review — verdict: ${result.verdict}`);
  lines.push(result.review);
  lines.push("");
  lines.push("--- STAMPS ---");
  for (const s of result.stages) lines.push(stampLine(s));
  lines.push(`surface=${result.surface} cross-family=${result.reviewerFamily !== result.executorFamily ? "yes" : "no"} (executor family=${result.executorFamily}, reviewer family=${result.reviewerFamily})`);
  return lines.join("\n");
}

export function formatBudget(config, ledger, surface = "coding", day = todayKey()) {
  const lines = [`Vokrew budget — ${day} (surface: ${surface})`, ""];
  for (const lane of config.lanes) {
    const used = countFor(ledger, lane.id, surface, day);
    if (lane.cap === null || lane.cap === undefined) {
      lines.push(`${lane.id}: ${used} used today · cap: unlimited · remaining: unlimited`);
    } else {
      lines.push(`${lane.id}: ${used} used today · cap: ${lane.cap}/day · remaining: ${Math.max(0, lane.cap - used)}`);
    }
  }
  const other = surface === "coding" ? "chat" : "coding";
  const otherTotal = Object.values(ledger.data.days?.[day]?.[other] || {}).reduce((a, b) => a + b, 0);
  lines.push("", `(${other} surface today: ${otherTotal} calls — budgets are kept separate)`);
  return lines.join("\n");
}

export { buildLanes };
