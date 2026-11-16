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
                message = review_dispatch.worker_prompt(packet, self.scratch / "gate.json", "sha256")
                self.assertIn("Omit the sources field entirely", message)
                self.assertNotIn("waiting-source", message)
                self.assertNotIn("source_version", message)
                self.assertIn("nonempty English evidence string", message)
                if gate == "expression":
                    self.assertEqual(packet["statement_navigation"]["proof_location"], "2.1")

        packet = review_dispatch.build_packet(self.main, self.action("main", "sources"), cutoff=CUTOFF)
        serialized = json.dumps(packet)
        self.assertFalse(packet["source_blind"])
        self.assertNotIn("PAIRED_PROOF_CANARY", serialized)
        self.assertNotIn("paired_proof_limited_application_check", packet)
        self.assertEqual(packet["source_cutoff"], CUTOFF)
        self.assertIn("EXTERNAL_CITATION_CANARY", serialized)
        self.assertNotIn("USER_REPLY_CANARY", serialized)
        self.assertNotIn("TARGET_FILE_CANARY", serialized)

    def test_statement_source_packet_only_exposes_relevant_proof_passages(self):
        self.append_component("main.tex", r"The Statement invokes \cite{visible}.")
        self.append_component("main-proof.tex", r"APPLICATION_CANARY verifies \cite{visible} here.")
        self.append_component("main-proof.tex", r"UNRELATED_CANARY uses \cite{proof-only}.")
        for gate in ("sources", "reuse"):
            with self.subTest(gate=gate):
                packet = review_dispatch.build_packet(self.main, self.action("main", gate), cutoff=CUTOFF)
                proof = packet["paired_proof_limited_application_check"]["text"]
                self.assertIn("APPLICATION_CANARY", proof)
                self.assertNotIn("UNRELATED_CANARY", proof)
                self.assertNotIn("proof-only", proof)
        proof = review_dispatch.build_packet(self.main, self.action("main-proof", "sources"), cutoff=CUTOFF)
        self.assertIn("UNRELATED_CANARY", proof["current_text"])

    def test_statement_expression_explains_blank_adjacent_prose(self):
        packet = review_dispatch.build_packet(self.main, self.action("main", "expression"), cutoff=CUTOFF)
        self.assertFalse(packet["adjacent_prose"].strip())
        self.assertEqual(packet["preceding_component"]["id"], "setting")
        message = review_dispatch.worker_prompt(packet, self.scratch / "gate.json", "sha256")
        self.assertIn("A blank adjacent_prose field means no intervening prose is written", message)
        self.assertIn("Use the supplied preceding_component or preceding_proof_transition_excerpt", message)
        self.assertIn("Flag a missing transition only if the manuscript needs one", message)
        self.assertIn("Request only a precise excerpt", message)

    def test_external_lookup_requires_a_gate_specific_reason(self):
        for gate in ("sources", "reuse"):
            with self.subTest(gate=gate):
                action = self.action("main-proof", gate)
                action.pop("source_resolution")
                packet = review_dispatch.build_packet(self.main, action, cutoff=CUTOFF)
                message = review_dispatch.worker_prompt(packet, self.scratch / "gate.json", "sha256")
                self.assertIn("return pass with sources:[] without a lookup", message)
                self.assertIn("concrete external source needed at this gate", message)
                self.assertIn("verify the eligible original PDF directly", message)
                self.assertIn("requires a source wait", message)
                self.assertIn("omit it if unknown", message)
                self.assertIn("Identify the missing external work and its use in evidence", message)
                if gate == "sources":
                    self.assertIn("Manuscript-local references do not require an external PDF", message)
                else:
                    self.assertIn("no concrete reuse opportunity", message)

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
            self.assertIn(f"[token]\n{action['token']}\n", read.stdout)
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


    def test_review_reader_preserves_tex_line_break_and_genuine_macro(self):
        current = r"\qquad" + "\n" + r"u_{\kappa,v}=c,\quad\nu\in\mathbb N."
        long_proof = "α" * 4050
        data = json.dumps({"current_text": current, "ambient": [{"text": long_proof}], "sources": []})
        path = self.scratch / "gate.json"
        path.write_text(data, encoding="utf-8")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        command = [sys.executable, "-c", review_dispatch.READ_CHUNK, str(path), digest]
        expected = f"[current_text]\n{current}\n\n[ambient / 1 / text]\n{long_proof}\n\n[sources]\n[]"
        for start in range(0, len(expected), 4000):
            end = min(start + 4000, len(expected))
            result = subprocess.run([*command, str(start)], check=True, capture_output=True, text=True)
            header = f"packet characters [{start},{end}) of {len(expected)}\n"
            self.assertEqual(result.stdout, header + expected[start:end])
        path.write_text(data + " ", encoding="utf-8")
        rejected = subprocess.run([*command, "0"], capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("review packet SHA-256 mismatch", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
