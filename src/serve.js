// Vokrew bridge: `vokrew serve` — a localhost-only HTTP face over the same
// core the CLI uses (src/core.js). The web face at vokrew.com/app pairs to
// this bridge with a single-use code and then drives the user's own local
// crew: page = remote control, user's machine = engine.
//
// Binds 127.0.0.1 ONLY. No TLS (localhost-only by design; the pairing token
// is the credential). Chat sessions live in memory; the ledger persists.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  runChain,
  runChatTurn,
  loadCrews,
  resolveCrew,
  loadCrewNotes,
  countFor,
  todayKey,
  formatBudget,
  saveLedger,
  stampLine,
  compactStamp,
} from "./core.js";
import { ollamaReachable, openaiCompatibleHealth } from "./providers.js";

export const BRIDGE_DEFAULT_PORT = 7717;
const CODE_TTL_MS = 10 * 60 * 1000; // pairing code lives 10 minutes
const LOCKOUT_MS = 5 * 60 * 1000; // after 5 wrong codes, pairing locks 5 min
const MAX_WRONG_ATTEMPTS = 5;
const MAX_BODY_BYTES = 1_000_000;
const SESSION_HISTORY_CAP = 20;

// Origins the web face may call from: the production site, and any
// localhost port (local development of the face). No wildcards, ever.
export function isAllowedOrigin(origin) {
  if (origin === "https://vokrew.com") return true;
  return /^https?:\/\/localhost(:\d{1,5})?$/.test(origin || "");
}

function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export function bridgeTokenPath(home) {
  return path.join(home, "bridge-token");
}

function loadPersistedToken(home) {
  try {
    const token = fs.readFileSync(bridgeTokenPath(home), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function persistToken(home, token) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(bridgeTokenPath(home), token + "\n", { mode: 0o600 });
}

function tokenEquals(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// The stamps block carried by /run and /chat responses: structured stage
// objects plus the same formatted lines the CLI prints, so a UI can render
// either form.
export function stampsOf(result) {
  const stages = (result.stages || []).map((s) => ({
    role: s.role,
    agent: s.agent,
    lane: s.lane,
    provider: s.provider,
    model: s.model,
    family: s.family,
    tier: s.tier,
    latencyMs: s.latencyMs,
    failover: s.failover,
    attempts: s.attempts,
  }));
  return {
    stamps: stages,
    stampLines: (result.stages || []).map((s) => stampLine(s)),
    compactStamps: (result.stages || []).map((s) => compactStamp(s)),
  };
}

// Lane health strings — the same data `vokrew lanes` prints.
async function laneHealth(lane) {
  if (lane.provider === "mock") return "mock (always available, no network)";
  if (lane.provider === "ollama")
    return (await ollamaReachable(lane.baseUrl)) ? `reachable at ${lane.baseUrl}` : `NOT reachable at ${lane.baseUrl}`;
  if (lane.provider === "openai-compatible") {
    const h = await openaiCompatibleHealth(lane);
    return h.ok
      ? `reachable at ${lane.baseUrl} (${h.modelCount} models)`
      : h.responded
        ? `server responded at ${lane.baseUrl} (GET /models unsupported — chat will be tried anyway)`
        : `NOT reachable at ${lane.baseUrl}`;
  }
  if (lane.provider === "openrouter")
    return process.env.OPENROUTER_API_KEY ? "API key present (BYOK)" : "no OPENROUTER_API_KEY set";
  return "unknown provider";
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
    }
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error("request body is not valid JSON"), { status: 400 });
  }
}

/**
 * Create the bridge (an http.Server, not yet listening).
 *
 * deps: { home, config, lanes, ledger, version?, resetToken?, onPairingCode? }
 * Returns { server, state, newPairingCode } — state is exposed for the CLI
 * (printing codes) and for tests.
 */
