// Provider implementations for Vokrew lanes.
//
// A lane's `chat(prompt, ctx)` returns { text, model, latencyMs }.
// ctx = { role, task, model } — ctx.model is a per-role model override from
// a crew preset; providers use it in place of lane.model when present.
// Providers are deliberately tiny: native fetch only, zero runtime deps.

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
  return async (prompt, ctx = {}) => {
    const model = ctx.model || lane.model;
    const start = performance.now();
    const data = await fetchJson(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = data?.message?.content ?? "";
    if (!text) throw new Error("ollama returned an empty response");
    return { text, model, latencyMs: timed(start) };
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
  return async (prompt, ctx = {}) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set (BYOK lane unavailable)");
    const model = ctx.model || lane.model;
    const start = performance.now();
    const data = await fetchJson("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-title": "vokrew",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("openrouter returned an empty response");
    return { text, model: data?.model || model, latencyMs: timed(start) };
  };
}

// --- openai-compatible (any OpenAI-shaped server: llama.cpp, llama-swap,
//     LM Studio, vLLM, a hosted endpoint, ...) --------------------------------
export function openaiCompatibleChat(lane) {
  const base = (lane.baseUrl || "").replace(/\/$/, "");
  return async (prompt, ctx = {}) => {
    if (!base) throw new Error(`lane "${lane.id}" (openai-compatible) has no baseUrl`);
    const model = ctx.model || lane.model;
    const headers = { "content-type": "application/json" };
    if (lane.apiKeyEnv) {
      const key = process.env[lane.apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const start = performance.now();
    const data = await fetchJson(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(`openai-compatible endpoint at ${base} returned an empty response`);
    return { text, model: data?.model || model, latencyMs: timed(start) };
  };
}

/**
 * Health check for an openai-compatible lane: GET {baseUrl}/models.
 * Falls back gracefully: a server that responds but doesn't support /models
 * is reported as responded-but-unsupported rather than dead.
 * Returns { responded, ok, modelCount }.
 */
export async function openaiCompatibleHealth(lane, timeoutMs = 800) {
  const base = (lane.baseUrl || "").replace(/\/$/, "");
  if (!base) return { responded: false, ok: false, modelCount: 0 };
  const headers = {};
  if (lane.apiKeyEnv && process.env[lane.apiKeyEnv]) {
    headers.authorization = `Bearer ${process.env[lane.apiKeyEnv]}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { responded: true, ok: false, modelCount: 0 };
    const data = await res.json().catch(() => null);
    const modelCount = Array.isArray(data?.data) ? data.data.length : 0;
    return { responded: true, ok: true, modelCount };
  } catch {
    return { responded: false, ok: false, modelCount: 0 };
  }
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
    return { text, model: ctx.model || lane.model || "mock-1", latencyMs: timed(start) };
  };
}

// --- failing (used by tests to exercise failover) ---------------------------
export function failingChat(message = "deliberate provider failure") {
  return async () => {
    throw new Error(message);
  };
}

const IMPLS = {
  ollama: ollamaChat,
  openrouter: openrouterChat,
  "openai-compatible": openaiCompatibleChat,
  mock: mockChat,
};

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
