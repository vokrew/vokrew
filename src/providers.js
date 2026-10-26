// Provider implementations for Vokrew lanes.
//
// A lane's `chat(prompt, ctx)` returns { text, model, latencyMs }.
// ctx = { role, task }. Providers are deliberately tiny: native fetch only,
// zero runtime dependencies.

function timed(start) {
  return Math.max(0, Math.round(performance.now() - start));
}

async function fetchJson(url, opts, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- ollama (local, first-class) -------------------------------------------
export function ollamaChat(lane) {
  const base = (lane.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  return async (prompt) => {
    const start = performance.now();
    const data = await fetchJson(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: lane.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = data?.message?.content ?? "";
    if (!text) throw new Error("ollama returned an empty response");
    return { text, model: lane.model, latencyMs: timed(start) };
  };
}

export async function ollamaReachable(baseUrl = "http://localhost:11434", timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// --- openrouter (BYOK) ------------------------------------------------------
export function openrouterChat(lane) {
  return async (prompt) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set (BYOK lane unavailable)");
    const start = performance.now();
    const data = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-title": "vokrew",
      },
      body: JSON.stringify({
        model: lane.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("openrouter returned an empty response");
    return { text, model: data?.model || lane.model, latencyMs: timed(start) };
  };
}

// --- mock (deterministic, no network) ---------------------------------------
export function mockChat(lane) {
  return async (prompt, ctx = {}) => {
    const start = performance.now();
    const task = (ctx.task || prompt || "").slice(0, 80);
    let text;
    if (ctx.role === "planner") {
      text = `Plan: 1) Restate the goal. 2) Do the work in small steps. 3) Verify before shipping. Task: "${task}"`;
    } else if (ctx.role === "reviewer") {
      const verdict = lane.mockVerdict || "APPROVED";
      text = `${verdict}: reviewed by family "${lane.family}". Notes: work matches the plan; no blocking issues found by the mock reviewer.`;
    } else {
      text = `Work: completed "${task}" following the plan (mock executor, family "${lane.family}").`;
    }
    return { text, model: lane.model || "mock-1", latencyMs: timed(start) };
  };
}

// --- failing (used by tests to exercise failover) ---------------------------
export function failingChat(message = "deliberate provider failure") {
  return async () => {
    throw new Error(message);
  };
}

const IMPLS = { ollama: ollamaChat, openrouter: openrouterChat, mock: mockChat };

/**
 * Build runnable lanes from config.
 * `overrides` maps lane id -> chat function (tests inject mocks/failures here).
 */
export function buildLanes(config, overrides = {}) {
  return (config.lanes || []).map((lane) => {
    let chat = overrides[lane.id];
    if (!chat) {
      const impl = IMPLS[lane.provider];
      if (!impl) throw new Error(`unknown provider "${lane.provider}" for lane "${lane.id}"`);
      chat = impl(lane);
    }
    return {
      ...lane,
      chat: async (prompt, ctx) => {
        const out = await chat(prompt, ctx);
        return {
          text: out.text,
          model: out.model || lane.model || "unknown",
          latencyMs: typeof out.latencyMs === "number" ? out.latencyMs : 0,
        };
      },
    };
  });
}
