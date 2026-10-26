// Vokrew core: config, quota ledger, crew presets, role router, the
// plan -> work -> review chain, and the light chat turn. The CLI (cli.js) is
// a thin face over this module; later faces (web chat, voice) build on the
// same core.

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
// Crew presets: named agents with standing instructions, preferred lanes and
// model overrides, plus a per-crew notes file as light, file-based memory.
// Stored at ~/.vokrew/crews.json; notes at ~/.vokrew/crews/<name>-notes.md.
// ---------------------------------------------------------------------------

// The built-in default crew: no names, no instructions — v0 behavior exactly.
export const DEFAULT_CREW = { name: "default", roles: {} };

const STARTER_CREWS = {
  default: { roles: {} },
  example: {
    roles: {
      planner: { name: "Scout", instructions: "Plan small, verifiable steps." },
      executor: { name: "Patch", instructions: "Prefer the smallest correct change." },
      reviewer: { name: "Judge", instructions: "Be strict. Flag anything unverified." },
    },
  },
};

export function crewsFile(home = vokrewHome()) {
  return path.join(home, "crews.json");
}

export function loadCrews(home = vokrewHome()) {
  fs.mkdirSync(home, { recursive: true });
  const file = crewsFile(home);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  fs.writeFileSync(file, JSON.stringify(STARTER_CREWS, null, 2) + "\n");
  return structuredClone(STARTER_CREWS);
}

/** Resolve a crew by name (or the default crew when name is omitted). */
export function resolveCrew(crews, name) {
  if (!name) {
    const def = crews?.default;
    return def ? { name: "default", roles: def.roles || {} } : structuredClone(DEFAULT_CREW);
  }
  const crew = crews?.[name];
  if (!crew) {
    const known = Object.keys(crews || {}).join(", ") || "(none)";
    throw new Error(`unknown crew "${name}" — crews.json defines: ${known}`);
  }
  return { name, roles: crew.roles || {} };
}

export function crewRole(crew, role) {
  return crew?.roles?.[role] || {};
}

export function crewNotesPath(home, crewName) {
  const safe = String(crewName || "default").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.join(home, "crews", `${safe}-notes.md`);
}

