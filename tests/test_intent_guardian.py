"""Contract tests for the observer; no provider outcomes or model responses are fabricated as live proof."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/intent_guardian.py"
spec = importlib.util.spec_from_file_location("guardian", SCRIPT)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GuardianContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cfg = {"checkpoint_every": 3}
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def event(self, name, **kwargs):
        return {"session_id": "contract-test", "hook_event_name": name, **kwargs}

    def reviewer(self, cfg, payload):
        self.calls.append(payload)
        return {"intervene": False, "resolved": False, "completed": False,
                "state_delta": "Task remains in progress."}, {"usage": {"cost": 0}}

    def run_event(self, event, reviewer=None):
        return g.process_event(event, "codex", self.cfg, self.root / "state", reviewer or self.reviewer)

    def test_current_codex_user_item_extracts_text_without_images(self):
        row = {"type": "event_msg", "payload": {"type": "item_completed", "item": {
            "type": "UserMessage", "id": "u1", "content": [{"type": "text", "text": "Finish the actual task"},
            {"type": "image", "url": "data:image/png;base64,NOT_TEXT"}]}}}
        self.assertEqual(g.records(row, "codex", 1), [("user", "Finish the actual task", "u1")])

    def test_claude_tool_result_is_not_a_human_prompt(self):
        row = {"type": "user", "uuid": "r1", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "tool response"}]}}
        rows = g.records(row, "claude", 1)
        self.assertEqual([x[0] for x in rows], ["tool"])

    def test_prompt_and_idle_observation_never_call_model(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        self.run_event(self.event("SessionStart"))
        self.assertEqual(self.calls, [])

    def test_changed_checkpoint_calls_once_and_unchanged_stop_does_not(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        for n in range(3):
            self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response=f"record {n}"))
        self.assertEqual(len(self.calls), 1)
        out, state = self.run_event(self.event("Stop"))
        self.assertEqual(out, {})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(state["status"], "unchanged evidence; no duplicate model call")

    def test_stop_feedback_uses_native_contract_and_no_repeat(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        def evaluator(cfg, payload):
            return {"intervene": True, "reason": "A concrete implementation remains open.",
                    "next_action": "Read the actual patch.", "proof_needed": "The saved patch readback.",
                    "evidence_ids": [payload["intent"][0]["id"]], "state_delta": "Needs patch verification."}, {"usage": {}}
        out, state = self.run_event(self.event("Stop"), evaluator)
        self.assertEqual(out["decision"], "block")
        self.assertIn("Read the actual patch", out["reason"])
        self.assertIsNotNone(state["pending"])
        out, state = self.run_event(self.event("Stop", stop_hook_active=True), evaluator)
        self.assertEqual(out, {})
        self.assertEqual(state["model_calls"], 1)

    def test_claude_stop_feedback_uses_non_error_native_context(self):
        output = g.emit_correction("Stop", {"reason": "An evidenced defect remains.",
            "next_action": "Read saved state.", "proof_needed": "Exact readback."}, "claude")
        self.assertNotIn("decision", output)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "Stop")

    def test_new_owner_input_arriving_during_review_invalidates_old_directive(self):
        transcript = self.root / "owner-steering.jsonl"
        row = {"type": "event_msg", "payload": {"type": "user_message", "message": "Implement requested change"}}
        transcript.write_text(json.dumps(row) + "\n")
        self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        def superseded(cfg, payload):
            with transcript.open("a") as stream:
                stream.write(json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": "Stop; read only now"}}) + "\n")
            return {"intervene": True, "reason": "Old action", "next_action": "Implement now",
                    "proof_needed": "Saved change", "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {"cost": 0.0001}}
        output, state = self.run_event(self.event("Stop"), superseded)
        self.assertEqual(output, {})
        self.assertEqual(state["last_review"]["discarded"], "newer human input")
        self.assertAlmostEqual(state["cost_usd"], 0.0001)

    def test_subagent_never_spawns_recursive_model_review(self):
        transcript = self.root / "child.jsonl"
        transcript.write_text(json.dumps({"type": "session_meta", "payload": {"thread_source": "subagent"}}) + "\n")
        self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        self.run_event(self.event("Stop"))
        self.assertEqual(self.calls, [])

    def test_resolution_requires_evidence_after_the_correction(self):
        payload = {"intent": [], "evidence": [{"id": "e:old", "kind": "tool"}],
                   "pending_correction": {"review_evidence_ids": ["e:old"]}}
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": False, "resolved": True, "resolution_evidence_ids": ["e:old"]}, payload)
        payload["evidence"].append({"id": "e:new", "kind": "tool"})
        g.validate_decision({"intervene": False, "resolved": True, "resolution_evidence_ids": ["e:new"]}, payload)

    def test_unknown_evidence_id_cannot_trigger_correction(self):
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": True, "evidence_ids": ["invented"], "reason": "x", "next_action": "x", "proof_needed": "x"}, {"intent": [], "evidence": []})

    def test_completion_requires_cited_evidence(self):
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": False, "completed": True}, {"intent": [], "evidence": []})

    def test_method_correction_is_retained_as_steering_not_completion_proof(self):
        correction = "Don't fucking assume. It's a schedule that's maybe prove me wrong, prove me right"
        self.run_event(self.event("UserPromptSubmit", prompt="Build and activate a continuously running intent observer"))
        _, state = self.run_event(self.event("UserPromptSubmit", prompt=correction))
        self.assertEqual(state["intent"][-1]["text"], correction)
        self.assertFalse(state["completed"])
        payload = g.review_payload(state, self.event("Stop"))
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": False, "completed": True, "evidence_ids": [state["intent"][-1]["id"]]}, payload)

    def test_missing_feature_polarity_is_preserved_verbatim(self):
        correction = "why does nto show the pwa install banner on teh website"
        _, state = self.run_event(self.event("UserPromptSubmit", prompt=correction))
        self.assertEqual(state["intent"][0]["text"], correction)
        self.assertNotIn("hide", state["intent"][0]["text"])

    def test_twenty_unsummarized_corrections_are_not_evicted(self):
        for n in range(20):
            _, state = self.run_event(self.event("UserPromptSubmit", prompt=f"Correction {n}: preserve this separate constraint"))
        self.assertEqual(len(state["intent"]), 20)
        self.assertEqual(state["intent"][5]["text"], "Correction 5: preserve this separate constraint")
        self.assertEqual(self.calls, [])

    def test_only_explicitly_summarized_prompts_can_be_compacted(self):
        for n in range(10):
            _, state = self.run_event(self.event("UserPromptSubmit", prompt=f"Correction {n}"))
        retained_middle = state["intent"][4]["id"]
        state["state_delta"] = "A reviewer preserved listed corrections."
        covered = [entry["id"] for entry in state["intent"] if entry["id"] != retained_middle]
        g.compact_reviewed_intent(state, {"summarized_intent_ids": covered})
        self.assertIn(retained_middle, {entry["id"] for entry in state["intent"]})
        self.assertEqual(len(state["intent"]), 5)

    def test_scope_gap_prevents_judgment_and_names_exact_missing_packet(self):
        self.cfg["max_unsummarized_intent_chars"] = 20
        self.run_event(self.event("UserPromptSubmit", prompt="A long actual owner scope exceeding this contract-test packet"))
        output, state = self.run_event(self.event("Stop"))
        self.assertEqual(output, {})
        self.assertEqual(self.calls, [])
        self.assertIn("evidence_ids", state["scope_gap"])
        self.assertEqual(state["scope_gap"]["limit"], 20)

    def test_own_hook_continuation_is_not_new_human_authority(self):
        continuation = "Intent observer: Scope is incomplete. Next action: Read actual record. Verify: Native readback."
        initial = g.initial_state("contract-test", "codex")
        initial["emitted_feedback_hashes"] = [g.digest(continuation)]
        g.atomic_save(self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json"), initial)
        _, state = self.run_event(self.event("UserPromptSubmit", prompt=continuation))
        self.assertEqual(state["intent"], [])
        transcript = self.root / "native-continuation.jsonl"
        transcript.write_text(json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": continuation}}) + "\n")
        _, state = self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        self.assertEqual(state["intent"], [])
        self.assertTrue(g.real_prompt("The Intent observer: report needs reviewing"))

    def test_same_owner_correction_after_assistant_reply_is_not_a_mirror(self):
        transcript = self.root / "repeated-owner.jsonl"
        rows = [
            {"type": "response_item", "payload": {"type": "message", "role": "user", "id": "u1", "content": "more"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "more"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "id": "a1", "content": "Here is the current result."}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "id": "u2", "content": "more"}},
        ]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        _, state = self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        self.assertEqual([entry["text"] for entry in state["intent"]], ["more", "more"])

    def test_runtime_delegation_preserves_original_task_with_its_provenance(self):
        payload = {"type": "function_call_output", "name": "create_thread", "namespace": "codex_app", "id": "native-bootstrap",
                   "output": "<codex_delegation><source_thread_id>source</source_thread_id><input>Build and activate the actual observer</input></codex_delegation>"}
        self.assertEqual(g.records({"type": "response_item", "payload": payload}, "codex", 1),
                         [("task_request", "Build and activate the actual observer", "native-bootstrap")])
        payload["namespace"] = "untrusted_tool"
        self.assertEqual(g.records({"type": "response_item", "payload": payload}, "codex", 1)[0][0], "tool")

    def test_source_error_prevents_review_of_stale_cached_scope(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        output, state = self.run_event(self.event("Stop", transcript_path=str(self.root / "missing.jsonl")))
        self.assertEqual(output, {})
        self.assertEqual(self.calls, [])
        self.assertIn("source_error", state)

    def test_changed_directive_wording_without_action_progress_does_not_loop(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        calls = []
        def evaluator(cfg, payload):
            calls.append(payload)
            return {"intervene": True, "reason": f"The same remaining defect, wording {len(calls)}", "next_action": "Read saved state.",
                    "proof_needed": "The actual saved readback.", "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {}}
        first, _ = self.run_event(self.event("Stop"), evaluator)
        second, state = self.run_event(self.event("Stop", stop_hook_active=True, last_assistant_message="I will do the requested check."), evaluator)
        self.assertIn("decision", first)
        self.assertEqual(second, {})
        self.assertEqual(state["interventions"], 1)
        self.assertIsNotNone(state["pending"])

    def test_pretool_checkpoint_is_advisory_and_never_denies_the_tool(self):
        self.cfg["checkpoint_every"] = 1
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        def evaluator(cfg, payload):
            return {"intervene": True, "reason": "A concrete route contradiction is present.", "next_action": "Read the actual saved setting.",
                    "proof_needed": "Native setting readback.", "evidence_ids": [payload["evidence"][-1]["id"]]}, {"usage": {}}
        output, state = self.run_event(self.event("PreToolUse", tool_name="read_file", tool_input={"file": "actual-path"}), evaluator)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "PreToolUse")
        self.assertNotIn("permissionDecision", output["hookSpecificOutput"])
        self.assertNotIn("decision", output)

    def test_native_schema_carries_explicit_intent_compaction_ids(self):
        schema = g.native_schema()
        self.assertIn("summarized_intent_ids", schema["required"])
        self.assertFalse(schema["additionalProperties"])

    def test_stop_event_metadata_cannot_be_mistaken_for_a_human_stop(self):
        state = g.initial_state("contract-test", "codex")
        g.add_evidence(state, "user", "Do not assume; compare the actual supported options", "u1")
        payload = g.review_payload(state, self.event("Stop"))
        self.assertTrue(payload["executor_proposed_final_stop"])
        self.assertIn("not a human stop", payload["event_semantics"])

    def test_interrupt_is_preserved_until_user_submits_again(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        self.run_event(self.event("Interrupt"))
        self.run_event(self.event("Stop", last_assistant_message="Partial progress"))
        self.assertEqual(self.calls, [])
        self.run_event(self.event("UserPromptSubmit", prompt="Continue"))
        self.run_event(self.event("Stop"))
        self.assertEqual(len(self.calls), 1)

    def test_incremental_ingest_does_not_consume_partial_json_line(self):
        transcript = self.root / "real-format.jsonl"
        row = {"type": "event_msg", "payload": {"type": "user_message", "message": "Implement requested change"}}
        transcript.write_text(json.dumps(row) + "\n" + '{"type":')
        _, state = self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        self.assertEqual(state["line"], 1)
        self.assertEqual(state["offset"], len((json.dumps(row) + "\n").encode()))
        self.assertEqual(len(state["intent"]), 1)

    def test_provider_error_is_fail_open_and_not_retried_on_same_evidence(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        failed = []
        def broken(cfg, payload):
            failed.append(1)
            raise RuntimeError("provider unavailable")
        out, state = self.run_event(self.event("Stop"), broken)
        self.assertEqual(out, {})
        self.assertIn("model_error", state)
        self.run_event(self.event("Stop"), broken)
        self.assertEqual(len(failed), 1)

    def test_credential_redaction_preserves_normal_receipt_ids(self):
        self.assertEqual(g.redact("receipt SUB-1234"), "receipt SUB-1234")
        self.assertNotIn("abcdef", g.redact("sk-or-v1-abcdef"))

    def test_verified_complete_stays_closed_until_a_new_prompt(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        def done(cfg, payload):
            self.calls.append(payload)
            return {"intervene": False, "completed": True, "evidence_ids": [payload["evidence"][-1]["id"]]}, {"usage": {}}
        self.run_event(self.event("Stop", last_assistant_message="Requested answer text is present here."), done)
        self.run_event(self.event("Stop", last_assistant_message="Additional status"), done)
        self.assertEqual(len(self.calls), 1)
        self.run_event(self.event("UserPromptSubmit", prompt="Now implement the follow-up"))
        self.run_event(self.event("Stop", last_assistant_message="Requested follow-up output is present here."), done)
        self.assertEqual(len(self.calls), 2)


if __name__ == "__main__":
    unittest.main()
