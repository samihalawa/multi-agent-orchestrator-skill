const hosts = ["codex", "claude", "cowork", "grokbot"];
const kinds = ["seen", "correction", "delivered", "outcome", "error"];
const labels = { codex: "Codex", claude: "Claude Code", cowork: "Cowork", grokbot: "GrokBot" };
const encoder = new TextEncoder();

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ...headers,
    },
  });
}

async function matches(provided, expected) {
  if (!expected || !provided || provided.length > 1024) return false;
  const [left, right] = await Promise.all(
    [provided, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value)))
  );
  return crypto.subtle.timingSafeEqual(left, right);
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function redact(message) {
  return message
    .replace(/\b(?:sk-or-v1-|sk-proj-|ghp_|github_pat_|ctx7sk-)[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9_./+-]{12,}=*/gi, "Bearer [credential]")
    .replace(/\b((?:authorization|api[_-]?key|password|secret|access_token|refresh_token)\s*[:=]\s*)[^\s,;"}]+/gi, "$1[credential]");
}

function normalize(event) {
  if (!event || typeof event.id !== "string" || !/^[\w:.-]{1,180}$/.test(event.id) ||
      typeof event.session_id !== "string" || !/^[\w:.-]{1,180}$/.test(event.session_id) ||
      !hosts.includes(event.host) || !kinds.includes(event.kind) ||
      typeof event.at !== "number" || !Number.isFinite(event.at) ||
      event.at < 0 || event.at > Date.now() / 1000 + 900) return null;
  if (event.message != null && typeof event.message !== "string") return null;
  if (event.outcome != null && !["verified", "superseded", "pending"].includes(event.outcome)) return null;
  return [event.id, event.host, event.session_id, event.kind, event.at,
    event.message ? redact(event.message).slice(0, 2600) : "", event.outcome ?? null];
}

async function ingest(request, env) {
  if (!await matches(request.headers.get("Authorization"), env.FEED_TOKEN ? "Bearer " + env.FEED_TOKEN : "")) {
    return response("Unauthorized", 401);
  }
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) {
    return response("Expected application/json", 415);
  }
  const body = await request.text();
  if (body.length > 80000) return response("Event batch is too large", 413);
  let events;
  try {
    const parsed = JSON.parse(body);
    events = (Array.isArray(parsed) ? parsed : [parsed]).map(normalize);
  } catch {
    return response("Invalid JSON", 400);
  }
  if (!events.length || events.length > 20 || events.includes(null)) return response("Invalid events", 400);
  const statement = env.DB.prepare(`
    INSERT INTO events (id, host, session_id, kind, at, message, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      at = excluded.at, message = excluded.message, outcome = excluded.outcome
    WHERE excluded.at >= events.at AND excluded.host = events.host
      AND excluded.session_id = events.session_id AND excluded.kind = events.kind
      AND (events.at <> excluded.at OR events.message <> excluded.message OR events.outcome IS NOT excluded.outcome)
  `);
  await env.DB.batch(events.map((event) => statement.bind(...event)));
  return response(JSON.stringify({ accepted: events.length }), 200, { "Content-Type": "application/json" });
}

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "short",
});

function timestamp(value) {
  return time.format(new Date(value * 1000));
}

async function dashboard(env) {
  const [events, heartbeat] = await Promise.all([
    env.DB.prepare(`SELECT host, session_id, kind, at, message, outcome
      FROM events WHERE kind <> 'seen' ORDER BY at DESC LIMIT 80`).all(),
    env.DB.prepare("SELECT host, MAX(at) AS at FROM events GROUP BY host").all(),
  ]);
  const last = Object.fromEntries(heartbeat.results.map((row) => [row.host, row.at]));
  const cards = hosts.map((host) => `<div><strong>${labels[host]}</strong><span>${
    last[host] != null ? "Last seen " + timestamp(last[host]) : "No events yet"
  }</span></div>`).join("");
  const rows = events.results.map((event) => `<li><div class="meta"><strong>${labels[event.host]}</strong>
    <span>${escape(event.kind)}${event.outcome ? " · " + escape(event.outcome) : ""}</span><time>${timestamp(event.at)}</time></div>
    ${event.message && ["correction", "error"].includes(event.kind) ? "<p>" + escape(event.message) + "</p>" : ""}
    <small>Session ${escape(event.session_id)}</small></li>`).join("");
  return response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>Intent Guardian</title>
    <style>
    :root{color-scheme:dark;font:16px system-ui;background:#111417;color:#edf1ef}
    body{max-width:48rem;margin:auto;padding:1.35rem}h1{font-size:1.65rem;margin:0 0 1.2rem}
    h2{font-size:1.1rem;margin:1.7rem 0 .65rem}.hosts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}
    .hosts div,li{background:#1a2024;border:1px solid #313a3e;border-radius:.65rem;padding:.7rem .85rem}
    .hosts span,small{display:block;color:#a7b5b3;font-size:.82rem;margin-top:.2rem;overflow-wrap:anywhere}
    ul{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}.meta{display:flex;gap:.45rem .7rem;flex-wrap:wrap;align-items:baseline}
    .meta span{color:#a1e2bb}.meta time{font-size:.8rem;color:#a7b5b3}p{line-height:1.42;overflow-wrap:anywhere;margin:.55rem 0;white-space:pre-wrap}
    </style></head><body><main><h1>Intent Guardian</h1><section aria-label="Last activity" class="hosts">${cards}</section>
    <h2>Recent events <small>Madrid time</small></h2>${rows ? "<ul>" + rows + "</ul>" : "<p>No corrections or errors recorded yet.</p>"}
    </main></body></html>`, 200, { "Content-Type": "text/html; charset=utf-8" });
}

export default {
  async fetch(request, env) {
    const route = new URL(request.url).pathname;
    if (route === "/healthz" && request.method === "GET") return response("OK");
    if (route === "/events" && request.method === "POST") return ingest(request, env);
    if (route !== "/") return response("Not found", 404);
    if (request.method !== "GET") return response("Method not allowed", 405, { Allow: "GET" });
    const expected = env.READER_PASSWORD ? "Basic " + btoa("sami:" + env.READER_PASSWORD) : "";
    if (!await matches(request.headers.get("Authorization"), expected)) {
      return response("Private dashboard", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
    }
    return dashboard(env);
  },
};
