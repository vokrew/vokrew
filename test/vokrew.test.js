import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildLanes,
  runChain,
  formatRun,
  stampLine,
  fenceLine,
  loadLedger,
  saveLedger,
  countFor,
  increment,
} from "../src/core.js";
import { failingChat, openaiCompatibleHealth } from "../src/providers.js";
import { createBridge, bridgeTokenPath } from "../src/serve.js";

const LANES = [
  { id: "plan-a", provider: "mock", family: "alpha", tier: "local", model: "mock-1", cap: null },
  { id: "exec-fail", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null },
  { id: "exec-b", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null },
  { id: "exec-capped", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: 1 },
  { id: "rev-beta", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null },
  { id: "rev-gamma", provider: "mock", family: "gamma", tier: "local", model: "mock-1", cap: null },
  { id: "rev-changes", provider: "mock", family: "gamma", tier: "local", model: "mock-1", cap: null, mockVerdict: "CHANGES" },
];

function setup(roles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vokrew-test-"));
  const config = { lanes: LANES, roles };
  const lanes = buildLanes(config, { "exec-fail": failingChat("boom: lane down") });
  const ledger = loadLedger(home);
  return { config, lanes, ledger };
}

test("1. chain runs stages in order planner -> executor -> reviewer", async () => {
  const { config, lanes, ledger } = setup({
    planner: ["plan-a"],
    executor: ["exec-b"],
    reviewer: ["rev-gamma"],
  });
  const result = await runChain({ task: "demo task", config, lanes, ledger });
  assert.deepEqual(result.order, ["planner", "executor", "reviewer"]);
  assert.deepEqual(result.stages.map((s) => s.role), ["planner", "executor", "reviewer"]);
  assert.equal(result.verdict, "APPROVED");
});

test("2. failover: executor's first lane throws -> second lane serves, stamp shows failover", async () => {
  const { config, lanes, ledger } = setup({
    planner: ["plan-a"],
    executor: ["exec-fail", "exec-b"],
    reviewer: ["rev-gamma"],
  });
  const result = await runChain({ task: "demo task", config, lanes, ledger });
  const exec = result.stages[1];
  assert.equal(exec.lane, "exec-b");
  assert.equal(exec.failover, true);
  assert.equal(exec.attempts[0].lane, "exec-fail");
  assert.equal(exec.attempts[0].status, "failed");
  assert.match(stampLine(exec), /failover/);
});

test("3. cross-family: reviewer picks a different family than executor when available", async () => {
  const { config, lanes, ledger } = setup({
    planner: ["plan-a"],
    executor: ["exec-b"], // family beta
    reviewer: ["rev-beta", "rev-gamma"], // beta listed first, gamma must win
  });
  const result = await runChain({ task: "demo task", config, lanes, ledger });
  const reviewer = result.stages[2];
  assert.equal(result.executorFamily, "beta");
  assert.equal(reviewer.lane, "rev-gamma");
  assert.notEqual(reviewer.family, result.executorFamily);
});

test("4. ledger: run increments today's counts; a capped lane is skipped", async () => {
  const { config, lanes, ledger } = setup({
    planner: ["plan-a"],
    executor: ["exec-capped", "exec-b"],
    reviewer: ["rev-gamma"],
  });
  // Pre-fill the capped lane to its cap of 1 for today (coding surface).
  increment(ledger, "exec-capped", "coding");
  const result = await runChain({ task: "demo task", config, lanes, ledger });
  const exec = result.stages[1];
  assert.equal(exec.attempts[0].lane, "exec-capped");
  assert.equal(exec.attempts[0].status, "skipped-cap");
  assert.equal(exec.lane, "exec-b");
  // The run incremented today's counts for the lanes actually used.
  assert.equal(countFor(ledger, "plan-a", "coding"), 1);
  assert.equal(countFor(ledger, "exec-b", "coding"), 1);
  assert.equal(countFor(ledger, "rev-gamma", "coding"), 1);
  assert.equal(countFor(ledger, "exec-capped", "coding"), 1); // unchanged: it never served
  // Surfaces are separate: chat counts untouched.
  assert.equal(countFor(ledger, "exec-b", "chat"), 0);
  // And it persists.
  saveLedger(ledger);
  const reloaded = loadLedger(path.dirname(ledger.file));
  assert.equal(countFor(reloaded, "exec-b", "coding"), 1);
});

test("5. reviewer CHANGES verdict is surfaced prominently in output", async () => {
  const { config, lanes, ledger } = setup({
    planner: ["plan-a"],
    executor: ["exec-b"],
    reviewer: ["rev-changes"],
  });
  const result = await runChain({ task: "demo task", config, lanes, ledger });
  assert.equal(result.verdict, "CHANGES");
  const out = formatRun(result);
  assert.match(out, /REVIEWER VERDICT: CHANGES REQUESTED/);
  assert.match(out, /--- STAMPS ---/);
  // The banner comes before the plan/work — never buried at the bottom.
  assert.ok(out.indexOf("CHANGES REQUESTED") < out.indexOf("## Plan"));
});

