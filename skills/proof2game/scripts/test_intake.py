import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import intake


def make_pdf(path):
    """Create a legible two-page PDF with page labels and an embedded text layer."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 420] /Resources 5 0 R /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 420] /Resources 5 0 R /Contents 7 0 R >>",
        b"<< /Font << /F1 8 0 R >> >>",
        *[
            b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"
            for data in (b"BT /F1 18 Tf 40 380 Td (Page one: 1 + 1 = 2.) Tj ET",
                         b"BT /F1 18 Tf 40 380 Td (Page two: 2 + 2 = 4.) Tj ET")
        ],
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    content = b"%PDF-1.4\n"
    offsets = []
    for number, item in enumerate(objects, 1):
        offsets.append(len(content))
        content += b"%d 0 obj\n" % number + item + b"\nendobj\n"
    xref = len(content)
    entries = b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    content += b"xref\n0 9\n0000000000 65535 f \n" + entries
    content += b"trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref
    path.write_bytes(content)


def source_data(public_date="2025-01-05", edition="preprint", version="v1"):
    return {
        "work_key": "study", "title": "A synthetic study", "authors": ["Synthetic Author"],
        "public_date": public_date, "version": version, "edition": edition,
        "source_url": "https://example.org/study", "publication_evidence": "Synthetic source metadata",
    }


class IntakeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def test_cli_preserves_original_bytes_on_authoring_host(self):
        source = self.project / "notes.md"
        original = "# 数学笔记\r\n".encode("utf-8")
        source.write_bytes(original)
        command = [sys.executable, str(Path(intake.__file__)), str(self.project)]
        subprocess.run([*command, "init-git"], capture_output=True, check=True)
        result = subprocess.run(
            [*command, "init-target", "-"],
            input=json.dumps({"input": str(source), "project_type": "unpublished"}),
            capture_output=True, text=True, check=True,
        )
        receipt = json.loads(result.stdout)
        self.assertEqual((Path(receipt["directory"]) / "original.md").read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)

    def target(self, public_date="2025-01-15", version="v2"):
        path = self.project / "note.md"
        path.write_text("# 原始稿件\n")
        return intake.init_target(self.project, {
            "input": str(path), "project_type": "public", "version": version,
            "public_date": public_date, "source_url": "https://example.org/note",
            "publication_evidence": "Synthetic publisher record",
        })

    def test_exact_versions_get_distinct_folders_and_keep_original(self):
        first = self.target(version="v1")
        second = self.target(version="v2")
        self.assertNotEqual(first["directory"], second["directory"])
        self.assertEqual(Path(first["directory"]).parent, self.project / ".proof2game")
        self.assertEqual(first["cutoff"], "2025-01-15")
        self.assertEqual(Path(first["directory"], first["original_path"]).read_bytes(), "# 原始稿件\n".encode())
        self.assertEqual(first["directory"], self.target(version="v1")["directory"])
        with self.assertRaisesRegex(ValueError, "exact saved target"):
            intake.cutoff_for(self.project, {"task_id": first["id"], "cutoff": "2025-01-16"})

    def test_existing_target_and_source_decisions_stay_in_legacy_directory(self):
        first = self.target(version="v1")
        modern = Path(first["directory"])
        legacy = self.project / ".mathgrove" / first["id"]
        modern.parent.rename(legacy.parent)
        initial_receipt = (legacy / "target.json").read_bytes()
        with intake.lock(self.project):
            repeated = self.target(version="v1")
            self.assertEqual(Path(repeated["directory"]), legacy)
            self.assertEqual(intake.resolve_task_path(modern), legacy)
            intake.record_unavailable(self.project, {"task_id": first["id"], "work_key": "original-work",
                                                      "resolution": "waived_optional", "reason": "User waiver"})
        self.assertTrue((legacy.parent / "intake.lock").is_file())
        self.assertFalse(modern.parent.exists())
        self.assertEqual((legacy / "target.json").read_bytes(), initial_receipt)
        self.assertTrue((legacy / "unavailable-sources" / "original-work.json").is_file())
        with intake.lock(self.project):
            new = self.target(version="v2")
        self.assertEqual(Path(new["directory"]).parent, modern.parent)
        self.assertEqual(intake.record_path(self.project, "target", first["id"]), legacy / "target.json")
        self.assertFalse((modern.parent / "intake.lock").exists())

    def test_duplicate_saved_ids_stop_without_overwriting_either_receipt(self):
        first = self.target(version="v1")
        modern = Path(first["directory"])
        legacy = self.project / ".mathgrove" / first["id"]
        shutil.copytree(modern, legacy)
        with self.assertRaisesRegex(ValueError, "exists in both work directories"):
            self.target(version="v1")
        with self.assertRaisesRegex(ValueError, "exists in both work directories"):
            intake.resolve_task_path(modern)
        self.assertEqual((modern / "target.json").read_bytes(), (legacy / "target.json").read_bytes())

    def test_shared_references_use_old_lock_and_preserve_existing_modern_lock(self):
        paths = [self.project / namespace / "intake.lock" for namespace in (".proof2game", ".mathgrove")]
        with intake.lock(self.project):
            self.assertTrue(paths[0].exists())
            self.assertFalse(paths[1].parent.exists())
        paths[1].parent.mkdir()
        with intake.lock(self.project):
            for path in paths:
                with self.subTest(path=path), path.open("a+b") as contender:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_arxiv_edition_pin(self):
        self.assertEqual(intake.arxiv_link("https://arxiv.org/pdf/2501.01234v2.pdf"),
                         {"arxiv_id": "2501.01234", "requested_version": "v2"})
        self.assertEqual(intake.arxiv_link("https://arxiv.org/abs/math/0301234")["arxiv_id"], "math/0301234")
        self.assertEqual(intake.arxiv_link("https://arxiv.org/html/2601.01234v1")["requested_version"], "v1")
        with self.assertRaisesRegex(ValueError, "exact requested"):
            intake.public_target({
                "version": "v2", "public_date": "2025-01-15",
                "publication_evidence": "Synthetic arXiv submission history",
                "arxiv_link": "https://arxiv.org/abs/2501.01234v1",
                "source_url": "https://arxiv.org/pdf/2501.01234v2",
            }, ".pdf")

    @unittest.skipUnless(shutil.which("git"), "Git is required")
    def test_initialize_git_once_without_staging_originals(self):
        self.assertTrue(intake.init_git(self.project)["created"])
        self.assertFalse(intake.init_git(self.project)["created"])
        self.assertEqual(intake.git(self.project, "diff", "--cached", "--name-only").stdout, "")

    def test_cutoff_precedes_published_preference_and_optional_wait_reuses_resolution(self):
        target = self.target()
        request = {"task_id": target["id"], "work_key": "study"}
        self.assertEqual(intake.choose_source(self.project, request)["state"], "check_publication")
        intake.record_publication(self.project, {
            **request, "checked_at": "2025-04-01", "status": "checked",
            "evidence": "Synthetic landing pages and submission history",
            "candidates": [source_data(), source_data("2025-02-01", "published", "journal")],
        })
        selected = intake.choose_source(self.project, request)
        self.assertEqual((selected["state"], selected["source"]["edition"]), ("need_pdf", "preprint"))
        intake.record_unavailable(self.project, {**request, "required": False,
                                  "resolution": "waived_optional", "reason": "User waived optional reuse"})
        self.assertEqual(intake.choose_source(self.project, {**request, "required": False})["state"], "optional_skip")
        self.assertEqual(intake.choose_source(self.project, request)["state"], "need_pdf")
        intake.record_unavailable(self.project, {**request, "required": True,
                                  "resolution": "unobtainable", "reason": "User cannot get this copy"})
        self.assertEqual(intake.choose_source(self.project, request)["state"], "required_unobtainable")
        self.assertEqual(intake.choose_source(self.project, {
            **request, "preferred_version": "journal",
        })["state"], "no_eligible_version")

    def test_eligible_formal_version_is_not_silently_replaced(self):
        target = self.target()
        request = {"task_id": target["id"], "work_key": "study"}
        intake.record_publication(self.project, {
            **request, "checked_at": "2025-04-01", "status": "checked",
            "evidence": "Synthetic version history",
            "candidates": [source_data(), source_data("2025-01-09", "published", "journal")],
        })
        outcome = intake.choose_source(self.project, request)
        self.assertEqual((outcome["state"], outcome["source"]["edition"]), ("need_pdf", "published"))
        explicit = intake.choose_source(self.project, {**request, "preferred_version": "v1"})
        self.assertEqual((explicit["state"], explicit["source"]["edition"]), ("need_pdf", "preprint"))

    def test_reference_period_must_establish_eligibility(self):
        month = source_data("2024-02", "published", "journal")
        preprint = source_data("2023", "preprint", "v1")
        for cutoff, expected in (("2023-12-31", "need_pdf"), ("2024-02-01", "check_publication"),
                                 ("2024-02-29", "need_pdf")):
            with self.subTest(cutoff=cutoff):
                request = {"work_key": "study", "cutoff": cutoff}
                intake.record_publication(self.project, {
                    **request, "checked_at": "2025-01-01", "status": "checked",
                    "evidence": "Synthetic journal dating by month and year", "candidates": [preprint, month],
                })
                outcome = intake.choose_source(self.project, request)
                self.assertEqual(outcome["state"], expected)
                if expected == "need_pdf":
                    self.assertEqual(outcome["source"]["public_date"], "2023" if cutoff < "2024" else "2024-02")
                else:
                    self.assertEqual(outcome["uncertain_candidates"][0]["public_date"], "2024-02")
        with self.assertRaises(ValueError):
            self.target(public_date="2024-02")
        with self.assertRaises(ValueError):
            intake.candidate(source_data("2024-13"))

    @unittest.skipUnless(shutil.which("pdfinfo") and shutil.which("pdftoppm"), "Poppler is required")
    def test_pdf_images_ocr_resume_reference_binding_and_cutoff(self):
        target = self.target()
        original = self.project / "study.pdf"
        make_pdf(original)
        ref = intake.register_reference(self.project, {**source_data("2024-12"), "pdf": str(original)})
        key = {"kind": "reference", "id": ref["id"]}
        self.assertEqual(ref["pending_pages"], [1, 2])
        rendered = [intake.render_page(self.project, {**key, "page": n}) for n in (1, 2)]
        self.assertNotEqual(rendered[0]["image_sha256"], rendered[1]["image_sha256"])
        self.assertEqual(Path(rendered[0]["image_path"]).read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        for image in rendered:
            n = image["page"]
            row = {**key, "page": n, "image_sha256": image["image_sha256"], "reviewer": "synthetic test",
                   "markdown": f"Page {n}: ${n}+{n}={n+n}$", "uncertainties": [], "method": "codex_pdf_image_ocr"}
            with self.assertRaisesRegex(ValueError, "actual rendered"):
                intake.record_page(self.project, {**row, "image_sha256": "wrong"})
            self.assertEqual(intake.record_page(self.project, row), intake.record_page(self.project, row))
            if n == 1:
                with self.assertRaisesRegex(ValueError, "page 2"):
                    intake.finish_ocr(self.project, key)
        completed = intake.finish_ocr(self.project, key)
        self.assertTrue(completed["complete"])
        self.assertEqual(completed["sha256"], hashlib.sha256(original.read_bytes()).hexdigest())
        self.assertEqual(intake.finish_ocr(self.project, key), completed)
        self.assertEqual(Path(completed["directory"], completed["pdf_path"]).read_bytes(), original.read_bytes())
        self.assertIn("## PDF page 2", Path(completed["directory"], completed["sidecar_path"]).read_text())
        bound = {"id": ref["id"], "sha256": completed["sha256"],
                 "cited_locations_physical_pages": {"Equation": [2]}}
        binding = intake.verify_citations(self.project, {"task_id": target["id"], "sources": [bound]})
        self.assertEqual(binding["sources"][0]["cited_locations_physical_pages"], {"Equation": [2]})
        too_early = self.target(public_date="2024-01-01")
        with self.assertRaisesRegex(ValueError, "published after"):
            intake.verify_citations(self.project, {"task_id": too_early["id"], "sources": [bound]})
        same_month = self.target(public_date="2024-12-10")
        with self.assertRaisesRegex(ValueError, "does not establish eligibility"):
            intake.verify_citations(self.project, {"task_id": same_month["id"], "sources": [bound]})
        with self.assertRaisesRegex(ValueError, "physical pages"):
            intake.verify_citations(self.project, {"task_id": target["id"], "sources": [
                {**bound, "cited_locations_physical_pages": {"Equation": [3]}},
            ]})

    def test_existing_target_id_rejects_changed_source_url(self):
        first = self.target()
        request = {"id": first["id"], "input": str(self.project / "note.md"), "project_type": "public",
                   "version": first["version"], "public_date": first["public_date"],
                   "source_url": "https://example.org/a-different-source",
                   "publication_evidence": "Synthetic publisher record"}
        with self.assertRaisesRegex(ValueError, "different original, version, or source"):
            intake.init_target(self.project, request)
        self.assertEqual(intake.checked_record(self.project, "target", first["id"])["source_url"],
                         first["source_url"])

    @unittest.skipUnless(shutil.which("pdfinfo"), "Poppler is required")
    def test_failed_reference_reuse_leaves_no_original_that_blocks_retry(self):
        original = self.project / "first.pdf"
        make_pdf(original)
        second = self.project / "second.pdf"
        second.write_bytes(original.read_bytes() + b"\\n% different PDF fixture\\n")
        info = source_data()
        target = intake.init_target(self.project, {
            "input": str(original), "project_type": "public",
            **{key: info[key] for key in ("version", "public_date", "source_url", "publication_evidence")},
        })
        reference = {**info, "id": "fixture", "pdf": str(original)}
        with self.assertRaisesRegex(ValueError, "exact completed public target"):
            intake.register_reference(self.project, {**reference, "reuse_target": target["id"]})
        self.assertFalse((self.project / "references" / "fixture").exists())
        retry = intake.register_reference(self.project, {**reference, "pdf": str(second)})
        self.assertEqual(Path(retry["directory"], retry["pdf_path"]).read_bytes(), second.read_bytes())
        with self.assertRaisesRegex(ValueError, "different original, version, or source"):
            intake.register_reference(self.project, {**reference, "pdf": str(second),
                                                     "source_url": "https://example.org/other-version"})

    @unittest.skipUnless(shutil.which("pdfinfo"), "Poppler is required")
    def test_target_pdf_cannot_be_used_before_ocr(self):
        original = self.project / "unpublished.pdf"
        make_pdf(original)
        target = intake.init_target(self.project, {"input": str(original), "project_type": "unpublished"})
        self.assertFalse(target["complete"])
        self.assertIsNone(target["proof_source_path"])
        self.assertEqual(target["pending_pages"], [1, 2])


if __name__ == "__main__":
    unittest.main()
