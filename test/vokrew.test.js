import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildLanes,
  runChain,
  formatRun,
  stampLine,
  loadLedger,
  saveLedger,
  countFor,
  increment,
} from "../src/core.js";
import { failingChat } from "../src/providers.js";

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
