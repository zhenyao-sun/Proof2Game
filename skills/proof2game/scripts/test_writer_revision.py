"""Synthetic unpublished revisions rendered with real TeX."""

from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pymupdf

import writer
import writer_revision


HEADER = r"""\documentclass{article}
\usepackage{amsmath}
\usepackage{xcolor}
\usepackage{hyperref}
\begin{document}
"""
FOOTER = "\\end{document}\n"
TEX = shutil.which("latexmk") and shutil.which("kpsewhich")


@unittest.skipUnless(TEX, "TeX tools unavailable")
class WriterRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="proof2game-writer-revision-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.bundle = self.root / "clean"
        self.source = self.bundle / "source"
        self.source.mkdir(parents=True)
        self.main = self.root / "snapshot.tex"
        self.baseline = self.root / "requested.tex"
        self.clean = self.bundle / "paper.pdf"

    def compile_clean(self, body, part=None):
        (self.source / "main.tex").write_text(HEADER + body + FOOTER, encoding="utf-8")
        if part:
            (self.source / "part.tex").write_text(part, encoding="utf-8")
        pdf = writer.run_latex(self.source, "main.tex", self.bundle / "render", "pdflatex")
        shutil.copyfile(pdf, self.clean)
        files = {name: writer.digest(data) for name, data in writer.source_files(self.source).items()}
        return {"entrypoint": "main.tex", "engine": "pdflatex", "pdf": "paper.pdf",
                "pdf_sha256": writer.digest(self.clean.read_bytes()), "source_digest": writer.record_digest(files)}

    def compare(self, receipt, **options):
        with (patch.object(writer, "verify_delivery", return_value=receipt),
              patch.object(writer, "applicable_inputs", return_value={"snapshot_digest": "synthetic-snapshot"})):
            return writer_revision.compare(self.main, self.bundle, self.baseline, **options)

    @unittest.skipUnless(shutil.which("latexdiff"), "latexdiff unavailable")
    def test_marks_additions_in_tex_and_retains_equations_and_citations(self):
        ending = r"""
Read equation~\eqref{eq:kept} and source~\cite{source}.
\begin{thebibliography}{1}
\bibitem{source} A reference.
\end{thebibliography}
"""
        self.baseline.write_text(HEADER + r"\textcolor{red}{Stable wording.} {\color{red} Kept phrase.} "
                                 + r"Discarded passage." + "\n"
                                 + r"\begin{equation}\label{eq:kept}x=1\end{equation}" + ending + FOOTER)
        receipt = self.compile_clean(r"\input{part}" + ending,
                                     r"Stable wording. Kept phrase. New material." + "\n"
                                     + r"\begin{equation}\label{eq:kept}x=2\end{equation}" + "\n")
        marked = self.compare(receipt)
        with pymupdf.open(marked) as document:
            page = document[0]
            spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            colored = "".join(span["text"] for span in spans if span["color"])
            black = "".join(span["text"] for span in spans if not span["color"])
            self.assertIn("New material", colored)
            self.assertTrue(any("x" in span["text"] and span["color"] for span in spans))
            self.assertIn("Stable wording. Kept phrase.", black)
            self.assertFalse(any("Discarded passage" in span["text"] for span in spans))
            self.assertIn("Read equation (1) and source [1].", page.get_text())
            self.assertFalse(page.first_annot)
            self.assertTrue(page.get_links())
        record = writer.read_record(self.bundle / "comparison" / "comparison.json")
        self.assertEqual(record["baseline_sha256"], writer.digest(self.baseline.read_bytes()))
        self.assertEqual(record["method"], "latexdiff-tex")
        self.assertEqual(self.compare(receipt), marked)
        self.baseline.write_text(self.baseline.read_text() + "% Changed designated baseline.")
        with self.assertRaisesRegex(writer.Rejected, "different inputs"):
            self.compare(receipt)

    def test_manual_markup_requires_the_same_visible_content(self):
        receipt = self.compile_clean("Visible clean paper.\n")
        self.baseline = self.root / "requested.txt"
        self.baseline.write_text("Visible old paper.")
        manual = self.root / "manual" / "main.tex"
        manual.parent.mkdir()
        manual.write_text(HEADER + r"Visible \textcolor{blue}{extra} clean paper." + "\n" + FOOTER)
        with self.assertRaisesRegex(writer.Rejected, "clean paper's visible text"):
            self.compare(receipt, marked_tex=manual)
        self.assertFalse((self.bundle / "comparison").exists())
        manual.write_text(HEADER + r"Visible \textcolor{blue}{clean} paper." + "\n" + FOOTER)
        marked = self.compare(receipt, marked_tex=manual)
        archived_source = marked.parent / "source" / "main.tex"
        self.assertEqual(archived_source.read_bytes(), manual.read_bytes())
        archived_source.write_text("Tampered marked source.")
        with self.assertRaisesRegex(writer.Rejected, "Marked TeX differs"):
            self.compare(receipt, marked_tex=manual)

    @unittest.skipUnless(shutil.which("latexdiff"), "latexdiff unavailable")
    def test_generated_marked_tex_can_be_the_next_baseline(self):
        self.baseline.write_text(HEADER + "Stable wording. Old draft.\n" + FOOTER)
        receipt = self.compile_clean("Stable wording. Intermediate discovery.\n")
        self.baseline = self.compare(receipt).parent / "source" / "main.tex"
        self.assertIn(r"\DIFadd{Intermediate discovery", self.baseline.read_text())

        self.bundle = self.root / "next"
        self.source = self.bundle / "source"
        self.source.mkdir(parents=True)
        self.clean = self.bundle / "paper.pdf"
        receipt = self.compile_clean("Stable wording. Intermediate discovery. Later improvement.\n")
        marked = self.compare(receipt)
        with pymupdf.open(marked) as document:
            spans = [span for block in document[0].get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            colored = "".join(span["text"] for span in spans if span["color"])
            black = "".join(span["text"] for span in spans if not span["color"])
            self.assertIn("Later improvement.", colored)
            self.assertNotIn("Intermediate", colored)
            self.assertIn("Intermediate discovery.", black)

    def test_non_tex_baseline_needs_a_checked_view_or_manual_tex(self):
        receipt = self.compile_clean("Visible clean paper.\n")
        self.baseline = self.root / "requested.txt"
        self.baseline.write_text("Visible old paper.")
        with self.assertRaisesRegex(writer.Rejected, "checked --baseline-view"):
            self.compare(receipt)
