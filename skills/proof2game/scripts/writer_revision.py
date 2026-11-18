#!/usr/bin/env python3
"""Compare the checked clean Writer revision with the selected manuscript."""

import argparse
from difflib import SequenceMatcher
import json
from pathlib import Path
import sys
import tempfile
import unicodedata

import writer


def pdf_words(document):
    """Read visible text positions without interpreting color or annotations."""
    return [(page.number, word) for page in document for word in page.get_text("words", sort=True)]


def mark_changes(clean, baseline, baseline_suffix, output):
    try:
        import pymupdf
    except ImportError as error:
        raise writer.Rejected("Install PyMuPDF in the Writer comparison environment.") from error

    if baseline_suffix == ".pdf":
        with pymupdf.open(stream=baseline, filetype="pdf") as old:
            before = [word[4] for _, word in pdf_words(old)]
            writer.require(before, "Supply a checked text rendition for an image-only baseline.")
    else:
        writer.require(baseline_suffix == ".txt", "Supply --baseline-view with rendered PDF or UTF-8 text.")
        before = baseline.decode("utf-8-sig").split()

    with pymupdf.open(stream=clean, filetype="pdf") as document:
        words = pdf_words(document)
        writer.require(words, "The clean Writer PDF has no extractable words.")
        def normalize(word):
            return unicodedata.normalize("NFKC", word)

        matcher = SequenceMatcher(None, [normalize(word) for word in before],
                                  [normalize(word[4]) for _, word in words])
        # Keep separated lines and pages as distinct highlights. Deletions
        # have an empty new span and never contribute content to the PDF.
        for operation, _, _, start, end in matcher.get_opcodes():
            if operation not in ("replace", "insert"):
                continue
            lines = {}
            for page_number, word in words[start:end]:
                line = (page_number, word[5], word[6])
                box = pymupdf.Rect(word[:4])
                if line in lines:
                    lines[line] |= box
                else:
                    lines[line] = box
            for (page_number, _, _), box in lines.items():
                document[page_number].add_highlight_annot(box)
        document.save(output)


def compare(main, previous, bundle, baseline=None, baseline_view=None, previous_main=None):
    previous, bundle = previous.resolve(strict=True), bundle.resolve(strict=True)
    writer.require(previous != bundle, "Use separate bundles for successive official papers.")
    writer.require(baseline is not None or baseline_view is None, "Identify the original --baseline for its view.")
    baseline = baseline if baseline is not None else previous / "paper.pdf"
    view = baseline_view if baseline_view is not None else baseline

    def bindings():
        inputs = writer.applicable_inputs("paper", main)
        prior_inputs = writer.applicable_inputs("paper", previous_main) if previous_main else inputs
        old = writer.verify_delivery("paper", previous, lambda: prior_inputs)
        new = writer.verify_delivery("paper", bundle, lambda: inputs)
        return {"snapshot_digest": inputs["snapshot_digest"], "previous_snapshot_digest": old["snapshot_digest"],
                "previous_pdf_sha256": old["pdf_sha256"],
                "clean_pdf_sha256": new["pdf_sha256"], "baseline_sha256": writer.digest(baseline.read_bytes()),
                "baseline_view_sha256": writer.digest(view.read_bytes())}

    bound = bindings()
    output = bundle / "comparison"
    pdf = "paper-marked.pdf"

    def checked_result():
        record = writer.read_record(output / "comparison.json")
        writer.require(all(record.get(k) == v for k, v in bound.items()),
                       "Existing comparison used different inputs. Use a new revision bundle.")
        writer.require(record.get("marked_sha256") == writer.digest(writer.pdf_bytes(output / pdf)),
                       "Marked PDF differs from its comparison record.")
        return output / pdf

    if output.exists():
        return checked_result()
    clean = writer.pdf_bytes(bundle / "paper.pdf")
    view_bytes = view.read_bytes()
    writer.require(writer.digest(clean) == bound["clean_pdf_sha256"] and
                   writer.digest(view_bytes) == bound["baseline_view_sha256"], "Comparison inputs changed.")
    with tempfile.TemporaryDirectory(dir=bundle, prefix=".comparison-") as tmp:
        staged = Path(tmp) / "comparison"
        staged.mkdir()
        mark_changes(clean, view_bytes, view.suffix.lower(), staged / pdf)
        writer.write_record(staged / "comparison.json", bound | {"marked_sha256": writer.digest(writer.pdf_bytes(staged / pdf))})
        writer.require(bindings() == bound, "Comparison inputs changed during markup.")
        try:
            staged.rename(output)
        except OSError:
            if not output.is_dir():
                raise
    return checked_result()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main", type=Path, required=True, help="Approved unpublished snapshot main.tex")
    parser.add_argument("--previous-main", type=Path, help="Archived approval entrypoint if the prior paper used a different snapshot")
    parser.add_argument("--previous", type=Path, required=True, help="Previous official Writer bundle")
    parser.add_argument("--bundle", type=Path, required=True, help="New checked clean Writer bundle")
    parser.add_argument("--baseline", type=Path, help="User-selected comparison file")
    parser.add_argument("--baseline-view", type=Path, help="Checked PDF or text rendition of the selected file")
    args = parser.parse_args(argv)
    try:
        marked = compare(args.main, args.previous, args.bundle, args.baseline, args.baseline_view, args.previous_main)
        print(json.dumps({"marked": str(marked)}, ensure_ascii=False))
    except (ValueError, OSError, RuntimeError, KeyError) as error:
        print(f"Writer comparison: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
