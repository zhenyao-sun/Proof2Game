#!/usr/bin/env python3
"""Compile an additions-only TeX comparison against an explicitly selected baseline."""

import argparse
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

import manuscript
import writer


ADDITION_PREAMBLE = r"""
\RequirePackage{xcolor}
\DeclareRobustCommand{\DIFadd}[1]{\textcolor{blue!65!black}{#1}}
\providecommand{\DIFdel}[1]{}
\providecommand{\DIFaddbegin}{}
\providecommand{\DIFaddend}{}
\providecommand{\DIFdelbegin}{}
\providecommand{\DIFdelend}{}
\providecommand{\DIFaddFL}[1]{\DIFadd{#1}}
\providecommand{\DIFdelFL}[1]{}
\providecommand{\DIFaddbeginFL}{}
\providecommand{\DIFaddendFL}{}
\providecommand{\DIFdelbeginFL}{}
\providecommand{\DIFdelendFL}{}
"""

TEX_INPUT = re.compile(r"(?<!\\)\\(input|include)\b\s*")
COLOR_COMMAND = re.compile(r"(?<!\\)\\(color|textcolor|colorbox)\b\s*(?:\[[^\]]+\]\s*)?")
COLOR_GROUP = re.compile(r"(?<![\w\\\]{}])\{\s*$")
DIFF_PREAMBLE = re.compile(
    r"^%DIF PREAMBLE EXTENSION ADDED BY LATEXDIFF[^\n]*\n"
    r".*?^%DIF END PREAMBLE EXTENSION ADDED BY LATEXDIFF[^\n]*(?:\n|$)",
    re.MULTILINE | re.DOTALL,
)
DIFF_COMMAND = re.compile(r"(?<!\\)\\DIF(add|del)(begin|end)?(?:FL|tex)?\b")


def flatten(entrypoint, root):
    """Read literal body includes from the document's source directory."""
    files = {}

    def visit(path, stack):
        resolved = path.resolve(strict=True)
        writer.require(resolved.is_relative_to(root) and resolved not in stack,
                       "TeX includes must be acyclic and local to the comparison source directory.")
        data = resolved.read_bytes()
        name = resolved.relative_to(root).as_posix()
        writer.require(files.setdefault(name, writer.digest(data)) == writer.digest(data),
                       "A TeX include changed during comparison.")
        source = data.decode("utf-8-sig")
        visible = manuscript.uncomment(source)
        pieces = []
        offset = 0
        for match in TEX_INPUT.finditer(visible):
            # TeX control sequences such as \input may occur in definitions
            # and examples. Automatic flattening supports literal includes.
            try:
                argument, end = manuscript.group(visible, match.end())
            except (ValueError, IndexError) as error:
                raise writer.Rejected("Use a coordinator-prepared marked TeX source for non-literal includes.") from error
            relative = Path(argument.strip())
            writer.require(relative.parts and not relative.is_absolute()
                           and ".." not in relative.parts and "\\" not in str(relative)
                           and "#" not in str(relative), "Use local literal TeX include paths.")
            filename = root / relative
            if not filename.exists() and not filename.suffix:
                filename = filename.with_suffix(".tex")
            included = visit(filename, (*stack, resolved))
            if match[1] == "include":
                included = "\\clearpage\n" + included + "\n\\clearpage"
            pieces.extend((source[offset:match.start()], included))
            offset = end
        return "".join((*pieces, source[offset:]))

    return visit(entrypoint, ()), files


def strip_baseline_color(source):
    """Ignore common TeX color markup while retaining the words it encloses."""
    visible = manuscript.uncomment(source)
    pieces = []
    position = 0
    while (command := COLOR_COMMAND.search(visible, position)) is not None:
        grouping = COLOR_GROUP.search(visible, position, command.start())
        try:
            _, end = manuscript.group(visible, command.end())
            if command[1] != "color":
                _, end = manuscript.group(visible, end)
            if grouping is not None and command[1] == "color":
                _, group_end = manuscript.group(visible, grouping.start())
        except (ValueError, IndexError) as error:
            raise writer.Rejected("Supply a checked uncolored TeX rendition of custom baseline color markup.") from error
        if grouping is not None and command[1] == "color":
            pieces.append(source[position:grouping.start()])
            pieces.append(strip_baseline_color(source[end:group_end - 1]))
            position = group_end
        else:
            pieces.append(source[position:command.start()])
            if command[1] != "color":
                _, start = manuscript.group(visible, command.end())
                open_brace = start
                while visible[open_brace].isspace():
                    open_brace += 1
                pieces.append(strip_baseline_color(source[open_brace + 1:end - 1]))
            position = end
    return "".join((*pieces, source[position:]))