// ---------------------------------------------------------------------------
// v1 Phase A tests (6-9)
// ---------------------------------------------------------------------------

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function closedPort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

test("6. openai-compatible provider: stub server returns text + model; refused connection fails over", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/models") {
        res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
      } else if (req.url === "/chat/completions") {
        res.end(JSON.stringify({ model: "stub-1", choices: [{ message: { content: "stub says hi" } }] }));
      } else {
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const stubLane = {
    id: "local-stub", provider: "openai-compatible", family: "localfam",
    tier: "local", model: "stub-req", baseUrl, cap: null,
  };
  const [lane] = buildLanes({ lanes: [stubLane], roles: {} });
  const out = await lane.chat("hello stub", { role: "executor", task: "hello stub" });
  assert.equal(out.text, "stub says hi");
  assert.equal(out.model, "stub-1"); // server-reported model wins
  const chatReq = requests.find((r) => r.url === "/chat/completions");
  assert.equal(chatReq.method, "POST");
  assert.equal(chatReq.body.model, "stub-req");
  assert.equal(chatReq.body.messages[0].content, "hello stub");

  // Health check = GET /models.
  const health = await openaiCompatibleHealth(stubLane);
  assert.equal(health.ok, true);
  assert.equal(health.responded, true);
  assert.equal(health.modelCount, 1);

  // Failover: dead endpoint (connection refused) first, mock second.
  const dead = {
    id: "dead-endpoint", provider: "openai-compatible", family: "localfam",
    tier: "local", model: "x", baseUrl: `http://127.0.0.1:${await closedPort()}`, cap: null,
  };
  const mockLane = { id: "mock-b", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null };
  const config = {
    lanes: [dead, mockLane],
    roles: { planner: ["mock-b"], executor: ["dead-endpoint", "mock-b"], reviewer: ["mock-b"] },
  };
  const result = await runChain({ task: "demo", config, lanes: buildLanes(config), ledger: loadLedger(tmpHome("vokrew-test-")) });
  const exec = result.stages[1];
  assert.equal(exec.attempts[0].lane, "dead-endpoint");
  assert.equal(exec.attempts[0].status, "failed");
  assert.equal(exec.lane, "mock-b");
  assert.equal(exec.failover, true);
});

test("7. crew preset: named executor's instructions are in its prompt, its name in the stamp; notes reach the planner", async () => {
  const captured = {};
  const lanesDef = [
    { id: "p", provider: "mock", family: "alpha", tier: "local", model: "mock-1", cap: null },
    { id: "e", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null },
    { id: "r", provider: "mock", family: "gamma", tier: "local", model: "mock-1", cap: null },
  ];
  const config = { lanes: lanesDef, roles: { planner: ["p"], executor: ["e"], reviewer: ["r"] } };
  const lanes = buildLanes(config, {
    p: async (prompt) => { captured.planner = prompt; return { text: "a plan", model: "mock-1", latencyMs: 0 }; },
    e: async (prompt) => { captured.executor = prompt; return { text: "work done", model: "mock-1", latencyMs: 0 }; },
  });
  const crew = {
    name: "four-hands",
    roles: { executor: { name: "Musky", instructions: "Work only from the brief; flag anything missing." } },
  };
  const result = await runChain({
    task: "demo", config, lanes, ledger: loadLedger(tmpHome("vokrew-test-")),
    crew, notes: "Remember: the gate is strict.",
  });
  assert.match(captured.executor, /Musky/);
  assert.match(captured.executor, /Work only from the brief; flag anything missing\./);
  assert.match(captured.planner, /Remember: the gate is strict\./);
  const exec = result.stages[1];
  assert.equal(exec.agent, "Musky");
  assert.match(stampLine(exec), /agent=Musky/);
  assert.equal(result.crew, "four-hands");
});

