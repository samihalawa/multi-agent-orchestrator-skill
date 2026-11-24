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

    def test_active_checkpoint_does_not_suppress_stop_closure_review(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement the requested change"))
        for n in range(3):
            self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response=f"record {n}"))
        self.assertEqual(len(self.calls), 1)
        out, state = self.run_event(self.event("Stop"))
        self.assertEqual(out, {})
        self.assertEqual(len(self.calls), 2)
        _, state = self.run_event(self.event("Stop"))
        self.assertEqual(len(self.calls), 2)
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

    def test_new_executor_result_invalidates_obsolete_stop_correction(self):
        transcript = self.root / "advancing.jsonl"
        transcript.write_text(json.dumps({"type": "event_msg", "payload": {
            "type": "user_message", "message": "Verify the published payload"}}) + "\n")
        self.run_event(self.event("SessionStart", transcript_path=str(transcript)))

        def outdated(cfg, payload):
            self.assertEqual(payload["review_focus"]["latest_owner_instruction_id"], payload["intent"][-1]["id"])
            self.assertEqual(payload["review_focus"]["executor_message_id"], payload["evidence"][-1]["id"])
            with transcript.open("a") as stream:
                stream.write(json.dumps({"type": "response_item", "payload": {
                    "type": "function_call_output", "call_id": "new-readback",
                    "output": "Published payload now retrieved and checksum matches"}}) + "\n")
            return {"intervene": True, "reason": "The payload has not been read.",
                    "next_action": "Retrieve the published payload.", "proof_needed": "Matching checksum.",
                    "evidence_ids": [payload["intent"][-1]["id"]]}, {"usage": {}}

        output, state = self.run_event(self.event("Stop", last_assistant_message="Stopping after build."), outdated)
        self.assertEqual(output, {})
        self.assertEqual(state["last_review"]["discarded"], "changed executor evidence")
        self.assertIsNone(state["pending"])
        _, state = self.run_event(self.event("Stop", last_assistant_message="Checksum now matches."))
        self.assertEqual(state["model_calls"], 2)
        self.assertIn("e:new-readback:result", [e["id"] for e in self.calls[-1]["evidence"]])

    def test_subagent_never_spawns_recursive_model_review(self):
        transcript = self.root / "child.jsonl"
        transcript.write_text(json.dumps({"type": "session_meta", "payload": {"id": "contract-test", "thread_source": "subagent"}}) + "\n")
        self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        self.run_event(self.event("Stop"))
        self.assertEqual(self.calls, [])

    def test_first_transcript_keeps_captured_claude_request_once(self):
        transcript = self.root / "claude.jsonl"
        prompt = "Finish the background run and verify the published result."
        g.process_event(self.event("UserPromptSubmit", prompt=prompt), "claude", self.cfg, self.root / "state", self.reviewer)
        transcript.write_text(json.dumps({"type": "user", "uuid": "real-user-message",
                                         "message": {"content": prompt}}) + "\n")
        _, state = g.process_event(self.event("Stop", transcript_path=str(transcript)),
                                   "claude", self.cfg, self.root / "state", self.reviewer)
        self.assertEqual([e["text"] for e in state["intent"]], [prompt])
        self.assertEqual(len(self.calls), 1)

    def test_repeated_goal_envelope_is_a_single_task_request(self):
        envelope = '<codex_internal_context source="goal">\n<objective>Verify the real outcome.</objective>\n' + ("runtime instructions\n" * 2000) + "</codex_internal_context>"
        state = g.initial_state("contract-test", "codex")
        g.add_evidence(state, "user", envelope, "goal1")
        g.add_evidence(state, "user", envelope, "goal2")
        self.assertEqual([(e["kind"], e["text"]) for e in state["intent"]],
                         [("task_request", "Verify the real outcome.")])
        self.assertFalse(state.get("human_revision", 0))

    def test_122_migration_rebinds_existing_native_desktop_task(self):
        transcript = self.root / "desktop.jsonl"
        rows = [
            {"type": "session_meta", "payload": {"id": "contract-test", "thread_source": "agent_created_thread"}},
            {"type": "session_meta", "payload": {"id": "other-thread", "thread_source": "subagent"}},
            {"type": "event_msg", "payload": {"type": "user_message", "message": "Complete the actual work."}},
        ]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        state = g.initial_state("contract-test", "codex")
        state.update(version="1.2.1", subagent=True, transcript_path=str(transcript), offset=transcript.stat().st_size)
        statefile = self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json")
        g.atomic_save(statefile, state)
        _, upgraded = self.run_event(self.event("Stop"))
        self.assertFalse(upgraded["subagent"])
        self.assertEqual(len(self.calls), 1)

    def test_resolution_requires_evidence_after_the_correction(self):
        payload = {"intent": [], "evidence": [{"id": "e:old", "kind": "tool"}],
                   "pending_correction": {"review_evidence_ids": ["e:old"]}}
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": False, "resolved": True, "resolution_evidence_ids": ["e:old"]}, payload)
        payload["evidence"].append({"id": "e:new", "kind": "tool"})
        g.validate_decision({"intervene": False, "resolved": True, "resolution_evidence_ids": ["e:new"]}, payload)
        payload["pending_correction"]["review_tool_digests"] = [g.digest("same publication")]
        payload["evidence"].extend([{"id": "e:mirror", "kind": "tool", "text": "same publication"},
                                    {"id": "e:claim", "kind": "assistant", "text": "It is done"}])
        for missing_proof in ("e:mirror", "e:claim"):
            with self.assertRaises(ValueError):
                g.validate_decision({"intervene": False, "resolved": True,
                                     "resolution_evidence_ids": [missing_proof]}, payload)

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

    def test_delegation_middle_scope_exception_survives_checkpoint_packet(self):
        state = g.initial_state("contract-test", "claude")
        exception = "Regenerable caches may be removed directly."
        prompt = "Agent " + ("scope " * 250) + exception + (" evidence" * 150)
        g.add_evidence(state, "action", prompt, "delegation")
        self.assertEqual(state["evidence"][-1]["text"], prompt)

    def test_every_correction_channel_starts_with_guardian_tag(self):
        decision = {"reason": "The requested result remains open.",
                    "next_action": "Read back the result.", "proof_needed": "Primary result."}
        for host in ("codex", "claude"):
            for event in ("Stop", "PostToolUse", "PreToolUse", "PostToolUseFailure"):
                with self.subTest(host=host, event=event):
                    output = g.emit_correction(event, decision, host)
                    message = output.get("reason") or output["hookSpecificOutput"]["additionalContext"]
                    self.assertTrue(message.startswith("[SAMI'S INTENT GUARDIAN] "))
                    self.assertEqual(g.classify_prompt(message), ("runtime_feedback", message))

    def test_native_wrapped_feedback_cannot_resume_an_interrupted_task(self):
        feedback = "Intent observer: Verify the native result."
        wrapper = '<hook_prompt hook_run_id="stop:11:/hooks.json">' + feedback + '</hook_prompt>'
        transcript = self.root / "wrapped-feedback.jsonl"
        rows = [
            {"type": "event_msg", "payload": {"type": "user_message", "message": "Verify the result"}},
            {"type": "event_msg", "payload": {"type": "turn_aborted", "reason": "interrupted"}},
            {"type": "response_item", "payload": {
                "type": "message", "role": "user", "id": "hook-1",
                "content": [{"type": "input_text", "text": wrapper}],
                "internal_chat_message_metadata_passthrough": {
                    "content_item_metadata": [{"provenance": {"type": "harness", "hook": True}}],
                },
            }},
        ]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        _, state = self.run_event(self.event("UserPromptSubmit", prompt=wrapper, transcript_path=str(transcript)))
        self.assertTrue(state["interrupted"])
        self.assertEqual(state["human_revision"], 1)
        self.assertEqual([e["text"] for e in state["intent"]], ["Verify the result"])
        self.assertIn({"id": "e:hook-1", "kind": "runtime_feedback", "text": feedback}, state["evidence"])

    def test_upgrade_repairs_hook_feedback_counted_as_human_steering(self):
        wrapper = '<hook_prompt hook_run_id="stop:11:/hooks.json">Review the remaining proof.</hook_prompt>'
        state = g.initial_state("contract-test", "codex")
        state["version"] = "1.2.3"
        state["intent"] = [{"id": "e:hook-1", "kind": "user", "text": wrapper}]
        state["evidence"] = state["intent"].copy()
        state["human_revision"] = 3
        state["pending"] = {"human_revision": 2}
        g.atomic_save(self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json"), state)
        _, amended = self.run_event(self.event("SessionStart"))
        self.assertEqual(amended["intent"], [])
        self.assertEqual(amended["evidence"][0]["kind"], "runtime_feedback")
        self.assertEqual(amended["pending"]["human_revision"], amended["human_revision"])

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

    def test_new_status_poll_does_not_repeat_pending_correction(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Finish the background run, then verify in the browser."))
        calls = []

        def evaluator(cfg, payload):
            calls.append(payload)
            return {"intervene": True, "reason": f"The background run is still pending, status {len(calls)}.",
                    "next_action": "Continue the existing run.", "proof_needed": "Native browser verification.",
                    "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {}}

        first, state = self.run_event(self.event("Stop"), evaluator)
        self.assertIn("decision", first)
        original = state["pending"]
        self.run_event(self.event("PostToolUse", tool_name="check_status", tool_response="Existing run still at 12/20."))
        second, state = self.run_event(self.event("Stop", stop_hook_active=True, last_assistant_message="It is still running."), evaluator)
        self.assertEqual(second, {})
        self.assertEqual(state["interventions"], 1)
        self.assertEqual(state["pending"], original)
        self.assertTrue(state["last_review"]["suppressed_pending_intervention"])

    def test_stop_can_replace_wait_when_a_new_result_changes_the_next_action(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Complete the import."))

        def first_review(cfg, payload):
            return {"intervene": True, "reason": "The import is still running.",
                    "next_action": "Wait for the import return.", "proof_needed": "The import result.",
                    "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {}}

        self.run_event(self.event("Stop"), first_review)
        self.run_event(self.event("PostToolUse", tool_name="check_import", tool_response="Import exited with no records saved."))

        def next_review(cfg, payload):
            result_id = next(e["id"] for e in payload["evidence"] if e["kind"] == "tool")
            return {"intervene": True, "reason": "The import process exited without saving records.",
                    "next_action": "Read the import error and recover the failed stage.",
                    "proof_needed": "Recovery of the failed stage and saved records.",
                    "evidence_ids": [result_id]}, {"usage": {}}

        output, state = self.run_event(self.event("Stop", stop_hook_active=True), next_review)
        self.assertIn("decision", output)
        self.assertEqual(state["interventions"], 2)
        self.assertIn("superseded_pending_at", state["last_review"])
        self.assertIn("recover the failed stage", state["pending"]["next_action"])

        repeated, state = self.run_event(self.event("Stop", last_assistant_message="I intend to recover the failed stage."), next_review)
        self.assertEqual(repeated, {})
        self.assertEqual(state["interventions"], 2)

    def test_pretool_checkpoint_is_advisory_and_never_denies_the_tool(self):
        self.cfg["checkpoint_every"] = 1
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        def evaluator(cfg, payload):
            return {"intervene": True, "reason": "A concrete route contradiction is present.", "next_action": "Read the actual saved setting.",
                    "proof_needed": "Native setting readback.", "evidence_ids": [payload["evidence"][-1]["id"]], "verdict_domain": "active_route"}, {"usage": {}}
        output, state = self.run_event(self.event("PreToolUse", tool_name="read_file", tool_input={"file": "actual-path"}), evaluator)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "PreToolUse")
        self.assertNotIn("permissionDecision", output["hookSpecificOutput"])
        self.assertNotIn("decision", output)

    def test_native_schema_carries_explicit_intent_compaction_ids(self):
        schema = g.native_schema()
        self.assertIn("summarized_intent_ids", schema["required"])
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(schema["properties"]["verdict_domain"]["enum"], ["active_route", "closure", "none"])

    def test_missing_config_defaults_to_qualified_native_luna_without_api_calls(self):
        config = g.load_config(self.root / "absent-config.json")
        self.assertEqual(config["backend"], "codex_subscription")
        self.assertEqual(config["model"], "gpt-6-luna")
        self.assertEqual(config["reasoning_effort"], "low")
        self.assertEqual(config["request_timeout"], 40)
        self.assertEqual(self.calls, [])

    def test_explicit_configured_provider_and_model_are_preserved(self):
        path = self.root / "explicit-config.json"
        path.write_text(json.dumps({"backend": "openrouter", "model": "explicit-owner-model", "request_timeout": 55}))
        config = g.load_config(path)
        self.assertEqual(config["backend"], "openrouter")
        self.assertEqual(config["model"], "explicit-owner-model")
        self.assertEqual(config["request_timeout"], 55)

    def test_live_redundant_six_file_proof_warning_is_deferred_while_verifying(self):
        # Regression from actual live observation: a committed version bump was
        # followed by an active six-file equality check, not a proposed Stop.
        self.cfg["checkpoint_every"] = 1
        self.run_event(self.event("UserPromptSubmit", prompt="Publish the skill and verify all six payload files."))
        def closure_warning(cfg, payload):
            return {"intervene": True, "completed": False, "verdict_domain": "closure",
                    "reason": "The patch-version bump was committed and pushed, but full six-file remote equality is not yet verified; continue rather than stop.",
                    "next_action": "Compare each of the six payload files.", "proof_needed": "Six matching hashes.",
                    "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {}}
        output, state = self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="Version bump was committed; equality verification is in progress.",
            last_assistant_message="I’m verifying each of the six payload files."), closure_warning)
        self.assertEqual(output, {})
        self.assertEqual(state.get("interventions", 0), 0)
        self.assertIsNone(state["pending"])
        self.assertEqual(state["last_review"]["deferred_model_verdict"]["domain"], "closure")
        self.assertFalse(state["last_review"]["decision"]["intervene"])
        self.assertIn("PHASE ISOLATION", g.policy_text(g.review_payload(state, self.event("PostToolUse"))))

    def test_active_checkpoint_cannot_mark_whole_task_complete(self):
        decision, deferred = g.guard_review_phase({"intervene": False, "completed": True, "verdict_domain": "closure"}, {"event": "PostToolUse"})
        self.assertFalse(decision["completed"])
        self.assertIsNotNone(deferred)

    def test_actual_stop_keeps_closure_warning_enabled(self):
        decision, deferred = g.guard_review_phase({"intervene": True, "completed": False, "verdict_domain": "closure"}, {"event": "Stop"})
        self.assertTrue(decision["intervene"])
        self.assertIsNone(deferred)
        self.assertNotIn("PHASE ISOLATION", g.policy_text({"event": "Stop"}))

    def test_stop_review_tracks_native_background_status_changes(self):
        job = {"id": "job-1", "status": "running", "type": "shell", "command": "private arguments"}
        calls = []

        def review(cfg, payload):
            calls.append(payload["native_background_tasks"])
            return {"intervene": False, "completed": False}, {}

        self.run_event(self.event("UserPromptSubmit", prompt="Generate and verify the audio"))
        self.run_event(self.event("Stop", background_tasks=[job]), review)
        self.run_event(self.event("Stop", background_tasks=[job]), review)
        self.run_event(self.event("Stop", background_tasks=[{**job, "status": "completed"}]), review)
        self.assertEqual(calls, [
            [{"id": "job-1", "status": "running", "type": "shell"}],
            [{"id": "job-1", "status": "completed", "type": "shell"}],
        ])

    def test_completion_and_resolution_can_share_new_primary_tool_citations(self):
        payload = {"event": "Stop", "intent": [], "evidence": [{"id": "e:new-proof", "kind": "tool"}],
                   "pending_correction": {"review_evidence_ids": ["e:old"]}}
        g.validate_decision({"intervene": False, "completed": True, "resolved": True, "verdict_domain": "closure",
                            "evidence_ids": [], "resolution_evidence_ids": ["e:new-proof"]}, payload)

    def test_assistant_done_claim_alone_cannot_prove_completion(self):
        with self.assertRaises(ValueError):
            g.validate_decision({"intervene": False, "completed": True, "verdict_domain": "closure", "evidence_ids": ["e:claim"]},
                                {"event": "Stop", "intent": [], "evidence": [{"id": "e:claim", "kind": "assistant", "text": "Done"}]})

    def test_invalid_decision_diagnostic_preserves_fields_without_raw_prompt(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Verify the actual result."))
        def invalid(cfg, payload):
            return {"intervene": False, "completed": True, "verdict_domain": "closure", "evidence_ids": [],
                    "reason": "No cited proof; incidental token sk-or-v1-contracttest"}, {"usage": {"input_tokens": 10}}
        output, state = self.run_event(self.event("Stop"), invalid)
        self.assertEqual(output, {})
        self.assertTrue(state["last_invalid_decision"]["decision"]["completed"])
        self.assertEqual(state["last_invalid_decision"]["decision"]["evidence_ids"], [])
        self.assertNotIn("sk-or-v1-contracttest", json.dumps(state["last_invalid_decision"]))
        self.assertEqual(state["last_review_failure_metrics"]["usage"]["input_tokens"], 10)

    def test_v11_state_upgrade_preserves_unsummarized_owner_intent(self):
        _, state = self.run_event(self.event("UserPromptSubmit", prompt="Preserve all these actual scope constraints."))
        state["version"] = "1.1.0"
        state["reviewed_hash"] = "old-phase-blind-cache"
        file = self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json")
        g.atomic_save(file, state)
        _, upgraded = self.run_event(self.event("SessionStart"))
        self.assertEqual(upgraded["version"], g.VERSION)
        self.assertEqual(upgraded["intent"], state["intent"])
        self.assertEqual(upgraded["policy_migrated_from"], "1.1.0")
        self.assertNotIn("reviewed_hash", upgraded)

    def test_codex_native_abort_suppresses_background_feedback_until_real_user_resumes(self):
        self.cfg["checkpoint_every"] = 1
        transcript = self.root / "native-abort.jsonl"
        rows = [
            {"type": "event_msg", "payload": {"type": "user_message", "message": "Implement requested change"}},
            {"type": "event_msg", "payload": {"type": "turn_aborted", "reason": "interrupted"}},
            {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "background", "output": "Background result arrived"}},
        ]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        output, state = self.run_event(self.event("PostToolUse", transcript_path=str(transcript), tool_name="background", tool_response="Background result"))
        self.assertEqual(output, {})
        self.assertTrue(state["interrupted"])
        self.assertEqual(state["interrupt_origin"]["host"], "codex")
        self.assertEqual(self.calls, [])
        continuation = "Intent observer: Old scope. Next action: Continue old work. Verify: Actual proof."
        state["emitted_feedback_hashes"] = [g.digest(continuation)]
        g.atomic_save(self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json"), state)
        _, state = self.run_event(self.event("UserPromptSubmit", prompt=continuation))
        self.assertTrue(state["interrupted"])
        with transcript.open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": "Continue with this newly stated scope"}}) + "\n")
        _, state = self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="New scoped result"))
        self.assertFalse(state["interrupted"])
        self.assertEqual(len(self.calls), 1)

    def test_claude_native_interrupt_marker_is_control_not_owner_goal(self):
        for marker in ["[Request interrupted by user]", "[Request interrupted by user for tool use]"]:
            row = {"type": "user", "uuid": marker, "message": {"content": marker}}
            self.assertEqual(g.records(row, "claude", 1), [("control", "interrupt", marker)])
            row["isMeta"] = True
            self.assertEqual(g.records(row, "claude", 1), [("control", "interrupt", marker)])
        state = g.initial_state("claude-contract", "claude")
        g.add_evidence(state, "user", "Original authorized task", "u1")
        g.add_evidence(state, "control", "interrupt", "cancel")
        self.assertTrue(state["interrupted"])
        self.assertEqual(len(state["intent"]), 1)
        g.add_evidence(state, "tool", "Late background output", "late-result")
        self.assertTrue(state["interrupted"])
        g.add_evidence(state, "user", "Resume the revised task", "u2")
        self.assertFalse(state["interrupted"])
        self.assertEqual(len(state["intent"]), 2)

    def test_upgrade_recovers_native_cancellation_without_losing_cached_intent(self):
        transcript = self.root / "preupgrade-cancel.jsonl"
        rows = [{"type": "event_msg", "payload": {"type": "user_message", "message": "Original task"}},
                {"type": "event_msg", "payload": {"type": "turn_aborted", "reason": "interrupted"}}]
        transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
        state = g.initial_state("contract-test", "codex")
        g.add_evidence(state, "user", "Original task", "cached-owner-id")
        state.update(version="1.1.0", transcript_path=str(transcript), offset=transcript.stat().st_size, line=2,
                     file_identity=[transcript.stat().st_dev, transcript.stat().st_ino])
        cached = list(state["intent"])
        g.atomic_save(self.root / "state" / (g.digest(["codex", "contract-test"])[:32] + ".json"), state)
        output, upgraded = self.run_event(self.event("Stop"))
        self.assertEqual(output, {})
        self.assertTrue(upgraded["interrupted"])
        self.assertEqual(upgraded["intent"], cached)
        self.assertEqual(upgraded["native_control_reconciliation"]["line"], 2)
        self.assertEqual(self.calls, [])

    def test_native_interruption_during_review_discards_older_feedback(self):
        transcript = self.root / "interrupt-inflight.jsonl"
        transcript.write_text(json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": "Original task"}}) + "\n")
        self.run_event(self.event("SessionStart", transcript_path=str(transcript)))
        def interrupted(cfg, payload):
            with transcript.open("a") as stream:
                stream.write(json.dumps({"type": "event_msg", "payload": {"type": "turn_aborted", "reason": "interrupted"}}) + "\n")
            return {"intervene": True, "verdict_domain": "closure", "reason": "Older scope missing proof", "next_action": "Continue old action",
                    "proof_needed": "Old proof", "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {}}
        output, state = self.run_event(self.event("Stop"), interrupted)
        self.assertEqual(output, {})
        self.assertTrue(state["interrupted"])
        self.assertEqual(state["last_review"]["discarded"], "native owner interruption")
        self.assertEqual(state.get("interventions", 0), 0)

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

    def test_controller_review_reuses_same_intent_and_publishes_no_raw_evidence(self):
        event = self.event("Stop", last_assistant_message="The source was read.",
                           _controller_job={"prompt": "Verify the real release",
                                            "evidence": ["Read the actual source; secret=foo"]})
        a, first = g.process_event(event, "grokbot", self.cfg, self.root, self.reviewer)
        b, second = g.process_event(event, "grokbot", self.cfg, self.root, self.reviewer)
        self.assertEqual(a, b)
        self.assertEqual(len(second["intent"]), 1)
        self.assertEqual(second["model_calls"], 1)
        self.assertEqual(self.calls[0]["review_phase"], "closure")
        self.assertEqual(g.feed_events(first)[0]["host"], "grokbot")
        self.assertNotIn("actual source", json.dumps(g.feed_events(first)))

    def test_backend_cooldown_spans_hosts_and_recovers_with_one_probe(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Check the requested record"))

        def broken(cfg, payload):
            raise g.ReviewBackendError("native_exit", "Native observer exited 1")

        _, state = self.run_event(self.event("Stop"), broken)
        self.assertEqual(state["model_error"]["category"], "native_exit")
        state_dir = self.root / "state"
        g.process_event({"session_id": "other", "hook_event_name": "UserPromptSubmit",
                         "prompt": "Verify the queue"}, "claude", self.cfg, state_dir, self.reviewer)
        _, other = g.process_event({"session_id": "other", "hook_event_name": "Stop"},
                                   "claude", self.cfg, state_dir, self.reviewer)
        self.assertEqual(other["model_calls"], 0)
        self.assertEqual(other["reviews_skipped_backend_cooldown"], 1)
        gate = next((state_dir / "backend").glob("*.json"))
        retry = json.loads(gate.read_text())
        g.atomic_save(gate, {**retry, "retry_at": 0})
        started, _ = g.backend_gate(gate, 40)
        self.assertIsNotNone(started)
        self.assertIsNone(g.backend_gate(gate, 40)[0])
        g.backend_gate(gate, 40, started=started)
        self.assertFalse(gate.exists())

    def test_native_claude_delivery_and_outcome_are_tied_to_same_correction(self):
        transcript = self.root / "claude.jsonl"
        transcript.write_text("")
        state_dir = self.root / "state"

        def run(name, reviewer, **extra):
            event = self.event(name, transcript_path=str(transcript), **extra)
            return g.process_event(event, "claude", self.cfg, state_dir, reviewer)

        run("UserPromptSubmit", self.reviewer, prompt="Verify the generated file")

        def correct(cfg, payload):
            return {"intervene": True, "reason": "File readback is missing", "next_action": "Read the file",
                    "proof_needed": "File readback", "evidence_ids": [payload["intent"][0]["id"]]}, {"usage": {"input_tokens": 35}}

        output, state = run("Stop", correct)
        correction = state["pending"]["feedback_hash"]
        self.assertNotIn("delivery", state["corrections"][correction])
        text = output["hookSpecificOutput"]["additionalContext"]
        transcript.write_text(json.dumps({"type": "attachment", "uuid": "feedback",
                                         "attachment": {"type": "hook_additional_context", "content": [text]}}) + "\n")
        run("PostToolUse", self.reviewer, tool_name="read_file", tool_response="Generated file verified")

        def resolve(cfg, payload):
            proof = next(entry["id"] for entry in payload["evidence"] if entry["kind"] == "tool")
            return {"resolved": True, "resolution_evidence_ids": [proof]}, {"usage": {"input_tokens": 45, "cached_input_tokens": 30}}

        _, state = run("Stop", resolve)
        self.assertEqual(state["corrections"][correction]["delivery"]["source_id"], "feedback:0")
        self.assertEqual(state["corrections"][correction]["outcome"]["status"], "verified")
        self.assertEqual(state["observed_review_tokens"], {"input_tokens": 80, "cached_input_tokens": 30})

    def test_verified_complete_stays_closed_until_a_new_prompt(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Implement requested change"))
        def done(cfg, payload):
            self.calls.append(payload)
            proof = next(entry for entry in reversed(payload["evidence"]) if entry["kind"] == "tool")
            return {"intervene": False, "completed": True, "evidence_ids": [proof["id"]], "verdict_domain": "closure"}, {"usage": {}}
        self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="Contract test output readback present."))
        self.run_event(self.event("Stop", last_assistant_message="Requested answer text is present here."), done)
        self.run_event(self.event("Stop", last_assistant_message="Additional status"), done)
        self.assertEqual(len(self.calls), 1)
        self.run_event(self.event("UserPromptSubmit", prompt="Now implement the follow-up"))
        self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="Follow-up contract output readback present."))
        self.run_event(self.event("Stop", last_assistant_message="Requested follow-up output is present here."), done)
        self.assertEqual(len(self.calls), 2)

    def test_high_signal_checkpoint_fires_before_checkpoint_every(self):
        self.cfg["checkpoint_every"] = 20
        self.run_event(self.event("UserPromptSubmit", prompt="Check all files"))
        self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="file 1 ok"))
        self.assertEqual(len(self.calls), 0)
        self.run_event(self.event("PostToolUse", tool_name="Bash", tool_response="UNAUTHORIZED: HTTP 401"))
        self.assertEqual(len(self.calls), 1)
        self.run_event(self.event("PostToolUse", tool_name="mcp__ccd_turn__wrap_up", tool_response="Shown in next-step box"))
        self.assertEqual(len(self.calls), 2)

    def test_native_exit_category_recognizes_claude_five_hour_limit_as_quota(self):
        self.assertEqual(g.native_exit_category("You've hit your 5-hour limit · resets 2pm (Europe/Madrid) · out of usage credits"), "quota")

    def test_normalize_decision_repairs_stale_compaction_and_abbreviated_ids(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Verify complete file"))
        self.run_event(self.event("PostToolUse", tool_name="read_file", tool_response="Readback complete"))
        def sloppy(cfg, payload):
            eid = payload["evidence"][-1]["id"]
            return {
                "intervene": False, "resolved": True, "completed": False,
                "verdict_domain": "none", "reason": "All ok.", "next_action": "", "proof_needed": "",
                "evidence_ids": [eid[:10] + "..."], "resolution_evidence_ids": [],
                "summarized_intent_ids": ["e:nonexistent-old"], "state_delta": "Verified."
            }, {"usage": {"input_tokens": 5, "cache_read_input_tokens": 1200, "output_tokens": 40}}
        out, state = self.run_event(self.event("Stop", last_assistant_message="Done."), sloppy)
        self.assertEqual(out, {})
        self.assertEqual(state["status"], "reviewed")
        self.assertNotIn("model_error", state)
        self.assertEqual(state["observed_review_tokens"]["input_tokens"], 1205)
        self.assertEqual(state["observed_review_tokens"]["cached_input_tokens"], 1200)

    def test_near_duplicate_stop_nag_is_suppressed_and_question_stop_overrides(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Finish the deployment"))
        calls = []
        def nag(cfg, payload):
            calls.append(payload)
            return {
                "intervene": True, "verdict_domain": "closure",
                "reason": "Deployment not verified yet.",
                "next_action": f"Wait for background deploy job {len(calls)} and verify the live endpoint.",
                "proof_needed": "Live health 200.",
                "evidence_ids": [payload["evidence"][-1]["id"]] if payload["evidence"] else [payload["intent"][0]["id"]],
            }, {"usage": {}}
        first, state = self.run_event(self.event("Stop"), nag)
        self.assertIn("decision", first)
        self.run_event(self.event("PostToolUse", tool_name="check_job", tool_response="Job still running at step 2"))
        second, state = self.run_event(self.event("Stop", stop_hook_active=True, last_assistant_message="Still waiting on job."), nag)
        self.assertEqual(second, {})
        self.assertTrue(state["last_review"]["suppressed_pending_intervention"])
        self.run_event(self.event("PostToolUse", tool_name="mcp__ccd_turn__wrap_up", tool_response="Asked user"))
        third, state = self.run_event(self.event("Stop", last_assistant_message="Should I deploy now?"), nag)
        self.assertIn("decision", third)
        self.assertEqual(state["interventions"], 2)

    def test_stop_interventions_capped_at_three_per_revision(self):
        self.run_event(self.event("UserPromptSubmit", prompt="Finish all steps"))
        for idx, action in enumerate([
            "Check alpha service logs",
            "Inspect beta database schema",
            "Verify gamma storage bucket",
            "Confirm delta DNS propagation",
        ], 1):
            self.run_event(self.event("PostToolUse", tool_name="Bash", tool_response=f"step {idx} result"))
            out, state = self.run_event(
                self.event("Stop", last_assistant_message=f"Finished step {idx}."),
                lambda cfg, payload, act=action: (
                    {"intervene": True, "verdict_domain": "closure", "reason": f"Missing {act}",
                     "next_action": act, "proof_needed": "Readback.",
                     "evidence_ids": [next(e["id"] for e in reversed(payload["evidence"]) if e["kind"] == "tool")]},
                    {"usage": {}},
                ),
            )
            if idx <= 3:
                self.assertIn("decision", out)
            else:
                self.assertEqual(out, {})
                self.assertTrue(state["last_review"]["suppressed_pending_intervention"])

    def test_antigravity_transcript_and_hook_contracts(self):
        state_dir = self.root / "state"
        transcript = self.root / "antigravity.jsonl"
        transcript.write_text("\n".join([
            json.dumps({
                "step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT",
                "content": "<USER_REQUEST>\nFix all 3 endpoints and verify live health\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nOS: mac\n</ADDITIONAL_METADATA>",
            }),
            json.dumps({
                "step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE",
                "thinking": "PRIVATE THINKING DO NOT INGEST",
                "content": "Checking first endpoint only.",
                "tool_calls": [{"name": "run_command", "args": {"CommandLine": "curl localhost:8080"}}],
            }),
            json.dumps({
                "step_index": 2, "source": "MODEL", "type": "GENERIC",
                "content": "HTTP 500 internal error",
            }),
        ]) + "\n")
        post_tool = {
            "conversationId": "agy-conv-1",
            "transcriptPath": str(transcript),
            "lastUserInput": "Fix all 3 endpoints and verify live health",
            "hookEventName": "PostToolUse",
            "toolCall": {"id": "call-1", "name": "run_command", "args": {"CommandLine": "curl localhost:8080"}},
            "error": "exit status 1",
        }
        out_tool, state = g.process_event(post_tool, "antigravity", self.cfg, state_dir,
                                          reviewer=lambda c, p: self.fail("PostToolUse must defer review to PostInvocation"))
        self.assertEqual(out_tool, {})
        self.assertTrue(state.get("high_signal_pending"))
        self.assertNotIn("PRIVATE THINKING DO NOT INGEST", json.dumps(state["evidence"]))
        self.assertEqual(state["intent"][0]["text"], "Fix all 3 endpoints and verify live health")

        def intervene(cfg, payload):
            self.calls.append(payload)
            tool_id = next(e["id"] for e in reversed(payload["evidence"]) if e["kind"] == "tool")
            return {
                "intervene": True, "verdict_domain": "active_route",
                "reason": "Command failed HTTP 500 while 2 endpoints remain unchecked.",
                "next_action": "Inspect server logs and fix all 3 endpoints.",
                "proof_needed": "200 responses from all 3 endpoints.",
                "evidence_ids": [tool_id],
            }, {"usage": {}}

        out_inv, state = g.process_event({
            "conversationId": "agy-conv-1",
            "transcriptPath": str(transcript),
            "hookEventName": "PostInvocation",
            "invocationNum": 2,
        }, "antigravity", self.cfg, state_dir, reviewer=intervene)
        self.assertEqual(out_inv["terminationBehavior"], "force_continue")
        msg = out_inv["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("[SAMI'S INTENT GUARDIAN]", msg)
        self.assertFalse(state.get("high_signal_pending"))

        with transcript.open("a") as stream:
            stream.write(json.dumps({"step_index": 3, "source": "SYSTEM", "type": "SYSTEM_MESSAGE",
                                     "content": f"<SYSTEM_MESSAGE>\n{msg}\n</SYSTEM_MESSAGE>"}) + "\n")
            stream.write(json.dumps({"step_index": 4, "source": "MODEL", "type": "GENERIC",
                                     "content": "All 3 endpoints returned HTTP 200 OK"}) + "\n")

        out_stop, state = g.process_event({
            "conversationId": "agy-conv-1",
            "transcriptPath": str(transcript),
            "hookEventName": "Stop",
            "terminationReason": "NO_TOOL_CALL",
            "fullyIdle": True,
        }, "antigravity", self.cfg, state_dir, reviewer=lambda c, p: (
            {"intervene": True, "verdict_domain": "closure",
             "reason": "Closure still needs final check.", "next_action": "Run health check.",
             "proof_needed": "Health check output.", "evidence_ids": [p["evidence"][-1]["id"]]},
            {"usage": {}},
        ))
        self.assertEqual(out_stop["decision"], "continue")
        self.assertIn("[SAMI'S INTENT GUARDIAN]", out_stop["reason"])
        first_hash = next(iter(state["corrections"]))
        self.assertIn("delivery", state["corrections"][first_hash])

        out_cancel, state = g.process_event({
            "conversationId": "agy-conv-1",
            "transcriptPath": str(transcript),
            "hookEventName": "Stop",
            "terminationReason": "USER_CANCELED",
            "fullyIdle": True,
        }, "antigravity", self.cfg, state_dir,
            reviewer=lambda c, p: self.fail("USER_CANCELED must never call judge"))
        self.assertEqual(out_cancel, {})
        self.assertTrue(state["interrupted"])



if __name__ == "__main__":
    unittest.main()
