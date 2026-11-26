import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const hosts = ["codex", "claude", "antigravity", "chatgpt", "claude_ai", "gemini_web", "grokbot", "cowork"];
const kinds = ["seen", "correction", "delivered", "outcome", "error", "manual_followup", "turn_user", "turn_assistant"];
const labels = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  chatgpt: "ChatGPT",
  claude_ai: "Claude.ai",
  gemini_web: "Gemini",
  grokbot: "Grok",
  cowork: "Cowork",
};
const maxBodyLength = 240_000;

function response(body, status = 200, headers = {}, csp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'") {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": csp,
      ...headers,
    },
  });
}

function matches(provided, expected) {
  if (!expected || !provided || provided.length > 1024) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function redact(message) {
  return String(message ?? "")
    .replace(/\b(?:sk-or-v1-|sk-proj-|ghp_|github_pat_|ctx7sk-)[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9_./+-]{12,}=*/gi, "Bearer [credential]")
    .replace(/\b((?:authorization|api[_-]?key|password|secret|access_token|refresh_token)\s*[:=]\s*)[^\s,;"}]+/gi, "$1[credential]");
}

function sanitizeJson(val, depth = 0) {
  if (depth > 4) return null;
  if (val === null || typeof val === "boolean" || typeof val === "number") {
    return Number.isFinite(val) || typeof val !== "number" ? val : null;
  }
  if (typeof val === "string") return redact(val).slice(0, 300);
  if (Array.isArray(val)) return val.slice(0, 30).map((x) => sanitizeJson(x, depth + 1));
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val).slice(0, 40)) {
      out[String(k).slice(0, 60)] = sanitizeJson(v, depth + 1);
    }
    return out;
  }
  return null;
}

function safeUrl(value) {
  if (typeof value !== "string" || !value || value.length > 260) return null;
  if (/^(?:https:\/\/|codex:\/\/threads\/|claude:\/\/)/.test(value) && !/[\s<>"'`]/.test(value)) return value;
  return null;
}

function normalize(event, importing = false) {
  if (!event || typeof event.id !== "string" || !/^[\w:.-]{1,180}$/.test(event.id) ||
      typeof event.session_id !== "string" || !/^[\w:.-]{1,180}$/.test(event.session_id) ||
      !hosts.includes(event.host) || !kinds.includes(event.kind) ||
      typeof event.at !== "number" || !Number.isFinite(event.at) ||
      event.at < 0 || event.at > Date.now() / 1000 + 900) return null;
  if (event.message != null && typeof event.message !== "string") return null;
  if (event.outcome != null && !["verified", "superseded", "redirected", "pending"].includes(event.outcome)) return null;
  const project = typeof event.project === "string"
    ? event.project.replace(/[^\p{L}\p{N} .@+\-_:/()–—]/gu, "").trim().slice(0, 80) || null
    : null;
  const title = typeof event.title === "string"
    ? event.title.replace(/[^\p{L}\p{N} .@+\-_:/()–—?!,'"]/gu, "").trim().slice(0, 100) || null
    : null;
  const sessionUrl = safeUrl(event.session_url);
  const sessionState = ["ongoing", "completed", "pending", "error", "stopped"].includes(event.session_state)
    ? event.session_state
    : null;
  return [
    event.id,
    event.host,
    event.session_id,
    event.kind,
    event.at,
    importing ? event.message : redact(event.message ?? "").slice(0, 2600),
    event.outcome ?? null,
    project,
    sessionUrl,
    sessionState,
    title,
  ];
}

async function readBody(request, limit = maxBodyLength) {
  const maxBytes = limit * 3;
  if (Number(request.headers["content-length"]) > maxBytes) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) return null;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, bytes).toString("utf8");
  return body.length <= limit ? body : null;
}

async function ingest(request, database, feedAuthorization) {
  if (!matches(request.headers.authorization, feedAuthorization)) {
    return response("Unauthorized", 401);
  }
  if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    return response("Expected application/json", 415);
  }
  const body = await readBody(request);
  if (body === null) return response("Event batch is too large", 413);
  let events;
  try {
    const parsed = JSON.parse(body);
    events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) => normalize(event));
  } catch {
    return response("Invalid JSON", 400);
  }
  if (!events.length || events.length > 80 || events.includes(null)) return response("Invalid events", 400);
  writeEvents(database, events);
  return response(JSON.stringify({ accepted: events.length }), 200, { "Content-Type": "application/json" });
}

async function ingestWatcher(request, database, feedAuthorization) {
  if (!matches(request.headers.authorization, feedAuthorization)) {
    return response("Unauthorized", 401);
  }
  if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    return response("Expected application/json", 415);
  }
  const body = await readBody(request, 16_000);
  if (body === null) return response("Watcher payload too large", 413);
  let clean;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response("Invalid watcher payload", 400);
    }
    clean = sanitizeJson(parsed);
  } catch {
    return response("Invalid JSON", 400);
  }
  const now = Date.now() / 1000;
  database.prepare(`
    INSERT INTO watcher_health (id, updated_at, payload)
    VALUES ('primary', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `).run(now, JSON.stringify(clean));
  return response(JSON.stringify({ accepted: true, at: now }), 200, { "Content-Type": "application/json" });
}

