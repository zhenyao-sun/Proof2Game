"""Deterministic ledger regressions. All worker returns here are synthetic fixtures."""
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import game_developer
import intake
import state
from test_intake import make_pdf, source_data


ASSETS = Path(__file__).resolve().parents[1] / "assets"


class Ledger(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proof2game-ledger-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name).resolve()
        self.task = self.project / ".proof2game" / "target-a"
        self.task.mkdir(parents=True)
        shutil.copyfile(ASSETS / "script-template.tex", self.task / "main.tex")
        shutil.copytree(ASSETS / "script-example", self.task / "components")
        (self.task / "original.md").write_text("Fixture manuscript\n")
        self.serial = 0

    def init(self, entry="verify", kind="unpublished"):
        target = {"id": self.task.name, "project_type": kind, "original_path": "original.md",
                  "sha256": state.file_digest(self.task / "original.md"),
                  "cutoff": "2023-01-01" if kind == "public" else None,
                  "public_date": "2023-01-01" if kind == "public" else None}
        (self.task / "target.json").write_bytes(state.json_bytes(target))
        self.data = state.transact(self.task, {
            "op": "init", "entry": entry, "tool_release": "fixture-release",
            "coordinator": {"session": "fixture-main", "model": "gpt-6.1-sol", "effort": "medium",
                            "evidence": "synthetic coordinator fixture"},
            "goal": {"id": "fixture-goal", "evidence": "synthetic Goal fixture"},
        })

    def change(self, op, **fields):
        self.data = state.transact(self.task, {"op": op, "expected_revision": self.data["state"]["revision"], **fields})
        return self.data["state"]

    def actions(self, **query):
        return [action for action in self.data["actions"] if all(action.get(key) == value for key, value in query.items())]

    def action(self, **query):
        return next(iter(self.actions(**query)))

    def bind(self, action):
        if not action["identity"]:
            self.serial += 1
            self.change("bind", token=action["token"], snapshot_digest=action["snapshot_digest"],
                        session=f"fixture-session-{self.serial}", model=action["model"], effort=action["effort"],
                        evidence="synthetic independent role fixture")
        return next(item for item in self.data["actions"] if item["token"] == action["token"])

    def result(self, action, verdict, **fields):
        action = self.bind(action)
        if action["role"] == "reviewer" and action["gate"] in ("sources", "reuse") and verdict == "pass":
            fields.setdefault("sources", [])
        return self.change("result", verdict=verdict, token=action["token"], snapshot_digest=action["snapshot_digest"],
                           session=action["identity"]["session"], evidence=f"synthetic {verdict} fixture", **fields)

    def pass_component(self, cid):
        while self.actions(role="reviewer", component=cid):
            self.result(self.action(role="reviewer", component=cid), "pass")

    def evaluate(self):
        for _ in range(70):
            phase = self.data["state"]["phase"]
            if phase == "dispatch":
                self.change("advance")
            elif phase == "review":
                self.result(self.action(role="reviewer"), "pass")
            elif phase == "explore":
                self.result(self.action(role="explorer"), "no-change")
            else:
                return phase
        self.fail("fixture failed to reach a route decision")

    def staged(self, folder="edit"):
        output = self.task / "staging" / folder
        output.mkdir(parents=True)
        shutil.copyfile(self.task / "main.tex", output / "main.tex")
        shutil.copytree(self.task / "components", output / "components")
        return output

    def proposal(self, folder):
        snapshot, _ = state.manuscript.parse(folder / "main.tex")
        return {"candidate": str(folder.relative_to(self.task)), "candidate_digest": snapshot["snapshot_digest"]}

    def work_on_proof(self, staged):
        proof = staged / "components" / "main-proof.tex"
        proof.write_text(proof.read_text() + "\nThis follows by the stated calculation.\n")

    def test_verified_private_scope_snapshot_and_artifact_incident(self):
        self.init("guided")
        self.assertEqual(self.change("advance")["phase"], "review")
        self.assertEqual([item["component"] for item in self.actions()], ["setting", "main"])
        self.assertEqual(self.evaluate(), "route")
        self.result(self.action(role="simplification"), "no-simplification")
        approved = self.change("advance")
        product = approved["delivery"]
        self.assertEqual(set(product["products"]), {"game", "paper"})
        certificate = self.task / product["approval_path"]
        self.assertEqual(state.read_json(certificate)["route_review"], "pass")
        self.assertEqual(state.manuscript.parse(certificate.with_name("main.tex"))[0]["snapshot_digest"],
                         product["snapshot_digest"])
        self.change("pause", kind="user", evidence="fixture user temporarily paused delivery")
        self.assertEqual(self.change("refactor-decision", decision="resume", confirmation="fixture user resumed")["phase"],
                         "delivery")
        invalid_game = self.task / "deliveries" / "bad.zip"
        with zipfile.ZipFile(invalid_game, "w") as fixture:
            fixture.writestr("game.json", "{}")
        with self.assertRaisesRegex(state.Rejected, "runtime files"):
            self.change("deliverable", kind="game", snapshot_digest=product["snapshot_digest"], status="checked",
                        artifact="deliveries/bad.zip", sha256=state.file_digest(invalid_game), evidence="fixture attempted substitution")
        main = certificate.with_name("main.tex")
        _, full = state.manuscript.parse(main)
        translation = game_developer.translation_input(product["snapshot_digest"], game_developer.resource_closure(main, full))
        substitutions = {
            "Throughout, the variables are real and inequalities use the usual order on the real numbers.": "全文变量均为实数，不等式按实数的通常顺序理解。",
            "If ": "若 ",
            ", then ": "，则 ",
            "The product of two nonnegative real numbers is nonnegative. Apply this to ": "两个非负实数的乘积非负。将此应用于 ",
            " and ": " 和 ",
            "By Lemma": "由引理",
            "Adding the three terms gives the claimed lower bound.": "将三项相加即得所述下界。",
        }
        for name, source in translation["files"].items():
            if name.startswith("components/"):
                for phrase, translated in substitutions.items():
                    source = source.replace(phrase, translated)
                translation["files"][name] = source
        game = self.task / "deliveries" / "example.zip"
        game_developer.export(main, game, translation=translation)
        self.change("deliverable", kind="game", snapshot_digest=product["snapshot_digest"], status="checked",
                    artifact="deliveries/example.zip", sha256=state.file_digest(game),
                    evidence="fixture game passed mechanical validation")
        self.change("deliverable", kind="game", snapshot_digest=product["snapshot_digest"], status="delivered",
                    evidence="synthetic chat delivery fixture")
        self.assertEqual(self.data["state"]["phase"], "delivery")
        self.change("deliverable", kind="paper", snapshot_digest=product["snapshot_digest"], status="blocked",
                    evidence="fixture: no worker available for this artifact")
        result = self.change("incident", kind="script", snapshot_digest=product["snapshot_digest"],
                             components=["main-proof"], evidence="fixture: credible mathematical concern")
        self.assertEqual(result["phase"], "dispatch")
        self.assertIn("main-proof", self.data["unsafe"])
        self.assertEqual(result["superseded"][0]["products"]["game"]["status"], "delivered")
        self.assertEqual(result["superseded"][0]["products"]["paper"]["status"], "blocked")
        self.assertEqual(state.read_json(certificate)["route_review"], "invalidated")

    def test_advancing_gate_keeps_continuing_reviewer_slot(self):
        self.init()
        self.change("advance")
        current = self.bind(self.action(component="main"))
        ledger = self.data["state"]
        actions = ledger["actions"]
        actions.pop(current["token"])
        for index in range(8):
            state.role_action(ledger, "reviewer", component=f"running-{index}")
        reviews = ledger["round"]["reviews"]
        ledger["round"]["reviews"] = {"queued-before-main": {"verdict": None}, **reviews}

        state.review_result(self.task, ledger, current, {"verdict": "pass", "evidence": "synthetic expression pass"})

        continued = next(action for action in actions.values() if action["component"] == "main")
        self.assertEqual(continued["gate"], "self_contained")
        self.assertEqual(continued["identity"], current["identity"])
        self.assertEqual(len(actions), 10)

    def test_nonpass_names_invalid_fields_and_keeps_gate_pending(self):
        self.init()
        self.change("advance")
        reviewer = self.bind(self.action(component="main"))
        before = self.data["state"]["revision"]
        malformed = [
            ({"issue": {"description": "unclear", "location": "first sentence"}},
             "location must be a nonempty string"),
            ({"issue": {"description": "unclear"}, "location": "first sentence"},
             "issue must be a nonempty string"),
        ]
        for fields, error in malformed:
            with self.subTest(fields=fields), self.assertRaisesRegex(state.Rejected, error):
                self.result(reviewer, "nonpass", **fields)
            status = state.transact(self.task, {"op": "status"})
            self.assertEqual(status["state"]["revision"], before)
            self.assertIn(reviewer, status["actions"])
        current = self.result(reviewer, "nonpass", issue="unclear", location="first sentence")
        self.assertEqual(current["round"]["issues"][reviewer["token"]]["issue"], "unclear")

    def test_missing_pdf_stops_at_fixer_and_keeps_completed_peers_on_replacement(self):
        self.init(kind="public")
        self.change("advance")
        self.pass_component("setting")
        primary = self.action(component="main")
        self.result(primary, "pass")
        self.change("select-release", schema=1, tool_release="approved-fixture-v2",
                    approval="synthetic user approval", compatibility="synthetic release schema confirmed")
        replacement = self.action(component="main")
        self.assertEqual(replacement["gate"], "expression")
        self.assertEqual(replacement["tool_release"], "approved-fixture-v2")
        self.assertFalse(self.actions(component="setting"))
        self.assertIsNone(replacement["identity"])
        for _ in range(3):
            self.result(self.action(component="main"), "pass")
        self.result(self.action(component="main"), "waiting-source", required=True, source="paper",
                    location="Proof application")
        waiting = self.action(component="main")
        self.change("source-resolve", token=waiting["token"], snapshot_digest=waiting["snapshot_digest"],
                    status="unavailable", evidence="fixture user confirmed inaccessible primary PDF")
        with self.assertRaisesRegex(state.Rejected, "resolve the source wait first"):
            self.result(self.action(component="main"), "pass")
        batch = self.action(role="batcher")
        self.assertEqual(batch["issues"], {})
        self.result(batch, "complete", issue_ids=list(batch["issues"]))
        fixer = self.action(role="fixer")
        self.assertEqual(self.data["state"]["phase"], "fix")
        self.assertEqual(fixer["waiting"], {"kind": "reviewer-sources", "tokens": [waiting["token"]]})
        with self.assertRaisesRegex(state.Rejected, "bound or waiting"):
            self.bind(fixer)
        self.change("advance")
        self.assertEqual(self.action(role="fixer")["token"], fixer["token"])
        self.assertEqual(self.action(component="main")["token"], waiting["token"])
        self.assertEqual(self.data["state"]["counters"]["rounds"], 0)
        self.assertFalse(self.actions(component="setting"))

    def test_reviewer_source_arrival_reopens_parked_fixer_then_reuses_existing_batch(self):
        self.init(kind="public")
        self.change("advance")
        self.result(self.action(component="setting"), "nonpass", issue="Synthetic scope defect", location="Setting")
        for _ in range(3):
            self.result(self.action(component="main"), "pass")
        self.result(self.action(component="main"), "waiting-source", required=False, source="study", location="Optional reuse")
        waiting = self.action(component="main")
        batch = self.action(role="batcher")
        issue_ids = list(batch["issues"])
        self.result(batch, "complete", issue_ids=issue_ids)
        fixer = self.action(role="fixer")
        with self.assertRaisesRegex(state.Rejected, "own token"):
            self.change("source-resolve", token=fixer["token"], snapshot_digest=fixer["snapshot_digest"],
                        status="waived", evidence="synthetic waiver")
        self.change("source-resolve", token=waiting["token"], snapshot_digest=waiting["snapshot_digest"],
                    status="waived", evidence="synthetic user intentionally waived optional reuse")
        self.assertEqual(self.data["state"]["phase"], "review")
        self.assertFalse(self.actions(role="fixer"))
        self.pass_component("main")
        self.assertFalse(self.actions(role="batcher"))
        self.assertIsNone(self.action(role="fixer")["waiting"])
        self.assertEqual(self.action(role="fixer")["order"], issue_ids)

    def test_waiting_fixer_progress_cannot_modify_round(self):
        self.init()
        self.change("advance")
        self.result(self.action(component="setting"), "nonpass", issue="Synthetic scope defect", location="Setting")
        self.pass_component("main")
        batch = self.action(role="batcher")
        self.result(batch, "complete", issue_ids=list(batch["issues"]))
        self.result(self.action(role="fixer"), "waiting-source", required=True, source="study", location="Repair")
        fixer = self.action(role="fixer")
        with self.assertRaisesRegex(state.Rejected, "resolve the source wait first"):
            self.change("fixer-progress", token=fixer["token"], snapshot_digest=fixer["snapshot_digest"],
                        session=fixer["identity"]["session"], issues={})
        self.change("source-resolve", token=fixer["token"], snapshot_digest=fixer["snapshot_digest"],
                    status="unavailable", evidence="synthetic unavailable PDF")
        self.assertEqual(self.action(role="fixer")["waiting"], fixer["waiting"])

    def test_unknown_source_version_can_resolve_existing_and_new_waits(self):
        self.init(kind="public")
        self.change("advance")
        self.pass_component("setting")
        for _ in range(3):
            self.result(self.action(component="main"), "pass")
        self.result(self.action(component="main"), "waiting-source", required=True,
                    source="needed-study", source_version="unknown", location="Required interface")
        waiting = self.action(component="main")
        self.assertIsNone(waiting["waiting"]["source_version"])
        self.result(self.action(role="batcher"), "complete", issue_ids=[])
        self.assertEqual(self.data["state"]["phase"], "fix")

        # Recreate a wait persisted by an earlier version of the runtime.
        ledger_path = self.task / "state.json"
        persisted = state.read_json(ledger_path)
        persisted["actions"][waiting["token"]]["waiting"]["source_version"] = "unknown"
        ledger_path.write_bytes(state.json_bytes(persisted))
        reference = {"complete": True, "public_date": "2022-01", "work_key": "needed-study",
                     "id": "needed-study-v2", "version": "v2", "sha256": "1" * 64}
        with patch.object(intake, "checked_record", return_value=reference):
            self.change("source-resolve", token=waiting["token"], snapshot_digest=waiting["snapshot_digest"],
                        status="available", reference_id=reference["id"], evidence="synthetic source receipt")
        current = self.action(component="main")
        self.assertIsNone(current["waiting"])
        self.assertIsNone(current["source_resolution"]["source_version"])
        self.assertEqual(current["source_resolution"]["reference_version"], "v2")
        self.assertEqual(self.data["state"]["phase"], "review")
        self.result(current, "nonpass", issue="Synthetic source does not support application", location="Required interface")
        self.assertEqual(len(self.action(role="batcher")["issues"]), 1)

    def test_required_source_wait_and_pass_bind_the_same_publication(self):
        self.init(kind="public")
        self.change("advance")
        self.pass_component("setting")
        for _ in range(3):
            self.result(self.action(component="main"), "pass")
        self.result(self.action(component="main"), "waiting-source", required=True,
                    source="needed-study", source_version="v2", location="Required interface")
        waiting = self.action(component="main")
        pdf = self.project / "fixture.pdf"
        make_pdf(pdf)

        def register(work_key, version):
            record = intake.register_reference(self.project, {
                **source_data(public_date="2022-01-01", version=version),
                "id": f"{work_key}-{version}", "work_key": work_key, "pdf": str(pdf),
            })
            page = {"kind": "reference", "id": record["id"]}
            for number in (1, 2):
                target = {**page, "page": number}
                image = intake.render_page(self.project, target)
                intake.record_page(self.project, {
                    **target, "image_sha256": image["image_sha256"], "reviewer": "synthetic fixture",
                    "method": "codex_pdf_image_ocr", "markdown": "Synthetic arithmetic page.",
                    "uncertainties": [],
                })
            return intake.finish_ocr(self.project, page)

        def resolve(reference):
            self.change("source-resolve", token=waiting["token"], snapshot_digest=waiting["snapshot_digest"],
                        status="available", reference_id=reference["id"], evidence="synthetic source receipt")

        unrelated = register("unrelated", "v2")
        with self.assertRaisesRegex(state.Rejected, "requested source work key"):
            resolve(unrelated)
        wrong_version = register("needed-study", "v1")
        with self.assertRaisesRegex(state.Rejected, "requested source version"):
            resolve(wrong_version)
        correct = register("needed-study", "v2")
        resolve(correct)
        current = self.action(component="main")
        self.assertEqual(current["source_resolution"]["reference_sha256"], correct["sha256"])
        with self.assertRaisesRegex(state.Rejected, "cite the resolved required source"):
            self.result(current, "pass", sources=[])
        with self.assertRaisesRegex(state.Rejected, "cite the resolved required source"):
            self.result(current, "pass", sources=[{
                "id": unrelated["id"], "sha256": unrelated["sha256"], "locators": {"Theorem A": [1]},
            }])
        with self.assertRaisesRegex(ValueError, "original's SHA-256"):
            self.result(current, "pass", sources=[{
                "id": correct["id"], "sha256": "0" * 64, "locators": {"Theorem A": [1]},
            }])
        self.result(current, "pass", sources=[{
            "id": correct["id"], "sha256": correct["sha256"], "locators": {"Theorem A": [1]},
        }])
        self.result(self.action(component="main"), "pass")
        self.assertIn("main", self.data["state"]["safe"])

    def test_public_nonpass_accepts_same_version_only_and_fresh_route(self):
        self.init(kind="public")
        self.assertEqual(self.evaluate(), "route")
        first = self.bind(self.action(role="public_route"))
        self.result(first, "nonpass", plan="Synthetic route repair.")
        candidate = self.staged()
        self.work_on_proof(candidate)
        self.result(self.action(role="refactor"), "candidate", **self.proposal(candidate))
        self.change("apply-candidate", changes={"main-proof": {"meaning": "substantive", "meaning_evidence": "synthetic new steps"}},
                    target_meaning_evidence="same target and context")
        self.assertIn("main-proof", self.data["unsafe"])
        self.assertIn("This follows", (self.task / "components" / "main-proof.tex").read_text())
        self.assertEqual(self.evaluate(), "route")
        latest = self.action(role="public_route")
        self.assertNotEqual(latest["snapshot_digest"], first["snapshot_digest"])
        with self.assertRaisesRegex(state.Rejected, "stale"):
            self.change("result", token=first["token"], snapshot_digest=first["snapshot_digest"],
                        session=first["identity"]["session"], verdict="pass", evidence="stale fixture")
        self.result(latest, "pass")
        self.assertEqual(self.data["state"]["phase"], "complete")

    def test_private_simplification_failure_rolls_back_and_retains_round_counts(self):
        self.init()
        self.assertEqual(self.evaluate(), "route")
        self.result(self.action(role="simplification"), "simplify", plan="Synthetic simplification.")
        baseline = state.file_digest(self.task / "components" / "main-proof.tex")
        initial_rounds = self.data["state"]["counters"]["rounds"]
        candidate = self.staged()
        self.work_on_proof(candidate)
        self.result(self.action(role="refactor"), "candidate", **self.proposal(candidate))
        self.change("apply-candidate", changes={"main-proof": {"meaning": "substantive", "meaning_evidence": "fixture simplification"}},
                    target_meaning_evidence="same target and context")
        self.assertEqual(self.evaluate(), "compare")
        self.result(self.action(role="simplification"), "worse")
        self.change("rollback", evidence="fixture restored baseline route")
        self.assertEqual(state.file_digest(self.task / "components" / "main-proof.tex"), baseline)
        self.assertGreater(self.data["state"]["counters"]["rounds"], initial_rounds)
        self.assertEqual(self.evaluate(), "route")
        self.assertTrue(self.action(role="simplification")["prior_attempts"])

    def test_external_edit_rejects_results(self):
        self.init()
        self.change("advance")
        before = self.data["state"]["revision"]
        (self.task / "main.tex").write_text((self.task / "main.tex").read_text() + "% drift\n")
        self.assertTrue(state.transact(self.task, {"op": "status"})["stale"])
        with self.assertRaisesRegex(state.Rejected, "outside the saved transaction"):
            self.change("advance")
        self.assertEqual(state.read_json(self.task / "state.json")["revision"], before)

    def test_legacy_task_keeps_active_review_and_git_checkpoint_at_original_path(self):
        current = self.task
        self.task = self.project / ".mathgrove" / current.name
        self.task.parent.mkdir()
        current.rename(self.task)
        self.init()
        self.change("advance")
        reviewer = self.bind(self.action(role="reviewer", component="main"))
        previous = (self.task / state.STATE_FILE).read_bytes()
        actual = state.transact(current, {"op": "status"})
        self.assertFalse(actual["stale"])
        self.assertEqual((self.task / state.STATE_FILE).read_bytes(), previous)
        self.assertFalse(current.exists())
        self.assertEqual(actual["state"]["actions"][reviewer["token"]]["identity"], reviewer["identity"])
        checkpoint = actual["state"]["checkpoints"][0]["commit"]
        stored = state.git(self.project, "show", f"{checkpoint}:.mathgrove/{self.task.name}/main.tex").stdout
        self.assertEqual(stored, (self.task / "main.tex").read_bytes())
        self.data = state.transact(current, {"op": "checkpoint", "expected_revision": actual["state"]["revision"]})
        self.assertEqual(self.data["state"]["checkpoints"][0]["commit"], checkpoint)
        self.assertFalse(current.exists())

    def test_edit_during_compile_is_never_overwritten(self):
        self.init(kind="public")
        self.assertEqual(self.evaluate(), "route")
        self.result(self.action(role="public_route"), "nonpass", plan="Synthetic route repair.")
        candidate = self.staged()
        self.work_on_proof(candidate)
        self.result(self.action(role="refactor"), "candidate", **self.proposal(candidate))
        live_proof = self.task / "components" / "main-proof.tex"
        old = live_proof.read_text()

        def concurrent_edit(source):
            self.assertEqual(source, candidate)
            live_proof.write_text(old + "\nUser edit during compile.\n")
            return {"navigation_numbers": {}}

        with patch.object(state, "compile_script", side_effect=concurrent_edit):
            with self.assertRaisesRegex(state.Rejected, "concurrent change"):
                self.change("apply-candidate",
                            changes={"main-proof": {"meaning": "substantive", "meaning_evidence": "fixture improvement"}},
                            target_meaning_evidence="same target and context")
        self.assertIn("User edit", live_proof.read_text())
        self.assertFalse((self.task / state.JOURNAL_FILE).exists())

    def test_replace_incident_fixer_without_an_open_round(self):
        self.init("guided", "public")
        self.assertEqual(self.evaluate(), "route")
        self.result(self.action(role="public_route"), "pass")
        approval = self.change("advance")["delivery"]
        self.assertEqual(set(approval["products"]), {"game", "referee"})
        self.assertTrue(approval["approval"]["referee_comparison"])
        self.assertEqual(approval["approval"]["report_findings"], [])
        self.assertIsNone(approval["approval"]["report_sha256"])
        self.change("incident", kind="counterexample", snapshot_digest=approval["snapshot_digest"],
                    evidence="recheck a potential public counterexample", components=["main-proof"])
        fixer = self.bind(self.action(role="fixer"))
        self.change("replace", token=fixer["token"], snapshot_digest=fixer["snapshot_digest"],
                    session=fixer["identity"]["session"], evidence="synthetic worker no longer available")
        new = self.action(role="fixer")
        self.assertNotEqual(new["token"], fixer["token"])
        self.assertEqual(new["purpose"], "incident")
        self.assertIsNone(new["identity"])


if __name__ == "__main__":
    unittest.main()
