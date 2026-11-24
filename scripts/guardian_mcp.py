# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp==1.21.1"]
# ///
"""Expose read-only Intent Guardian diagnostics over MCP stdio."""

import hashlib
import json
import sys

from mcp.server.fastmcp import FastMCP

# The plugin install can be read-only.
sys.dont_write_bytecode = True

import time

from intent_guardian import DEFAULT_CONFIG, DEFAULT_STATE, VERSION, backend_chain, digest, policy_text

server = FastMCP("intent-guardian")
HOSTS = ("codex", "claude", "cowork", "grokbot", "antigravity", "chatgpt", "claude_ai", "gemini_web")


@server.tool()
def guardian_health() -> dict:
    """Return the installed engine version, backend cooldown state, and policy fingerprint."""
    try:
        cfg = json.loads(DEFAULT_CONFIG.read_text()) if DEFAULT_CONFIG.is_file() else {}
    except (OSError, ValueError):
        cfg = {}
    now = time.time()
    chain = []
    for entry in backend_chain(cfg):
        key = digest([entry.get(k) for k in ("backend", "model", "native_home", "native_auth_source", "api_base")])[:24]
        gate = DEFAULT_STATE / "backend" / (key + ".json")
        try:
            retry = json.loads(gate.read_text()) if gate.is_file() else {}
        except (OSError, ValueError):
            retry = {}
        chain.append({
            "backend": entry.get("backend"),
            "model": entry.get("model"),
            "cooling_seconds": max(0, round(retry.get("retry_at", 0) - now)) if retry.get("retry_at", 0) > now else 0,
            "last_failure": retry.get("category"),
        })
    return {
        "version": VERSION,
        "config_exists": DEFAULT_CONFIG.is_file(),
        "policy_sha256": hashlib.sha256(policy_text().encode()).hexdigest(),
        "backend_chain": chain,
        "scheduled_polling": False,
    }


@server.tool()
def guardian_status() -> dict:
    """Count observed sessions and pending interventions by host."""
    hosts = {host: {"observed_sessions": 0, "pending_interventions": 0} for host in HOSTS}
    for path in DEFAULT_STATE.glob("*.json"):
        try:
            state = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        if not isinstance(state, dict) or state.get("host") not in HOSTS:
            continue
        counts = hosts[state["host"]]
        counts["observed_sessions"] += 1
        counts["pending_interventions"] += int(bool(state.get("pending")))
    return {"version": VERSION, "hosts": hosts}


if __name__ == "__main__":
    server.run(transport="stdio")
