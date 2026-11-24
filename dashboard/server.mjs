import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const hosts = ["codex", "claude", "antigravity", "chatgpt", "claude_ai", "gemini_web", "grokbot", "cowork"];
const kinds = ["seen", "correction", "delivered", "outcome", "error"];
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
const maxBodyLength = 80_000;

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
  return message
    .replace(/\b(?:sk-or-v1-|sk-proj-|ghp_|github_pat_|ctx7sk-)[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9_./+-]{12,}=*/gi, "Bearer [credential]")
    .replace(/\b((?:authorization|api[_-]?key|password|secret|access_token|refresh_token)\s*[:=]\s*)[^\s,;"}]+/gi, "$1[credential]");
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
  if (event.outcome != null && !["verified", "superseded", "pending"].includes(event.outcome)) return null;
  const project = typeof event.project === "string"
    ? event.project.replace(/[^\w .@+-]/g, "").trim().slice(0, 80) || null
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
  ];
}

async function readBody(request) {
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
    INSERT INTO events (id, host, session_id, kind, at, message, outcome, project, session_url, session_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      at = excluded.at,
      message = excluded.message,
      outcome = excluded.outcome,
      project = COALESCE(excluded.project, events.project),
      session_url = COALESCE(excluded.session_url, events.session_url),
      session_state = COALESCE(excluded.session_state, events.session_state)
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
  const seenRows = database.prepare(`
    SELECT host, session_id, MAX(at) AS last_at,
      MAX(project) AS project,
      MAX(session_url) AS session_url,
      (SELECT s2.session_state FROM events s2
        WHERE s2.host = events.host AND s2.session_id = events.session_id AND s2.session_state IS NOT NULL
        ORDER BY s2.at DESC LIMIT 1) AS session_state
    FROM events
    GROUP BY host, session_id
    ORDER BY last_at DESC
    LIMIT 180
  `).all();
  const detailRows = database.prepare(`
    SELECT id, host, session_id, kind, at, message, outcome, project, session_url, session_state
    FROM events
    WHERE kind <> 'seen'
    ORDER BY at DESC
    LIMIT 500
  `).all();
  const heartbeat = database.prepare("SELECT host, MAX(at) AS at FROM events GROUP BY host").all();
  return {
    serverTime: Date.now() / 1000,
    labels,
    hosts: Object.fromEntries(heartbeat.map((r) => [r.host, r.at])),
    sessions: seenRows,
    events: detailRows,
  };
}

function clientApp() {
  const HOST_META = {
    codex: { label: "Codex", code: "CX", color: "#007AFF" },
    claude: { label: "Claude Code", code: "CC", color: "#FF9F0A" },
    antigravity: { label: "Antigravity", code: "AG", color: "#34C759" },
    chatgpt: { label: "ChatGPT", code: "CG", color: "#30B0C7" },
    claude_ai: { label: "Claude.ai", code: "CA", color: "#FF9F0A" },
    gemini_web: { label: "Gemini", code: "GM", color: "#5856D6" },
    grokbot: { label: "Grok", code: "GK", color: "#AF52DE" },
    cowork: { label: "Cowork", code: "CW", color: "#FF2D55" },
  };
  const HOST_ORDER = ["codex", "claude", "antigravity", "chatgpt", "claude_ai", "gemini_web", "grokbot", "cowork"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const isWide = () => innerWidth >= 760;

  let state = { serverTime: Date.now() / 1000, sessions: [], events: [] };
  let sessions = [], filtered = [];
  let fHost = "all", fState = "all", fProject = "all";
  let selKey = null, selIdx = -1;

  const relTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts * 1000), n = new Date();
    if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const fullTime = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-GB", { timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "short" }) : "";

  function resumeCommand(host, sid, url) {
    if (host === "codex") return "codex resume " + sid;
    if (host === "claude") return "claude --resume " + sid;
    if (host === "antigravity") return "agy --conversation " + sid;
    return url || sid;
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
        byKey.set(key, { key, host: ev.host, session_id: ev.session_id, last_at: ev.at, project: ev.project, session_url: ev.session_url, session_state: ev.session_state, events: [] });
      }
      const obj = byKey.get(key);
      obj.events.push(ev);
      if (!obj.project && ev.project) obj.project = ev.project;
      if (!obj.session_url && ev.session_url) obj.session_url = ev.session_url;
      if (ev.at > (obj.last_at || 0)) obj.last_at = ev.at;
    }
    sessions = [...byKey.values()].map((s) => {
      s.events.sort((a, b) => b.at - a.at);
      s.status = deriveStatus(s, s.events, now);
      s.corrections = s.events.filter((e) => e.kind === "correction").length;
      s.latestMsg = (s.events.find((e) => e.message) || {}).message || "";
      return s;
    }).sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
  }

  function renderChips() {
    const activeHosts = HOST_ORDER.filter((h) => sessions.some((s) => s.host === h));
    if (fHost !== "all" && !activeHosts.includes(fHost)) fHost = "all";
    const hostItems = [["all", "All", null, sessions.length], ...activeHosts.map((h) => [h, HOST_META[h]?.label || h, HOST_META[h]?.color || "#8E8E93", sessions.filter((s) => s.host === h).length])];
    $("hostChips").innerHTML = hostItems.map(([k, lbl, col, cnt]) =>
      `<button class="chip${fHost === k ? " on" : ""}" data-host="${esc(k)}">${col ? `<span class="d" style="background:${col}"></span>` : ""}${esc(lbl)} <span class="n">${cnt}</span></button>`
    ).join("");

    const baseH = sessions.filter((s) => fHost === "all" || s.host === fHost);
    const stCounts = {
      all: baseH.length,
      pending: baseH.filter((s) => s.status === "pending").length,
      ongoing: baseH.filter((s) => s.status === "ongoing").length,
      completed: baseH.filter((s) => s.status === "completed").length,
      error: baseH.filter((s) => s.status === "error").length,
    };
    const stItems = [["all", "Any State", null], ["pending", "Needs Action", "#FF9F0A"], ["ongoing", "Ongoing", "#007AFF"], ["completed", "Completed", "#34C759"], ["error", "Errors", "#FF3B30"]]
      .filter(([k]) => k === "all" || stCounts[k] > 0);
    $("stateChips").innerHTML = stItems.map(([k, lbl, col]) =>
      `<button class="chip${fState === k ? " on" : ""}" data-st="${k}">${col ? `<span class="d" style="background:${col}"></span>` : ""}${esc(lbl)} <span class="n">${stCounts[k]}</span></button>`
    ).join("");

    const projs = [...new Set(baseH.map((s) => s.project).filter(Boolean))];
    if (fProject !== "all" && !projs.includes(fProject)) fProject = "all";
    $("projectChips").style.display = projs.length ? "flex" : "none";
    if (projs.length) {
      $("projectChips").innerHTML = [["all", "All Projects", baseH.length], ...projs.map((p) => [p, p, baseH.filter((s) => s.project === p).length])].map(([k, lbl, cnt]) =>
        `<button class="chip${fProject === k ? " on" : ""}" data-proj="${esc(k)}">${esc(lbl)} <span class="n">${cnt}</span></button>`
      ).join("");
    }
  }

  function rowHtml(s, i) {
    const hm = HOST_META[s.host] || { label: s.host, code: s.host.slice(0, 2).toUpperCase(), color: "#8E8E93" };
    const title = s.project || hm.label;
    const stMap = { ongoing: ["Ongoing", "st-ongoing"], completed: ["Done", "st-completed"], pending: ["Action", "st-pending"], error: ["Error", "st-error"], stopped: ["Idle", "st-stopped"] };
    const [stLbl, stCls] = stMap[s.status] || ["Observed", "st-stopped"];
    const sub = s.latestMsg ? s.latestMsg.replace(/\[SAMI'S INTENT GUARDIAN\]\s*/g, "") : (s.events.length ? s.events[0].kind : "No corrections · session monitored");
    return `<button class="row${s.key === selKey && isWide() ? " sel" : ""}" data-i="${i}">
      <div class="av" style="background:${hm.color}20;color:${hm.color}">${esc(hm.code)}<span class="dot" style="background:${s.status === "ongoing" ? "var(--green)" : s.status === "pending" ? "var(--orange)" : s.status === "error" ? "var(--red)" : "transparent"}"></span></div>
      <div class="rt">
        <div class="rt-top"><div class="rn">${esc(title)}</div><span class="rt2">${esc(relTime(s.last_at))}</span></div>
        <div class="rsub"><span>${esc(hm.label)}</span><span>·</span><span style="font-family:var(--mono)">${esc(s.session_id.slice(0, 8))}</span><span class="badge-pill ${stCls}">${esc(stLbl)}</span>${s.corrections ? `<span>· ${s.corrections} prompt${s.corrections > 1 ? "s" : ""}</span>` : ""}</div>
        <div class="rs">${esc(sub)}</div>
      </div>
      <svg class="chev" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6-6 6"/></svg>
    </button>`;
  }

  function renderList() {
    buildSessions();
    renderChips();
    const q = $("searchInput").value.trim().toLowerCase();
    filtered = sessions.filter((s) =>
      (fHost === "all" || s.host === fHost) &&
      (fState === "all" || s.status === fState) &&
      (fProject === "all" || s.project === fProject) &&
      (!q || [s.session_id, s.host, HOST_META[s.host]?.label, s.project, s.latestMsg].join(" ").toLowerCase().includes(q))
    );
    const ongoingN = sessions.filter((s) => s.status === "ongoing").length;
    const pendingN = sessions.filter((s) => s.status === "pending").length;
    const sb = $("statusBar");
    sb.className = "status live";
    sb.lastElementChild.textContent = `Live · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${sessions.length} sessions · ${ongoingN} ongoing${pendingN ? " · " + pendingN + " action" : ""}`;

    const needs = filtered.filter((s) => s.status === "pending" || s.status === "error");
    const active = filtered.filter((s) => s.status === "ongoing");
    const rest = filtered.filter((s) => !needs.includes(s) && !active.includes(s));
    const groups = [
      ["Needs Attention", needs],
      ["Ongoing", active],
      ["Completed & Recent", rest],
    ].filter(([, arr]) => arr.length);
    filtered = groups.flatMap(([, arr]) => arr);
    let idx = 0;
    $("list").innerHTML = filtered.length
      ? groups.map(([name, arr]) => `<div class="sec">${esc(name)} · ${arr.length}</div><div class="group">${arr.map((s) => rowHtml(s, idx++)).join("")}</div>`).join("")
      : '<div class="empty">No matching sessions.</div>';
    if (selKey) {
      const k = filtered.findIndex((s) => s.key === selKey);
      if (k >= 0) { selIdx = k; renderDetail(false); }
    } else if (isWide() && filtered.length) {
      openAt(0);
    }
  }

  function parseCorrectionParts(msg) {
    const clean = msg.replace(/^\[SAMI'S INTENT GUARDIAN\]\s*(DO NOT STOP[^\n]*\n)?/, "").trim();
    const gap = (clean.match(/(?:^|\n)Gap:\s*([\s\S]*?)(?=\nExecute now|\nNext action:|$)/i) || [])[1];
    const exec = (clean.match(/(?:^|\n)(?:Execute now[^:]*:|Next action:)\s*([\s\S]*?)(?=\nVerify[^:]*:|$)/i) || [])[1];
    const verify = (clean.match(/(?:^|\n)Verify[^:]*:\s*([\s\S]*)$/i) || [])[1];
    if (gap || exec || verify) return { gap, exec, verify };
    return null;
  }

  function eventCardHtml(ev, idx) {
    const kindLbl = { correction: "Guardian Prompt", delivered: "Delivered to Session", outcome: "Outcome", error: "Observer Error" }[ev.kind] || ev.kind;
    const stPill = ev.outcome ? `<span class="badge-pill ${ev.outcome === "verified" ? "st-completed" : ev.outcome === "pending" ? "st-pending" : "st-stopped"}">${esc(ev.outcome)}</span>` : "";
    const parts = ev.kind === "correction" && ev.message ? parseCorrectionParts(ev.message) : null;
    let body = "";
    if (parts) {
      body = `<div class="ev-kv">${parts.gap ? `<div><b>Gap</b>${esc(parts.gap.trim())}</div>` : ""}${parts.exec ? `<div><b>Execute Contract</b>${esc(parts.exec.trim())}</div>` : ""}${parts.verify ? `<div><b>Primary Proof</b>${esc(parts.verify.trim())}</div>` : ""}</div>`;
    } else if (ev.message && ["correction", "error"].includes(ev.kind)) {
      body = `<div class="ev-body">${esc(ev.message)}</div>`;
    }
    const copyBtn = ev.kind === "correction" && ev.message ? `<div class="ev-foot"><button class="mini-btn" data-copy-ev="${idx}">Copy Prompt</button></div>` : "";
    return `<div class="ev-card k-${esc(ev.kind)}"><div class="ev-head"><strong>${esc(kindLbl)}</strong>${stPill}<time>${esc(fullTime(ev.at))}</time></div>${body}${copyBtn}</div>`;
  }

  function detailHtml(s, inSheet) {
    const hm = HOST_META[s.host] || { label: s.host, code: s.host.slice(0, 2).toUpperCase(), color: "#8E8E93" };
    const cmd = resumeCommand(s.host, s.session_id, s.session_url);
    const stMap = { ongoing: ["Ongoing", "st-ongoing"], completed: ["Completed", "st-completed"], pending: ["Needs Action", "st-pending"], error: ["Error", "st-error"], stopped: ["Idle", "st-stopped"] };
    const [stLbl, stCls] = stMap[s.status] || ["Observed", "st-stopped"];
    return `<div class="d-top">
        <div class="tt">${esc(s.project || hm.label)} · ${esc(s.session_id.slice(0, 8))}</div>
        <div class="navs">
          ${inSheet ? '<button class="glass close-btn" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ""}
          <button class="glass" data-act="prev" ${selIdx <= 0 ? "disabled" : ""} aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
          <span class="pos">${selIdx + 1} / ${filtered.length}</span>
          <button class="glass" data-act="next" ${selIdx >= filtered.length - 1 ? "disabled" : ""} aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
        </div>
      </div>
      <div class="d-scroll">
        <div class="hero-card">
          <div class="hero-row">
            <div class="av" style="width:48px;height:48px;font-size:16px;background:${hm.color}20;color:${hm.color}">${esc(hm.code)}</div>
            <div class="hero-meta">
              <h2>${esc(s.project || hm.label)}</h2>
              <div class="hero-tags">
                <span class="tag">${esc(hm.label)}</span>
                <span class="badge-pill ${stCls}">${esc(stLbl)}</span>
                <span class="tag">${esc(fullTime(s.last_at))}</span>
              </div>
              <div class="sid">${esc(s.session_id)}</div>
            </div>
          </div>
          <div class="acts">
            ${s.session_url ? `<a class="act primary" href="${esc(s.session_url)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>Open Session</a>` : ""}
            <button class="act" data-copy-cmd="${esc(cmd)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>${s.session_url ? "Copy Resume" : "Copy: " + esc(cmd.slice(0, 26))}</button>
          </div>
        </div>
        <div class="ev-sec">Activity &amp; Guardian Prompts · ${s.events.length}</div>
        <div class="cards">${s.events.length ? s.events.map((e, i) => eventCardHtml(e, i)).join("") : '<div class="ev-card"><div class="ev-body" style="color:var(--label-2)">Monitored cleanly — no Guardian interventions or errors required yet.</div></div>'}</div>
      </div>`;
  }

  function renderDetail(scrollTop) {
    const s = filtered[selIdx];
    if (!s) return;
    const wide = isWide();
    const root = wide ? $("main") : $("sheetDetail");
    const prevScroll = !scrollTop && root.querySelector(".d-scroll") ? root.querySelector(".d-scroll").scrollTop : 0;
    root.innerHTML = detailHtml(s, !wide);
    if (!scrollTop && root.querySelector(".d-scroll")) root.querySelector(".d-scroll").scrollTop = prevScroll;
    document.querySelectorAll("#list .row").forEach((r) => r.classList.toggle("sel", +r.dataset.i === selIdx));
  }

  function openAt(i) {
    if (i < 0 || i >= filtered.length) return;
    selIdx = i;
    selKey = filtered[i].key;
    renderDetail(true);
    if (!isWide()) { $("bd").classList.add("on"); $("sheet").classList.add("on"); document.body.style.overflow = "hidden"; }
  }
  function closeSheet() {
    $("sheet").classList.remove("on");
    $("bd").classList.remove("on");
    document.body.style.overflow = "";
  }
  function toast(t) {
    const el = $("toast"); el.textContent = t; el.classList.add("on");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 1700);
  }

  function bindRoot(root) {
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        if (act.dataset.act === "close") closeSheet();
        else openAt(selIdx + (act.dataset.act === "next" ? 1 : -1));
        return;
      }
      const cmdBtn = e.target.closest("[data-copy-cmd]");
      if (cmdBtn) {
        navigator.clipboard?.writeText(cmdBtn.dataset.copyCmd).then(() => toast("Copied resume command"), () => toast(cmdBtn.dataset.copyCmd));
        return;
      }
      const evBtn = e.target.closest("[data-copy-ev]");
      if (evBtn) {
        const s = filtered[selIdx];
        const msg = s?.events?.[+evBtn.dataset.copyEv]?.message || "";
        if (msg) navigator.clipboard?.writeText(msg).then(() => toast("Copied Guardian prompt"), () => toast("Copy unavailable"));
      }
    });
  }
  bindRoot($("main"));
  bindRoot($("sheetDetail"));

  $("hostChips").onclick = (e) => { const b = e.target.closest("[data-host]"); if (b) { fHost = b.dataset.host; renderList(); } };
  $("stateChips").onclick = (e) => { const b = e.target.closest("[data-st]"); if (b) { fState = b.dataset.st; renderList(); } };
  $("projectChips").onclick = (e) => { const b = e.target.closest("[data-proj]"); if (b) { fProject = b.dataset.proj; renderList(); } };
  $("searchInput").addEventListener("input", renderList);
  $("list").onclick = (e) => { const r = e.target.closest(".row"); if (r) openAt(+r.dataset.i); };
  $("bd").onclick = closeSheet;
  $("side").addEventListener("scroll", () => $("navbar").classList.toggle("solid", $("side").scrollTop > 34), { passive: true });
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "Escape" && !isWide()) closeSheet();
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); openAt(Math.min(filtered.length - 1, selIdx + 1)); }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); openAt(Math.max(0, selIdx - 1)); }
  });
  addEventListener("resize", () => { if (isWide()) closeSheet(); renderList(); });

  async function syncLive(manual) {
    if (document.hidden && !manual) return;
    if (manual) $("refreshBtn").classList.add("spin");
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) { state = await res.json(); renderList(); }
    } catch {}
    if (manual) setTimeout(() => $("refreshBtn").classList.remove("spin"), 350);
  }
  $("refreshBtn").onclick = () => syncLive(true);
  syncLive(false);
  setInterval(() => syncLive(false), 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncLive(false); });
}

function dashboardHtml() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Intent Guardian</title>
<style>
:root{
  --accent:#007AFF;--accent-soft:rgba(0,122,255,.12);
  --green:#34C759;--green-soft:rgba(52,199,89,.14);
  --orange:#FF9F0A;--orange-soft:rgba(255,159,10,.15);
  --red:#FF3B30;--red-soft:rgba(255,59,48,.14);
  --purple:#AF52DE;--teal:#30B0C7;--indigo:#5856D6;--pink:#FF2D55;
  --bg:#F2F2F7;--card:#FFFFFF;--label:#101114;--label-2:rgba(60,60,67,.62);--label-3:rgba(60,60,67,.36);
  --sep:rgba(60,60,67,.16);--fill:rgba(118,118,128,.12);--bar:rgba(249,249,249,.86);
  --text:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Helvetica Neue",Arial,sans-serif;
  --round:ui-rounded,"SF Pro Rounded","SF Pro Display",-apple-system,system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;
  --ease:cubic-bezier(.32,.72,0,1);--st:env(safe-area-inset-top,0px);--sb:env(safe-area-inset-bottom,0px);
}
@media (prefers-color-scheme:dark){
  :root{
    --accent:#0A84FF;--accent-soft:rgba(10,132,255,.2);
    --green:#30D158;--green-soft:rgba(48,209,88,.18);
    --orange:#FF9F0A;--orange-soft:rgba(255,159,10,.18);
    --red:#FF453A;--red-soft:rgba(255,69,58,.18);
    --bg:#000000;--card:#1C1C1E;--label:#FFFFFF;--label-2:rgba(235,235,245,.62);--label-3:rgba(235,235,245,.34);
    --sep:rgba(84,84,88,.55);--fill:rgba(118,118,128,.24);--bar:rgba(22,22,24,.86);
  }
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;color-scheme:light dark}
body{font-family:var(--text);background:var(--bg);color:var(--label);-webkit-font-smoothing:antialiased;overscroll-behavior:none;font-size:15px}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
a{color:inherit}
svg{display:block}
.shell{height:100dvh;display:flex;overflow:hidden}
.side{width:100%;height:100%;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;position:relative;padding-bottom:calc(24px + var(--sb))}
.main{display:none}
@media (min-width:760px){
  .side{width:380px;flex:none;border-right:.5px solid var(--sep);padding-bottom:24px}
  .main{display:block;flex:1;height:100%;overflow:hidden;position:relative;background:var(--bg)}
}
@media (min-width:1160px){.side{width:420px}}
.navbar{position:sticky;top:0;z-index:20;height:calc(44px + var(--st));padding-top:var(--st);display:flex;align-items:center;justify-content:center;border-bottom:.5px solid transparent;transition:background .2s,border-color .2s}
.navbar.solid{background:var(--bar);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom-color:var(--sep)}
.navbar .t{font-weight:600;font-size:17px;opacity:0;transition:opacity .2s}
.navbar.solid .t{opacity:1}
.navbar .r{position:absolute;right:12px;top:calc(var(--st) + 6px);display:flex;gap:4px}
.ib{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;color:var(--accent)}
.ib svg{width:19px;height:19px}
.ib.spin svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.large{padding:0 18px 2px;margin-top:-2px}
.large h1{font-family:var(--round);font-size:32px;font-weight:700;letter-spacing:-.5px}
.status{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12.5px;color:var(--label-2)}
.status i{width:7px;height:7px;border-radius:50%;background:var(--label-3);flex:none}
.status.live i{background:var(--green);box-shadow:0 0 0 3px var(--green-soft)}
.search{margin:12px 16px 0;display:flex;align-items:center;gap:7px;background:var(--fill);border-radius:10px;height:36px;padding:0 10px;color:var(--label-2)}
.search svg{width:16px;height:16px;flex:none}
.search input{flex:1;border:0;background:none;font:inherit;font-size:15px;color:var(--label);outline:none;min-width:0}
.search input::placeholder{color:var(--label-2)}
.chips{display:flex;gap:7px;overflow-x:auto;padding:10px 16px 0;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;height:30px;padding:0 11px;border-radius:15px;background:var(--card);font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;box-shadow:0 .5px 1px rgba(0,0,0,.05);transition:transform .12s,background .15s}
.chip:active{transform:scale(.96)}
.chip .d{width:7px;height:7px;border-radius:50%}
.chip .n{color:var(--label-2);font-weight:400;font-variant-numeric:tabular-nums}
.chip.on{background:var(--label);color:var(--bg)}
.chip.on .n{color:var(--bg);opacity:.72}
.sec{font-size:12px;font-weight:600;color:var(--label-2);text-transform:uppercase;letter-spacing:.35px;margin:18px 28px 6px}
.group{margin:0 16px;background:var(--card);border-radius:12px;overflow:hidden}
.row{display:flex;align-items:center;gap:11px;padding:10px 14px 10px 12px;width:100%;text-align:left;position:relative;transition:background .12s}
.row:active{background:var(--fill)}
.row.sel{background:var(--accent);color:#fff}
.row.sel .rs,.row.sel .chev,.row.sel .rt2,.row.sel .rsub{color:rgba(255,255,255,.82)}
.row.sel .badge-pill{background:rgba(255,255,255,.22);color:#fff}
.row+.row::before{content:"";position:absolute;top:0;left:64px;right:0;border-top:.5px solid var(--sep)}
.row.sel::before,.row.sel+.row::before{display:none}
.av{width:42px;height:42px;border-radius:11px;flex:none;display:grid;place-items:center;font-family:var(--round);font-weight:700;font-size:14px;letter-spacing:-.3px;position:relative}
.av .dot{position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;border:2px solid var(--card)}
.rt{flex:1;min-width:0}
.rt-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.rn{font-size:15.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.rt2{font-size:12px;color:var(--label-3);flex:none;font-variant-numeric:tabular-nums}
.rsub{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--label-2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs{font-size:13px;color:var(--label-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.chev{width:8px;height:14px;color:var(--label-3);flex:none}
@media (min-width:760px){.chev{display:none}}
.badge-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:1.5px 7px;border-radius:6px;line-height:1.3;flex:none}
.st-ongoing{background:var(--accent-soft);color:var(--accent)}
.st-completed{background:var(--green-soft);color:var(--green)}
.st-pending{background:var(--orange-soft);color:var(--orange)}
.st-error{background:var(--red-soft);color:var(--red)}
.st-stopped{background:var(--fill);color:var(--label-2)}
.empty{text-align:center;color:var(--label-2);padding:48px 20px;font-size:14px}
.detail{height:100%;display:flex;flex-direction:column;background:var(--bg);position:relative}
.d-top{height:52px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;background:var(--bar);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);border-bottom:.5px solid var(--sep);flex:none}
.d-top .tt{font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;margin-right:10px}
.navs{display:flex;gap:8px;align-items:center;flex:none}
.glass{width:30px;height:30px;border-radius:50%;background:var(--fill);color:var(--accent);display:grid;place-items:center}
.glass svg{width:14px;height:14px}
.glass:disabled{opacity:.32;pointer-events:none}
.pos{font-size:12px;color:var(--label-2);font-variant-numeric:tabular-nums;min-width:34px;text-align:center}
.main .close-btn{display:none}
.d-scroll{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:16px 18px calc(28px + var(--sb))}
.hero-card{background:var(--card);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}
.hero-row{display:flex;align-items:flex-start;gap:12px}
.hero-meta{flex:1;min-width:0}
.hero-meta h2{font-family:var(--round);font-size:21px;font-weight:700;letter-spacing:-.3px;word-break:break-word}
.hero-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tag{font-size:12px;font-weight:500;padding:3px 9px;border-radius:8px;background:var(--fill);color:var(--label-2)}
.sid{font-family:var(--mono);font-size:12px;color:var(--label-2);word-break:break-all;margin-top:2px}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.act{flex:1;min-width:130px;height:38px;border-radius:10px;background:var(--accent-soft);color:var(--accent);font-size:13.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;padding:0 12px;transition:transform .1s}
.act:active{transform:scale(.97)}
.act.primary{background:var(--accent);color:#fff}
.act svg{width:16px;height:16px;flex:none}
.ev-sec{font-size:12px;font-weight:600;color:var(--label-2);text-transform:uppercase;letter-spacing:.35px;margin:18px 4px 8px}
.cards{display:flex;flex-direction:column;gap:10px}
.ev-card{background:var(--card);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:8px;border-left:3px solid transparent}
.ev-card.k-correction{border-left-color:var(--accent)}
.ev-card.k-error{border-left-color:var(--red)}
.ev-card.k-delivered{border-left-color:var(--green)}
.ev-card.k-outcome{border-left-color:var(--purple)}
.ev-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ev-head time{font-size:12px;color:var(--label-2);margin-left:auto;font-variant-numeric:tabular-nums}
.ev-body{font-size:14px;line-height:1.48;white-space:pre-wrap;word-break:break-word;color:var(--label)}
.ev-kv{display:flex;flex-direction:column;gap:6px;font-size:13.5px;line-height:1.45}
.ev-kv b{font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:var(--label-2);display:block;margin-bottom:1px}
.ev-foot{display:flex;justify-content:flex-end}
.mini-btn{font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-soft);padding:4px 10px;border-radius:7px}
.mini-btn:active{opacity:.75}
.bd{position:fixed;inset:0;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .28s;z-index:40}
.bd.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;top:calc(14px + var(--st));z-index:41;background:var(--bg);border-radius:14px 14px 0 0;transform:translateY(105%);transition:transform .38s var(--ease);overflow:hidden;box-shadow:0 -10px 40px rgba(0,0,0,.18)}
.sheet.on{transform:translateY(0)}
@media (min-width:760px){.sheet,.bd{display:none}}
.toast{position:fixed;left:50%;bottom:calc(28px + var(--sb));transform:translate(-50%,16px);opacity:0;background:rgba(28,28,30,.92);color:#fff;font-size:13.5px;font-weight:500;padding:9px 16px;border-radius:20px;z-index:80;transition:all .25s var(--ease);pointer-events:none}
.toast.on{transform:translate(-50%,0);opacity:1}
.placeholder{height:100%;display:grid;place-items:center;color:var(--label-3);font-size:15px;text-align:center;padding:24px}
.placeholder svg{width:44px;height:44px;margin:0 auto 10px}
</style>
</head>
<body>
<div class="shell">
  <aside class="side" id="side">
    <div class="navbar" id="navbar">
      <div class="t">Intent Guardian</div>
      <div class="r">
        <button class="ib" id="refreshBtn" aria-label="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
      </div>
    </div>
    <div class="large">
      <h1>Intent Guardian</h1>
      <div class="status" id="statusBar"><i></i><span>Connecting…</span></div>
    </div>
    <label class="search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.2-4.2"/></svg>
      <input id="searchInput" type="search" placeholder="Search session, project, prompt…" autocomplete="off">
    </label>
    <div class="chips" id="hostChips"></div>
    <div class="chips" id="stateChips"></div>
    <div class="chips" id="projectChips"></div>
    <div id="list"></div>
  </aside>
  <main class="main" id="main">
    <div class="placeholder"><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7l7-4z"/></svg>Select a session to inspect prompts &amp; live state</div></div>
  </main>
</div>
<div class="bd" id="bd"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true"><div class="detail" id="sheetDetail"></div></div>
<div class="toast" id="toast"></div>
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
    const route = new URL(request.url, "http://localhost").pathname;
    if (route === "/healthz" && request.method === "GET") {
      database.prepare("SELECT id FROM events LIMIT 1").get();
      return response("OK");
    }
    if (route === "/events" && request.method === "POST") return ingest(request, database, feedAuthorization);
    if (route === "/api/state" && request.method === "GET") {
      if (!matches(request.headers.authorization, readerAuthorization)) {
        return response("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="Intent Guardian", charset="UTF-8"' });
      }
      return response(JSON.stringify(queryState(database)), 200, { "Content-Type": "application/json; charset=utf-8" });
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
for (const col of ["project TEXT", "session_url TEXT", "session_state TEXT"]) {
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
