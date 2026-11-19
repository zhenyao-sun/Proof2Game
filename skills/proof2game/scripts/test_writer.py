"""Focused Writer regressions using synthetic math, real TeX builds and Markdown rendering."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

import manuscript
import referee_markdown
import writer
import writer_revision


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
        bindings = ("input_digest", "source_digest", "pdf_sha256")
        if candidate["schema"] == 3:
            bindings = ("input_digest", "artifact_sha256")
            extra = {
                "openings": {key: paragraph.partition(". ")[0].rstrip(".") + "."
                             for key, paragraph in candidate["opening_paragraphs"].items()},
                "opening_judgment": "Read the contribution and the mathematical appraisal independently.",
                "italics": "Compared the original excerpts with the Markdown preview.",
                **extra,
            }
            extra["openings"]["major_count"] = candidate["issue_counts"]["major"]
        return {
            **{key: candidate[key] for key in bindings},
            "worker_session": "synthetic-test-session",
            "model": "gpt-6.2-sol", "effort": "ultra",
            "render": "Synthetic test evidence, PDF page 1.",
            "references": "Synthetic test evidence, references checked with stable TeX labels.",
            "humanizer": "Synthetic comparison: removed repeated wording and retained the identity's quantifier.",
            **extra,
        }

    def referee_document(self, summary, assessment, major, minor):
        path = self.draft / "referee.md"
        sections = zip(referee_markdown.SECTIONS, (summary, assessment, major, minor))
        path.write_text("# Referee report\n\n" + "\n\n".join(f"## {h}\n\n{body}" for h, body in sections))
        return path

    def test_paper_inspect_lists_only_sources_cited_in_the_snapshot(self):
        (self.snapshot / "proof.tex").write_text(r"Use \cite{alpha,beta}. % \cite{comment}")
        main = self.main.read_text().replace(r"\section{Main Results}", r"\cite{intro}\section{Main Results}")
        self.main.write_text(main.replace(r"\end{document}", r"""
