"""Regression tests for detached and progressive Reviewer inputs."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import manuscript
import review_dispatch


ASSETS = Path(__file__).resolve().parents[1] / "assets"
CUTOFF = "2023-05-15"


class ReviewDispatchTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.task = root / ".proof2game" / "task"
        self.task.mkdir(parents=True)
        self.scratch = root / "packets"
        self.scratch.mkdir()
        self.main = self.task / "main.tex"
        shutil.copyfile(ASSETS / "script-template.tex", self.main)
        shutil.copytree(ASSETS / "script-example", self.task / "components")

    def append_component(self, filename, text):
        with (self.task / "components" / filename).open("a", encoding="utf-8") as handle:
            handle.write("\n\n" + text + "\n")

    def action(self, component, gate):
        return {
            "role": "reviewer", "token": "pending-gate", "waiting": None,
            "component": component, "gate": gate,
            "snapshot_digest": manuscript.parse(self.main)[0]["snapshot_digest"],
            "source_blind": gate not in ("sources", "reuse"),
            "independent_of_target": True, "identity": None,
            "model": "gpt-6-luna", "effort": "high", "tool_release": "installed-release",
            "prior_findings": "PREVIOUS_FINDING_CANARY",
            "target_path": "TARGET_FILE_CANARY.pdf",
            "source_resolution": {
                "source": "EXTERNAL_CITATION_CANARY", "required": False,
                "location": "source location", "status": "waived",
                "evidence": "USER_REPLY_CANARY",
            },
        }

    def test_statement_remains_blind_until_sources(self):
        self.append_component("main-proof.tex", "PAIRED_PROOF_CANARY")
        self.append_component("setting.tex", "% UNPUBLISHED_WORKER_NOTE_CANARY")
        for gate in ("expression", "self_contained", "mathematics"):
            with self.subTest(gate=gate):
                packet = review_dispatch.build_packet(self.main, self.action("main", gate), cutoff=CUTOFF)
                serialized = json.dumps(packet)
                self.assertTrue(packet["source_blind"])
                self.assertTrue(packet["target_independent"])
                for forbidden in ("PAIRED_PROOF_CANARY", "TARGET_FILE_CANARY", "PREVIOUS_FINDING_CANARY",
                                  "EXTERNAL_CITATION_CANARY", "UNPUBLISHED_WORKER_NOTE_CANARY", CUTOFF):
                    self.assertNotIn(forbidden, serialized)
                self.assertIn("current_text", packet)
                if gate == "expression":
                    self.assertEqual(packet["statement_navigation"]["proof_location"], "2.1")

        packet = review_dispatch.build_packet(self.main, self.action("main", "sources"), cutoff=CUTOFF)
        serialized = json.dumps(packet)
        self.assertFalse(packet["source_blind"])
        self.assertIn("PAIRED_PROOF_CANARY", packet["paired_proof_limited_application_check"]["text"])
        self.assertEqual(packet["source_cutoff"], CUTOFF)
        self.assertIn("EXTERNAL_CITATION_CANARY", serialized)
        self.assertNotIn("USER_REPLY_CANARY", serialized)
        self.assertNotIn("TARGET_FILE_CANARY", serialized)

    def test_convention_opening_omits_rest_and_its_references(self):
        self.append_component("main.tex", "VISIBLE_PRIOR_INTERFACE_CANARY")
        self.append_component("lower-bound-proof.tex", "UNRELATED_PRIOR_PROOF_CANARY")
        source = self.main.read_text(encoding="utf-8")
        source = source.replace(
            "\\section{Detailed Proofs}",
            "\\MScomponent{other}{statement}{components/other.tex}{other-proof}{Theorem}{}\n"
            "\\section{Detailed Proofs}",
        ).replace(
            "\\begin{bibdiv}",
            "\\MSnode{other}{1}\n\\MScomponent{local}{convention}{components/local.tex}{}{}{}\n"
            "\\MScomponent{other-proof}{proof}{components/other-proof.tex}{other}{}{}\n"
            "\\MSendnode\n\\begin{bibdiv}",
        )
        self.main.write_text(source, encoding="utf-8")
        components = self.task / "components"
        (components / "other.tex").write_text("Let $y\\in\\mathbb R$. Then $y^2\\geq 0$.")
        (components / "other-proof.tex").write_text("Apply the square bound to $y$.")
        (components / "local.tex").write_text(
            "OPENING_CANARY. We fix a real variable here.\n\n"
            "LATER_CONVENTION_CANARY. The needed bound is Theorem~\\ref{ms:main}.\n"
        )
        packet = review_dispatch.build_packet(self.main, self.action("local", "opening"), cutoff=CUTOFF)
        serialized = json.dumps(packet)
        self.assertIn("OPENING_CANARY", packet["current_text"])
        self.assertEqual(packet["direct_statement_interfaces"], [])
        self.assertEqual(packet["ambient"][0]["id"], "setting")
        for forbidden in ("LATER_CONVENTION_CANARY", "VISIBLE_PRIOR_INTERFACE_CANARY", "UNRELATED_PRIOR_PROOF_CANARY"):
            self.assertNotIn(forbidden, serialized)

        packet = review_dispatch.build_packet(self.main, self.action("local", "expression"), cutoff=CUTOFF)
        self.assertIn("LATER_CONVENTION_CANARY", packet["current_text"])
        self.assertIn("VISIBLE_PRIOR_INTERFACE_CANARY", packet["direct_statement_interfaces"][0]["text"])
        self.assertNotIn("UNRELATED_PRIOR_PROOF_CANARY", json.dumps(packet))

    def test_reject_changed_snapshot_inapplicable_gate_and_waiting_action(self):
        action = self.action("main", "expression")
        self.append_component("main.tex", "NEW_STATEMENT_VERSION")
        with self.assertRaisesRegex(ValueError, "differs"):
            review_dispatch.build_packet(self.main, action, cutoff=CUTOFF)
        with self.assertRaisesRegex(ValueError, "inapplicable"):
            review_dispatch.build_packet(self.main, self.action("main", "opening"), cutoff=CUTOFF)
        action = self.action("main", "sources")
        action["waiting"] = {"source": "Unavailable paper"}
        with self.assertRaisesRegex(ValueError, "available"):
            review_dispatch.build_packet(self.main, action, cutoff=CUTOFF)

    def test_current_assignment_and_exact_detached_transport(self):
        action = self.action("main", "expression")
        status = {"stale": False, "actions": [action], "state": {"target": {"cutoff": CUTOFF}, "revision": 8}}
        with patch.object(review_dispatch.state, "transact", return_value=status), \
             patch.object(review_dispatch.tempfile, "gettempdir", return_value=str(self.scratch)):
            result = review_dispatch.prepare(self.task, action["token"])
            self.assertEqual(result["operation"], "fresh")
            self.assertEqual(result["revision"], 8)
            self.assertIn("must not influence your mathematical judgment", result["message"])
            self.assertIn("Defer all reads of external sources", result["message"])
            path = Path(result["path"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o400)
            self.assertFalse(path.is_relative_to(self.task))
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), result["sha256"])
            self.assertFalse(str(self.task) in result["message"])
            self.assertFalse(str(self.task) in path.read_text(encoding="utf-8"))
            command = [sys.executable, "-c", review_dispatch.READ_CHUNK, str(path), result["sha256"], "0"]
            read = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(read.stdout.split("\n", 1)[1])["token"], action["token"])
            action["identity"] = {"session": "continued-session"}
            previous_location = self.task.parent.parent / ".mathgrove" / self.task.name
            continued = review_dispatch.prepare(previous_location, action["token"])
            self.assertEqual(continued["operation"], "continue")
            self.assertEqual(continued["session"], "continued-session")
            with self.assertRaisesRegex(ValueError, "current assignment"):
                review_dispatch.prepare(self.task, "expired-token")
            status["stale"] = True
            with self.assertRaisesRegex(ValueError, "ledger differ"):
                review_dispatch.prepare(self.task, action["token"])


if __name__ == "__main__":
    unittest.main()