function writeEvents(database, events) {
  const statement = database.prepare(`
    INSERT INTO events (id, host, session_id, kind, at, message, outcome, project, session_url, session_state, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      at = excluded.at,
      message = excluded.message,
      outcome = excluded.outcome,
      project = COALESCE(excluded.project, events.project),
      session_url = COALESCE(excluded.session_url, events.session_url),
      session_state = COALESCE(excluded.session_state, events.session_state),
      title = COALESCE(excluded.title, events.title)
    WHERE excluded.at >= events.at AND excluded.host = events.host
      AND excluded.session_id = events.session_id AND excluded.kind = events.kind
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events) statement.run(...event);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function queryState(database) {
  const now = Date.now() / 1000;
  const seenRows = database.prepare(`
    SELECT host, session_id, MAX(at) AS last_at,
      MAX(project) AS project,
      COALESCE(
        (SELECT t.title FROM events t
          WHERE t.host = events.host AND t.session_id = events.session_id AND t.title IS NOT NULL
          ORDER BY t.at DESC LIMIT 1),
        MAX(title)
      ) AS title,
      MAX(session_url) AS session_url,
      (SELECT s2.session_state FROM events s2
        WHERE s2.host = events.host AND s2.session_id = events.session_id AND s2.session_state IS NOT NULL
        ORDER BY s2.at DESC LIMIT 1) AS session_state,
      SUM(CASE WHEN kind = 'correction' THEN 1 ELSE 0 END) AS corrections_count,
      SUM(CASE WHEN kind = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
      SUM(CASE WHEN kind = 'manual_followup' THEN 1 ELSE 0 END) AS manual_count,
      SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN kind IN ('turn_user', 'turn_assistant') THEN 1 ELSE 0 END) AS turn_count
    FROM events
    GROUP BY host, session_id
    HAVING corrections_count > 0 OR manual_count > 0 OR error_count > 0 OR turn_count > 0 OR MAX(at) >= ?
    ORDER BY last_at DESC
    LIMIT 250
  `).all(now - 86400);
  const detailRows = database.prepare(`
    SELECT id, host, session_id, kind, at, message, outcome, project, session_url, session_state, title
    FROM events
    WHERE kind NOT IN ('seen', 'turn_user', 'turn_assistant')
    ORDER BY at DESC
    LIMIT 1000
  `).all();
  const heartbeat = database.prepare("SELECT host, MAX(at) AS at, COUNT(DISTINCT session_id) AS sessions FROM events GROUP BY host").all();
  const watcherRow = database.prepare("SELECT updated_at, payload FROM watcher_health WHERE id = 'primary'").get();
  let watcher = null;
  if (watcherRow) {
    try {
      const parsed = JSON.parse(watcherRow.payload);
      watcher = {
        ...parsed,
        updated_at: watcherRow.updated_at,
        age_sec: Math.max(0, Math.round(now - watcherRow.updated_at)),
        alive: (now - watcherRow.updated_at) < 180,
      };
    } catch {}
  }

  const perHost = {};
  for (const h of hosts) {
    perHost[h] = {
      sessions: 0,
      last_at: null,
      corrections: 0,
      delivered: 0,
      verified: 0,
      superseded: 0,
      redirected: 0,
      pending: 0,
      errors: 0,
      manual_followups: 0,
    };
  }
  for (const r of heartbeat) {
    if (!perHost[r.host]) continue;
    perHost[r.host].sessions = r.sessions;
    perHost[r.host].last_at = r.at;
  }

  const totals = {
    sessions: 0,
    corrections: 0,
    delivered: 0,
    verified: 0,
    superseded: 0,
    redirected: 0,
    pending: 0,
    errors: 0,
    manual_followups: 0,
    median_resolution_sec: null,
    last_24h: { corrections: 0, delivered: 0, verified: 0, superseded: 0, redirected: 0, errors: 0, manual_followups: 0 },
  };
  totals.sessions = Object.values(perHost).reduce((a, b) => a + b.sessions, 0);

  const aggRows = database.prepare(`
    SELECT host, kind, outcome, COUNT(*) AS cnt,
      SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS cnt24
    FROM events
    WHERE kind NOT IN ('seen', 'turn_user', 'turn_assistant')
    GROUP BY host, kind, outcome
  `).all(now - 86400);

  for (const r of aggRows) {
    const h = perHost[r.host];
    const c = Number(r.cnt || 0);
    const c24 = Number(r.cnt24 || 0);
    if (r.kind === "correction") {
      totals.corrections += c;
      totals.last_24h.corrections += c24;
      if (h) h.corrections += c;
      if (r.outcome === "verified") {
        totals.verified += c;
        totals.last_24h.verified += c24;
        if (h) h.verified += c;
      } else if (r.outcome === "superseded") {
        totals.superseded += c;
        totals.last_24h.superseded += c24;
        if (h) h.superseded += c;
      } else if (r.outcome === "redirected") {
        totals.redirected += c;
        totals.last_24h.redirected += c24;
        if (h) h.redirected += c;
      } else if (r.outcome === "pending") {
        totals.pending += c;
        if (h) h.pending += c;
      }
    } else if (r.kind === "delivered") {
      totals.delivered += c;
      totals.last_24h.delivered += c24;
      if (h) h.delivered += c;
    } else if (r.kind === "error") {
      totals.errors += c;
      totals.last_24h.errors += c24;
      if (h) h.errors += c;
    } else if (r.kind === "manual_followup") {
      totals.manual_followups += c;
      totals.last_24h.manual_followups += c24;
      if (h) h.manual_followups += c;
    }
  }

  const resTimes = database.prepare(`
    SELECT (o.at - c.at) AS dt
    FROM events c
    JOIN events o
      ON o.host = c.host
     AND o.session_id = c.session_id
     AND o.kind = 'outcome'
     AND o.outcome = 'verified'
     AND o.message = c.message
     AND o.at >= c.at
    WHERE c.kind = 'correction'
    ORDER BY dt ASC
    LIMIT 500
  `).all().map((r) => Number(r.dt)).filter((x) => Number.isFinite(x) && x >= 0);
  if (resTimes.length) {
    const mid = Math.floor(resTimes.length / 2);
    totals.median_resolution_sec = Math.round(
      resTimes.length % 2 ? resTimes[mid] : (resTimes[mid - 1] + resTimes[mid]) / 2
    );
  }

  const manualRows = database.prepare(`
    SELECT host, session_id, project, title, session_url, at, message
    FROM events
    WHERE kind = 'manual_followup'
    ORDER BY at DESC
    LIMIT 60
  `).all();
  const manualByCategory = {};
  const recentManual = manualRows.map((r) => {
    const msg = String(r.message || "");
    const m = msg.match(/^\[([a-z0-9_]+)\]\s*([\s\S]*)$/i);
    const category = m ? m[1] : "steering";
    const snippet = m ? m[2] : msg;
    manualByCategory[category] = (manualByCategory[category] || 0) + 1;
    return {
      host: r.host,
      session_id: r.session_id,
      project: r.title || r.project,
      session_url: r.session_url,
      at: r.at,
      category,
      snippet,
    };
  });

  return {
    serverTime: now,
    labels,
    hosts: Object.fromEntries(heartbeat.map((r) => [r.host, r.at])),
    watcher,
    metrics: {
      ...totals,
      manual_by_category: manualByCategory,
      recent_manual: recentManual.slice(0, 20),
      per_host: perHost,
    },
    sessions: seenRows,
    events: detailRows,
  };
}

function querySession(database, host, sessionId) {
  const rows = database.prepare(`
    SELECT id, host, session_id, kind, at, message, outcome, project, session_url, session_state, title
    FROM events
    WHERE host = ? AND session_id = ? AND kind <> 'seen'
    ORDER BY at ASC
    LIMIT 400
  `).all(host, sessionId);
  return {
    host,
    session_id: sessionId,
    serverTime: Date.now() / 1000,
    events: rows,
  };
}

function clientApp() {
  const HOST_META = {
    codex: { label: "Codex", color: "#2563EB" },
    claude: { label: "Claude Code", color: "#D97706" },
    antigravity: { label: "Antigravity", color: "#16A34A" },
    chatgpt: { label: "ChatGPT", color: "#0D9488" },
    claude_ai: { label: "Claude.ai", color: "#D97706" },
    gemini_web: { label: "Gemini", color: "#4F46E5" },
    grokbot: { label: "Grok", color: "#9333EA" },
    cowork: { label: "Cowork", color: "#DB2777" },
  };
  const HOST_ORDER = ["codex", "claude", "antigravity", "chatgpt", "claude_ai", "gemini_web", "grokbot", "cowork"];
  const CATEGORY_LABELS = {
    prior_insistence: "Prior Insistence Missed",
    no_ui_cli: "CLI / No-UI Requested",
    sibling_sweep: "Sibling Sweep",
    live_verification: "Live Runtime Proof",
    scope_coverage: "Full Coverage",
    stall_nudge: "Stall / Idle Nudge",
    route_override: "Route Override",
    steering: "Steering",
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const isWide = () => innerWidth >= 900;

  let state = { serverTime: Date.now() / 1000, watcher: null, metrics: null, sessions: [], events: [] };
  let sessions = [];
  let filtered = [];
  let fScope = "all";
  let fHost = "all";
  let fState = "all";
  let fProject = "all";
  let selKey = null;
  let selIdx = -1;
  let viewMode = "sessions"; // "sessions" | "health"
  let mobileView = "list";   // "list" | "detail" | "health"
  let pinnedChatMode = null; // null (auto) | "all" | "prompts"
  let expandAllCards = false;
  let listScrollY = 0;

  let userScrolling = false;
  let scrollIdleTimer = null;
  let pendingSyncData = null;
  let lastListSig = "";
  let lastDetailSig = "";
  let lastHealthSig = "";
  let bottomObserver = null;

  const sessionCache = new Map();
  const expandedCards = new Set();
  const collapsedCards = new Set();

  // --- Theme (dark-mode & dark-mode-toggle guides) ---
  function getStoredTheme() {
    try {
      const v = localStorage.getItem("color-scheme");
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  }
  function applyTheme(mode) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const root = document.documentElement;
    if (mode === "light" || mode === "dark") {
      if (meta) meta.content = mode;
      root.dataset.theme = mode;
    } else {
      if (meta) meta.content = "light dark";
      delete root.dataset.theme;
    }
    document.querySelectorAll("[data-theme-opt]").forEach((btn) => {
      const active = btn.dataset.themeOpt === mode;
      btn.classList.toggle("on", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  function setTheme(mode) {
    try {
      if (mode === "light" || mode === "dark") localStorage.setItem("color-scheme", mode);
      else localStorage.removeItem("color-scheme");
    } catch {}
    applyTheme(mode);
  }
  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") applyTheme(getStoredTheme());
  });

  // --- Formatting helpers ---
  const fmtDuration = (sec) => {
    if (sec == null || !Number.isFinite(sec)) return "—";
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return s ? `${m}m ${s}s` : `${m}m`;
    }
    return `${Math.round(sec / 360) / 10}h`;
  };
  const relTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const n = new Date();
    if (d.toDateString() === n.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const ageLabel = (sec) => {
    if (sec == null) return "";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  };
  const fullTime = (ts) => (ts
    ? new Date(ts * 1000).toLocaleString("en-GB", { timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "short" })
    : "");
  const dateBucket = (ts, nowSec) => {
    if (!ts) return "Earlier";
    const d = new Date(ts * 1000);
    const n = new Date(nowSec * 1000);
    if (d.toDateString() === n.toDateString()) return "Today";
    const y = new Date(n);
    y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return "Earlier";
  };

  function resumeCommand(host, sid, url) {
    if (host === "codex") return "codex resume " + sid;
    if (host === "claude") return "claude --resume " + sid;
    if (host === "antigravity") return "agy --conversation " + sid;
    return url || sid;
  }

  function cleanPreview(msg) {
    if (!msg) return "";
    let t = String(msg).replace(/^\[SAMI'S INTENT GUARDIAN\]\s*(?:DO NOT STOP[^\n]*\n)?/i, "");
    const gap = (t.match(/(?:^|\n)Gap:\s*([^\n]+)/i) || [])[1];
    if (gap) return gap.trim();
    t = t.replace(/^\[([a-z0-9_]+)\]\s*/i, "");
    return t.replace(/\s+/g, " ").trim();
  }

  function deriveStatus(s, evs, now) {
    const hasPending = evs.some((e) => e.kind === "correction" && e.outcome === "pending");
    const latestErr = evs.find((e) => e.kind === "error");
    if (s.session_state === "completed") return "completed";
    if (s.session_state === "pending" || hasPending) return "pending";
    if (s.session_state === "error" || (latestErr && latestErr.at >= s.last_at - 120)) return "error";
    if (s.session_state === "stopped") return "stopped";
    if (s.session_state === "ongoing") return (now - s.last_at < 7200) ? "ongoing" : "stopped";
    return (now - s.last_at < 1800) ? "ongoing" : "completed";
  }

  function buildSessions() {
    const byKey = new Map();
    const now = state.serverTime || Date.now() / 1000;
    for (const s of state.sessions || []) {
      const key = s.host + ":" + s.session_id;
      byKey.set(key, { ...s, key, events: [] });
    }
    for (const ev of state.events || []) {
      const key = ev.host + ":" + ev.session_id;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          host: ev.host,
          session_id: ev.session_id,
          last_at: ev.at,
          project: ev.project,
          title: ev.title,
          session_url: ev.session_url,
          session_state: ev.session_state,
          events: [],
        });
      }
      const obj = byKey.get(key);
      obj.events.push(ev);
      if (!obj.project && ev.project) obj.project = ev.project;
      if (!obj.title && ev.title) obj.title = ev.title;
      if (!obj.session_url && ev.session_url) obj.session_url = ev.session_url;
      if (ev.at > (obj.last_at || 0)) obj.last_at = ev.at;
    }
    sessions = [...byKey.values()].map((s) => {
      s.events.sort((a, b) => a.at - b.at);
      s.status = deriveStatus(s, s.events, now);
      s.corrections = Math.max(Number(s.corrections_count || 0), s.events.filter((e) => e.kind === "correction").length);
      s.deliveredCount = Math.max(Number(s.delivered_count || 0), s.events.filter((e) => e.kind === "delivered").length);
      s.manualCount = Math.max(Number(s.manual_count || 0), s.events.filter((e) => e.kind === "manual_followup").length);
      s.errorCount = Math.max(Number(s.error_count || 0), s.events.filter((e) => e.kind === "error").length);
      s.turnCount = Number(s.turn_count || 0);
      const rev = [...s.events].reverse();
      s.latestMsg = (rev.find((e) => e.kind === "correction" && e.message) || rev.find((e) => e.message) || {}).message || "";
      s.isPrompted = s.corrections > 0 || s.manualCount > 0 || s.errorCount > 0 || s.status === "pending" || s.status === "error";
      return s;
    }).sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
  }

  function effectiveChatMode(s) {
    if (pinnedChatMode) return pinnedChatMode;
    if (!s) return "all";
    return (s.corrections > 0 || s.errorCount > 0) ? "prompts" : "all";
  }

  function syncLayoutMode() {
    const wide = isWide();
    const shell = $("shell");
    shell.dataset.wide = wide ? "1" : "0";
    shell.dataset.view = wide ? viewMode : mobileView;
    const isSessionsTab = viewMode === "sessions";
    $("tabSessions").classList.toggle("on", isSessionsTab);
    $("tabHealth").classList.toggle("on", !isSessionsTab);
    $("tabSessions").setAttribute("aria-selected", isSessionsTab ? "true" : "false");
    $("tabHealth").setAttribute("aria-selected", !isSessionsTab ? "true" : "false");
  }

  function renderHeaderWatcher() {
    const w = state.watcher;
    const dot = $("watcherDot");
    const lbl = $("watcherTitle");
    if (!w) {
      dot.className = "w-dot offline";
      lbl.title = "Watcher: awaiting heartbeat";
    } else {
      const live = Boolean(w.alive);
      dot.className = `w-dot ${live ? "on" : "stale"}`;
      lbl.title = `Watcher v${w.version || "?"} · ${live ? "Live" : "Stale"} (${ageLabel(w.age_sec)}) · ${w.auto_deliver ? "Auto-Deliver ON" : "Observe"} · ${w.ticks ?? 0} ticks`;
    }
  }

  function renderFilterPopover() {
    const scoped = sessions.filter((s) => {
      if (fScope === "prompted") return s.isPrompted;
      if (fScope === "action") return s.status === "pending" || s.status === "error";
      return true;
    });

    const activeHosts = HOST_ORDER.filter((h) => scoped.some((s) => s.host === h));
    if (fHost !== "all" && !activeHosts.includes(fHost)) fHost = "all";
    const hostSel = $("filterHost");
    const hostOpts = [["all", `All platforms (${scoped.length})`], ...activeHosts.map((h) => {
      const cnt = scoped.filter((s) => s.host === h).length;
      return [h, `${HOST_META[h]?.label || h} (${cnt})`];
    })];
    hostSel.innerHTML = hostOpts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    hostSel.value = fHost;

    const baseH = scoped.filter((s) => fHost === "all" || s.host === fHost);
    const stDefs = [
      ["all", `Any status (${baseH.length})`],
      ["pending", `Needs action (${baseH.filter((s) => s.status === "pending").length})`],
      ["ongoing", `Ongoing (${baseH.filter((s) => s.status === "ongoing").length})`],
      ["manual", `Manual follow-up (${baseH.filter((s) => s.manualCount > 0).length})`],
      ["completed", `Completed (${baseH.filter((s) => s.status === "completed").length})`],
      ["error", `Errors (${baseH.filter((s) => s.status === "error").length})`],
    ];
    const stateSel = $("filterState");
    stateSel.innerHTML = stDefs.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    stateSel.value = fState;

    const projCounts = new Map();
    for (const s of baseH) {
      if (s.project) projCounts.set(s.project, (projCounts.get(s.project) || 0) + 1);
    }
    const projs = [...projCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (fProject !== "all" && !projCounts.has(fProject)) fProject = "all";
    const projSel = $("filterProject");
    projSel.innerHTML = [
      `<option value="all">All projects (${baseH.length})</option>`,
      ...projs.map(([p, c]) => `<option value="${esc(p)}">${esc(p)} (${c})</option>`),
    ].join("");
    projSel.value = fProject;

    const activeCount = (fHost !== "all" ? 1 : 0) + (fState !== "all" ? 1 : 0) + (fProject !== "all" ? 1 : 0);
    const badge = $("filterBadge");
    badge.textContent = activeCount ? String(activeCount) : "";
    badge.hidden = activeCount === 0;
    $("filterBtn").classList.toggle("active", activeCount > 0);

    const chips = [];
    if (fHost !== "all") chips.push(`<button type="button" class="active-chip" data-clear="host">${esc(HOST_META[fHost]?.label || fHost)} <span aria-hidden="true">×</span></button>`);
    if (fState !== "all") chips.push(`<button type="button" class="active-chip" data-clear="state">${esc(fState)} <span aria-hidden="true">×</span></button>`);
    if (fProject !== "all") chips.push(`<button type="button" class="active-chip" data-clear="project">${esc(fProject)} <span aria-hidden="true">×</span></button>`);
    const bar = $("activeFilters");
    if (chips.length) {
      bar.innerHTML = chips.join("") + '<button type="button" class="clear-all" data-clear="all">Clear</button>';
      bar.hidden = false;
    } else {
      bar.innerHTML = "";
      bar.hidden = true;
    }
  }

  function rowHtml(s, i) {
    const hm = HOST_META[s.host] || { label: s.host, color: "#64748B" };
    const mainTitle = s.title || s.project || hm.label;
    const dotCls = s.status === "ongoing" ? "dot-live"
      : s.status === "pending" ? "dot-warn"
      : s.status === "error" ? "dot-err"
      : "dot-idle";

    const metaParts = [esc(hm.label)];
    if (s.project && s.project !== mainTitle) metaParts.push(esc(s.project));
    if (s.status === "pending") metaParts.push('<span class="sig-warn">Needs action</span>');
    else if (s.status === "error") metaParts.push('<span class="sig-err">Error</span>');
    if (s.corrections > 0) metaParts.push(`<span>${s.corrections} prompt${s.corrections === 1 ? "" : "s"}</span>`);
    if (s.manualCount > 0) metaParts.push(`<span class="sig-manual">${s.manualCount} manual</span>`);

    const clean = cleanPreview(s.latestMsg);
    const preview = clean || (s.turnCount ? `${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} · clean` : "Monitored · no interventions");
    const isSelected = viewMode === "sessions" && s.key === selKey && isWide();

    return `<button type="button" class="row${isSelected ? " sel" : ""}" data-i="${i}">
      <div class="row-top">
        <span class="s-dot ${dotCls}" aria-hidden="true"></span>
        <span class="row-title">${esc(mainTitle)}</span>
        <time class="row-time">${esc(relTime(s.last_at))}</time>
      </div>
      <div class="row-meta">${metaParts.join('<span class="sep-dot">·</span>')}</div>
      <div class="row-prev">${esc(preview)}</div>
    </button>`;
  }

  function computeListSignature(items, q) {
    const parts = [fScope, fHost, fState, fProject, q, selKey || "", isWide() ? "W" : "N", viewMode];
    for (const s of items) {
      parts.push(`${s.key}|${Math.floor(s.last_at || 0)}|${s.status}|${s.title || ""}|${s.project || ""}|${s.corrections}|${s.deliveredCount}|${s.manualCount}|${s.errorCount}|${s.turnCount}|${(s.latestMsg || "").slice(0, 48)}`);
    }
    return parts.join(";");
  }

  function renderList(force = false) {
    buildSessions();
    renderHeaderWatcher();
    renderFilterPopover();

    const q = $("searchInput").value.trim().toLowerCase();
    $("clearSearch").hidden = !q;

    const scopedAll = sessions.filter((s) => {
      if (fScope === "prompted" && !s.isPrompted) return false;
      if (fScope === "action" && s.status !== "pending" && s.status !== "error") return false;
      if (fHost !== "all" && s.host !== fHost) return false;
      if (fState !== "all" && (fState === "manual" ? s.manualCount === 0 : s.status !== fState)) return false;
      if (fProject !== "all" && s.project !== fProject) return false;
      if (q && ![s.session_id, s.host, HOST_META[s.host]?.label, s.project, s.title, s.latestMsg].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });

    const pCnt = sessions.filter((s) => s.isPrompted).length;
    const aCnt = sessions.filter((s) => s.status === "pending" || s.status === "error").length;
    $("scopeTabs").innerHTML = `
      <button type="button" class="seg-b${fScope === "all" ? " on" : ""}" data-scope="all">All <span>${sessions.length}</span></button>
      <button type="button" class="seg-b${fScope === "prompted" ? " on" : ""}" data-scope="prompted">Prompted <span>${pCnt}</span></button>
      <button type="button" class="seg-b${fScope === "action" ? " on" : ""}" data-scope="action">Action <span>${aCnt}</span></button>
    `;

    filtered = scopedAll;
    const sig = computeListSignature(filtered, q);
    if (force || sig !== lastListSig) {
      lastListSig = sig;
      const now = state.serverTime || Date.now() / 1000;
      const buckets = new Map([["Today", []], ["Yesterday", []], ["Earlier", []]]);
      for (const s of filtered) {
        buckets.get(dateBucket(s.last_at, now)).push(s);
      }
      let idx = 0;
      const html = [...buckets.entries()]
        .filter(([, arr]) => arr.length > 0)
        .map(([label, arr]) => `<div class="sec">${esc(label)} · ${arr.length}</div><div class="group">${arr.map((s) => rowHtml(s, idx++)).join("")}</div>`)
        .join("");
      $("list").innerHTML = html || '<div class="empty">No matching sessions.</div>';
    }

    if (viewMode === "health") {
      if (isWide() || mobileView === "health") renderHealth(force);
      return;
    }

    if (selKey) {
      const k = filtered.findIndex((s) => s.key === selKey);
      if (k >= 0) {
        selIdx = k;
        if (isWide() || mobileView === "detail") {
          renderDetail(false, force);
          fetchSessionDetail(filtered[k], false);
        }
      } else if (isWide() && filtered.length) {
        openAt(0, false);
      }
    } else if (isWide() && filtered.length) {
      openAt(0, false);
    } else if (isWide() && !filtered.length) {
      lastDetailSig = "";
      $("main").innerHTML = '<div class="placeholder">Select a session to inspect prompts &amp; activity</div>';
    }
  }

  function parseCorrectionParts(msg) {
    const clean = msg.replace(/^\[SAMI'S INTENT GUARDIAN\]\s*(?:DO NOT STOP[^\n]*\n)?/i, "").trim();
    const gap = (clean.match(/(?:^|\n)Gap:\s*([\s\S]*?)(?=\n(?:Execute now|Next action|Before finishing)|\nVerify|$)/i) || [])[1];
    const exec = (clean.match(/(?:^|\n)(?:Execute now(?:\s*\([^\n]*?\))?:|Next action:)\s*([\s\S]*?)(?=\n(?:Verify[^\n]*:|Before finishing[^\n]*:)|$)/i) || [])[1];
    const verify = (clean.match(/(?:^|\n)(?:Verify[^\n]*:|Before finishing[^\n]*:)\s*([\s\S]*)$/i) || [])[1];
    if (gap || exec || verify) return { gap, exec, verify };
    return null;
  }

  function buildTimeline(rawEvents, showAllMessages) {
    const sorted = [...(rawEvents || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    const deliveredMsgs = new Set();
    const outcomeByMsg = new Map();
    for (const ev of sorted) {
      if (ev.kind === "delivered" && ev.message) deliveredMsgs.add(ev.message);
      if (ev.kind === "outcome" && ev.message && ev.outcome) {
        outcomeByMsg.set(ev.message, { status: ev.outcome, at: ev.at });
      }
    }
    const items = [];
    const totalPrompts = sorted.filter((e) => e.kind === "correction").length;
    let promptNum = 0;
    const manualList = sorted.filter((e) => e.kind === "manual_followup");
    for (const ev of sorted) {
      if (ev.kind === "delivered" || ev.kind === "outcome") continue;
      if (!showAllMessages && (ev.kind === "turn_user" || ev.kind === "turn_assistant" || ev.kind === "manual_followup")) continue;
      if (ev.kind === "correction") {
        promptNum += 1;
        const outRec = outcomeByMsg.get(ev.message);
        const finOutcome = outRec?.status || ev.outcome || "pending";
        const turnaroundSec = (finOutcome === "verified" && outRec?.at && ev.at && outRec.at >= ev.at)
          ? Math.round(outRec.at - ev.at)
          : null;
        items.push({
          ...ev,
          _promptNum: promptNum,
          _totalPrompts: totalPrompts,
          _delivered: ev.message ? deliveredMsgs.has(ev.message) : false,
          _outcome: finOutcome,
          _turnaroundSec: turnaroundSec,
        });
        continue;
      }
      if (ev.kind === "turn_user") {
        const msgNorm = (ev.message || "").slice(0, 60);
        const dupManual = manualList.some((m) => Math.abs((m.at || 0) - (ev.at || 0)) < 10 && (m.message || "").includes(msgNorm.slice(0, 25)));
        if (dupManual) continue;
      }
      items.push(ev);
    }
    return items;
  }

  function renderMessageBody(text) {
    const raw = String(text || "");
    if (raw.length <= 750) return `<div class="msg-body">${esc(raw)}</div>`;
    const preview = raw.slice(0, 520).trimEnd() + "…";
    return `<div class="msg-body">${esc(preview)}</div>
      <details class="inline-more"><summary>Show full message (${raw.length} chars)</summary><div class="msg-body full">${esc(raw)}</div></details>`;
  }

  function timelineItemHtml(ev, idx, sessionKey) {
    if (ev.kind === "turn_user") {
      return `<article class="msg msg-user">
        <header class="msg-head"><strong>You</strong><time>${esc(fullTime(ev.at))}</time></header>
        ${renderMessageBody(ev.message)}
      </article>`;
    }
    if (ev.kind === "manual_followup") {
      const m = (ev.message || "").match(/^\[([a-z0-9_]+)\]\s*([\s\S]*)$/i);
      const cat = m ? m[1] : "steering";
      const snippet = m ? m[2] : (ev.message || "");
      return `<article class="msg msg-manual">
        <header class="msg-head"><strong>You · Follow-up</strong><span class="tag-inline">${esc(CATEGORY_LABELS[cat] || cat)}</span><time>${esc(fullTime(ev.at))}</time></header>
        ${renderMessageBody(snippet)}
      </article>`;
    }
    if (ev.kind === "turn_assistant") {
      return `<article class="msg msg-agent">
        <header class="msg-head"><strong>Agent</strong><time>${esc(fullTime(ev.at))}</time></header>
        ${renderMessageBody(ev.message)}
      </article>`;
    }
    if (ev.kind === "correction") {
      const statusCls = ev._outcome === "verified" ? "ok" : ev._outcome === "pending" ? "warn" : "muted";
      const parts = ev.message ? parseCorrectionParts(ev.message) : null;
      const cardId = `${sessionKey}:${ev.id || idx}`;
      const defaultOpen = ev._outcome === "pending" || ev._promptNum === ev._totalPrompts;
      const isOpen = expandAllCards || (!collapsedCards.has(cardId) && (expandedCards.has(cardId) || defaultOpen));
      let body = "";
      if (parts) {
        const hasMore = Boolean(parts.exec || parts.verify);
        const moreHtml = hasMore
          ? `<details class="ev-more" data-card-id="${esc(cardId)}"${isOpen ? " open" : ""}><summary>Execution contract &amp; proof</summary><div class="ev-kv">${parts.exec ? `<div><b>Execute</b>${esc(parts.exec.trim())}</div>` : ""}${parts.verify ? `<div><b>Verify</b>${esc(parts.verify.trim())}</div>` : ""}</div></details>`
          : "";
        body = `${parts.gap ? `<div class="ev-gap">${esc(parts.gap.trim())}</div>` : ""}${moreHtml}`;
      } else {
        body = `<div class="ev-gap">${esc(ev.message)}</div>`;
      }
      const metaBits = [
        ev._delivered ? "Delivered" : null,
        ev._outcome,
        ev._turnaroundSec != null ? `resolved in ${fmtDuration(ev._turnaroundSec)}` : null,
      ].filter(Boolean);

      return `<article class="g-card">
        <header class="g-head">
          <strong>Guardian #${ev._promptNum}</strong>
          <span class="g-status ${statusCls}">${esc(metaBits.join(" · "))}</span>
          <time>${esc(fullTime(ev.at))}</time>
          ${ev.message ? `<button type="button" class="text-btn" data-copy-ev="${idx}">Copy</button>` : ""}
        </header>
        ${body}
      </article>`;
    }
    if (ev.kind === "error") {
      return `<article class="g-card g-err">
        <header class="g-head"><strong>Observer Error</strong><time>${esc(fullTime(ev.at))}</time></header>
        <div class="ev-gap">${esc(ev.message)}</div>
      </article>`;
    }
    return "";
  }

  function detailHtml(s) {
    const hm = HOST_META[s.host] || { label: s.host };
    const title = s.title || s.project || hm.label;
    const cmd = resumeCommand(s.host, s.session_id, s.session_url);
    const stLabels = { ongoing: "Ongoing", completed: "Completed", pending: "Needs action", error: "Error", stopped: "Idle" };
    const stLbl = stLabels[s.status] || "Observed";

    const cached = sessionCache.get(s.key);
    const fullRaw = cached?.events?.length ? cached.events : s.events;
    const mode = effectiveChatMode(s);
    const promptsTimeline = buildTimeline(fullRaw, false);
    const allTimeline = buildTimeline(fullRaw, true);
    const timeline = mode === "all" ? allTimeline : promptsTimeline;
    const hasTurns = allTimeline.some((x) => x.kind === "turn_user" || x.kind === "turn_assistant");
    const promptTotal = promptsTimeline.filter((x) => x.kind === "correction").length;

    const metaItems = [hm.label, s.project, stLbl, fullTime(s.last_at)].filter(Boolean);

    return `<div class="d-top-wrap">
        <div class="d-top">
          <div class="d-top-left">
            <button type="button" class="back-btn" data-act="back" aria-label="Back to sessions">← Sessions</button>
            <div class="d-titles">
              <div class="d-tt">${esc(title)}</div>
              <div class="d-sub">${esc(metaItems.join(" · "))}</div>
            </div>
          </div>
          <div class="d-acts">
            ${s.session_url ? `<a class="ghost-btn" href="${esc(s.session_url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
            <button type="button" class="ghost-btn" data-copy-cmd="${esc(cmd)}">${s.session_url ? "Copy URL" : "Copy cmd"}</button>
            <div class="nav-pair">
              <button type="button" class="icon-btn" data-act="prev" ${selIdx <= 0 ? "disabled" : ""} aria-label="Previous session">↑</button>
              <button type="button" class="icon-btn" data-act="next" ${selIdx >= filtered.length - 1 ? "disabled" : ""} aria-label="Next session">↓</button>
            </div>
          </div>
        </div>
      </div>
      <div class="d-body">
        <div class="d-controls">
          <div class="seg" role="group" aria-label="Timeline mode">
            <button type="button" class="seg-b${mode === "all" ? " on" : ""}" data-mode="all">All activity${cached?.events ? ` <span>${allTimeline.length}</span>` : ""}</button>
            <button type="button" class="seg-b${mode === "prompts" ? " on" : ""}" data-mode="prompts">Guardian only <span>${promptsTimeline.length}</span></button>
          </div>
          <div class="d-controls-r">
            ${promptTotal > 1 ? `<button type="button" class="text-btn" data-toggle-expand="1">${expandAllCards ? "Collapse all" : "Expand all"}</button>` : ""}
            <details class="info-pop">
              <summary class="text-btn">Info</summary>
              <div class="info-card">
                <div><span>Session ID</span><code>${esc(s.session_id)}</code></div>
                <div><span>Turns</span><span>${s.turnCount}</span></div>
                <div><span>Prompts / Delivered</span><span>${s.corrections} / ${s.deliveredCount}</span></div>
                <div><span>Manual follow-ups</span><span>${s.manualCount}</span></div>
                <div><span>Last activity</span><span>${esc(fullTime(s.last_at))}</span></div>
              </div>
            </details>
          </div>
        </div>
        ${mode === "all" && !hasTurns ? `<div class="hint-line">${cached?.loading ? "Loading conversation messages…" : "Only Guardian & follow-up events are stored for this session."}</div>` : ""}
        <div class="thread">
          ${timeline.length ? timeline.map((e, i) => timelineItemHtml(e, i, s.key)).join("") : '<div class="empty-thread">Monitored cleanly — no Guardian interventions required.</div>'}
        </div>
        <div class="scroll-sentinel" aria-hidden="true"></div>
      </div>
      <button type="button" class="jump-bot" data-jump-bot="1">↓ Latest</button>`;
  }

  function setupDetailScrollObserver() {
    if (bottomObserver) {
      bottomObserver.disconnect();
      bottomObserver = null;
    }
    const main = $("main");
    const sentinel = main.querySelector(".scroll-sentinel");
    const jb = main.querySelector("[data-jump-bot]");
    if (!sentinel || !jb) return;

    if (!CSS.supports("container-type", "scroll-state")) {
      const root = isWide() ? main : null;
      bottomObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const atBottom = entry.isIntersecting;
          main.classList.toggle("at-bottom", atBottom);
          if (atBottom && document.activeElement === jb) {
            main.focus({ preventScroll: true });
          }
        }
      }, { root, threshold: 0 });
      bottomObserver.observe(sentinel);
    } else {
      jb.addEventListener("focusout", () => {
        if (!document.activeElement || document.activeElement === document.body) {
          main.focus({ preventScroll: true });
        }
      });
    }
  }

  function renderDetail(scrollToBottom = false, force = false) {
    const s = filtered[selIdx];
    if (!s) return;
    const cached = sessionCache.get(s.key);
    const fullRaw = cached?.events?.length ? cached.events : s.events;
    const lastEv = fullRaw[fullRaw.length - 1] || {};
    const mode = effectiveChatMode(s);
    const sig = `${s.key}|${mode}|${expandAllCards}|${fullRaw.length}|${lastEv.id || ""}|${lastEv.at || ""}|${lastEv.outcome || ""}|${Boolean(cached?.loading)}|${selIdx}|${filtered.length}`;
    if (!force && sig === lastDetailSig) return;

    const main = $("main");
    const prevKey = lastDetailSig.split("|")[0];
    const isSameSession = prevKey === s.key;
    const wide = isWide();
    const nearBottom = wide
      ? (main.scrollHeight - main.scrollTop - main.clientHeight) < 100
      : (document.documentElement.scrollHeight - window.scrollY - window.innerHeight) < 100;
    const prevScroll = wide ? main.scrollTop : window.scrollY;

    lastDetailSig = sig;
    main.innerHTML = detailHtml(s);
    setupDetailScrollObserver();

    if (scrollToBottom) {
      if (wide) {
        if (main.scrollHeight > main.clientHeight + 120) main.scrollTop = main.scrollHeight;
        else main.scrollTop = 0;
      } else {
        window.scrollTo(0, 0);
      }
    } else if (isSameSession) {
      if (nearBottom && wide) {
        main.scrollTop = main.scrollHeight;
      } else if (wide) {
        main.scrollTop = prevScroll;
      }
    }

    document.querySelectorAll("#list .row").forEach((r) => r.classList.toggle("sel", +r.dataset.i === selIdx));
  }

  async function fetchSessionDetail(s, scrollBottom = false) {
    if (!s) return;
    const prev = sessionCache.get(s.key);
    if (prev && prev.last_at === s.last_at && prev.events) return;
    sessionCache.set(s.key, { ...(prev || {}), loading: true });
    try {
      const res = await fetch(`/api/session?host=${encodeURIComponent(s.host)}&session_id=${encodeURIComponent(s.session_id)}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        sessionCache.set(s.key, { last_at: s.last_at, loading: false, events: data.events || [] });
        if (selKey === s.key && viewMode === "sessions") {
          renderDetail(scrollBottom, true);
        }
      }
    } catch {}
  }

  function healthHtml() {
    const w = state.watcher || {};
    const m = state.metrics || {};
    const perHost = m.per_host || {};
    const corrs = Number(m.corrections || 0);
    const deliv = Number(m.delivered || 0);
    const ver = Number(m.verified || 0);
    const closed = ver + Number(m.superseded || 0) + Number(m.redirected || 0);
    const delivRate = corrs ? `${Math.round((deliv / corrs) * 100)}%` : "—";
    const verRate = closed ? `${Math.round((ver / closed) * 100)}%` : "—";
    const m24 = m.last_24h || {};
    const theme = getStoredTheme();

    const platRows = HOST_ORDER.map((h) => {
      const hm = HOST_META[h] || { label: h };
      const st = perHost[h] || {};
      const last = st.last_at ? relTime(st.last_at) : "—";
      return `<tr class="plat-row" data-jump-host="${esc(h)}">
        <td><strong>${esc(hm.label)}</strong></td>
        <td class="num">${st.sessions || 0}</td>
        <td class="num">${st.corrections || 0}</td>
        <td class="num">${st.delivered || 0}</td>
        <td class="num">${st.verified || 0}</td>
        <td class="num">${st.manual_followups || 0}</td>
        <td class="num">${st.errors || 0}</td>
        <td class="muted">${esc(last)}</td>
      </tr>`;
    }).join("");

    const cats = Object.entries(m.manual_by_category || {}).sort((a, b) => b[1] - a[1]);
    const catLine = cats.length
      ? cats.map(([k, v]) => `${CATEGORY_LABELS[k] || k}: ${v}`).join(" · ")
      : "None logged yet";

    const recentManual = (m.recent_manual || []).slice(0, 15).map((r) => {
      const hm = HOST_META[r.host] || { label: r.host };
      return `<button type="button" class="manual-row" data-jump-key="${esc(r.host + ":" + r.session_id)}">
        <div class="manual-top">
          <strong>${esc(r.project || hm.label)}</strong>
          <span>${esc(hm.label)} · ${esc(CATEGORY_LABELS[r.category] || r.category)}</span>
          <time>${esc(relTime(r.at))}</time>
        </div>
        <div class="manual-msg">${esc(r.snippet)}</div>
      </button>`;
    }).join("");

    const watchEvents = Array.isArray(w.recent_events) ? w.recent_events : [];
    const watchHtml = watchEvents.length
      ? watchEvents.slice(0, 12).map((ev) => `<div class="w-ev"><span>${esc(ev.kind || "info")}</span><span>${esc(ev.detail || "")}</span><time>${esc(ev.at ? relTime(Date.parse(ev.at) / 1000) : "")}</time></div>`).join("")
      : '<div class="muted">Waiting for next watcher event…</div>';

    return `<div class="d-top-wrap">
        <div class="d-top">
          <div class="d-top-left">
            <button type="button" class="back-btn" data-act="back-health">← Sessions</button>
            <div class="d-titles">
              <div class="d-tt">System Health</div>
              <div class="d-sub">${w.alive ? `Watcher v${esc(w.version || "?")} live (${esc(ageLabel(w.age_sec))})` : "Watcher heartbeat pending"} · ${esc(w.auto_deliver ? "Auto-deliver ON" : "Observe")} · ${esc(w.ticks ?? 0)} ticks</div>
            </div>
          </div>
        </div>
      </div>
      <div class="d-body health-body">
        <div class="metric-grid">
          <div class="metric-cell"><div class="m-val">${corrs}</div><div class="m-lbl">Guardian Prompts</div><div class="m-sub">${delivRate} delivered (${deliv}) · ${m.pending ?? 0} open</div></div>
          <div class="metric-cell"><div class="m-val">${ver}</div><div class="m-lbl">Verified Closed</div><div class="m-sub">${verRate} of ${closed} · median ${esc(fmtDuration(m.median_resolution_sec))}</div></div>
          <button type="button" class="metric-cell metric-btn" data-kpi="manual"><div class="m-val">${m.manual_followups ?? 0}</div><div class="m-lbl">Manual Follow-Ups</div><div class="m-sub">${m24.manual_followups ?? 0} in last 24h → filter</div></button>
          <button type="button" class="metric-cell metric-btn" data-kpi="error"><div class="m-val">${m.errors ?? 0}</div><div class="m-lbl">Observer Errors</div><div class="m-sub">${m24.errors ?? 0} in last 24h → filter</div></button>
        </div>

        <h2 class="h-sec">Platforms</h2>
        <div class="table-wrap">
          <table class="plat-table">
            <thead><tr><th>Platform</th><th class="num">Sessions</th><th class="num">Prompts</th><th class="num">Deliv</th><th class="num">Verified</th><th class="num">Manual</th><th class="num">Errors</th><th>Last active</th></tr></thead>
            <tbody>${platRows}</tbody>
          </table>
        </div>

        <h2 class="h-sec">Recent Manual Follow-Ups</h2>
        <p class="h-note">${esc(catLine)}</p>
        <div class="manual-list">${recentManual || '<div class="muted">Zero post-Guardian manual follow-ups captured yet.</div>'}</div>

        <details class="watcher-log">
          <summary>Watcher activity log (${watchEvents.length})</summary>
          <div class="w-ev-list">${watchHtml}</div>
        </details>

        <div class="health-foot">
          <span class="m-lbl">Appearance</span>
          <div class="seg" role="group" aria-label="Appearance">
            <button type="button" class="seg-b${theme === "system" ? " on" : ""}" data-theme-opt="system">System</button>
            <button type="button" class="seg-b${theme === "light" ? " on" : ""}" data-theme-opt="light">Light</button>
            <button type="button" class="seg-b${theme === "dark" ? " on" : ""}" data-theme-opt="dark">Dark</button>
          </div>
        </div>
      </div>`;
  }

  function renderHealth(force = false) {
    const w = state.watcher || {};
    const m = state.metrics || {};
    const sig = `${w.ticks || 0}|${w.age_sec || 0}|${m.corrections || 0}|${m.verified || 0}|${m.manual_followups || 0}|${m.errors || 0}|${getStoredTheme()}`;
    if (!force && sig === lastHealthSig) return;
    lastHealthSig = sig;
    $("main").innerHTML = healthHtml();
  }

  function openAt(i, pushHistory = true) {
    if (i < 0 || i >= filtered.length) return;
    const s = filtered[i];
    if (!isWide() && mobileView === "list") {
      listScrollY = window.scrollY;
    }
    selIdx = i;
    selKey = s.key;
    viewMode = "sessions";
    if (!isWide()) {
      mobileView = "detail";
      if (pushHistory) {
        try { history.pushState({ igView: "detail", key: s.key }, ""); } catch {}
      }
    }
    syncLayoutMode();
    renderDetail(true, true);
    fetchSessionDetail(s, true);
  }

  function backToList(fromPop = false) {
    if (isWide()) return;
    mobileView = "list";
    viewMode = "sessions";
    syncLayoutMode();
    renderList(false);
    requestAnimationFrame(() => window.scrollTo(0, listScrollY));
    if (!fromPop && history.state?.igView) {
      try { history.back(); } catch {}
    }
  }

  function openKey(key) {
    fScope = "all";
    fHost = "all";
    fState = "all";
    fProject = "all";
    $("searchInput").value = "";
    viewMode = "sessions";
    selKey = key;
    syncLayoutMode();
    renderList(true);
    const idx = filtered.findIndex((s) => s.key === key);
    if (idx >= 0) openAt(idx, true);
  }

  function toast(t) {
    const el = $("toast");
    el.textContent = t;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), 1700);
  }

  // --- Popover polyfill fallback for older browsers (CSP forbids external scripts) ---
  function setupPopoverFallback() {
    if (Object.hasOwn(HTMLElement.prototype, "popover")) return;
    const pop = $("filtersPopover");
    const btn = $("filterBtn");
    if (!pop || !btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.toggle(":popover-open");
    });
    document.addEventListener("click", (e) => {
      if (!pop.contains(e.target) && e.target !== btn) pop.classList.remove(":popover-open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") pop.classList.remove(":popover-open");
    });
  }

  // --- Mobile sticky header hide-on-scroll fallback for browsers without scroll-state ---
  function setupHeaderHideFallback() {
    if (CSS.supports("container-type", "scroll-state")) return;
    const bar = $("topBar");
    let lastY = window.scrollY;
    window.addEventListener("scroll", () => {
      if (isWide()) {
        bar.classList.remove("is-hidden");
        return;
      }
      const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const y = Math.max(0, Math.min(window.scrollY, maxY));
      if (y === lastY) return;
      bar.classList.toggle("is-hidden", y > lastY && y > bar.offsetHeight);
      lastY = y;
    }, { passive: true });
  }

  // --- Event bindings ---
  $("main").addEventListener("toggle", (e) => {
    const det = e.target;
    if (!(det instanceof HTMLDetailsElement) || !det.dataset.cardId) return;
    const id = det.dataset.cardId;
    if (det.open) { expandedCards.add(id); collapsedCards.delete(id); }
    else { expandedCards.delete(id); collapsedCards.add(id); }
  }, true);

  $("main").addEventListener("click", (e) => {
    const expBtn = e.target.closest("[data-toggle-expand]");
    if (expBtn) {
      expandAllCards = !expandAllCards;
      if (!expandAllCards) { expandedCards.clear(); collapsedCards.clear(); }
      renderDetail(false, true);
      return;
    }
    const jb = e.target.closest("[data-jump-bot]");
    if (jb) {
      if (isWide()) {
        const m = $("main");
        m.scrollTo({ top: m.scrollHeight, behavior: "smooth" });
      } else {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      }
      return;
    }
    const modeBtn = e.target.closest("[data-mode]");
    if (modeBtn) {
      pinnedChatMode = modeBtn.dataset.mode;
      const s = filtered[selIdx];
      renderDetail(false, true);
      if (pinnedChatMode === "all" && s) fetchSessionDetail(s, false);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "back") backToList(false);
      else if (a === "back-health") {
        viewMode = "sessions";
        mobileView = "list";
        syncLayoutMode();
        renderList(false);
      } else if (a === "prev") openAt(selIdx - 1, false);
      else if (a === "next") openAt(selIdx + 1, false);
      return;
    }
    const jHost = e.target.closest("[data-jump-host]");
    if (jHost) {
      fScope = "all";
      fHost = jHost.dataset.jumpHost;
      fState = "all";
      fProject = "all";
      viewMode = "sessions";
      mobileView = "list";
      selKey = null;
      syncLayoutMode();
      renderList(true);
      return;
    }
    const kpi = e.target.closest("[data-kpi]");
    if (kpi) {
      fScope = "prompted";
      fState = kpi.dataset.kpi;
      viewMode = "sessions";
      mobileView = "list";
      selKey = null;
      syncLayoutMode();
      renderList(true);
      return;
    }
    const jKey = e.target.closest("[data-jump-key]");
    if (jKey) {
      openKey(jKey.dataset.jumpKey);
      return;
    }
    const themeBtn = e.target.closest("[data-theme-opt]");
    if (themeBtn) {
      setTheme(themeBtn.dataset.themeOpt);
      return;
    }
    const cmdBtn = e.target.closest("[data-copy-cmd]");
    if (cmdBtn) {
      navigator.clipboard?.writeText(cmdBtn.dataset.copyCmd).then(() => toast("Copied"), () => toast(cmdBtn.dataset.copyCmd));
      return;
    }
    const evBtn = e.target.closest("[data-copy-ev]");
    if (evBtn) {
      const s = filtered[selIdx];
      const cached = s ? sessionCache.get(s.key) : null;
      const rawEvents = (cached?.events?.length) ? cached.events : (s?.events || []);
      const timeline = buildTimeline(rawEvents, effectiveChatMode(s) === "all");
      const msg = timeline[+evBtn.dataset.copyEv]?.message || "";
      if (msg) navigator.clipboard?.writeText(msg).then(() => toast("Copied prompt"), () => toast("Copy unavailable"));
    }
  });

  $("tabSessions").onclick = () => {
    viewMode = "sessions";
    if (!isWide()) mobileView = "list";
    syncLayoutMode();
    renderList(true);
  };
  $("tabHealth").onclick = () => {
    viewMode = "health";
    if (!isWide()) mobileView = "health";
    syncLayoutMode();
    renderHealth(true);
    if (!isWide()) window.scrollTo(0, 0);
  };

  $("scopeTabs").onclick = (e) => {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    fScope = b.dataset.scope;
    selKey = null;
    renderList(true);
  };
  $("filterHost").onchange = (e) => { fHost = e.target.value; selKey = null; renderList(true); };
  $("filterState").onchange = (e) => { fState = e.target.value; selKey = null; renderList(true); };
  $("filterProject").onchange = (e) => { fProject = e.target.value; selKey = null; renderList(true); };
  $("resetFiltersBtn").onclick = () => {
    fHost = "all"; fState = "all"; fProject = "all";
    renderList(true);
  };
  $("activeFilters").onclick = (e) => {
    const b = e.target.closest("[data-clear]");
    if (!b) return;
    const c = b.dataset.clear;
    if (c === "host" || c === "all") fHost = "all";
    if (c === "state" || c === "all") fState = "all";
    if (c === "project" || c === "all") fProject = "all";
    renderList(true);
  };
  $("filtersPopover").onclick = (e) => {
    const t = e.target.closest("[data-theme-opt]");
    if (t) setTheme(t.dataset.themeOpt);
  };

  $("searchInput").addEventListener("input", () => renderList(true));
  $("clearSearch").onclick = () => {
    $("searchInput").value = "";
    $("searchInput").focus();
    renderList(true);
  };
  $("list").onclick = (e) => {
    const r = e.target.closest(".row");
    if (r) openAt(+r.dataset.i, true);
  };

  window.addEventListener("popstate", () => {
    if (!isWide() && mobileView !== "list") {
      backToList(true);
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); openAt(Math.min(filtered.length - 1, selIdx + 1), false); }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); openAt(Math.max(0, selIdx - 1), false); }
  });
  window.addEventListener("resize", () => {
    syncLayoutMode();
    renderList(false);
  });

  function markScrolling() {
    userScrolling = true;
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      userScrolling = false;
      if (pendingSyncData) {
        const d = pendingSyncData;
        pendingSyncData = null;
        state = d;
        renderList(false);
      }
    }, 300);
  }
  window.addEventListener("scroll", markScrolling, { passive: true });
  $("side").addEventListener("scroll", markScrolling, { passive: true });
  $("main").addEventListener("scroll", markScrolling, { passive: true });

  async function syncLive(manual) {
    if (document.hidden && !manual) return;
    if (manual) $("refreshBtn").classList.add("spin");
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (!manual && userScrolling) {
          pendingSyncData = data;
        } else {
          state = data;
          const hasSel = !manual && Boolean(window.getSelection()?.toString()?.trim());
          if (!hasSel) renderList(manual);
        }
      }
    } catch {}
    if (manual) setTimeout(() => $("refreshBtn").classList.remove("spin"), 350);
  }

  applyTheme(getStoredTheme());
  setupPopoverFallback();
  setupHeaderHideFallback();
  syncLayoutMode();
  $("refreshBtn").onclick = () => syncLive(true);
  syncLive(false);
  setInterval(() => syncLive(false), 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncLive(false); });
}

function dashboardHtml() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<script>try{var s=localStorage.getItem("color-scheme");if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;document.documentElement.dataset.theme=s;}}catch(e){}</script>
<meta name="robots" content="noindex,nofollow">
<title>Intent Guardian</title>
<style>
:root{
  --bg-l:#FFFFFF;--bg-2-l:#F7F7F8;--hover-l:#EFEFF1;--sel-l:#ECEEF2;--border-l:rgba(17,19,24,.09);
  --text-l:#111318;--text-2-l:#59606D;--text-3-l:#858C99;--accent-l:#1D4ED8;--accent-soft-l:rgba(29,78,216,.09);
  --bar-l:rgba(255,255,255,.92);--sb-track-l:#F3F4F6;--sb-thumb-l:#C4C9D4;

  --bg-d:#0E1014;--bg-2-d:#13161C;--hover-d:#1B1F27;--sel-d:#202530;--border-d:rgba(255,255,255,.09);
  --text-d:#ECEEF2;--text-2-d:#939AA6;--text-3-d:#646B78;--accent-d:#60A5FA;--accent-soft-d:rgba(96,165,250,.14);
  --bar-d:rgba(14,16,20,.92);--sb-track-d:#161920;--sb-thumb-d:#3A4150;

  --bg:var(--bg-l);--bg-2:var(--bg-2-l);--hover:var(--hover-l);--sel:var(--sel-l);--border:var(--border-l);
  --text:var(--text-l);--text-2:var(--text-2-l);--text-3:var(--text-3-l);--accent:var(--accent-l);--accent-soft:var(--accent-soft-l);
  --bar:var(--bar-l);--sb-track:var(--sb-track-l);--sb-thumb:var(--sb-thumb-l);

  --green:#16A34A;--amber:#D97706;--red:#DC2626;--rose:#DB2777;
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;
  --st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px);

  color-scheme:light dark;
  scrollbar-color:var(--sb-thumb) var(--sb-track);
}
:root:has(> head > meta[name="color-scheme"][content="dark"]){color-scheme:dark}
:root:has(> head > meta[name="color-scheme"][content="light"]){color-scheme:light}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:var(--bg-d);--bg-2:var(--bg-2-d);--hover:var(--hover-d);--sel:var(--sel-d);--border:var(--border-d);
    --text:var(--text-d);--text-2:var(--text-2-d);--text-3:var(--text-3-d);--accent:var(--accent-d);--accent-soft:var(--accent-soft-d);
    --bar:var(--bar-d);--sb-track:var(--sb-track-d);--sb-thumb:var(--sb-thumb-d);
  }
}
html[data-theme="dark"]{
  --bg:var(--bg-d);--bg-2:var(--bg-2-d);--hover:var(--hover-d);--sel:var(--sel-d);--border:var(--border-d);
  --text:var(--text-d);--text-2:var(--text-2-d);--text-3:var(--text-3-d);--accent:var(--accent-d);--accent-soft:var(--accent-soft-d);
  --bar:var(--bar-d);--sb-track:var(--sb-track-d);--sb-thumb:var(--sb-thumb-d);
}
@supports (color:light-dark(white,black)){
  :root{
    --bg:light-dark(var(--bg-l),var(--bg-d));
    --bg-2:light-dark(var(--bg-2-l),var(--bg-2-d));
    --hover:light-dark(var(--hover-l),var(--hover-d));
    --sel:light-dark(var(--sel-l),var(--sel-d));
    --border:light-dark(var(--border-l),var(--border-d));
    --text:light-dark(var(--text-l),var(--text-d));
    --text-2:light-dark(var(--text-2-l),var(--text-2-d));
    --text-3:light-dark(var(--text-3-l),var(--text-3-d));
    --accent:light-dark(var(--accent-l),var(--accent-d));
    --accent-soft:light-dark(var(--accent-soft-l),var(--accent-soft-d));
    --bar:light-dark(var(--bar-l),var(--bar-d));
    --sb-track:light-dark(var(--sb-track-l),var(--sb-track-d));
    --sb-thumb:light-dark(var(--sb-thumb-l),var(--sb-thumb-d));
  }
}
@supports not (scrollbar-color:auto){
  *{scrollbar-width:auto}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:var(--sb-thumb);border-radius:5px}
  ::-webkit-scrollbar-track{background:var(--sb-track)}
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{font-family:var(--font);background:var(--bg);color:var(--text);font-size:15px;-webkit-font-smoothing:antialiased;container-type:scroll-state;scroll-padding-top:56px}
body{min-height:100dvh;background:var(--bg);overflow-x:clip}
button,input,select{font:inherit;color:inherit}
button{background:none;border:0;cursor:pointer}
a{color:inherit}

/* Top bar */
.top-bar{position:sticky;top:0;z-index:30;height:calc(48px + var(--st));padding:var(--st) 14px 0;background:var(--bar);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;transition:transform .2s ease}
.brand{display:flex;align-items:center;gap:8px;min-width:0}
.brand-name{font-size:15px;font-weight:600;letter-spacing:-.2px;white-space:nowrap}
.w-dot{width:7px;height:7px;border-radius:50%;background:var(--text-3);flex:none}
.w-dot.on{background:var(--green)}
.w-dot.stale{background:var(--amber)}
.top-actions{display:flex;align-items:center;gap:8px}
.icon-btn{width:30px;height:30px;border-radius:7px;display:inline-grid;place-items:center;color:var(--text-2);border:1px solid transparent;transition:background .12s,color .12s}
.icon-btn:hover{background:var(--hover);color:var(--text)}
.icon-btn:disabled{opacity:.35;pointer-events:none}
.icon-btn svg{width:16px;height:16px}
.icon-btn.spin svg{animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Hide mobile top-bar on scroll down, restore on scroll up */
@media (max-width:899px){
  @container scroll-state((scrolled:bottom) and (scrollable:top)){
    .top-bar{transform:translateY(-100%)}
  }
  .top-bar.is-hidden:not(:focus-within){transform:translateY(-100%)}
  .top-bar:focus-within{transform:none}
}

/* Shell layout: real document scroll on mobile, 2-col independent scroll on desktop */
.shell{display:block;min-height:calc(100dvh - 48px - var(--st))}
.shell[data-wide="0"][data-view="list"] .main{display:none}
.shell[data-wide="0"][data-view="detail"] .side,
.shell[data-wide="0"][data-view="health"] .side{display:none}
.app-frame:has(.shell[data-wide="0"][data-view="detail"]) .top-bar{display:none}

@media (min-width:900px){
  html,body{height:100%;overflow:hidden}
  .app-frame{height:100dvh;display:grid;grid-template-rows:48px minmax(0,1fr)}
  .top-bar{position:relative;height:48px;padding:0 18px}
  .shell{display:grid;grid-template-columns:360px minmax(0,1fr);height:100%;min-height:0;overflow:hidden}
  .side{height:100%;overflow-y:auto;overscroll-behavior-y:contain;border-right:1px solid var(--border);background:var(--bg-2)}
  .main{height:100%;overflow-y:auto;overscroll-behavior-y:contain;background:var(--bg);position:relative;container-type:scroll-state;container-name:detail-scroll;scroll-padding-top:64px;outline:none}
}
@media (min-width:1200px){
  .shell{grid-template-columns:390px minmax(0,1fr)}
}

/* Segmented controls */
.seg{display:inline-flex;background:var(--bg-2);border:1px solid var(--border);padding:2px;border-radius:8px;gap:2px}
.seg-b{height:25px;padding:0 9px;border-radius:6px;font-size:12.5px;font-weight:500;color:var(--text-2);display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:background .12s,color .12s}
.seg-b span{font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.seg-b.on{background:var(--bg);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.seg-b.on span{color:var(--text-2)}

/* List toolbar */
.list-toolbar{position:sticky;top:0;z-index:10;background:var(--bg-2);border-bottom:1px solid var(--border);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
@media (max-width:899px){.list-toolbar{position:static;background:var(--bg)}}
.search-box{display:flex;align-items:center;gap:7px;height:34px;padding:0 10px;border-radius:8px;background:var(--bg);border:1px solid var(--border)}
.search-box:focus-within{border-color:var(--accent)}
.search-box svg{width:14px;height:14px;color:var(--text-3);flex:none}
.search-box input{flex:1;min-width:0;border:0;background:none;outline:none;font-size:13.5px}
.search-box input::placeholder{color:var(--text-3)}
.clear-x{font-size:15px;color:var(--text-3);padding:0 4px;line-height:1}
.toolbar-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.filter-btn{height:29px;padding:0 10px;border-radius:7px;border:1px solid var(--border);background:var(--bg);font-size:12.5px;font-weight:500;color:var(--text-2);display:inline-flex;align-items:center;gap:6px}
.filter-btn:hover{background:var(--hover);color:var(--text)}
.filter-btn.active{border-color:var(--accent);color:var(--accent)}
.f-badge{background:var(--accent);color:#fff;font-size:11px;font-weight:600;padding:0 5px;border-radius:9px;line-height:16px}
.active-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.active-filters[hidden]{display:none}
.active-chip{font-size:12px;padding:2px 8px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-weight:500;display:inline-flex;align-items:center;gap:4px}
.clear-all{font-size:12px;color:var(--text-2);padding:2px 6px}
.clear-all:hover{color:var(--text)}

/* Popover */
.popover-panel{width:min(320px,calc(100vw - 24px));padding:14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-shadow:0 12px 32px rgba(0,0,0,.14)}
.popover-panel[popover]:is(:popover-open,.\:popover-open){display:flex;flex-direction:column;gap:12px;margin:auto}
@supports not selector(:popover-open){[popover]:not(.\:popover-open){display:none}}
.popover-panel::backdrop{background:rgba(0,0,0,.22)}
.pop-field{display:flex;flex-direction:column;gap:4px}
.pop-field label{font-size:11.5px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.3px}
.pop-field select{height:34px;padding:0 8px;border-radius:7px;border:1px solid var(--border);background:var(--bg-2);font-size:13.5px}
.pop-foot{display:flex;justify-content:flex-end;border-top:1px solid var(--border);padding-top:10px}
.text-btn{font-size:12.5px;font-weight:500;color:var(--accent);padding:3px 6px;border-radius:5px}
.text-btn:hover{background:var(--accent-soft)}

/* Session List */
.list-wrap{padding-bottom:calc(28px + var(--sb))}
.sec{font-size:11.5px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.4px;padding:14px 14px 6px}
.group{display:flex;flex-direction:column}
.row{width:100%;text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px;position:relative;transition:background .1s}
.row:hover{background:var(--hover)}
.row.sel{background:var(--sel)}
.row.sel::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent)}
.row-top{display:flex;align-items:center;gap:8px;min-width:0}
.s-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dot-live{background:var(--green)}
.dot-warn{background:var(--amber)}
.dot-err{background:var(--red)}
.dot-idle{border:1.5px solid var(--text-3);background:transparent}
.row-title{flex:1;min-width:0;font-size:14px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.1px}
.row-time{font-family:var(--mono);font-size:11.5px;color:var(--text-3);flex:none;font-variant-numeric:tabular-nums}
.row-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;padding-left:15px;font-size:12px;color:var(--text-2)}
.sep-dot{color:var(--text-3)}
.sig-warn{color:var(--amber);font-weight:550}
.sig-err{color:var(--red);font-weight:550}
.sig-manual{color:var(--rose);font-weight:500}
.row-prev{padding-left:15px;font-size:12.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty,.empty-thread{padding:48px 20px;text-align:center;color:var(--text-2);font-size:14px}

/* Detail Header (state-aware sticky header) */
.d-top-wrap{position:sticky;top:0;z-index:20;container-type:scroll-state;container-name:detail-header}
.d-top{background:var(--bar);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:10px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;transition:box-shadow .18s}
@container detail-header scroll-state(stuck:top){
  .d-top{box-shadow:0 2px 10px rgba(0,0,0,.06)}
}
.d-top-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.back-btn{display:none;font-size:13.5px;font-weight:550;color:var(--accent);padding:4px 8px 4px 2px;white-space:nowrap;flex:none}
@media (max-width:899px){
  .d-top{padding:10px 14px}
  .back-btn{display:inline-flex;align-items:center}
}
.d-titles{min-width:0;flex:1}
.d-tt{font-size:15.5px;font-weight:600;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.d-sub{font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.d-acts{display:flex;align-items:center;gap:6px;flex:none}
.ghost-btn{height:28px;padding:0 9px;border-radius:6px;border:1px solid var(--border);font-size:12px;font-weight:500;color:var(--text-2);display:inline-flex;align-items:center;text-decoration:none;white-space:nowrap}
.ghost-btn:hover{background:var(--hover);color:var(--text)}
.nav-pair{display:inline-flex;align-items:center;gap:2px}
@media (max-width:600px){.ghost-btn[data-copy-cmd]{display:none}}

/* Detail Body & Thread */
.d-body{max-width:74ch;margin:0 auto;padding:14px 18px calc(72px + var(--sb));display:flex;flex-direction:column;gap:14px}
@media (max-width:899px){.d-body{padding:12px 14px calc(72px + var(--sb))}}
.d-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.d-controls-r{display:flex;align-items:center;gap:8px;position:relative}
.info-pop{position:relative}
.info-pop summary{list-style:none;cursor:pointer}
.info-pop summary::-webkit-details-marker{display:none}
.info-card{position:absolute;right:0;top:28px;z-index:25;width:290px;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);box-shadow:0 8px 24px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:6px;font-size:12px}
.info-card > div{display:flex;justify-content:space-between;gap:10px}
.info-card span:first-child{color:var(--text-2)}
.info-card code{font-family:var(--mono);font-size:11px;word-break:break-all;text-align:right}
.hint-line{font-size:12.5px;color:var(--text-2);padding:8px 12px;border-radius:7px;background:var(--bg-2);border:1px solid var(--border)}

.thread{display:flex;flex-direction:column;gap:12px}
.msg{padding:12px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg)}
.msg-user{background:var(--bg-2)}
.msg-manual{background:var(--bg-2);border-color:rgba(219,39,119,.28)}
.msg-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12.5px}
.msg-head strong{font-weight:600}
.msg-head time{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--text-3)}
.tag-inline{font-size:11.5px;color:var(--rose);font-weight:500}
.msg-body{font-size:14.5px;line-height:1.56;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.inline-more{margin-top:6px}
.inline-more summary{font-size:12.5px;font-weight:500;color:var(--accent);cursor:pointer}
.msg-body.full{margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}

.g-card{padding:13px 15px;border-radius:8px;border:1px solid var(--border);background:var(--bg);display:flex;flex-direction:column;gap:8px}
.g-card.g-err{border-color:rgba(220,38,38,.32)}
.g-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12.5px}
.g-head strong{font-weight:600}
.g-head time{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--text-3)}
.g-status{font-size:12px;font-weight:500}
.g-status.ok{color:var(--green)}
.g-status.warn{color:var(--amber)}
.g-status.muted{color:var(--text-2)}
.ev-gap{font-size:14.5px;line-height:1.54;white-space:pre-wrap;word-break:break-word}
.ev-more{border-top:1px solid var(--border);padding-top:8px}
.ev-more summary{font-size:12.5px;font-weight:500;color:var(--text-2);cursor:pointer;user-select:none}
.ev-kv{margin-top:8px;display:flex;flex-direction:column;gap:8px;font-size:13.5px;line-height:1.5}
.ev-kv b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:var(--text-3);margin-bottom:2px}

/* Scroll-position-aware Latest button */
.scroll-sentinel{height:1px;width:100%}
.jump-bot{position:sticky;bottom:calc(16px + var(--sb));float:right;margin-right:18px;z-index:25;padding:7px 13px;border-radius:18px;background:var(--text);color:var(--bg);font-size:12.5px;font-weight:550;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .2s,transform .2s;opacity:1}
@media (max-width:899px){.jump-bot{position:fixed;right:16px;bottom:calc(16px + var(--sb));float:none;margin:0}}
@supports (container-type:scroll-state){
  .jump-bot{opacity:0;visibility:hidden;transform:translateY(8px);pointer-events:none}
  @container detail-scroll scroll-state(scrollable:bottom){
    .jump-bot{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
  }
}
.main.at-bottom .jump-bot{opacity:0;visibility:hidden;pointer-events:none}

/* Health view */
.health-body{max-width:84ch;gap:18px}
.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--border);gap:1px}
.metric-cell{background:var(--bg);padding:13px 14px;text-align:left}
.metric-btn:hover{background:var(--hover)}
.m-val{font-family:var(--mono);font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15}
.m-lbl{font-size:12.5px;font-weight:550;margin-top:4px}
.m-sub{font-size:12px;color:var(--text-2);margin-top:2px}
.h-sec{font-size:12.5px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.35px;margin-top:4px}
.h-note{font-size:12.5px;color:var(--text-2);margin-top:-10px}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:9px}
.plat-table{width:100%;border-collapse:collapse;font-size:13px}
.plat-table th,.plat-table td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
.plat-table th{font-size:11.5px;font-weight:600;color:var(--text-2);background:var(--bg-2)}
.plat-table tr:last-child td{border-bottom:0}
.plat-row{cursor:pointer}
.plat-row:hover td{background:var(--hover)}
.plat-table .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--text-2)}
.manual-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:9px;overflow:hidden}
.manual-row{width:100%;text-align:left;padding:11px 13px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px}
.manual-row:last-child{border-bottom:0}
.manual-row:hover{background:var(--hover)}
.manual-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
.manual-top span{color:var(--text-2)}
.manual-top time{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--text-3)}
.manual-msg{font-size:13.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.watcher-log{border:1px solid var(--border);border-radius:9px;padding:10px 13px;font-size:13px}
.watcher-log summary{cursor:pointer;font-weight:550;color:var(--text-2)}
.w-ev-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.w-ev{display:flex;gap:10px;font-size:12.5px;border-top:1px solid var(--border);padding-top:6px}
.w-ev span:first-child{font-weight:600;color:var(--text-2);min-width:64px}
.w-ev span:nth-child(2){flex:1;min-width:0;word-break:break-word}
.w-ev time{font-family:var(--mono);font-size:11.5px;color:var(--text-3);flex:none}
.health-foot{display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid var(--border)}

.placeholder{height:100%;display:grid;place-items:center;color:var(--text-3);font-size:14px;padding:24px;text-align:center}
.toast{position:fixed;left:50%;bottom:calc(24px + var(--sb));transform:translate(-50%,12px);opacity:0;background:var(--text);color:var(--bg);font-size:13px;font-weight:500;padding:8px 15px;border-radius:18px;z-index:80;transition:opacity .2s,transform .2s;pointer-events:none}
.toast.on{transform:translate(-50%,0);opacity:1}
</style>
</head>
<body>
<div class="app-frame">
  <header class="top-bar" id="topBar">
    <div class="brand">
      <span class="w-dot offline" id="watcherDot" aria-hidden="true"></span>
      <span class="brand-name" id="watcherTitle">Intent Guardian</span>
    </div>
    <div class="top-actions">
      <div class="seg" role="tablist" aria-label="View">
        <button type="button" class="seg-b on" id="tabSessions" role="tab" aria-selected="true">Sessions</button>
        <button type="button" class="seg-b" id="tabHealth" role="tab" aria-selected="false">Health</button>
      </div>
      <button type="button" class="icon-btn" id="refreshBtn" aria-label="Refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>
  </header>

  <div class="shell" id="shell" data-wide="1" data-view="sessions">
    <aside class="side" id="side">
      <div class="list-toolbar">
        <label class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.2-4.2"/></svg>
          <input id="searchInput" type="search" placeholder="Search sessions, projects, prompts…" autocomplete="off">
          <button type="button" class="clear-x" id="clearSearch" aria-label="Clear search" hidden>×</button>
        </label>
        <div class="toolbar-row">
          <div class="seg" id="scopeTabs" role="group" aria-label="Scope"></div>
          <button type="button" class="filter-btn" id="filterBtn" popovertarget="filtersPopover">Filter <span class="f-badge" id="filterBadge" hidden></span></button>
        </div>
        <div class="active-filters" id="activeFilters" hidden></div>
      </div>
      <div class="list-wrap" id="list"></div>
    </aside>
    <main class="main" id="main" tabindex="-1">
      <div class="placeholder">Select a session to inspect prompts &amp; activity</div>
    </main>
  </div>
</div>

<div id="filtersPopover" class="popover-panel" popover="auto">
  <div class="pop-field">
    <label for="filterHost">Platform</label>
    <select id="filterHost"></select>
  </div>
  <div class="pop-field">
    <label for="filterState">Status</label>
    <select id="filterState"></select>
  </div>
  <div class="pop-field">
    <label for="filterProject">Project</label>
    <select id="filterProject"></select>
  </div>
  <div class="pop-field">
    <label>Appearance</label>
    <div class="seg" role="group" aria-label="Appearance">
      <button type="button" class="seg-b" data-theme-opt="system">System</button>
      <button type="button" class="seg-b" data-theme-opt="light">Light</button>
      <button type="button" class="seg-b" data-theme-opt="dark">Dark</button>
    </div>
  </div>
  <div class="pop-foot">
    <button type="button" class="text-btn" id="resetFiltersBtn">Reset filters</button>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>(${clientApp.toString()})()</script>
</body>
</html>`;
  return response(
    html,
    200,
    { "Content-Type": "text/html; charset=utf-8" },
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function serve(database, feedToken, readerPassword) {
  const feedAuthorization = "Bearer " + feedToken;
  const readerAuthorization = "Basic " + Buffer.from("sami:" + readerPassword).toString("base64");
  async function handle(request) {
    const parsedUrl = new URL(request.url, "http://localhost");
    const route = parsedUrl.pathname;
    if (route === "/healthz" && request.method === "GET") {
      database.prepare("SELECT id FROM events LIMIT 1").get();
      return response("OK");
    }
    if (route === "/events" && request.method === "POST") return ingest(request, database, feedAuthorization);
    if (route === "/watcher" && request.method === "POST") return ingestWatcher(request, database, feedAuthorization);
    if (route === "/admin/prune-ghosts" && request.method === "POST") {
      if (!matches(request.headers.authorization, feedAuthorization)) {
        return response("Unauthorized", 401);
      }
      const cutoff = Date.now() / 1000 - 86400;
      const info = database.prepare(`
        DELETE FROM events
        WHERE kind = 'seen' AND at < ?
          AND NOT EXISTS (
            SELECT 1 FROM events e2
            WHERE e2.host = events.host AND e2.session_id = events.session_id AND e2.kind <> 'seen'
          )
      `).run(cutoff);
      return response(JSON.stringify({ pruned: Number(info.changes || 0) }), 200, { "Content-Type": "application/json" });
    }
    if (route === "/api/state" && request.method === "GET") {
      if (!matches(request.headers.authorization, readerAuthorization)) {
        return response("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
      }
      return response(JSON.stringify(queryState(database)), 200, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (route === "/api/session" && request.method === "GET") {
      if (!matches(request.headers.authorization, readerAuthorization)) {
        return response("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
      }
      const host = parsedUrl.searchParams.get("host") || "";
      const sid = parsedUrl.searchParams.get("session_id") || "";
      if (!hosts.includes(host) || !/^[\w:.-]{1,180}$/.test(sid)) {
        return response("Invalid host or session_id", 400);
      }
      return response(JSON.stringify(querySession(database, host, sid)), 200, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (route !== "/") return response("Not found", 404);
    if (request.method !== "GET") return response("Method not allowed", 405, { Allow: "GET" });
    if (!matches(request.headers.authorization, readerAuthorization)) {
      return response("Private dashboard", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
    }
    return dashboardHtml();
  }
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (incoming, outgoing) => {
    let result;
    try {
      result = await handle(incoming);
    } catch (error) {
      if (outgoing.destroyed) return;
      console.error("Dashboard request failed", error.code ?? error.name);
      result = response("Server error", 500);
    }
    const headers = Object.fromEntries(result.headers);
    if (!incoming.readableEnded && (incoming.headers["content-length"] || incoming.headers["transfer-encoding"])) {
      headers.connection = "close";
    }
    outgoing.writeHead(result.status, headers);
    outgoing.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  process.once("SIGTERM", () => server.close(() => database.close()));
}

const database = new DatabaseSync(process.env.GUARDIAN_DB_PATH ?? "/data/guardian.sqlite");
database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
database.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
for (const col of ["project TEXT", "session_url TEXT", "session_state TEXT", "title TEXT"]) {
  try { database.exec("ALTER TABLE events ADD COLUMN " + col); } catch {}
}
if (process.argv[2] === "--import-events") {
  const rows = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array of D1 events");
  const events = rows.map((row) => (typeof row?.message === "string" ? normalize(row, true) : null));
  if (events.includes(null)) throw new Error("Invalid D1 event row");
  writeEvents(database, events);
  const total = database.prepare("SELECT COUNT(*) AS total FROM events").get().total;
  console.log(JSON.stringify({ processed: events.length, total }));
  database.close();
} else {
  const { FEED_TOKEN, READER_PASSWORD } = process.env;
  if (!FEED_TOKEN || !READER_PASSWORD) throw new Error("FEED_TOKEN and READER_PASSWORD must be configured");
  serve(database, FEED_TOKEN, READER_PASSWORD);
}