def strip_previous_diff(source):
    """Remove prior latexdiff markup, retaining additions and omitting deletions."""
    def strip(text):
        visible = manuscript.uncomment(text)
        pieces = []
        position = 0
        while (command := DIFF_COMMAND.search(visible, position)) is not None:
            pieces.append(text[position:command.start()])
            position = command.end()
            if command[2]:
                while position < len(text) and text[position] in " \t":
                    position += 1
                continue
            opening = position
            while opening < len(visible) and visible[opening].isspace():
                opening += 1
            _, position = manuscript.group(visible, opening)
            if command[1] == "add":
                pieces.append(strip(text[opening + 1:position - 1]))
        return "".join((*pieces, text[position:]))

    unmarked, count = DIFF_PREAMBLE.subn("", source, count=1)
    return strip(unmarked) if count else source


def make_comparison_source(source, entrypoint, baseline_source, temporary):
    executable = shutil.which("latexdiff")
    writer.require(executable, "Install latexdiff or supply a coordinator-prepared --marked-tex.")
    revised, _ = flatten(source / entrypoint, source)
    old = temporary / "baseline.tex"
    new = temporary / "revision.tex"
    style = temporary / "comparison-style.tex"
    old.write_text(strip_baseline_color(strip_previous_diff(baseline_source)), encoding="utf-8")
    new.write_text(revised, encoding="utf-8")
    style.write_text(ADDITION_PREAMBLE, encoding="utf-8")
    command = [executable, "--encoding=utf8", "--no-del", "--no-label", "--math-markup=whole",
               "--graphics-markup=none", "--preamble", str(style), str(old), str(new)]
    options = dict(cwd=temporary, capture_output=True, text=True, encoding="utf-8")
    process = subprocess.run(command, **options)
    if (process.returncode != 0 and "Can't locate Encode/Locale.pm" in process.stderr
            and sys.platform == "darwin"):
        # TeX Live selects Perl through PATH. Homebrew Perl may lack a module
        # shipped with macOS Perl.
        process = subprocess.run(["/usr/bin/perl", *command], **options)
    writer.require(process.returncode == 0 and process.stdout.strip(),
                   "Could not produce TeX comparison. Supply --marked-tex if the document needs manual markup."
                   + (f"\n{process.stderr.strip()}" if process.stderr.strip() else ""))
    (source / entrypoint).write_text(process.stdout, encoding="utf-8")


def check_marked_content(clean, marked):
    try:
        import pymupdf
    except ImportError as error:
        raise writer.Rejected("Install PyMuPDF to check the compiled TeX comparison.") from error

    def text(document):
        flags = pymupdf.TEXTFLAGS_TEXT | pymupdf.TEXT_DEHYPHENATE
        return "".join(unicodedata.normalize("NFKC", "".join(
            page.get_text(flags=flags) for page in document)).split())

    with (pymupdf.open(stream=clean, filetype="pdf") as clean_pdf,
          pymupdf.open(stream=marked, filetype="pdf") as marked_pdf):
        writer.require(not any(page.first_annot for page in marked_pdf),
                       "Marked changes must come from TeX, without PDF annotations.")
        writer.require(text(clean_pdf) == text(marked_pdf),
                       "The compiled comparison differs from the clean paper's visible text. "
                       "Use --marked-tex to preserve the clean content.")