export function loadCrewNotes(home, crewName) {
  const file = crewNotesPath(home, crewName);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function appendCrewLearning(home, crewName, line) {
  const file = crewNotesPath(home, crewName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// Quota ledger: per-day counts per lane, per surface (coding / chat kept
// separate from day one, so one surface can't silently eat the other).
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

function orderedLanes(laneIds, lanesById, role, executorFamily) {
  let lanes = (laneIds || []).map((id) => lanesById.get(id)).filter(Boolean);
  if (role === "reviewer" && executorFamily) {
    // Cross-family rule: a reviewer from a DIFFERENT family than the
    // executor goes first when such a lane is available.
    const diff = lanes.filter((l) => l.family !== executorFamily);
    const same = lanes.filter((l) => l.family === executorFamily);
    if (diff.length) lanes = [...diff, ...same];
  }
  return lanes;
}

// Lane order for a role: the crew's preferred lanes first, then the config's
// role list (deduped) so failover still has somewhere to go.
function laneOrderFor(config, crew, role) {
  const preferred = crewRole(crew, role).lanes || [];
  const base = config.roles?.[role] || [];
  return [...preferred, ...base.filter((id) => !preferred.includes(id))];
}

async function runStage({ role, prompt, task, lanesById, ledger, surface, executorFamily, laneIds, agent }) {
  const candidates = orderedLanes(laneIds, lanesById, role, executorFamily);
  const attempts = [];
  for (const lane of candidates) {
    if (isCapped(lane, ledger, surface)) {
      attempts.push({ lane: lane.id, status: "skipped-cap" });
      continue;
    }
    try {
      const out = await lane.chat(prompt, { role, task, model: agent?.model });
      increment(ledger, lane.id, surface);
      attempts.push({ lane: lane.id, status: "served" });
      return {
        role,
        agent: agent?.name || null,
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

function instructionsPrefix(agent, role) {
  if (!agent?.instructions) return "";
  const label = agent.name ? `${agent.name} (${role})` : role;
  return `Standing instructions for ${label}: ${agent.instructions}\n\n`;
}

// The workspace fence line (v1: a declared + stamped contract in the
// executor's prompt and the run output — the CLI executes no file/shell
// tools yet, so nothing enforces it mechanically. See README honesty note.)
export function fenceLine(workspace) {
  return `WORKSPACE FENCE: your work is scoped to the workspace folder "${workspace}". Anything outside that folder must be proposed, not assumed.`;
}

/**
 * Run the chain: planner -> executor -> reviewer.
 * Optional: crew (resolved preset), notes (crew standing context for the
 * planner), workspace (fence), remember + home (reviewer appends a one-line
 * learning to the crew notes file).
 */
export async function runChain({
  task,
  surface = "coding",
  config,
  lanes,
  ledger,
  crew = null,
  notes = "",
  workspace = null,
  remember = false,
  home = null,
}) {
  const lanesById = new Map(lanes.map((l) => [l.id, l]));
  const stages = [];
  const order = [];

  const plannerAgent = crewRole(crew, "planner");
  let plannerPrompt = instructionsPrefix(plannerAgent, "planner");
  if (notes) plannerPrompt += `Crew notes (standing context from previous runs):\n${notes}\n\n`;
  plannerPrompt += `You are the planner. Write a short plan (3-5 steps) for this coding task:\n\n${task}`;
  const planner = await runStage({
    role: "planner",
    task,
    surface,
    lanesById,
    ledger,
    laneIds: laneOrderFor(config, crew, "planner"),
    agent: plannerAgent,
    prompt: plannerPrompt,
  });
  stages.push(planner);
  order.push("planner");

  const executorAgent = crewRole(crew, "executor");
  let executorPrompt = instructionsPrefix(executorAgent, "executor");
  if (workspace) executorPrompt += `${fenceLine(workspace)}\n\n`;
  executorPrompt += `You are the executor. Do the work for this task, following the plan.\n\nTask: ${task}\n\nPlan:\n${planner.text}`;
  const executor = await runStage({
    role: "executor",
    task,
    surface,
    lanesById,
    ledger,
    laneIds: laneOrderFor(config, crew, "executor"),
    agent: executorAgent,
    prompt: executorPrompt,
  });
  stages.push(executor);
  order.push("executor");

  const reviewerAgent = crewRole(crew, "reviewer");
  const reviewerPrompt =
    instructionsPrefix(reviewerAgent, "reviewer") +
    `You are the reviewer. Judge the work against the task and plan. Reply starting with APPROVED or CHANGES, then brief notes.\n\nTask: ${task}\n\nPlan:\n${planner.text}\n\nWork:\n${executor.text}`;
  const reviewer = await runStage({
    role: "reviewer",
    task,
    surface,
    lanesById,
    ledger,
    executorFamily: executor.family,
    laneIds: laneOrderFor(config, crew, "reviewer"),
    agent: reviewerAgent,
    prompt: reviewerPrompt,
  });
  stages.push(reviewer);
  order.push("reviewer");

  const result = {
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
    crew: crew?.name || null,
    workspace: workspace || null,
    learned: null,
  };

  if (remember && home && crew?.name) {
    const firstLine = reviewer.text.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "reviewed";
    const line = `- ${todayKey()}: ${firstLine.slice(0, 160)}`;
    appendCrewLearning(home, crew.name, line);
    result.learned = line;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Chat turn (surface=chat): a LIGHT chain — the executor answers; the
// reviewer runs only when verify is set (the REPL's --verify / "!check").
// ---------------------------------------------------------------------------

export const CHAT_CONTEXT_TURNS = 6;

export async function runChatTurn({
  message,
  history = [],
  verify = false,
  config,
  lanes,
  ledger,
  crew = null,
}) {
  const surface = "chat";
  const lanesById = new Map(lanes.map((l) => [l.id, l]));
  const stages = [];

  const executorAgent = crewRole(crew, "executor");
  let prompt = instructionsPrefix(executorAgent, "executor");
  prompt += "You are answering in a chat. Reply directly and helpfully to the user's latest message.\n";
  const recent = history.slice(-CHAT_CONTEXT_TURNS);
  if (recent.length) {
    prompt += "\nConversation so far (most recent last):\n";
    for (const turn of recent) {
      prompt += `User: ${turn.user}\nAssistant: ${turn.assistant}\n`;
    }
  }
  prompt += `\nUser: ${message}`;

  const executor = await runStage({
    role: "executor",
    task: message,
    surface,
    lanesById,
    ledger,
    laneIds: laneOrderFor(config, crew, "executor"),
    agent: executorAgent,
    prompt,
  });
  stages.push(executor);

  let review = null;
  let verdict = null;
  if (verify) {
    const reviewerAgent = crewRole(crew, "reviewer");
    const reviewer = await runStage({
      role: "reviewer",
      task: message,
      surface,
      lanesById,
      ledger,
      executorFamily: executor.family,
      laneIds: laneOrderFor(config, crew, "reviewer"),
      agent: reviewerAgent,
      prompt:
        instructionsPrefix(reviewerAgent, "reviewer") +
        `You are the reviewer. Judge the assistant's answer to the user's message. Reply starting with APPROVED or CHANGES, then brief notes.\n\nUser message: ${message}\n\nAnswer:\n${executor.text}`,
    });
    stages.push(reviewer);
    review = reviewer.text;
    verdict = parseVerdict(reviewer.text);
  }

  return {
    message,
    surface,
    text: executor.text,
    stages,
    review,
    verdict,
    crew: crew?.name || null,
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
  const agent = stage.agent ? ` agent=${stage.agent}` : "";
  return `${stage.role}:${agent} lane=${stage.lane} provider=${stage.provider} model=${stage.model} family=${stage.family} tier=${stage.tier} latency=${stage.latencyMs}ms${suffix}`;
}

/** One compact line per stage — used by the chat REPL after each answer. */
export function compactStamp(stage) {
  const agent = stage.agent ? ` agent=${stage.agent}` : "";
  return `[${stage.role}${agent} · lane=${stage.lane} · model=${stage.model} · ${stage.latencyMs}ms]`;
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
  let footer = `surface=${result.surface} cross-family=${result.reviewerFamily !== result.executorFamily ? "yes" : "no"} (executor family=${result.executorFamily}, reviewer family=${result.reviewerFamily})`;
  if (result.crew && result.crew !== "default") footer += ` crew=${result.crew}`;
  if (result.workspace) footer += ` workspace=${result.workspace}`;
  lines.push(footer);
  if (result.learned) lines.push(`remembered: ${result.learned}`);
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