export function createBridge({ home, config, lanes, ledger, version, resetToken = false, onPairingCode } = {}) {
  if (!home) throw new Error("createBridge: home is required");
  if (!config || !lanes || !ledger) throw new Error("createBridge: config, lanes and ledger are required");
  version = version || packageVersion();
  const notifyCode = onPairingCode || (() => {});

  if (resetToken) {
    try {
      fs.unlinkSync(bridgeTokenPath(home));
    } catch {
      /* no token file — nothing to reset */
    }
  }

  const state = {
    token: resetToken ? null : loadPersistedToken(home),
    code: null,
    codeExpiresAt: 0,
    wrongAttempts: 0,
    lockoutUntil: 0,
  };

  function newPairingCode() {
    state.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    state.codeExpiresAt = Date.now() + CODE_TTL_MS;
    notifyCode(state.code);
    return state.code;
  }

  // Per-session chat context, in memory only: restart = fresh sessions.
  const sessions = new Map();

  function sendJson(res, status, obj, cors) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(cors || {}),
    });
    res.end(body);
  }

  function isAuthed(req) {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return !!match && tokenEquals(match[1], state.token);
  }

  async function handlePair(req, res, cors) {
    const now = Date.now();
    if (state.lockoutUntil > now) {
      return sendJson(res, 429, { ok: false, error: "pairing is locked after too many wrong codes — try again in a few minutes" }, cors);
    }
    const body = await readJsonBody(req);
    const code = String(body.code ?? "");
    if (!state.code || state.codeExpiresAt <= now) {
      newPairingCode();
      return sendJson(res, 401, { ok: false, error: "pairing code expired — a new code was printed on the server console" }, cors);
    }
    if (!tokenEquals(code, state.code)) {
      state.wrongAttempts += 1;
      if (state.wrongAttempts >= MAX_WRONG_ATTEMPTS) {
        state.lockoutUntil = now + LOCKOUT_MS;
        state.wrongAttempts = 0;
      }
      return sendJson(res, 401, { ok: false, error: "wrong pairing code" }, cors);
    }
    state.wrongAttempts = 0;
    newPairingCode(); // single-use: consumed codes never work twice
    if (!state.token) {
      state.token = crypto.randomBytes(24).toString("base64url");
      persistToken(home, state.token);
    }
    return sendJson(res, 200, { ok: true, token: state.token }, cors);
  }

  async function handleRun(req, res, cors) {
    const body = await readJsonBody(req);
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) return sendJson(res, 400, { ok: false, error: 'missing "task"' }, cors);
    const surface = body.surface || "coding";
    if (surface !== "coding" && surface !== "chat") {
      return sendJson(res, 400, { ok: false, error: '"surface" must be "coding" or "chat"' }, cors);
    }
    let crew;
    try {
      crew = resolveCrew(loadCrews(home), body.crew || undefined);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message }, cors);
    }
    const notes = crew?.name ? loadCrewNotes(home, crew.name) : "";
    try {
      const result = await runChain({
        task,
        surface,
        config,
        lanes,
        ledger,
        crew,
        notes,
        workspace: typeof body.workspace === "string" && body.workspace ? body.workspace : null,
        home,
      });
      saveLedger(ledger);
      return sendJson(
        res,
        200,
        {
          ok: true,
          task: result.task,
          surface: result.surface,
          verdict: result.verdict,
          plan: result.plan,
          work: result.work,
          review: result.review,
          crossFamily: result.reviewerFamily !== result.executorFamily,
          crew: result.crew,
          workspace: result.workspace,
          ...stampsOf(result),
        },
        cors
      );
    } catch (err) {
      saveLedger(ledger);
      return sendJson(res, 500, { ok: false, error: `run failed: ${err.message}` }, cors);
    }
  }

  async function handleChat(req, res, cors) {
    const body = await readJsonBody(req);
    let message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) return sendJson(res, 400, { ok: false, error: 'missing "message"' }, cors);
    let verify = !!body.verify;
    if (message.startsWith("!check ")) {
      verify = true;
      message = message.slice("!check ".length).trim();
      if (!message) return sendJson(res, 400, { ok: false, error: 'missing "message"' }, cors);
    }
    let sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null;
    if (!sessionId) sessionId = crypto.randomUUID();
    let session = sessions.get(sessionId);
    if (!session) {
      session = { history: [], crewName: null };
      sessions.set(sessionId, session);
    }
    if (typeof body.crew === "string" && body.crew) session.crewName = body.crew;
    let crew;
    try {
      crew = resolveCrew(loadCrews(home), session.crewName || undefined);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message }, cors);
    }
    try {
      const turn = await runChatTurn({
        message,
        history: session.history,
        verify,
        config,
        lanes,
        ledger,
        crew,
      });
      saveLedger(ledger);
      session.history.push({ user: message, assistant: turn.text });
      if (session.history.length > SESSION_HISTORY_CAP) {
        session.history = session.history.slice(-SESSION_HISTORY_CAP);
      }
      return sendJson(
        res,
        200,
        {
          ok: true,
          sessionId,
          message,
          surface: turn.surface,
          text: turn.text,
          review: turn.review,
          verdict: turn.verdict,
          crew: turn.crew,
          ...stampsOf(turn),
        },
        cors
      );
    } catch (err) {
      saveLedger(ledger);
      return sendJson(res, 500, { ok: false, error: `chat failed: ${err.message}` }, cors);
    }
  }

  function handleBudget(req, res, cors, url) {
    const surface = url.searchParams.get("surface") || "coding";
    if (surface !== "coding" && surface !== "chat") {
      return sendJson(res, 400, { ok: false, error: '"surface" must be "coding" or "chat"' }, cors);
    }
    const day = todayKey();
    const laneViews = config.lanes.map((lane) => {
      const used = countFor(ledger, lane.id, surface, day);
      const cap = lane.cap === undefined ? null : lane.cap;
      return { id: lane.id, used, cap, remaining: cap === null ? null : Math.max(0, cap - used) };
    });
    const other = surface === "coding" ? "chat" : "coding";
    const otherSurfaceTotal = Object.values(ledger.data.days?.[day]?.[other] || {}).reduce((a, b) => a + b, 0);
    return sendJson(
      res,
      200,
      { ok: true, surface, day, lanes: laneViews, otherSurfaceTotal, text: formatBudget(config, ledger, surface, day) },
      cors
    );
  }

  async function handleLanes(req, res, cors) {
    const views = [];
    for (const lane of config.lanes) {
      views.push({
        id: lane.id,
        provider: lane.provider,
        model: lane.model,
        family: lane.family,
        tier: lane.tier,
        cap: lane.cap === undefined ? null : lane.cap,
        health: await laneHealth(lane),
      });
    }
    return sendJson(res, 200, { ok: true, lanes: views }, cors);
  }

  function handleCrews(req, res, cors) {
    const crews = loadCrews(home);
    const views = Object.entries(crews || {}).map(([name, crew]) => ({
      name,
      roles: crew?.roles || {},
    }));
    return sendJson(res, 200, { ok: true, crews: views }, cors);
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const hasOrigin = typeof origin === "string" && origin.length > 0;
    const originAllowed = !hasOrigin || isAllowedOrigin(origin);
    const cors = hasOrigin && originAllowed ? { "access-control-allow-origin": origin, vary: "Origin" } : {};

    try {
      // CORS preflight: answered for allowed origins only.
      if (req.method === "OPTIONS") {
        if (!originAllowed) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, {});
        res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          // Private Network Access: a public https page (vokrew.com/app)
          // fetching this loopback bridge needs this on the preflight.
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
          vary: "Origin",
        });
        return res.end();
      }
      if (!originAllowed) return sendJson(res, 403, { ok: false, error: "origin not allowed" }, {});

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") {
        return sendJson(res, 200, { ok: true, name: "vokrew", version, surfaces: ["coding", "chat"] }, cors);
      }
      if (route === "POST /pair") return await handlePair(req, res, cors);

      const protectedRoutes = ["POST /run", "POST /chat", "GET /budget", "GET /lanes", "GET /crews"];
      if (protectedRoutes.includes(route)) {
        if (!isAuthed(req)) {
          return sendJson(res, 401, { ok: false, error: state.token ? "missing or invalid bearer token" : "not paired yet — POST /pair with the code printed by `vokrew serve`" }, cors);
        }
        if (route === "POST /run") return await handleRun(req, res, cors);
        if (route === "POST /chat") return await handleChat(req, res, cors);
        if (route === "GET /budget") return handleBudget(req, res, cors, url);
        if (route === "GET /lanes") return await handleLanes(req, res, cors);
        if (route === "GET /crews") return handleCrews(req, res, cors);
      }

      return sendJson(res, 404, { ok: false, error: `no such route: ${route}` }, cors);
    } catch (err) {
      const status = err.status || 500;
      if (!res.headersSent) return sendJson(res, status, { ok: false, error: err.message || "internal error" }, cors);
      return res.end();
    }
  });

  return { server, state, newPairingCode };
}
