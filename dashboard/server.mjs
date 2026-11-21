import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const hosts = ["codex", "claude", "cowork", "grokbot"];
const kinds = ["seen", "correction", "delivered", "outcome", "error"];
const labels = { codex: "Codex", claude: "Claude Code", cowork: "Cowork", grokbot: "GrokBot" };
const maxBodyLength = 80_000;

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

function matches(provided, expected) {
  if (!expected || !provided || provided.length > 1024) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
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

function normalize(event, importing = false) {
  if (!event || typeof event.id !== "string" || !/^[\w:.-]{1,180}$/.test(event.id) ||
      typeof event.session_id !== "string" || !/^[\w:.-]{1,180}$/.test(event.session_id) ||
      !hosts.includes(event.host) || !kinds.includes(event.kind) ||
      typeof event.at !== "number" || !Number.isFinite(event.at) ||
      event.at < 0 || event.at > Date.now() / 1000 + 900) return null;
  if (event.message != null && typeof event.message !== "string") return null;
  if (event.outcome != null && !["verified", "superseded", "pending"].includes(event.outcome)) return null;
  return [event.id, event.host, event.session_id, event.kind, event.at,
    importing ? event.message : redact(event.message ?? "").slice(0, 2600), event.outcome ?? null];
}

async function readBody(request) {
  // UTF-8 uses at most three bytes per UTF-16 code unit. Retain the existing
  // character limit while bounding memory for requests without Content-Length.
  const maxBytes = maxBodyLength * 3;
  if (Number(request.headers["content-length"]) > maxBytes) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) return null;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, bytes).toString("utf8");
  return body.length <= maxBodyLength ? body : null;
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
  if (!events.length || events.length > 20 || events.includes(null)) return response("Invalid events", 400);
  writeEvents(database, events);
  return response(JSON.stringify({ accepted: events.length }), 200, { "Content-Type": "application/json" });
}

function writeEvents(database, events) {
  const statement = database.prepare(`
    INSERT INTO events (id, host, session_id, kind, at, message, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      at = excluded.at, message = excluded.message, outcome = excluded.outcome
    WHERE excluded.at >= events.at AND excluded.host = events.host
      AND excluded.session_id = events.session_id AND excluded.kind = events.kind
      AND (events.at <> excluded.at OR events.message <> excluded.message OR events.outcome IS NOT excluded.outcome)
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

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "short",
});

function timestamp(value) {
  return time.format(new Date(value * 1000));
}

function dashboard(database) {
  const events = database.prepare(`SELECT host, session_id, kind, at, message, outcome
    FROM events WHERE kind <> 'seen' ORDER BY at DESC LIMIT 80`).all();
  const heartbeat = database.prepare("SELECT host, MAX(at) AS at FROM events GROUP BY host").all();
  const last = Object.fromEntries(heartbeat.map((row) => [row.host, row.at]));
  const cards = hosts.map((host) => `<div><strong>${labels[host]}</strong><span>${
    last[host] != null ? "Last seen " + timestamp(last[host]) : "No events yet"
  }</span></div>`).join("");
  const rows = events.map((event) => `<li><div class="meta"><strong>${labels[event.host]}</strong>
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

function serve(database, feedToken, readerPassword) {
  const feedAuthorization = "Bearer " + feedToken;
  const readerAuthorization = "Basic " + Buffer.from("sami:" + readerPassword).toString("base64");
  async function handle(request) {
    const route = new URL(request.url, "http://localhost").pathname;
    if (route === "/healthz" && request.method === "GET") {
      database.prepare("SELECT id FROM events LIMIT 1").get();
      return response("OK");
    }
    if (route === "/events" && request.method === "POST") return ingest(request, database, feedAuthorization);
    if (route !== "/") return response("Not found", 404);
    if (request.method !== "GET") return response("Method not allowed", 405, { Allow: "GET" });
    if (!matches(request.headers.authorization, readerAuthorization)) {
      return response("Private dashboard", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
    }
    return dashboard(database);
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