test("8. chat: scripted two-turn session answers both turns on surface=chat; ledger keeps chat separate from coding", () => {
  const home = tmpHome("vokrew-chat-");
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const res = spawnSync(process.execPath, [cli, "chat", "--mock"], {
    input: "first question please\nsecond question please\n/exit\n",
    env: { ...process.env, VOKREW_HOME: home },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(res.status, 0, res.stderr);
  // Both turns answered (the mock executor echoes its task = the message).
  assert.match(res.stdout, /first question please/);
  assert.match(res.stdout, /second question please/);
  // Compact stamp printed after each answer.
  assert.ok((res.stdout.match(/\[executor/g) || []).length >= 2);
  const ledger = loadLedger(home);
  assert.equal(countFor(ledger, "mock", "chat"), 2);
  assert.equal(countFor(ledger, "mock", "coding"), 0);
});

test("9. workspace: run stamps the path and the executor prompt carries the fence line", async () => {
  const captured = {};
  const lanesDef = [
    { id: "p", provider: "mock", family: "alpha", tier: "local", model: "mock-1", cap: null },
    { id: "e", provider: "mock", family: "beta", tier: "local", model: "mock-1", cap: null },
    { id: "r", provider: "mock", family: "gamma", tier: "local", model: "mock-1", cap: null },
  ];
  const config = { lanes: lanesDef, roles: { planner: ["p"], executor: ["e"], reviewer: ["r"] } };
  const lanes = buildLanes(config, {
    e: async (prompt) => { captured.executor = prompt; return { text: "work done", model: "mock-1", latencyMs: 0 }; },
  });
  const ws = tmpHome("vokrew-ws-");
  const result = await runChain({
    task: "demo", config, lanes, ledger: loadLedger(tmpHome("vokrew-test-")), workspace: ws,
  });
  assert.equal(result.workspace, ws);
  assert.match(captured.executor, /WORKSPACE FENCE/);
  assert.ok(captured.executor.includes(ws));
  assert.equal(
    fenceLine(ws),
    `WORKSPACE FENCE: your work is scoped to the workspace folder "${ws}". Anything outside that folder must be proposed, not assumed.`
  );
  assert.ok(formatRun(result).includes(`workspace=${ws}`));
});

// ---------------------------------------------------------------------------
// v2 bridge test (10)
// ---------------------------------------------------------------------------

test("10. bridge: health open, pair flow gates /run, stamped chain over HTTP, chat lands on chat surface, bad origin rejected", async (t) => {
  const home = tmpHome("vokrew-bridge-");
  const mockLane = { id: "mock", provider: "mock", family: "mock", tier: "local", model: "mock-1", cap: null };
  const config = { lanes: [mockLane], roles: { planner: ["mock"], executor: ["mock"], reviewer: ["mock"] } };
  const ledger = loadLedger(home);
  const bridge = createBridge({ home, config, lanes: buildLanes(config), ledger, version: "test-10" });
  await new Promise((r) => bridge.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => bridge.server.close(r)));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const code = bridge.newPairingCode();
  const wrongCode = code === "000000" ? "999999" : "000000";
  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // /health answers without auth.
  let res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, "test-10");
  assert.deepEqual(body.surfaces, ["coding", "chat"]);

  // /run without a token -> 401, JSON (never HTML).
  res = await post("/run", { task: "demo task" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type"), /application\/json/);
  body = await res.json();
  assert.equal(body.ok, false);

  // Wrong pair code -> 401.
  res = await post("/pair", { code: wrongCode });
  assert.equal(res.status, 401);
  body = await res.json();
  assert.equal(body.ok, false);

  // Correct code -> token, and the token is persisted for restarts.
  res = await post("/pair", { code });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(typeof body.token === "string" && body.token.length >= 16);
  const token = body.token;
  assert.equal(fs.readFileSync(bridgeTokenPath(home), "utf8").trim(), token);
  // The consumed code is single-use: pairing again with it fails.
  res = await post("/pair", { code });
  assert.equal(res.status, 401);

  const auth = { authorization: `Bearer ${token}` };

  // /run with the token + mock lane returns the stamped chain.
  res = await post("/run", { task: "demo task" }, auth);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.verdict, "APPROVED");
  assert.equal(body.surface, "coding");
  assert.deepEqual(body.stamps.map((s) => s.role), ["planner", "executor", "reviewer"]);
  assert.ok(body.stamps.every((s) => s.lane === "mock" && typeof s.latencyMs === "number"));
  assert.equal(body.stampLines.length, 3);
  assert.match(body.stampLines[0], /^planner: lane=mock/);
  assert.equal(countFor(loadLedger(home), "mock", "coding"), 3);

  // /chat turn lands on surface=chat in the ledger.
  res = await post("/chat", { message: "hello bridge" }, auth);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.surface, "chat");
  assert.ok(body.sessionId);
  assert.ok(body.text.length > 0);
  assert.equal(body.stamps.length, 1); // light chain: executor only, no verify
  assert.equal(countFor(loadLedger(home), "mock", "chat"), 1);
  assert.equal(countFor(loadLedger(home), "mock", "coding"), 3); // unchanged

  // /budget and /crews answer with the token (and crews never leak notes).
  res = await fetch(`${base}/budget?surface=chat`, { headers: auth });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.lanes.find((l) => l.id === "mock").used, 1);
  res = await fetch(`${base}/crews`, { headers: auth });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.ok(Array.isArray(body.crews) && body.crews.some((c) => c.name === "default"));

  // A disallowed Origin is rejected on preflight (and gets no CORS grant).
  res = await fetch(`${base}/run`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  body = await res.json();
  assert.equal(body.ok, false);

  // An allowed Origin preflight is answered with that origin echoed.
  res = await fetch(`${base}/run`, {
    method: "OPTIONS",
    headers: { origin: "https://vokrew.com", "access-control-request-method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://vokrew.com");
});
