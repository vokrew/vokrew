// Stage 0 evaluator (Phase 1, GAP-1 + GAP-2): the bridge run registry.
// Async POST /run answers 202 + runId immediately; the record is pollable
// through its phases and lands with the same stamps a ?wait=1 run returns.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildLanes, loadLedger } from "../src/core.js";
import { createBridge } from "../src/serve.js";

const STAGE_DELAY_MS = 300; // ~300 ms per stage, per the stage-0 spec

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A delayed stub lane: waits ~300 ms per call, then answers with
// role-appropriate text. latencyMs is reported as the fixed delay (the
// same fixed-latency convention the suite's other overrides use) so two
// runs of the same task produce deep-equal stamps.
function delayedStubChat(prompt, ctx = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const task = (ctx.task || prompt || "").slice(0, 80);
      let text;
      if (ctx.role === "planner") text = `Plan: stub plan for "${task}".`;
      else if (ctx.role === "reviewer") text = `APPROVED: stub review for "${task}".`;
      else text = `Work: stub work for "${task}".`;
      resolve({ text, model: "stub-1", latencyMs: STAGE_DELAY_MS });
    }, STAGE_DELAY_MS);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("11. run registry: async POST /run -> 202, phases poll in order, final record matches ?wait=1 stamps, list/404/401", async (t) => {
  const home = tmpHome("vokrew-registry-");
  const stubDef = { id: "stub", provider: "mock", family: "stubfam", tier: "local", model: "stub-1", cap: null };
  const config = { lanes: [stubDef], roles: { planner: ["stub"], executor: ["stub"], reviewer: ["stub"] } };
  const lanes = buildLanes(config, { stub: delayedStubChat });
  const ledger = loadLedger(home);
  const bridge = createBridge({ home, config, lanes, ledger, version: "test-11" });
  await new Promise((r) => bridge.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => bridge.server.close(r)));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });

  // Pair to get a token.
  const code = bridge.newPairingCode();
  let res = await post("/pair", { code });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const auth = { authorization: `Bearer ${token}` };

  // (f) unauthenticated -> 401 on both new GETs.
  res = await get("/runs");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
  res = await get("/runs/whatever");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);

  // (e) unknown id -> 404 (authenticated).
  res = await get("/runs/does-not-exist", auth);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).ok, false);

  // (a) POST /run answers 202 + runId in <100 ms while still executing.
  const task = "registry demo task";
  const t0 = performance.now();
  res = await post("/run", { task }, auth);
  const elapsed = performance.now() - t0;
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal(started.ok, true);
  assert.ok(typeof started.runId === "string" && started.runId.length > 0);
  assert.ok(elapsed < 100, `POST /run took ${Math.round(elapsed)}ms, want <100ms`);
  const runId = started.runId;

  res = await get(`/runs/${runId}`, auth);
  assert.equal(res.status, 200);
  let run = (await res.json()).run;
  assert.equal(run.state, "running"); // still executing: chain takes ~900 ms
  assert.equal(run.phase, "planner");
  assert.deepEqual(run.stages, []);

  // (b) polling observes the phase sequence planner -> executor ->
  // reviewer in order while stages land one by one.
  const phasesSeen = [];
  const deadline = Date.now() + 15000;
  while (run.state === "running") {
    assert.ok(Date.now() < deadline, "run did not finish within 15s");
    await sleep(25);
    res = await get(`/runs/${runId}`, auth);
    assert.equal(res.status, 200);
    run = (await res.json()).run;
    if (run.state === "running" && run.phase && phasesSeen[phasesSeen.length - 1] !== run.phase) {
      phasesSeen.push(run.phase);
    }
  }
  assert.deepEqual(phasesSeen, ["planner", "executor", "reviewer"]);

  // (c) final record: done, verdict present, full result fields carried.
  assert.equal(run.state, "done");
  assert.equal(run.phase, null);
  assert.equal(run.verdict, "APPROVED");
  assert.equal(run.crossFamily, false); // one lane serves every role here
  assert.ok(run.plan && run.work && run.review);
  assert.ok(run.finishedAt >= run.startedAt);
  assert.equal(run.stages.length, 3);
  assert.deepEqual(run.stages.map((s) => s.role), ["planner", "executor", "reviewer"]);
  assert.equal(run.error, null);

  // The same task through ?wait=1 (today's blocking behavior) returns the
  // exact pre-registry body, and its stamps deep-equal the record's.
  res = await post("/run?wait=1", { task }, auth);
  assert.equal(res.status, 200);
  const waited = await res.json();
  assert.equal(waited.ok, true);
  assert.equal(waited.verdict, run.verdict);
  assert.deepEqual(run.stamps, waited.stamps);
  assert.deepEqual(run.stages, waited.stamps);
  assert.deepEqual(run.stampLines, waited.stampLines);
  assert.deepEqual(run.compactStamps, waited.compactStamps);

  // (d) GET /runs lists the record, newest first, in summary shape.
  // (?wait=1 runs are not registered — the compat path is unchanged.)
  res = await get("/runs?limit=20", auth);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.ok, true);
  assert.equal(list.runs.length, 1);
  const summary = list.runs[0];
  assert.equal(summary.id, runId);
  assert.equal(summary.task, task);
  assert.equal(summary.state, "done");
  assert.equal(summary.phase, null);
  assert.equal(summary.verdict, "APPROVED");
  assert.equal(summary.crew, "default");
  assert.equal(summary.surface, "coding");
});
