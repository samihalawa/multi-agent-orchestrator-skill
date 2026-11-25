#!/usr/bin/env node
/**
 * Puntual-style continuous change watcher for Intent Guardian.
 *
 * Cheaply polls Chrome CDP (127.0.0.1:9222) and broken-cwd Codex rollouts every 15s,
 * calls intent_guardian.py (gpt-6-luna) ONLY when a new completed turn is detected,
 * publishes results to intent-guardian.megawebs.com, and optionally auto-delivers
 * corrections into open web tabs or broken-cwd Codex threads.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARDIAN_PY = join(__dirname, 'intent_guardian.py');
const PYTHON_BIN = '/usr/bin/python3';
const CODEX_DESKTOP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const CDP_BASE = 'http://127.0.0.1:9222';

const HOME = homedir();
const CONFIG_PATH = join(HOME, '.config', 'intent-guardian', 'config.json');
const STATE_DIR = join(HOME, '.local', 'state', 'intent-guardian');
const WATCHER_STATE_PATH = join(STATE_DIR, 'watcher-state.json');
const LOG_PATH = join(HOME, 'Library', 'Logs', 'intent-guardian-watcher.log');
const CODEX_SESSIONS_DIR = join(HOME, '.codex', 'sessions');

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has('--once');
const NO_DELIVER = ARGS.has('--no-deliver');
const SEED_ONLY = ARGS.has('--seed-only');

const WATCHER_VERSION = '2.0.0';
const GUARDIAN_TAG = "[SAMI'S INTENT GUARDIAN]";
const DEFAULT_INTERVAL_MS = 15_000;
const STABLE_MS = 10_000;
const DELIVERY_COOLDOWN_MS = 60_000;
const MAX_AUTO_WEB_PER_USER_TURN = 1;
const MAX_AUTO_CODEX_PER_USER_TURN = 2;
const RECENT_WEB_MS = ONCE ? 6 * 3600_000 : 30 * 60_000;
const RECENT_CODEX_MS = ONCE ? 6 * 3600_000 : 30 * 60_000;
const COLD_SEED_AGE_MS = 5 * 60_000;
const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(WATCHER_STATE_PATH, 'utf8'));
    return {
      seen: raw.seen || {},
      api_cursors: raw.api_cursors || { chatgpt: {}, grokbot: {}, gemini_web: {}, claude_ai: {} },
      codex_mtimes: raw.codex_mtimes || {},
      claude_mtimes: raw.claude_mtimes || {},
      health: {
        last_tick_at: null,
        last_success_at: null,
        ticks: 0,
        ai_calls: 0,
        deliveries: 0,
        fails: 0,
        cdp_fails: 0,
        last_cdp_kickstart_at: 0,
        last_error: null,
        per_platform: {},
        ...(raw.health || {}),
      },
    };
  } catch {
    return {
      seen: {},
      api_cursors: { chatgpt: {}, grokbot: {}, gemini_web: {}, claude_ai: {} },
      codex_mtimes: {},
      claude_mtimes: {},
      health: {
        last_tick_at: null,
        last_success_at: null,
        ticks: 0,
        ai_calls: 0,
        deliveries: 0,
        fails: 0,
        cdp_fails: 0,
        last_cdp_kickstart_at: 0,
        last_error: null,
        per_platform: {},
      },
    };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = join(STATE_DIR, `.watcher-state.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, WATCHER_STATE_PATH);
}

function rotateLogIfLarge() {
  try {
    if (statSync(LOG_PATH).size > 500_000) truncateSync(LOG_PATH, 0);
  } catch {
    // log file may not exist in manual --once runs
  }
}

function notifyMac(title, message) {
  try {
    const cleanTitle = String(title || 'Intent Guardian').replace(/["\\\n\r]/g, ' ').slice(0, 60);
    const cleanMsg = String(message || '').replace(/["\\\n\r]/g, ' ').slice(0, 180);
    execFileSync('/usr/bin/osascript', [
      '-e',
      `display notification "${cleanMsg}" with title "${cleanTitle}"`,
    ], { timeout: 3000, stdio: 'ignore' });
  } catch {
    // non-fatal
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function cdpTabs() {
  const list = await fetchJson(`${CDP_BASE}/json/list`, 4000);
  return list.filter((t) => t.type === 'page' && typeof t.url === 'string');
}

function evalIn(wsUrl, expression, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      done(null);
      return;
    }
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }));
      } catch {
        done(null);
      }
    };
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.id !== 1) return;
        if (d.result?.exceptionDetails) {
          done({ _eval_error: d.result.exceptionDetails.text || 'eval_exception' });
        } else {
          done(d.result?.result?.value ?? null);
        }
      } catch {
        done(null);
      }
    };
  });
}

async function cdpCookies() {
  const ver = await fetchJson(`${CDP_BASE}/json/version`, 4000);
  if (!ver?.webSocketDebuggerUrl) throw new Error('CDP version missing webSocketDebuggerUrl');
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => done(new Error('Storage.getCookies timeout')), 7000);
    ws.onerror = () => done(new Error('Storage.getCookies ws error'));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.id === 1) done(null, d.result?.cookies || []);
      } catch (e) {
        done(e);
      }
    };
  });
}

const cookieHeader = (cookies, domain) =>
  cookies
    .filter((c) => !c.partitionKey && c.domain && c.domain.includes(domain))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

function parseWebTabUrl(url) {
  let m;
  if ((m = url.match(/^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9-]+)/))) {
    return { host: 'chatgpt', sid: m[1] };
  }
  if ((m = url.match(/^https:\/\/claude\.ai\/chat\/([a-zA-Z0-9-]+)/))) {
    return { host: 'claude_ai', sid: m[1] };
  }
  if ((m = url.match(/^https:\/\/gemini\.google\.com\/app\/([a-zA-Z0-9_-]+)/))) {
    return { host: 'gemini_web', sid: m[1] };
  }
  if ((m = url.match(/^https:\/\/grok\.com\/(?:c|chat)\/([a-zA-Z0-9-]+)/))) {
    return { host: 'grokbot', sid: m[1] };
  }
  return null;
}

// Browser-side extractor functions (stringified cleanly into Runtime.evaluate)
function extractGeminiTabFn() {
  const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Detener" i], .stop-icon, mat-progress-spinner');
  const streaming = !!(stopBtn && stopBtn.offsetParent !== null);
  const queries = Array.from(document.querySelectorAll('user-query')).map((e) => {
    const raw = (e.innerText || '').trim();
    if (/^You said /i.test(raw) && raw.includes('\n\n')) {
      return raw.slice(raw.indexOf('\n\n') + 2).trim();
    }
    return raw.replace(/^You said\s*\n?/i, '').trim();
  }).filter(Boolean);
  const responses = Array.from(document.querySelectorAll('model-response')).map((e) =>
    (e.innerText || '').replace(/^Gemini said\s*\n?/i, '').trim()
  ).filter(Boolean);
  const turns = [];
  const maxLen = Math.max(queries.length, responses.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < queries.length) turns.push({ role: 'user', text: queries[i] });
    if (i < responses.length) turns.push({ role: 'assistant', text: responses[i] });
  }
  const editor = document.querySelector('.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"]');
  const composer_empty = editor ? !(editor.innerText || '').trim() : false;
  return {
    title: (document.title || 'Google Gemini').replace(/\s*-\s*Google Gemini$/, '').trim(),
    url: location.href,
    streaming,
    composer_empty,
    turns,
  };
}

async function extractGrokTabFn(sid) {
  const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
  const streaming = !!(stopBtn && stopBtn.offsetParent !== null);
  const editor = document.querySelector('textarea, div[contenteditable="true"][role="textbox"], .tiptap[contenteditable="true"]');
  const composer_empty = editor ? !(editor.value ?? editor.innerText ?? '').trim() : false;
  let turns = [];
  try {
    const nRes = await fetch(`/rest/app-chat/conversations/${sid}/response-node?includeThreads=true`);
    if (nRes.ok) {
      const nodes = await nRes.json();
      const ids = (nodes.responseNodes || []).map((x) => x.responseId).filter(Boolean);
      if (ids.length) {
        const lRes = await fetch(`/rest/app-chat/conversations/${sid}/load-responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ responseIds: ids }),
        });
        if (lRes.ok) {
          const loaded = await lRes.json();
          turns = (loaded.responses || [])
            .filter((r) => r.message)
            .map((r) => ({ role: r.sender === 'human' ? 'user' : 'assistant', text: String(r.message).trim() }))
            .filter((t) => t.text);
        }
      }
    }
  } catch {}
  return {
    title: (document.title || 'Grok').replace(/\s*-\s*Grok$/, '').trim(),
    url: location.href,
    streaming,
    composer_empty,
    turns,
  };
}

async function extractChatGptTabFn(sid) {
  const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]');
  const streaming = !!(stopBtn && stopBtn.offsetParent !== null);
  const editor = document.querySelector('#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], textarea');
  const composer_empty = editor ? !(editor.value ?? editor.innerText ?? '').trim() : false;
  let title = (document.title || 'ChatGPT').replace(/\s*\|\s*ChatGPT$/, '').trim();
  const turns = [];
  try {
    const sRes = await fetch('/api/auth/session');
    const sess = sRes.ok ? await sRes.json() : {};
    if (sess.accessToken) {
      const cRes = await fetch(`/backend-api/conversation/${sid}`, {
        headers: { authorization: `Bearer ${sess.accessToken}` },
      });
      if (cRes.ok) {
        const conv = await cRes.json();
        title = conv.title || title;
        let n = conv.current_node;
        while (n && conv.mapping?.[n]) {
          const m = conv.mapping[n].message;
          const role = m?.author?.role;
          if (role === 'user' || role === 'assistant') {
            const ctype = m?.content?.content_type;
            if (!['thoughts', 'reasoning_recap'].includes(ctype) && Array.isArray(m?.content?.parts)) {
              const text = m.content.parts.filter((p) => typeof p === 'string').join('\n').trim();
              if (text) turns.push({ role, text });
            }
          }
          n = conv.mapping[n].parent;
        }
        turns.reverse();
      }
    }
  } catch {}
  if (!turns.length) {
    for (const el of document.querySelectorAll('[data-message-author-role]')) {
      const role = el.getAttribute('data-message-author-role');
      if (role === 'user' || role === 'assistant') {
        const text = (el.innerText || '').trim();
        if (text) turns.push({ role, text });
      }
    }
  }
  return { title, url: location.href, streaming, composer_empty, turns };
}

async function extractClaudeAiTabFn(sid) {
  const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
  const streaming = !!(stopBtn && stopBtn.offsetParent !== null);
  const editor = document.querySelector('div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"]');
  const composer_empty = editor ? !(editor.innerText || '').trim() : false;
  let title = (document.title || 'Claude').replace(/\s*-\s*Claude$/, '').trim();
  let turns = [];
  try {
    const oRes = await fetch('/api/organizations');
    const orgs = oRes.ok ? await oRes.json() : [];
    const orgId = Array.isArray(orgs) && orgs[0]?.uuid;
    if (orgId) {
      const cRes = await fetch(`/api/organizations/${orgId}/chat_conversations/${sid}?tree=True&rendering_mode=messages&consistency=strong`);
      if (cRes.ok) {
        const conv = await cRes.json();
        title = conv.name || title;
        turns = (conv.chat_messages || [])
          .map((m) => ({
            role: m.sender === 'human' ? 'user' : 'assistant',
            text: String(m.text || (m.content || []).map((c) => c.text || '').join('\n')).trim(),
          }))
          .filter((t) => t.text);
      }
    }
  } catch {}
  return { title, url: location.href, streaming, composer_empty, turns };
}

function deliverToWebTabFn(host, text) {
  const selectors = {
    gemini_web: {
      editor: '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[role="textbox"]',
      send: 'button.send-button, button[aria-label*="Send" i], button[aria-label*="Enviar" i]',
    },
    grokbot: {
      editor: 'textarea, div[contenteditable="true"][role="textbox"], .tiptap[contenteditable="true"]',
      send: 'button[type="submit"], button[aria-label*="Submit" i], button[aria-label*="Send" i]',
    },
    chatgpt: {
      editor: '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], textarea',
      send: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
    },
    claude_ai: {
      editor: 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"]',
      send: 'button[aria-label*="Send" i]',
    },
  };
  const sel = selectors[host];
  if (!sel) return { ok: false, reason: 'unsupported host' };
  const el = document.querySelector(sel.editor);
  if (!el) return { ok: false, reason: 'no editor' };
  const current = (el.value ?? el.innerText ?? '').trim();
  if (current) return { ok: false, reason: 'composer not empty' };
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc?.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const btn = Array.from(document.querySelectorAll(sel.send)).find((b) => !b.disabled && b.offsetParent !== null);
      if (btn) {
        btn.click();
        resolve({ ok: true, method: 'button' });
      } else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        resolve({ ok: true, method: 'enter' });
      }
    }, 350);
  });
}

function runPythonGuardian(args, stdinJson = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ['-B', GUARDIAN_PY, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`intent_guardian.py ${args[0]} timed out`));
    }, 65_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`bad json (${code}): ${out.slice(0, 200)} | ${err.slice(0, 120)}`));
      }
    });
    if (stdinJson !== null) child.stdin.write(JSON.stringify(stdinJson));
    child.stdin.end();
  });
}

async function recordDelivery(host, sid, feedbackHash, sourceId) {
  try {
    await runPythonGuardian([
      'record-delivery',
      '--host', host,
      '--session-id', sid,
      '--feedback-hash', feedbackHash || '',
      '--source-id', sourceId || 'watcher',
    ]);
  } catch (e) {
    log(`[record-delivery-warn] ${host}:${sid}: ${e.message}`);
  }
}

async function publishWatcherHealth(state, cfg) {
  const feedUrl = cfg.feed_url;
  if (!feedUrl || !feedUrl.startsWith('https://')) return false;
  let token = process.env.GUARDIAN_FEED_TOKEN || '';
  if (!token && cfg.feed_token_file) {
    try {
      const p = cfg.feed_token_file.replace(/^~(?=\/|$)/, HOME);
      token = readFileSync(p, 'utf8').trim();
    } catch {
      return false;
    }
  }
  if (!token) return false;
  const watcherUrl = feedUrl.replace(/\/events\/?$/, '/watcher');
  const payload = {
    version: WATCHER_VERSION,
    pid: process.pid,
    interval_ms: Number(cfg.watcher_interval_ms) || DEFAULT_INTERVAL_MS,
    auto_deliver: cfg.watcher_auto_deliver !== false && !NO_DELIVER,
    seen_count: Object.keys(state.seen || {}).length,
    ...state.health,
  };
  try {
    const res = await fetch(watcherUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': `IntentGuardianWatcher/${WATCHER_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sendCodexTurn(threadId, text) {
  return new Promise((resolve, reject) => {
    if (!existsSync(CODEX_DESKTOP_BIN)) {
      reject(new Error('Codex Desktop binary missing'));
      return;
    }
    const p = spawn(CODEX_DESKTOP_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('codex app-server turn/start timeout'));
    }, 20_000);
    const send = (obj) => p.stdin.write(JSON.stringify(obj) + '\n');
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'thread/resume', params: { threadId } });
        } else if (msg.id === 2) {
          if (msg.error) {
            clearTimeout(timer);
            try { p.kill(); } catch {}
            reject(new Error(JSON.stringify(msg.error).slice(0, 180)));
          } else {
            send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text }] } });
          }
        } else if (msg.id === 3) {
          clearTimeout(timer);
          try { p.kill(); } catch {}
          if (msg.error) reject(new Error(JSON.stringify(msg.error).slice(0, 180)));
          else resolve(msg.result || { ok: true });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'guardian-watcher', version: WATCHER_VERSION } } });
  });
}

function summarizeTurns(turns) {
  const cleanTurns = (turns || []).filter((t) => t && typeof t.text === 'string' && t.text.trim());
  const humanPrompts = cleanTurns.filter((t) => t.role === 'user' && !t.text.includes(GUARDIAN_TAG));
  const lastAsst = [...cleanTurns].reverse().find((t) => t.role === 'assistant');
  if (!humanPrompts.length || !lastAsst) return null;
  const lastUserDigest = sha(humanPrompts[humanPrompts.length - 1].text.trim());
  const turnDigest = sha([lastUserDigest, lastAsst.text.trim()]);
  return { cleanTurns, humanPrompts, lastAsst, lastUserDigest, turnDigest };
}

async function handleWebCandidate(state, cfg, candidate, isColdStart) {
  const { host, sid, title, url, streaming, composer_empty, turns, updatedAtMs, tab } = candidate;
  if (streaming) return;
  const summary = summarizeTurns(turns);
  if (!summary) return;

  const key = `${host}:${sid}`;
  const prev = state.seen[key] || {};
  const now = Date.now();

  if (prev.reviewed_digest === summary.turnDigest) return;

  if (SEED_ONLY) {
    state.seen[key] = {
      ...prev,
      reviewed_digest: summary.turnDigest,
      last_user_digest: summary.lastUserDigest,
      updated_at: updatedAtMs || now,
      title,
      url,
    };
    return;
  }

  // Cold-start / historical anti-spam rule (daemon mode only, skipped in --once)
  if (!ONCE && !prev.reviewed_digest && !prev.pending_digest) {
    const staleByTime = updatedAtMs && (now - updatedAtMs > COLD_SEED_AGE_MS);
    if (staleByTime || (isColdStart && !updatedAtMs)) {
      state.seen[key] = {
        ...prev,
        reviewed_digest: summary.turnDigest,
        last_user_digest: summary.lastUserDigest,
        updated_at: updatedAtMs || now,
        title,
        url,
      };
      log(`[seed] ${key} (${title.slice(0, 45)})`);
      return;
    }
  }

  // 2-tick stability debounce in daemon mode so we never evaluate mid-stream
  if (!ONCE) {
    if (prev.pending_digest !== summary.turnDigest) {
      state.seen[key] = { ...prev, pending_digest: summary.turnDigest, pending_seen_at: now, title, url };
      return;
    }
    if (now - (prev.pending_seen_at || 0) < STABLE_MS) return;
  }

  const prompt = summary.humanPrompts.slice(-6).map((t) => t.text.trim()).join('\n\n');
  const evidence = summary.cleanTurns.slice(-10).map((t) => `${t.role}: ${t.text.trim().slice(0, 1600)}`);

  state.health.ai_calls = (state.health.ai_calls || 0) + 1;
  const res = await runPythonGuardian(['review-job', '--host', host], {
    session_id: sid,
    prompt,
    result: summary.lastAsst.text.trim(),
    evidence,
    session_url: url,
    project: title,
  });

  const sameUser = prev.last_user_digest === summary.lastUserDigest;
  const autoCount = sameUser ? (prev.auto_sent_count || 0) : 0;

  state.seen[key] = {
    ...prev,
    reviewed_digest: summary.turnDigest,
    pending_digest: null,
    pending_seen_at: null,
    last_user_digest: summary.lastUserDigest,
    auto_sent_count: autoCount,
    updated_at: updatedAtMs || now,
    title,
    url,
    last_status: res.status,
  };

  log(`[review] ${key} status=${res.status} err=${res.model_error?.category || 'none'} title=${JSON.stringify(title.slice(0, 40))}`);

  const correction = res.hook_output?.reason || res.hook_output?.hookSpecificOutput?.additionalContext || '';
  if (!correction) return;

  notifyMac(`Intent Guardian (${host})`, res.last_review?.decision?.reason || correction.slice(0, 140));

  const autoDeliver = cfg.watcher_auto_deliver !== false && !NO_DELIVER;
  if (!autoDeliver || !tab) return;
  if (!composer_empty) {
    log(`[deliver-skip] ${key}: composer not empty`);
    return;
  }
  if (autoCount >= MAX_AUTO_WEB_PER_USER_TURN) {
    log(`[deliver-skip] ${key}: max ${MAX_AUTO_WEB_PER_USER_TURN} auto-delivery reached for this turn`);
    return;
  }
  if (autoCount >= 1 && /\b(?:your video is ready|video is ready|tu v[ií]deo est[aá] listo|here(?:'s| is) (?:the|your) (?:video|image))\b/i.test(summary.lastAsst.text || '')) {
    log(`[deliver-skip] ${key}: native media-ready completion`);
    return;
  }
  if (now - (prev.last_sent_at || 0) < DELIVERY_COOLDOWN_MS) {
    log(`[deliver-skip] ${key}: cooldown`);
    return;
  }

  const sent = await evalIn(
    tab.webSocketDebuggerUrl,
    `(${deliverToWebTabFn.toString()})(${JSON.stringify(host)}, ${JSON.stringify(correction)})`,
    8000,
  );
  if (sent?.ok) {
    await sleep(1500);
    state.seen[key].auto_sent_count = autoCount + 1;
    state.seen[key].last_sent_at = Date.now();
    state.health.deliveries = (state.health.deliveries || 0) + 1;
    await recordDelivery(host, sid, res.feedback_hash, `cdp-dom:${sent.method}`);
    log(`[delivered] ${key} via ${sent.method}`);
  } else {
    log(`[deliver-failed] ${key}: ${JSON.stringify(sent)}`);
  }
}

async function fetchOpenTabCandidate(tab, parsed) {
  let expr;
  if (parsed.host === 'gemini_web') expr = `(${extractGeminiTabFn.toString()})()`;
  else if (parsed.host === 'grokbot') expr = `(${extractGrokTabFn.toString()})(${JSON.stringify(parsed.sid)})`;
  else if (parsed.host === 'chatgpt') expr = `(${extractChatGptTabFn.toString()})(${JSON.stringify(parsed.sid)})`;
  else if (parsed.host === 'claude_ai') expr = `(${extractClaudeAiTabFn.toString()})(${JSON.stringify(parsed.sid)})`;
  else return null;

  const res = await evalIn(tab.webSocketDebuggerUrl, expr, 7000);
  if (!res || res._eval_error || !Array.isArray(res.turns) || !res.turns.length) return null;
  return {
    host: parsed.host,
    sid: parsed.sid,
    title: res.title || tab.title || parsed.host,
    url: res.url || tab.url,
    streaming: Boolean(res.streaming),
    composer_empty: Boolean(res.composer_empty),
    turns: res.turns,
    updatedAtMs: null,
    tab,
  };
}

async function sweepBackgroundWebApis(state, cfg, tabs, openKeys, isColdStart) {
  let cookies = [];
  try {
    cookies = await cdpCookies();
  } catch {
    return;
  }
  const now = Date.now();

  // 1. ChatGPT background API
  try {
    const ck = cookieHeader(cookies, 'chatgpt.com');
    if (ck) {
      const s = await fetch('https://chatgpt.com/api/auth/session', {
        headers: { cookie: ck, 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
      }).then((r) => (r.ok ? r.json() : {}));
      if (s.accessToken) {
        const list = await fetch('https://chatgpt.com/backend-api/conversations?offset=0&limit=5&order=updated', {
          headers: { authorization: `Bearer ${s.accessToken}`, cookie: ck, 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(6000),
        }).then((r) => (r.ok ? r.json() : {}));
        const items = (list.items || []).slice(0, 5);
        state.health.per_platform.chatgpt = { last_checked: new Date().toISOString(), recent_count: items.length };
        let checked = 0;
        for (const it of items) {
          const updMs = Date.parse(it.update_time || '');
          if (!updMs || now - updMs > RECENT_WEB_MS) continue;
          const key = `chatgpt:${it.id}`;
          if (openKeys.has(key)) continue;
          if (state.api_cursors.chatgpt[it.id] === it.update_time && state.seen[key]?.reviewed_digest) continue;
          if (ONCE && checked >= 2) break;
          checked++;
          const conv = await fetch(`https://chatgpt.com/backend-api/conversation/${it.id}`, {
            headers: { authorization: `Bearer ${s.accessToken}`, cookie: ck, 'user-agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(7000),
          }).then((r) => (r.ok ? r.json() : null));
          if (!conv) continue;
          const turns = [];
          let n = conv.current_node;
          while (n && conv.mapping?.[n]) {
            const m = conv.mapping[n].message;
            const role = m?.author?.role;
            if (role === 'user' || role === 'assistant') {
              const ctype = m?.content?.content_type;
              if (!['thoughts', 'reasoning_recap'].includes(ctype) && Array.isArray(m?.content?.parts)) {
                const text = m.content.parts.filter((p) => typeof p === 'string').join('\n').trim();
                if (text) turns.push({ role, text });
              }
            }
            n = conv.mapping[n].parent;
          }
          turns.reverse();
          state.api_cursors.chatgpt[it.id] = it.update_time;
          await handleWebCandidate(state, cfg, {
            host: 'chatgpt',
            sid: it.id,
            title: conv.title || it.title || 'ChatGPT',
            url: `https://chatgpt.com/c/${it.id}`,
            streaming: false,
            composer_empty: false,
            turns,
            updatedAtMs: updMs,
            tab: null,
          }, isColdStart);
        }
      }
    }
  } catch (e) {
    state.health.per_platform.chatgpt = { last_checked: new Date().toISOString(), error: e.message.slice(0, 120) };
  }

  // 2. Grok.com background API
  try {
    const ck = cookieHeader(cookies, 'grok.com');
    if (ck) {
      const list = await fetch('https://grok.com/rest/app-chat/conversations?pageSize=5', {
        headers: { cookie: ck, 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000),
      }).then((r) => (r.ok ? r.json() : {}));
      const convs = (list.conversations || []).slice(0, 5);
      state.health.per_platform.grokbot = { last_checked: new Date().toISOString(), recent_count: convs.length };
      let checked = 0;
      for (const it of convs) {
        const sid = it.conversationId;
        const mod = it.modifyTime || it.createTime || '';
        const updMs = Date.parse(mod);
        if (!sid || !updMs || now - updMs > RECENT_WEB_MS) continue;
        const key = `grokbot:${sid}`;
        if (openKeys.has(key)) continue;
        if (state.api_cursors.grokbot[sid] === mod && state.seen[key]?.reviewed_digest) continue;
        if (ONCE && checked >= 2) break;
        checked++;
        const nodes = await fetch(`https://grok.com/rest/app-chat/conversations/${sid}/response-node?includeThreads=true`, {
          headers: { cookie: ck, 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(6000),
        }).then((r) => (r.ok ? r.json() : {}));
        const ids = (nodes.responseNodes || []).map((x) => x.responseId).filter(Boolean);
        if (!ids.length) continue;
        const loaded = await fetch(`https://grok.com/rest/app-chat/conversations/${sid}/load-responses`, {
          method: 'POST',
          headers: { cookie: ck, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
          body: JSON.stringify({ responseIds: ids }),
          signal: AbortSignal.timeout(6000),
        }).then((r) => (r.ok ? r.json() : {}));
        const turns = (loaded.responses || [])
          .filter((r) => r.message)
          .map((r) => ({ role: r.sender === 'human' ? 'user' : 'assistant', text: String(r.message).trim() }))
          .filter((t) => t.text);
        state.api_cursors.grokbot[sid] = mod;
        await handleWebCandidate(state, cfg, {
          host: 'grokbot',
          sid,
          title: it.title || 'Grok',
          url: `https://grok.com/c/${sid}`,
          streaming: false,
          composer_empty: false,
          turns,
          updatedAtMs: updMs,
          tab: null,
        }, isColdStart);
      }
    }
  } catch (e) {
    state.health.per_platform.grokbot = { last_checked: new Date().toISOString(), error: e.message.slice(0, 120) };
  }

  // 3. Gemini Web MaZiqc tracking via any open Gemini tab
  const gemTab = tabs.find((t) => t.url.startsWith('https://gemini.google.com/'));
  if (gemTab) {
    const res = await evalIn(gemTab.webSocketDebuggerUrl, `(async () => {
      const wiz = window.WIZ_global_data || {};
      if (!wiz.SNlM0e || !wiz.cfb2h) return null;
      const body = new URLSearchParams({"f.req": JSON.stringify([[["MaZiqc", JSON.stringify([8, null, [0, null, 1]]), null, "generic"]]]), at: wiz.SNlM0e});
      const r = await fetch("/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&bl=" + encodeURIComponent(wiz.cfb2h) + "&f.sid=" + encodeURIComponent(wiz.FdrFJe || ""), {
        method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body
      });
      const txt = await r.text();
      const line = txt.split(String.fromCharCode(10)).find((l) => l.startsWith("[["));
      if (!line) return null;
      const inner = JSON.parse(JSON.parse(line)[0][2]);
      return (inner[2] || []).slice(0, 5).map((c) => ({id: String(c[0]).replace(/^c_/, ""), title: c[1], ts: c[5]?.[0]}));
    })()`, 7000);
    if (Array.isArray(res)) {
      for (const c of res) state.api_cursors.gemini_web[c.id] = c.ts;
      state.health.per_platform.gemini_web = { last_checked: new Date().toISOString(), recent_count: res.length };
    }
  }

  // 4. Claude.ai background sweep via any open Claude.ai tab (bypasses Cloudflare)
  const claudeTab = tabs.find((t) => t.url.startsWith('https://claude.ai/'));
  if (claudeTab) {
    const res = await evalIn(claudeTab.webSocketDebuggerUrl, `(async () => {
      const orgs = await fetch("/api/organizations").then(r => r.ok ? r.json() : []);
      const orgId = Array.isArray(orgs) && orgs[0]?.uuid;
      if (!orgId) return { error: "no_org" };
      const list = await fetch("/api/organizations/" + orgId + "/chat_conversations?limit=5").then(r => r.ok ? r.json() : []);
      return { orgId, items: Array.isArray(list) ? list.slice(0, 5).map(x => ({uuid: x.uuid, name: x.name, updated_at: x.updated_at})) : [] };
    })()`, 7000);
    if (res && Array.isArray(res.items)) {
      state.health.per_platform.claude_ai = { last_checked: new Date().toISOString(), recent_count: res.items.length };
      for (const it of res.items) {
        const updMs = Date.parse(it.updated_at || '');
        if (!it.uuid || !updMs || now - updMs > RECENT_WEB_MS) continue;
        const key = `claude_ai:${it.uuid}`;
        if (openKeys.has(key)) continue;
        if (state.api_cursors.claude_ai[it.uuid] === it.updated_at && state.seen[key]?.reviewed_digest) continue;
        const conv = await evalIn(claudeTab.webSocketDebuggerUrl, `(async () => {
          const r = await fetch("/api/organizations/${res.orgId}/chat_conversations/${it.uuid}?tree=True&rendering_mode=messages&consistency=strong");
          return r.ok ? r.json() : null;
        })()`, 7000);
        if (!conv) continue;
        const turns = (conv.chat_messages || [])
          .map((m) => ({
            role: m.sender === 'human' ? 'user' : 'assistant',
            text: String(m.text || (m.content || []).map((c) => c.text || '').join('\n')).trim(),
          }))
          .filter((t) => t.text);
        state.api_cursors.claude_ai[it.uuid] = it.updated_at;
        await handleWebCandidate(state, cfg, {
          host: 'claude_ai',
          sid: it.uuid,
          title: conv.name || it.name || 'Claude.ai',
          url: `https://claude.ai/chat/${it.uuid}`,
          streaming: false,
          composer_empty: false,
          turns,
          updatedAtMs: updMs,
          tab: null,
        }, isColdStart);
      }
    }
  }
}

function recentCodexSessionFiles() {
  const dirs = new Set();
  const now = new Date();
  for (const offsetHours of [0, -12, -24]) {
    const d = new Date(now.getTime() + offsetHours * 3600_000);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dirs.add(join(CODEX_SESSIONS_DIR, yyyy, mm, dd));
  }
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        results.push({ path: p, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

function guardianStateLastSeenMs(host, sid) {
  try {
    const key = sha(`[${JSON.stringify(host)}, ${JSON.stringify(sid)}]`).slice(0, 32);
    const raw = JSON.parse(readFileSync(join(STATE_DIR, `${key}.json`), 'utf8'));
    return (Number(raw.last_seen) || 0) * 1000;
  } catch {
    return 0;
  }
}

function inspectCodexRollout(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return null;
  let meta;
  try { meta = JSON.parse(lines[0]); } catch { return null; }
  if (meta.type !== 'session_meta') return null;
  const pl = meta.payload || {};
  const sid = pl.id || pl.session_id;
  const cwd = pl.cwd || '';
  const src = pl.source;
  const isSubagent = pl.thread_source === 'subagent' || (src && typeof src === 'object' && 'subagent' in src);
  if (!sid || isSubagent) return null;
  const brokenCwd = !(cwd && existsSync(cwd));

  let lastUserLine = -1;
  let lastDoneLine = -1;
  let lastTaskStart = -1;
  let lastTaskEnd = -1;
  let userCount = 0;
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const t = row.type;
    const p = row.payload || {};
    if (t === 'event_msg' && p.type === 'task_started') {
      lastTaskStart = i;
    } else if (t === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      lastTaskEnd = i;
      lastDoneLine = i;
    } else if (t === 'event_msg' && p.type === 'user_message' && (p.message || '').trim()) {
      userCount++;
      lastUserLine = i;
    } else if (t === 'response_item' && p.type === 'message' && p.role === 'user') {
      const txt = Array.isArray(p.content)
        ? p.content.filter((x) => x && x.type === 'input_text').map((x) => x.text || '').join(' ').trim()
        : '';
      if (txt && !/^(?:#\s*AGENTS\.md|<environment_context>|<permissions|<collaboration_mode>|<skill>|<recommended_plugins>|<hook_prompt)/.test(txt)) {
        userCount++;
        lastUserLine = i;
      }
    } else if (t === 'response_item' && p.type === 'function_call_output' && p.namespace === 'codex_app' && (p.name === 'create_thread' || p.name === 'automation_update')) {
      userCount++;
      lastUserLine = i;
    } else if (t === 'event_msg' && p.type === 'agent_message') {
      lastDoneLine = i;
    } else if (t === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      lastDoneLine = i;
    }
  }
  if (!userCount || lastTaskStart > lastTaskEnd || lastDoneLine <= lastUserLine) return null;
  return { sid, cwd, brokenCwd, userCount };
}

async function sweepBrokenCwdCodex(state, cfg) {
  const now = Date.now();
  const autoDeliver = cfg.watcher_auto_deliver !== false && !NO_DELIVER;
  for (const [key, entry] of Object.entries(state.seen || {})) {
    const q = entry?.pending_codex_delivery;
    if (!q) continue;
    let currentMtime = null;
    try { currentMtime = statSync(q.filePath).mtimeMs; } catch {}
    if (!currentMtime || currentMtime !== q.mtimeMs || q.attempts >= 3 || (now - (q.queued_at || now) > 600_000)) {
      delete entry.pending_codex_delivery;
      continue;
    }
    if (!autoDeliver || now < (q.next_retry_at || 0)) continue;
    try {
      await sendCodexTurn(q.sid, q.correction);
      entry.auto_sent_count = (entry.auto_sent_count || 0) + 1;
      entry.last_sent_at = Date.now();
      delete entry.pending_codex_delivery;
      state.health.deliveries = (state.health.deliveries || 0) + 1;
      await recordDelivery('codex', q.sid, q.feedback_hash, 'codex-app-server-retry');
      log(`[codex-delivered-retry] sid=${q.sid} attempt=${q.attempts}`);
    } catch (e) {
      if (/active writer/i.test(e.message || '')) {
        q.attempts = (q.attempts || 1) + 1;
        q.next_retry_at = Date.now() + 60_000;
        state.health.active_writer_skips = (state.health.active_writer_skips || 0) + 1;
      } else {
        delete entry.pending_codex_delivery;
        log(`[codex-deliver-retry-failed] sid=${q.sid}: ${e.message}`);
      }
    }
  }

  const files = recentCodexSessionFiles();
  let audited = 0;
  for (const { path: filePath, mtimeMs } of files) {
    if (now - mtimeMs > RECENT_CODEX_MS) break;
    if (!ONCE && now - mtimeMs < 6000) continue; // still actively writing
    if (state.codex_mtimes[filePath] === mtimeMs) continue;

    const info = inspectCodexRollout(filePath);
    if (!info) {
      state.codex_mtimes[filePath] = mtimeMs;
      continue;
    }

    if (SEED_ONLY) {
      state.codex_mtimes[filePath] = mtimeMs;
      continue;
    }
    if (!info.brokenCwd) {
      if (!ONCE && now - mtimeMs < 45_000) continue; // give native Stop hook time to run first
      const lastSeenMs = guardianStateLastSeenMs('codex', info.sid);
      if (lastSeenMs && mtimeMs <= lastSeenMs + 30_000) {
        state.codex_mtimes[filePath] = mtimeMs;
        continue;
      }
    }

    state.health.ai_calls = (state.health.ai_calls || 0) + 1;
    const res = await runPythonGuardian([
      'audit',
      '--host', 'codex',
      '--session-id', info.sid,
      '--transcript', filePath,
      '--event', 'Stop',
    ]);
    state.codex_mtimes[filePath] = mtimeMs;
    audited++;
    log(`[${info.brokenCwd ? 'codex-broken-cwd' : 'codex-missed-stop'}] sid=${info.sid} status=${res.status} err=${res.model_error?.category || 'none'}`);

    const correction = res.hook_output?.reason || '';
    if (correction) {
      notifyMac('Intent Guardian (codex)', res.last_review?.decision?.reason || correction.slice(0, 140));
      const key = `codex:${info.sid}`;
      const prev = state.seen[key] || {};
      if (autoDeliver && (prev.auto_sent_count || 0) < MAX_AUTO_CODEX_PER_USER_TURN && now - (prev.last_sent_at || 0) > DELIVERY_COOLDOWN_MS) {
        try {
          await sendCodexTurn(info.sid, correction);
          state.seen[key] = { ...prev, auto_sent_count: (prev.auto_sent_count || 0) + 1, last_sent_at: Date.now() };
          state.health.deliveries = (state.health.deliveries || 0) + 1;
          await recordDelivery('codex', info.sid, res.feedback_hash, 'codex-app-server');
          log(`[codex-delivered] sid=${info.sid} via app-server turn/start`);
        } catch (e) {
          if (/active writer/i.test(e.message || '')) {
            state.health.active_writer_skips = (state.health.active_writer_skips || 0) + 1;
            state.seen[key] = {
              ...prev,
              pending_codex_delivery: {
                sid: info.sid,
                filePath,
                mtimeMs,
                correction,
                feedback_hash: res.feedback_hash || '',
                attempts: 1,
                queued_at: Date.now(),
                next_retry_at: Date.now() + 45_000,
              },
            };
            log(`[codex-deliver-queued] sid=${info.sid}: active writer, retry in 45s`);
          } else {
            log(`[codex-deliver-failed] sid=${info.sid}: ${e.message}`);
          }
        }
      }
    }
    if (ONCE && audited >= 1) break;
  }
  state.health.per_platform.codex_broken_cwd = { last_checked: new Date().toISOString(), audited_last_tick: audited };
}

function inspectClaudeJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let hasUser = false;
  let lastRole = null;
  for (const line of lines.slice(-60)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain || row.isMeta) continue;
    const t = row.type;
    if (t === 'user') {
      const c = row.message?.content;
      const isToolOnly = Array.isArray(c) && c.length && c.every((x) => x && x.type === 'tool_result');
      if (!isToolOnly) {
        hasUser = true;
        lastRole = 'user';
      }
    } else if (t === 'assistant') {
      lastRole = 'assistant';
    }
  }
  return hasUser && lastRole === 'assistant';
}

async function sweepMissedClaudeStops(state, cfg) {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;
  const now = Date.now();
  const candidates = [];
  for (const proj of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dir = join(CLAUDE_PROJECTS_DIR, proj);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
      const filePath = join(dir, name);
      try {
        const st = statSync(filePath);
        if (now - st.mtimeMs <= RECENT_CODEX_MS) {
          candidates.push({ filePath, mtimeMs: st.mtimeMs, sid: name.slice(0, -6) });
        }
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let audited = 0;
  for (const { filePath, mtimeMs, sid } of candidates) {
    if (!ONCE && now - mtimeMs < 45_000) continue;
    if (state.claude_mtimes[filePath] === mtimeMs) continue;
    const lastSeenMs = guardianStateLastSeenMs('claude', sid);
    if (lastSeenMs && mtimeMs <= lastSeenMs + 30_000) {
      state.claude_mtimes[filePath] = mtimeMs;
      continue;
    }
    if (SEED_ONLY || !inspectClaudeJsonl(filePath)) {
      state.claude_mtimes[filePath] = mtimeMs;
      continue;
    }
    state.health.ai_calls = (state.health.ai_calls || 0) + 1;
    const res = await runPythonGuardian([
      'audit',
      '--host', 'claude',
      '--session-id', sid,
      '--transcript', filePath,
      '--event', 'Stop',
    ]);
    state.claude_mtimes[filePath] = mtimeMs;
    audited++;
    log(`[claude-missed-stop] sid=${sid} status=${res.status} err=${res.model_error?.category || 'none'}`);
    const corr = res.hook_output?.hookSpecificOutput?.additionalContext || res.hook_output?.reason || '';
    if (corr) notifyMac('Intent Guardian (claude)', res.last_review?.decision?.reason || corr.slice(0, 140));
    if (ONCE && audited >= 1) break;
  }
  state.health.per_platform.claude = { last_checked: new Date().toISOString(), audited_last_tick: audited };
}

async function tick(state) {
  rotateLogIfLarge();
  const cfg = loadConfig();
  const isColdStart = !state.health.ticks;
  const prevDeliveries = state.health.deliveries || 0;
  state.health.ticks = (state.health.ticks || 0) + 1;
  state.health.last_tick_at = new Date().toISOString();

  // 1. Web tabs & background web APIs via shared Chrome CDP
  let tabs = [];
  let cdpOk = false;
  try {
    tabs = await cdpTabs();
    cdpOk = true;
    state.health.cdp_fails = 0;
  } catch (e) {
    state.health.cdp_fails = (state.health.cdp_fails || 0) + 1;
    if (state.health.cdp_fails % 5 === 1) log(`[cdp-warn] Chrome CDP unavailable: ${e.message}`);
    if (!ONCE && state.health.cdp_fails >= 5 && Date.now() - (state.health.last_cdp_kickstart_at || 0) > 600_000) {
      try {
        execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.sami.chrome-agent`], {
          timeout: 5000,
          stdio: 'ignore',
        });
        state.health.last_cdp_kickstart_at = Date.now();
        log(`[cdp-self-heal] kickstarted com.sami.chrome-agent after ${state.health.cdp_fails} failures`);
      } catch {}
    }
  }

  if (cdpOk) {
    const openKeys = new Set();
    for (const tab of tabs) {
      const parsed = parseWebTabUrl(tab.url);
      if (!parsed) continue;
      const key = `${parsed.host}:${parsed.sid}`;
      openKeys.add(key);
      const cand = await fetchOpenTabCandidate(tab, parsed);
      if (cand) {
        state.health.per_platform[parsed.host] = {
          last_checked: new Date().toISOString(),
          open_tab_sid: parsed.sid,
          streaming: cand.streaming,
        };
        await handleWebCandidate(state, cfg, cand, isColdStart);
      }
    }
    if (ONCE || state.health.ticks % 2 === 0) {
      await sweepBackgroundWebApis(state, cfg, tabs, openKeys, isColdStart);
    }
  }

  // 2. Broken-cwd & missed-Stop Codex rollouts + missed-Stop Claude Code transcripts
  await sweepBrokenCwdCodex(state, cfg);
  await sweepMissedClaudeStops(state, cfg);

  state.health.last_success_at = new Date().toISOString();
  state.health.last_error = null;
  saveState(state);
  if (ONCE || state.health.ticks % 4 === 1 || (state.health.deliveries || 0) > prevDeliveries) {
    await publishWatcherHealth(state, cfg);
  }
}

async function main() {
  const state = loadState();
  const beforeAi = state.health.ai_calls || 0;
  if (ONCE) {
    await tick(state);
    console.log(JSON.stringify({
      ok: true,
      mode: 'once',
      no_deliver: NO_DELIVER,
      ai_calls_this_run: (state.health.ai_calls || 0) - beforeAi,
      total_ticks: state.health.ticks,
      deliveries: state.health.deliveries,
      per_platform: state.health.per_platform,
      seen_keys: Object.keys(state.seen),
    }, null, 2));
    return;
  }

  let stopping = false;
  let running = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      stopping = true;
      log(`received ${sig}, shutting down cleanly`);
      process.exit(0);
    });
  }

  log(`guardian_watcher v${WATCHER_VERSION} started (interval=${loadConfig().watcher_interval_ms || DEFAULT_INTERVAL_MS}ms, auto_deliver=${loadConfig().watcher_auto_deliver !== false && !NO_DELIVER})`);
  while (!stopping) {
    if (!running) {
      running = true;
      try {
        await tick(state);
      } catch (e) {
        state.health.fails = (state.health.fails || 0) + 1;
        state.health.last_error = String(e.message || e).slice(0, 200);
        log('[tick-error]', state.health.last_error);
        saveState(state);
      } finally {
        running = false;
      }
    }
    const interval = Number(loadConfig().watcher_interval_ms) || DEFAULT_INTERVAL_MS;
    await sleep(Math.max(5000, interval));
  }
}

main().catch((e) => {
  console.error('guardian_watcher fatal:', e);
  process.exit(1);
});