\begin{bibdiv}\begin{biblist}
\bib{unused}{article}{title={A reference to \cite{unused-source}}}
\end{biblist}\end{bibdiv}\end{document}"""))
        clean, _ = manuscript.parse(self.main)
        self.write(self.approval_path, self.approval | {"snapshot_digest": clean["snapshot_digest"]})
        with redirect_stdout(StringIO()) as output:
            self.assertEqual(writer.main(["inspect", "--kind", "paper", "--main", str(self.main)]), 0)
        inspected = json.loads(output.getvalue())
        self.assertEqual(inspected["cited_keys"], ["alpha", "beta", "intro"])
        guide = inspected["writing_guide"]
        self.assertEqual(guide["id"], "blader/humanizer@v4.0.0")
        self.assertEqual(writer.digest(Path(guide["path"]).read_bytes()), guide["sha256"])

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("kpsewhich"), "TeX tools unavailable")
    def test_revision_uses_checked_clean_paper_and_actual_comparison_content(self):
        import pymupdf

        def checked_bundle(name, body):
            bundle = self.task / name
            tex = self.draft_document("paper", body)
            read_inputs = lambda: writer.applicable_inputs("paper", self.main)
            candidate = writer.compile_delivery("paper", tex, bundle, "pdflatex", read_inputs)
            self.write(self.checks_path, self.self_check(candidate, fidelity="Synthetic comparison fixture.",
                       targets={key: {"statement": "p. 1", "proof": "p. 1"} for key in self.snap["targets"]}))
            writer.finish_delivery("paper", bundle, self.checks_path, read_inputs)
            return bundle

        def words_and_marks(path):
            with pymupdf.open(path) as doc:
                words, marked = [], []
                for page in doc:
                    boxes = [annot.rect for annot in page.annots()]
                    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
                        words.append(word)
                        if any(((x0 + x1) / 2, (y0 + y1) / 2) in box for box in boxes):
                            marked.append(word)
                return words, marked

        previous = checked_bundle("previous", r"Shared obsolete lemma.\newpage Second page.")
        current = checked_bundle("current", r"Shared improved lemma.\newpage Second page.")
        snapshot_files = writer.source_files(self.snapshot)
        old_pdf = (previous / "paper.pdf").read_bytes()
        clean_pdf = (current / "paper.pdf").read_bytes()
        expected_words, clean_marks = words_and_marks(current / "paper.pdf")
        self.assertEqual(clean_marks, [])
        marked = writer_revision.compare(self.main, previous, current)
        self.assertEqual(words_and_marks(marked), (expected_words, ["improved"]))
        self.assertEqual(writer_revision.compare(self.main, previous, current), marked)

        # A collaborator already made the same edit and applied color to it.
        external = self.task / "collaborator.pdf"
        with pymupdf.open(marked) as document:
            document.save(external)
        another = self.task / "another"
        shutil.copytree(current, another, ignore=shutil.ignore_patterns("comparison"))
        selected = writer_revision.compare(self.main, previous, another, external)
        self.assertEqual(words_and_marks(selected), (expected_words, []))
        self.assertEqual((previous / "paper.pdf").read_bytes(), old_pdf)
        self.assertEqual((current / "paper.pdf").read_bytes(), clean_pdf)
        self.assertEqual(writer.source_files(self.snapshot), snapshot_files)
        with self.assertRaisesRegex(writer.Rejected, "different inputs"):
            writer_revision.compare(self.main, previous, another)

        # The next round starts from the most recent clean delivery.
        following = checked_bundle("following", r"improved lemma.\newpage Second page.")
        removed = writer_revision.compare(self.main, current, following)
        self.assertNotIn("Shared", words_and_marks(removed)[0])
        self.assertEqual(words_and_marks(removed)[1], [])

        # The designated source file stays bound even when its colored TeX
        # is compared through a checked plain-text rendition.
        converted = self.task / "converted"
        shutil.copytree(current, converted, ignore=shutil.ignore_patterns("comparison"))
        original = self.task / "edited.tex"
        original.write_text(r"Shared \textcolor{red}{improved} lemma.\newpage Second page.")
        rendition = self.task / "visible.txt"
        rendition.write_text(" ".join(expected_words))
        marked_view = writer_revision.compare(self.main, previous, converted, original, rendition)
        self.assertEqual(words_and_marks(marked_view), (expected_words, []))
        original.write_text("Later external version.")
        with self.assertRaisesRegex(writer.Rejected, "different inputs"):
            writer_revision.compare(self.main, previous, converted, original, rendition)
        selected.write_bytes(b"damaged")
        with self.assertRaisesRegex(writer.Rejected, "Invalid compiled PDF"):
            writer_revision.compare(self.main, previous, another, external)
        self.public_input()
        with self.assertRaisesRegex(writer.Rejected, "unpublished"):
            writer_revision.compare(self.main, previous, current)

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

    def test_public_comparison_without_findings_binds_both_inputs_and_the_markdown(self):
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
        md = self.referee_document("Version v2 gives the two additive identities.",
                                    "The use of commutativity makes the second argument easy to follow.",
                                    "No major issues.", "No minor issues.")
        with redirect_stdout(StringIO()) as output:
            result = writer.main(["prepare", "--kind", "referee", "--main", str(self.main), "--target", str(target),
                                  "--markdown", str(md), "--bundle", str(self.bundle)])
        self.assertEqual(result, 0)
        candidate = json.loads(output.getvalue())
        self.assertEqual((self.bundle / "referee.md").read_bytes(), md.read_bytes())
        comparison = {"plus-zero": {"original": "line 1, first identity", "script": "target.tex and proof.tex",
                                    "report": "p. 1, Assessment"}}
        checks = self.self_check(candidate, scope="Both results were compared with the original.",
                                 comparison=comparison, findings={}, issues={"major": [], "minor": []},
                                 diagnosis_only="Both lists explicitly record that there are no issues.")
        self.write(self.checks_path, checks)
        with self.assertRaisesRegex(writer.Rejected, "Compare every approved target"):
            writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs)
        comparison["zero-plus"] = {"original": "line 1, second identity", "script": "other.tex and other-proof.tex",
                                   "report": "p. 1, Assessment"}
        self.write(self.checks_path, checks)
        finished = writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs)
        self.assertEqual(finished, writer.verify_delivery("referee", self.bundle, read_inputs))
        self.assertEqual(finished, writer.finish_delivery("referee", self.bundle, self.checks_path, read_inputs))
        (self.bundle / "referee.md").write_bytes(md.read_bytes() + b"\nChanged.")
        with self.assertRaisesRegex(writer.Rejected, "Markdown file has changed"):
            writer.verify_delivery("referee", self.bundle, read_inputs)
        (self.bundle / "referee.md").write_bytes(md.read_bytes())
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
        authorization["report_findings"][0]["confirmed_revision"] = {
            "new_conclusion": "A strictly smaller set of reals meets the property.",
            "user_confirmation": "Verified revision in synthetic private approval.",
        }
        self.write(withdrawal, authorization)
        read_inputs = lambda: writer.applicable_inputs("referee", target=target, withdrawal=withdrawal)
        md = self.referee_document("Version v2 makes a claim about positive real numbers.",
                                   "One major issue invalidates the claim in equation (1).",
                                   "1. Page 1, equation (1).\n\n   > *Every real is positive.*\n\n"
                                   "   The real number $-1$ is negative.", "No minor issues.")
        candidate = writer.prepare_report(md, self.bundle, read_inputs)
        self.assertIsNone(candidate["snapshot_digest"])
        checks = self.self_check(
            candidate, scope="Only the original conclusion and counterexample are discussed.",
            findings={"F1": {"original_location": "page 1, Finding", "evidence": "page 1, Finding",
                             "affected_conclusion": "page 1, Finding"}},
            withdrawal="page 1, Major Issues, item 1",
            diagnosis_only="The report contains the failing real number and leaves the verified repair private.",
            issues={"major": [{"location": "p. 1, equation (1)", "quotation": "every real is positive",
                               "problem": "The assertion fails at -1."}], "minor": []},
        )
        for missing in ("humanizer", "diagnosis_only", "issues", "openings", "opening_judgment", "italics"):
            with self.subTest(missing=missing), self.assertRaises(writer.Rejected):
                writer.check_evidence({k: v for k, v in checks.items() if k != missing}, read_inputs(), candidate)
        for invalid in ({"major": [], "minor": []}, {"major": [{"location": "p. 1"}], "minor": []}):
            with self.subTest(invalid=invalid), self.assertRaises(writer.Rejected):
                writer.check_evidence(checks | {"issues": invalid}, read_inputs(), candidate)
        for conflict in ({"major_count": 2}, {"summary": "The paper gives a result."}):
            with self.subTest(conflict=conflict), self.assertRaises(writer.Rejected):
                writer.check_evidence(checks | {"openings": checks["openings"] | conflict}, read_inputs(), candidate)
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

    def test_visible_referee_sections_have_text_and_follow_the_required_order(self):
        target, _ = self.public_input()
        read_inputs = lambda: writer.applicable_inputs("referee", self.main, target)
        md = self.referee_document("First.", "", "A major issue.", "No minor issues.")
        with self.assertRaisesRegex(ValueError, "Empty referee section: Assessment"):
            writer.prepare_report(md, self.bundle, read_inputs)
        md = self.referee_document("First.", "Second.", "Third.", "Fourth.")
        md.write_text(md.read_text().replace("## Summary", "## First"))
        with self.assertRaisesRegex(ValueError, "in order"):
            writer.prepare_report(md, self.bundle, read_inputs)

    def test_quote_styling_in_lists_and_elsewhere_in_the_report(self):
        for quote in ('"a naked quotation"', '“*partly* italic”', '> $x = 0$', '> *The equality* $x=0$.'):
            with self.subTest(quote=quote), self.assertRaisesRegex(ValueError, "Italicize"):
                md = self.referee_document("The passage reads\n\n" + quote, "Assessment.", "None.", "None.")
                referee_markdown.inspect(md.read_bytes())
        md = self.referee_document('The paper uses *“a short phrase”*.', 'One major issue affects the result.',
                                   '1. Equation (1).\n\n   > *$x=0$*\n\n   A counterexample exists.', 'None.')
        self.assertEqual(referee_markdown.inspect(md.read_bytes())["issue_counts"], {"major": 1, "minor": 0})
        for sentence, expected in (("Two major issues invalidate the first claim.", 1),
                                   ("The proof has an interesting structure.", 2)):
            self.assertFalse(referee_markdown.count_matches(sentence, expected))
        self.assertTrue(referee_markdown.count_matches("Twenty-one major issues undermine the estimate.", 21))
        self.assertTrue(referee_markdown.is_opening("Eq. (1) states the claim. Further details follow.",
                                                    "Eq. (1) states the claim."))
        displaced = "The paper is interesting. Two major issues undermine the proof."
        self.assertFalse(referee_markdown.is_opening(displaced, displaced))

    def test_legacy_checked_referee_pdfs_verify(self):
        from test_intake import make_pdf

        target, _ = self.public_input()
        inputs = writer.applicable_inputs("referee", self.main, target)
        for schema in (1, 2):
            with self.subTest(schema=schema):
                bundle = self.task / f"sealed-v{schema}"
                source = bundle / "source"
                source.mkdir(parents=True)
                (source / "main.tex").write_text(r"\documentclass{article}\begin{document}Report.\end{document}")
                make_pdf(bundle / "referee.pdf")
                manifest = {k: writer.digest(v) for k, v in writer.source_files(source).items()}
                candidate = {"schema": schema, "kind": "referee", "snapshot_digest": inputs["snapshot_digest"],
                             "input_digest": writer.record_digest(inputs), "source_files": manifest,
                             "source_digest": writer.record_digest(manifest), "entrypoint": "main.tex",
                             "pdf": "referee.pdf", "pdf_sha256": writer.digest((bundle / "referee.pdf").read_bytes())}
                checks = self.self_check(candidate, scope="Original compared.", findings={"F1": {
                    "original_location": "p. 1", "evidence": "p. 1", "affected_conclusion": "p. 1"}})
                if schema == 1:
                    checks.pop("humanizer")
                else:
                    candidate["humanizer"] = writer.HUMANIZER
                    checks.update(diagnosis_only="Diagnosis checked.", issues={"major": [
                        {"location": "eq. 1", "quotation": "positive", "problem": "Negative reals."}], "minor": []})
                self.write(bundle / "candidate.json", candidate)
                self.write(bundle / "receipt.json", candidate | {"checks": checks})
                self.assertEqual(writer.verify_delivery("referee", bundle, lambda: inputs)["schema"], schema)


if __name__ == "__main__":
    unittest.main()