def compare(main, bundle, baseline, baseline_view=None, marked_tex=None):
    bundle = bundle.resolve(strict=True)
    baseline = baseline.resolve(strict=True)
    view = baseline_view.resolve(strict=True) if baseline_view else baseline
    manual = marked_tex.resolve(strict=True) if marked_tex else None
    writer.require(baseline.is_file() and view.is_file(), "Identify the exact user-designated baseline file.")
    writer.require(manual is None or (manual.is_file() and manual.suffix.lower() == ".tex"
                                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.tex", manual.name)
                                    and not manual.is_relative_to(bundle)
                                    and not bundle.is_relative_to(manual.parent)),
                   "Supply a staged marked TeX entrypoint in its own source directory.")
    writer.require(manual or view.suffix.lower() == ".tex",
                   "Supply a checked --baseline-view in TeX or prepare --marked-tex against the designated baseline.")

    def bindings():
        inputs = writer.applicable_inputs("paper", main)
        receipt = writer.verify_delivery("paper", bundle, lambda: inputs)
        baseline_data = baseline.read_bytes()
        view_data = view.read_bytes()
        source_text, source_hashes = flatten(view, view.parent) if not manual else (None, {})
        marked_files = writer.source_files(manual.parent) if manual else None
        return receipt, source_text, marked_files, {
            "schema": 2,
            "method": "coordinator-tex" if manual else "latexdiff-tex",
            "snapshot_digest": inputs["snapshot_digest"],
            "clean_pdf_sha256": receipt["pdf_sha256"],
            "clean_source_digest": receipt["source_digest"],
            "baseline_sha256": writer.digest(baseline_data),
            "baseline_view_sha256": writer.digest(view_data),
            "baseline_tex_files": source_hashes,
            "manual_entrypoint": manual.name if manual else None,
            "manual_files_digest": writer.record_digest({k: writer.digest(v) for k, v in marked_files.items()})
            if manual else None,
        }

    receipt, baseline_source, marked_files, bound = bindings()
    output = bundle / "comparison"
    pdf = "paper-marked.pdf"

    def checked_result():
        record = writer.read_record(output / "comparison.json")
        writer.require(all(record.get(k) == v for k, v in bound.items()),
                       "Existing comparison used different inputs or an earlier comparison method. Use a new bundle.")
        writer.require(record.get("marked_sha256") == writer.digest(writer.pdf_bytes(output / pdf)),
                       "Marked PDF differs from its comparison record.")
        files = {name: writer.digest(data) for name, data in writer.source_files(output / "source").items()}
        writer.require(files == record.get("source_files"), "Marked TeX differs from its comparison record.")
        return output / pdf

    if output.exists():
        return checked_result()

    with tempfile.TemporaryDirectory(dir=bundle, prefix=".comparison-") as tmp:
        temporary = Path(tmp)
        staged = temporary / "comparison"
        source = staged / "source"
        if manual:
            files = marked_files
            entrypoint = manual.name
        else:
            files = writer.source_files(bundle / "source")
            entrypoint = receipt["entrypoint"]
        for name, data in files.items():
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if not manual:
            make_comparison_source(source, entrypoint, baseline_source, temporary)
        build = temporary / "render"
        marked = writer.run_latex(source, entrypoint, build, receipt["engine"])
        writer.check_local_resources(source, build, entrypoint)
        pdf_data = writer.pdf_bytes(marked)
        check_marked_content(writer.pdf_bytes(bundle / receipt["pdf"]), pdf_data)
        (staged / pdf).write_bytes(pdf_data)
        writer.write_record(staged / "comparison.json", bound | {
            "entrypoint": entrypoint,
            "marked_sha256": writer.digest(pdf_data),
            "source_files": {name: writer.digest(data) for name, data in writer.source_files(source).items()},
        })
        writer.require(bindings()[3] == bound, "Comparison inputs changed during markup.")
        try:
            os.rename(staged, output)
        except OSError:
            if not output.is_dir():
                raise
    return checked_result()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main", type=Path, required=True, help="Approved unpublished snapshot main.tex")
    parser.add_argument("--bundle", type=Path, required=True, help="Checked clean Writer bundle")
    parser.add_argument("--baseline", type=Path, required=True, help="Exact user-designated manuscript")
    parser.add_argument("--baseline-view", type=Path, help="Checked TeX rendition of the selected file")
    parser.add_argument("--marked-tex", type=Path, help="Coordinator-prepared marked TeX entrypoint if automatic comparison is unsuitable")
    args = parser.parse_args(argv)
    try:
        marked = compare(args.main, args.bundle, args.baseline, args.baseline_view, args.marked_tex)
        print(json.dumps({"marked": str(marked)}, ensure_ascii=False))
    except (ValueError, OSError, RuntimeError, KeyError) as error:
        print(f"Writer comparison: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
