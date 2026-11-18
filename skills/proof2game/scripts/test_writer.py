"""Focused Writer regressions using local synthetic math and real TeX builds."""
import json
from pathlib import Path
import shutil
from subprocess import CompletedProcess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import manuscript
import writer


ASSETS = Path(__file__).resolve().parent.parent / "assets"


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.workspace = TemporaryDirectory(prefix="proof2game-writer-test-")
        self.addCleanup(self.workspace.cleanup)
        self.task = Path(self.workspace.name)
        self.snapshot = self.task / "snapshot"
        self.snapshot.mkdir()
        self.main = self.snapshot / "main.tex"
        self.main.write_text(
            r"""
\documentclass{article}
\begin{document}
\section{Main Results}
\MScomponent{plus-zero}{statement}{target.tex}{proof-plus-zero}{Theorem}{Additive identity}
\MScomponent{zero-plus}{statement}{other.tex}{proof-zero-plus}{Theorem}{Left identity}
\section{Detailed Proofs}
\MSnode{plus-zero}{0}
\MScomponent{proof-plus-zero}{proof}{proof.tex}{plus-zero}{}{}
\MSendnode
\MSnode{zero-plus}{0}
\MScomponent{proof-zero-plus}{proof}{other-proof.tex}{zero-plus}{}{}
\MSendnode
\end{document}
""",
            encoding="utf-8",
        )
        for name, body in {
            "target.tex": r"For every real number $x$, one has $x + 0 = x$.",
            "other.tex": r"For every real number $x$, one has $0 + x = x$.",
            "proof.tex": "Use the defining property of the additive identity.",
            "other-proof.tex": "Use commutativity and the defining property of the additive identity.",
        }.items():
            (self.snapshot / name).write_text(body, encoding="utf-8")
        self.snap, _ = manuscript.parse(self.main)
        self.approval = {
            "schema": 1, "snapshot_digest": self.snap["snapshot_digest"],
            "components": self.snap["cone"], "project_type": "unpublished",
            "cutoff": None, "math_review": "pass", "proof_obligations": "closed",
            "route_review": "pass",
        }
        self.approval_path = self.snapshot / "approval.json"
        self.write(self.approval_path, self.approval)
        self.draft = self.task / "draft"
        self.draft.mkdir()
        self.bundle = self.task / "bundle"
        self.checks_path = self.task / "checks.json"

    def write(self, path, record):
        path.write_text(json.dumps(record), encoding="utf-8")

    def test_split_system_tex_roots_do_not_permit_external_draft_assets(self):
        distribution = self.task / "tex-distribution"
        configuration = self.task / "tex-configuration"
        build = self.task / "build"
        for path in (distribution, configuration, build):
            path.mkdir()
        project_alias = self.task / "project-alias"
        project_alias.symlink_to(self.task.resolve(), target_is_directory=True)
        source_alias = project_alias / "draft"
        build_alias = project_alias / "build"
        variables = {"TEXMFROOT": distribution, "TEXMFSYSCONFIG": configuration}
        recorder = build / "main.fls"
        recorder.write_text(f"INPUT {configuration / 'texmf.cnf'}\nINPUT ./main.tex\n")

        def kpsewhich(command, **kwargs):
            variable = command[1].split("=", 1)[1]
            return CompletedProcess(command, 0, stdout=str(variables.get(variable, "")))

        with patch.object(writer.subprocess, "run", side_effect=kpsewhich):
            writer.check_local_resources(source_alias, build_alias, "main.tex")
            with recorder.open("a") as stream:
                stream.write(f"INPUT {self.task / 'unbundled-asset.tex'}\n")
            with self.assertRaisesRegex(writer.Rejected, "unbundled-asset"):
                writer.check_local_resources(source_alias, build_alias, "main.tex")

    def public_input(self):
        target = self.task / "target.json"
        original = self.task / "original.tex"
        original.write_text("Equation (1) asserts that every real is positive.", encoding="utf-8")
        report = self.task / "report.md"
        report.write_text("Original Eq. (1): set x = -1, which is real and not positive.", encoding="utf-8")
        original_digest = writer.digest(original.read_bytes())
        self.write(target, {
            "project_type": "public", "version": "v2",
            "public_date": "2024-01-02", "original_path": original.name, "sha256": original_digest,
        })
        self.approval.update(
            project_type="public", cutoff="2024-01-02", original_sha256=original_digest,
            report_sha256=writer.digest(report.read_bytes()), report_findings=[{
                "id": "F1", "location": "p. 1, equation (1)",
                "original_conclusion": "Every real is positive.",
                "evidence": "At x=-1 the hypothesis holds and the conclusion fails.",
                "verification": "Synthetic fixture: substitution into original Eq. (1).",
            }],
        )
        self.write(self.approval_path, self.approval)
        return target, report

    def draft_document(self, kind, body):
        name = f"writer-{kind}.tex"
        tex = self.draft / "main.tex"
        tex.write_text(
            (ASSETS / name).read_text(encoding="utf-8").replace(r"\end{document}", body + "\n" + r"\end{document}"),
            encoding="utf-8",
        )
        return tex

    def self_check(self, candidate, **extra):
        return {
            **{key: candidate[key] for key in ("input_digest", "source_digest", "pdf_sha256")},
            "worker_session": "synthetic-test-session",
            "model": "gpt-6.2-sol", "effort": "ultra",
            "render": "Synthetic test evidence, PDF page 1.",
            "references": "Synthetic test evidence, references checked with stable TeX labels.",
            **extra,
        }

    def test_requires_current_filtered_approval(self):
        self.assertEqual(writer.applicable_inputs("paper", self.main)["targets"], ["plus-zero", "zero-plus"])
        (self.snapshot / "target.tex").write_text("Changed theorem.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "does not match"):
            writer.applicable_inputs("paper", self.main)

    def test_legacy_public_findings_remain_bound_and_public_cannot_write_paper(self):
        target, report = self.public_input()
        self.assertEqual(writer.applicable_inputs("referee", self.main, target)["report_findings"][0]["id"], "F1")
        with self.assertRaisesRegex(writer.Rejected, "unpublished project"):
            writer.applicable_inputs("paper", self.main)
        self.approval["report_findings"] = []
        self.write(self.approval_path, self.approval)
        with self.assertRaisesRegex(writer.Rejected, "approved manuscript comparison"):
            writer.applicable_inputs("referee", self.main, target)
        self.approval["report_findings"] = [{
            "id": "test", "location": "line 1", "original_conclusion": "all reals positive",
            "evidence": "x=-1", "verification": "substitution",
        }]
        self.write(self.approval_path, self.approval)
        report.write_text("Unverified change.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "differs"):
            writer.applicable_inputs("referee", self.main, target)

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("kpsewhich"), "MacTeX tools unavailable")
    def test_public_comparison_without_findings_compiles_and_binds_both_inputs(self):
        target, report = self.public_input()
        original = self.task / "original.tex"
        original.write_text("The two additive identities are x+0=x and 0+x=x.", encoding="utf-8")
        original_record = writer.read_record(target)
        original_record["sha256"] = writer.digest(original.read_bytes())
        self.write(target, original_record)
        self.approval.update(referee_comparison=True, report_findings=[], report_sha256=None,
                             original_sha256=original_record["sha256"])
        self.write(self.approval_path, self.approval)
        report.rename(report.with_name("unrelated-notes.md"))
        read_inputs = lambda: writer.applicable_inputs("referee", self.main, target)
        self.assertEqual(read_inputs()["report_findings"], [])
        tex = self.draft_document("referee", r"""
\paragraph{Scope.} Original version v2 (2024-01-02).
\paragraph{Assessment.} The two additive identities are unchanged. The game's proof of the
left identity makes the use of commutativity explicit.
""")
        candidate = writer.compile_delivery("referee", tex, self.bundle, "pdflatex", read_inputs)
        comparison = {"plus-zero": {"original": "line 1, first identity", "script": "target.tex and proof.tex",
                                    "report": "p. 1, Assessment"}}
        checks = self.self_check(candidate, scope="Both results were compared with the original.",
                                 comparison=comparison, findings={})
        self.write(self.checks_path, checks)
        with self.assertRaisesRegex(writer.Rejected, "Compare every approved target"):
            writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs)
        comparison["zero-plus"] = {"original": "line 1, second identity", "script": "other.tex and other-proof.tex",
                                   "report": "p. 1, Assessment"}
        self.write(self.checks_path, checks)
        finished = writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs)
        self.assertEqual(finished, writer.verify_delivery("referee", self.bundle, read_inputs))
        script = self.snapshot / "other-proof.tex"
        unchanged = script.read_bytes()
        script.write_text("Changed proof.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "does not match"):
            writer.verify_delivery("referee", self.bundle, read_inputs)
        script.write_bytes(unchanged)
        original.write_text("A different original.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "bytes differ"):
            writer.verify_delivery("referee", self.bundle, read_inputs)

    def test_latex_rejects_work_identity_declarations(self):
        with self.assertRaisesRegex(writer.Rejected, "Omit work title"):
            writer.check_paper_identity({"main.tex": rb"\title{An authorless paper}"})
        writer.check_paper_identity({"main.tex": rb"% \author{This is only a comment}"})

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("kpsewhich"), "MacTeX tools unavailable")
    def test_paper_build_and_resume_verify_every_target_and_exact_bytes(self):
        read_inputs = lambda: writer.applicable_inputs("paper", self.main)
        tex = self.draft_document("paper", r"""
\section{Introduction}
\input{results}
\section{Proofs}
The additive identity is the definition of \eqref{e:zero}.
Commutativity gives the other equality.
""")
        (self.draft / "results.tex").write_text(
            r"""\begin{theorem} For every real $x$ one has
\begin{equation}\label{e:zero} x+0=x. \end{equation}
\end{theorem}
\begin{theorem} For every real $x$ one has $0+x=x$.\end{theorem}
""", encoding="utf-8"
        )
        candidate = writer.compile_delivery("paper", tex, self.bundle, "pdflatex", read_inputs)
        self.assertIn("results.tex", candidate["source_files"])
        self.assertTrue((self.bundle / "paper.pdf").read_bytes().startswith(b"%PDF-"))
        checks = self.self_check(
            candidate, fidelity="Both statements and the defining property appear on page 1.",
            targets={"plus-zero": {"statement": "Theorem 1.1", "proof": "Section 2 paragraph 1"}},
        )
        self.write(self.checks_path, checks)
        with self.assertRaisesRegex(writer.Rejected, "every current target"):
            writer.finish_delivery("paper", self.bundle, self.checks_path, read_inputs)
        checks["targets"]["zero-plus"] = {"statement": "Theorem 1.2", "proof": "Section 2 paragraph 1, final sentence"}
        self.write(self.checks_path, checks)
        finished = writer.finish_delivery("paper", self.bundle, self.checks_path, read_inputs)
        self.assertEqual(finished, writer.verify_delivery("paper", self.bundle, read_inputs))
        self.assertEqual(finished, writer.finish_delivery("paper", self.bundle, self.checks_path, read_inputs))
        (self.bundle / "source/results.tex").write_text("Changed after review.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "sources have changed"):
            writer.verify_delivery("paper", self.bundle, read_inputs)

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("kpsewhich"), "MacTeX tools unavailable")
    def test_public_last_target_withdrawal_uses_preserved_evidence_without_snapshot(self):
        target, _ = self.public_input()
        withdrawal = self.task / "withdrawal.json"
        authorization = self.approval | {
            "snapshot_digest": None, "kind": "referee", "reason": "last-target-withdrawn",
            "withdrawal": {
                "targets": ["thm:positivity"], "counterexample": "$x=-1$",
                "evidence": "Substitute into the original Eq. (1)",
                "user_confirmation": "Synthetic user confirmation of the final target withdrawal.",
            },
        }
        self.write(withdrawal, authorization)
        read_inputs = lambda: writer.applicable_inputs("referee", target=target, withdrawal=withdrawal)
        tex = self.draft_document("referee", r"""
\paragraph{Version.} v2 (2024-01-02).
\paragraph{Finding.} The assertion (p. 1, equation (1)) that every real number is positive fails at $x=-1$.
\paragraph{Outcome.} The target statement was withdrawn.
""")
        candidate = writer.compile_delivery("referee", tex, self.bundle, "pdflatex", read_inputs)
        self.assertIsNone(candidate["snapshot_digest"])
        checks = self.self_check(
            candidate, scope="Only the original conclusion and counterexample are discussed.",
            findings={"F1": {"original_location": "page 1, Finding", "evidence": "page 1, Finding",
                             "affected_conclusion": "page 1, Finding"}},
            withdrawal="page 1, Outcome",
        )
        self.write(self.checks_path, checks)
        writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs)
        self.assertEqual(writer.verify_delivery("referee", self.bundle, read_inputs)["kind"], "referee")
        self.write(withdrawal, authorization | {"revoked": "Counterexample has a new material issue."})
        with self.assertRaisesRegex(writer.Rejected, "actual authorization"):
            writer.verify_delivery("referee", self.bundle, read_inputs)
        self.write(withdrawal, authorization)
        (self.task / "original.tex").write_text("Different version.", encoding="utf-8")
        with self.assertRaisesRegex(writer.Rejected, "bytes differ"):
            writer.verify_delivery("referee", self.bundle, read_inputs)

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("kpsewhich"), "MacTeX tools unavailable")
    def test_unresolved_cross_references_stop_delivery(self):
        tex = self.draft_document("paper", r"Reference to \ref{missing-label}.")
        read_inputs = lambda: writer.applicable_inputs("paper", self.main)
        with self.assertRaisesRegex(writer.Rejected, "cross-references"):
            writer.compile_delivery("paper", tex, self.bundle, "pdflatex", read_inputs)
        self.assertFalse(self.bundle.exists())


if __name__ == "__main__":
    unittest.main()
