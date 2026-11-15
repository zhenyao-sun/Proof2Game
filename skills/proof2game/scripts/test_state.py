"""Deterministic ledger regressions. All worker returns here are synthetic fixtures."""
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import game_developer
import state


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

    def test_missing_pdf_binds_nonpass_and_keeps_completed_peers_on_replacement(self):
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
        with self.assertRaisesRegex(state.Rejected, "indispensable"):
            self.result(self.action(component="main"), "pass")
        self.result(self.action(component="main"), "nonpass", issue="This inference could not be verified.",
                    location="Proof application")
        batch = self.action(role="batcher")
        self.result(batch, "complete", issue_ids=list(batch["issues"]))
        issue = next(iter(batch["issues"]))
        self.result(self.action(role="fixer"), "no-change",
                    issues={issue: {"status": "disagreed", "evidence": "fixture: concern addressed locally"}})
        self.assertEqual(self.data["state"]["safe"], ["setting"])
        self.assertEqual(self.data["state"]["counters"]["rounds"], 1)
        self.change("advance")
        self.assertEqual(self.action(component="main")["gate"], "expression")
        self.assertFalse(self.actions(component="setting"))

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
