#!/usr/bin/env python3
"""Internal Proof2Game writer delivery checks. Model judgments stay with the writer."""

import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


HUMANIZER = "blader/humanizer@v4.0.0"
HUMANIZER_SHA256 = "804a119e924ac30295b298213e0b71b3e38b2667b8ef4fb7b69e9246369b9045"


class Rejected(ValueError):
    """Raised when Writer cannot use an input or deliver an artifact."""


def require(condition, message):
    if not condition:
        raise Rejected(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def record_digest(record):
    return digest(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def read_record(path):
    record = json.loads(Path(path).read_text(encoding="utf-8"))
    require(isinstance(record, dict), f"Expected a JSON object at {path}.")
    return record


def write_record(path, record):
    with path.open("x", encoding="utf-8") as output:
        json.dump(record, output, ensure_ascii=False, sort_keys=True, indent=2)
        output.write("\n")


def require_text(record, keys, purpose):
    require(isinstance(record, dict), f"Expected structured {purpose}.")
    for key in keys:
        require(isinstance(record.get(key), str) and record[key].strip(),
                f"Missing {purpose} field {key}.")


def writing_guide():
    path = Path(__file__).resolve().parents[1] / "references/humanizer/SKILL.md"
    require(digest(path.read_bytes()) == HUMANIZER_SHA256, "Bundled Humanizer differs from the pinned release.")
    return {"id": HUMANIZER, "path": str(path), "sha256": HUMANIZER_SHA256}


def approved_snapshot(main):
    import manuscript

    main = Path(main).resolve(strict=True)
    approval = read_record(main.with_name("approval.json"))
    clean, _ = manuscript.parse(main)
    active = [component["id"] for component in clean["components"]]
    require(approval.get("schema") == 1 and approval.get("snapshot_digest") == clean["snapshot_digest"]
            and approval.get("components") == active, "Approval does not match the current filtered snapshot.")
    require(set(active) == set(clean["cone"]) and not clean["open_obligations"] and clean["targets"],
            "Snapshot must contain exactly the closed, active target dependencies.")
    expected = {"math_review": "pass", "proof_obligations": "closed", "route_review": "pass"}
    require(all(approval.get(key) == value for key, value in expected.items()),
            "Current math, proof-closure and route approvals are required.")
    return approval, clean["targets"]


def exact_target(path):
    path = Path(path).resolve(strict=True)
    target = read_record(path)
    require(target.get("project_type") == "public", "Referee reports require a public target.")
    require_text(target, ("original_path", "sha256", "version", "public_date"), "target")
    require(date.fromisoformat(target["public_date"]).isoformat() == target["public_date"],
            "Target public date must be the exact ISO date of the processed original.")
    relative = Path(target["original_path"])
    original = (path.parent / relative).resolve(strict=True)
    require(not relative.is_absolute() and original.is_relative_to(path.parent) and original.is_file(),
            "The preserved target must be an actual file within its task directory.")
    require(digest(original.read_bytes()) == target["sha256"], "Preserved target bytes differ from the recorded version.")
    return path, target


def applicable_inputs(kind, main=None, target=None, withdrawal=None):
    if withdrawal is not None:
        require(kind == "referee" and main is None, "Only a public final withdrawal can proceed without a snapshot.")
        approval = read_record(withdrawal)
        require(approval.get("schema") == 1 and approval.get("kind") == "referee"
                and approval.get("reason") == "last-target-withdrawn"
                and "snapshot_digest" in approval and approval["snapshot_digest"] is None
                and not approval.get("revoked"),
                "Expected the actual authorization for a public final-target withdrawal.")
        decision = approval.get("withdrawal")
        require_text(decision, ("counterexample", "evidence", "user_confirmation"), "withdrawal")
        require(isinstance(decision.get("targets"), list) and decision["targets"]
                and all(isinstance(item, str) and item.strip() for item in decision["targets"]),
                "Withdrawal authorization must identify the withdrawn target.")
        targets = []
    else:
        require(main is not None, "A filtered, approved snapshot is required.")
        approval, targets = approved_snapshot(main)

    project_type = "unpublished" if kind == "paper" else "public"
    require(approval.get("project_type") == project_type, f"The {kind} delivery requires a {project_type} project.")
    inputs = {"kind": kind, "snapshot_digest": approval["snapshot_digest"], "targets": targets}
    if kind == "paper":
        require(target is None, "Write the paper from the approved snapshot.")
        return inputs

    require(target is not None, "Referee reports require the exact target version record.")
    target_path, original = exact_target(target)
    require(approval.get("cutoff") == original["public_date"]
            and approval.get("original_sha256") == original["sha256"],
            "The report authorization and original version do not agree.")
    findings = approval.get("report_findings")
    comparison = withdrawal is None and approval.get("referee_comparison") is True
    require(isinstance(findings, list) and (findings or comparison),
            "An approved manuscript comparison or original-text findings are required.")
    report_sha256 = approval.get("report_sha256")
    if findings:
        report = target_path.with_name("report.md")
        require(report.is_file() and digest(report.read_bytes()) == report_sha256,
                "The project report.md differs from the approved findings record.")
    else:
        require(report_sha256 is None, "An empty findings record cannot bind a project report.")
    ids = set()
    for finding in findings:
        require_text(finding, ("id", "location", "original_conclusion", "evidence", "verification"), "finding")
        require(finding["id"] not in ids, f'Duplicate finding {finding["id"]}.')
        ids.add(finding["id"])
        if "confirmed_revision" in finding:
            require_text(finding["confirmed_revision"], ("new_conclusion", "user_confirmation"), "confirmed revision")

    if comparison:
        inputs["referee_comparison"] = True
    return inputs | {
        "target": {key: original.get(key) for key in ("version", "public_date", "sha256")},
        "report_sha256": report_sha256,
        "report_findings": findings,
        "withdrawal": approval.get("withdrawal") if withdrawal else None,
    }


def source_files(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        mode = path.lstat().st_mode
        require(not stat.S_ISLNK(mode), f"Use a local copy of the source asset {path.relative_to(directory)}.")
        if stat.S_ISDIR(mode):
            continue
        require(stat.S_ISREG(mode), f"Unsupported source asset {path.relative_to(directory)}.")
        require(path.suffix.lower() not in {".fls", ".fdb_latexmk", ".aux", ".log", ".synctex", ".synctex.gz"},
                f"Keep generated files outside the source tree: {path.name}.")
        files[path.relative_to(directory).as_posix()] = path.read_bytes()
    return files


def check_paper_identity(files):
    import manuscript

    forbidden = re.compile(r"\\author\b(?!\s*\{\s*\})|\bpdfauthor\s*=(?!\s*\{\s*\})")
    for name, data in files.items():
        if Path(name).suffix in {".tex", ".sty", ".cls", ".ltx"}:
            require(not forbidden.search(manuscript.uncomment(data.decode("utf-8"))),
                    f"Omit author declarations from the authorless paper in {name}.")


def run_latex(source, main, build, engine):
    invocation = {
        "pdflatex": ("-pdf", "-pdflatex"),
        "lualatex": ("-lualatex", "-pdflualatex"),
        "xelatex": ("-xelatex", "-pdfxelatex"),
    }
    option, executable = invocation[engine]
    command = [
        "latexmk", "-norc", option, f"{executable}={engine} -no-shell-escape %O %S",
        "-recorder", "-halt-on-error", "-interaction=nonstopmode", "-bibtex-",
        f"-outdir={build}", f"./{main}",
    ]
    environment = os.environ.copy()
    environment.update(openin_any="p", openout_any="p", TEXINPUTS="")
    build.mkdir()
    log_path = build / "build.log"
    with log_path.open("xb") as log:
        result = subprocess.run(command, cwd=source, env=environment, stdout=log, stderr=subprocess.STDOUT)
    require(result.returncode == 0, f"Compilation failed. See {log_path}.")

    transcript = (build / Path(main).with_suffix(".log")).read_text(encoding="utf-8", errors="replace")
    unresolved = re.search(r"(?:LaTeX|Package \S+) Warning:.*(?:undefined|multiply defined)"
                           r"|Label\(s\) may have changed|Rerun to get cross-references right",
                           transcript, re.IGNORECASE)
    require(not unresolved, f"Resolve unstable or missing cross-references in {build}.")
    return build / Path(main).with_suffix(".pdf")


def check_local_resources(source, build, main):
    path = subprocess.run(
        ["kpsewhich", "-var-value=TEXMFROOT"], check=True, capture_output=True, text=True
    ).stdout.strip()
    require(path and Path(path).is_absolute(), "Cannot locate the system TeX distribution.")
    system = Path(path).resolve(strict=True)
    require(system != Path("/") and system.is_dir(), "Cannot identify a bounded system TeX installation.")
    recorder = build / Path(main).with_suffix(".fls")
    for line in recorder.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("INPUT "):
            path = (source / line[6:]).resolve()
            require(any(path.is_relative_to(root) for root in (source, build, system)),
                    f"Copy the dependencies of the Writer source locally. External input: {path}")


def pdf_bytes(path):
    data = path.read_bytes()
    require(data.startswith(b"%PDF-") and b"%%EOF" in data[-1024:], f"Invalid compiled PDF: {path}")
    return data


def compile_delivery(kind, tex, bundle, engine, read_inputs):
    require(kind == "paper", "For a referee report use prepare with --markdown.")
    inputs = read_inputs()
    guide = writing_guide()
    tex = Path(tex).resolve(strict=True)
    bundle = Path(bundle).resolve()
    require(tex.suffix == ".tex" and tex.is_file(), "Point --tex to the complete draft entrypoint.")
    # TeX can consume explicit filenames. A portable basename also avoids command expansion by latexmk.
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.tex", tex.name)),
            "Use a portable TeX entrypoint filename.")
    require(not bundle.exists() and not bundle.is_relative_to(tex.parent) and bundle.parent.is_dir(),
            "Choose a new delivery bundle beside, or outside, the draft source directory.")

    files = source_files(tex.parent)
    check_paper_identity(files)
    staging = Path(tempfile.mkdtemp(prefix=f".{kind}-build-", dir=bundle.parent))
    source = staging / "source"
    for name, data in files.items():
        asset = source / name
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_bytes(data)
    build = staging / "render"
    compiled = run_latex(source, tex.name, build, engine)
    check_local_resources(source, build, tex.name)
    require(source_files(source) == files, "Compilation modified the delivered source tree.")
    require(read_inputs() == inputs, "Approved Writer inputs changed during compilation.")
    name = f"{kind}.pdf"
    pdf = pdf_bytes(compiled)
    (staging / name).write_bytes(pdf)
    manifest = {file: digest(data) for file, data in files.items()}
    candidate = {
        "schema": 4, "kind": kind, "snapshot_digest": inputs["snapshot_digest"],
        "humanizer": guide["id"],
        "input_digest": record_digest(inputs), "source_digest": record_digest(manifest),
        "source_files": manifest, "entrypoint": tex.name, "pdf": name,
        "pdf_sha256": digest(pdf), "engine": engine,
    }
    write_record(staging / "candidate.json", candidate)
    staging.rename(bundle)
    return candidate


def prepare_report(markdown, bundle, read_inputs):
    import referee_markdown

    inputs = read_inputs()
    require(inputs["kind"] == "referee", "Markdown preparation is for a referee report.")
    guide = writing_guide()
    markdown = Path(markdown).resolve(strict=True)
    bundle = Path(bundle).resolve()
    require(markdown.suffix.lower() == ".md" and markdown.is_file(), "Supply the complete UTF-8 Markdown report.")
    require(not bundle.exists() and bundle.parent.is_dir(), "Choose a new versioned Writer bundle.")
    data = markdown.read_bytes()
    outline = referee_markdown.inspect(data)
    candidate = {
        "schema": 3, "kind": "referee", "snapshot_digest": inputs["snapshot_digest"],
        "humanizer": guide["id"], "input_digest": record_digest(inputs),
        "artifact": "referee.md", "artifact_sha256": digest(data), **outline,
    }
    with tempfile.TemporaryDirectory(prefix=".referee-stage-", dir=bundle.parent) as tmp:
        staging = Path(tmp) / "bundle"
        staging.mkdir()
        (staging / candidate["artifact"]).write_bytes(data)
        write_record(staging / "candidate.json", candidate)
        require(read_inputs() == inputs and markdown.read_bytes() == data,
                "The approved inputs or the Markdown report changed during preparation.")
        staging.rename(bundle)
    return candidate


def current_candidate(kind, bundle, inputs):
    candidate = read_record(bundle / "candidate.json")
    schema = candidate.get("schema")
    require((schema in (1, 2, 4) if kind == "paper" else schema in (1, 2, 3))
            and candidate.get("kind") == kind
            and candidate.get("snapshot_digest") == inputs["snapshot_digest"]
            and candidate.get("input_digest") == record_digest(inputs),
            "Candidate belongs to a different delivery or input version.")
    if schema >= 2:
        require(candidate.get("humanizer") == HUMANIZER, "Candidate writing guide differs from the selected version.")
    if schema == 3:
        import referee_markdown

        require(kind == "referee" and candidate.get("artifact") == "referee.md", "Unexpected Markdown artifact.")
        data = (bundle / "referee.md").read_bytes()
        require(digest(data) == candidate.get("artifact_sha256"), "The checked Markdown file has changed.")
        outline = referee_markdown.inspect(data)
        require(all(candidate.get(key) == value for key, value in outline.items()), "Report outline differs.")
        return candidate
    require(candidate.get("pdf") == f"{kind}.pdf", "Wrong PDF in the Writer candidate.")
    files = source_files(bundle / "source")
    manifest = {file: digest(data) for file, data in files.items()}
    require(candidate.get("entrypoint") in manifest and candidate.get("source_files") == manifest
            and candidate.get("source_digest") == record_digest(manifest),
            "Compiled Writer sources have changed.")
    require(candidate.get("pdf_sha256") == digest(pdf_bytes(bundle / candidate["pdf"])),
            "Compiled Writer PDF has changed.")
    return candidate


def check_evidence(checks, inputs, candidate):
    require_text(checks, ("worker_session", "model", "effort", "render", "references"), "Writer self-check")
    bindings = ("input_digest", "artifact_sha256") if candidate["schema"] == 3 else ("input_digest", "source_digest", "pdf_sha256")
    for key in bindings:
        require(checks.get(key) == candidate[key], f"Writer self-check does not match {key}.")
    if candidate["schema"] >= 2:
        require_text(checks, ("humanizer",), "Humanizer editing and fidelity check")
    if candidate["kind"] == "paper":
        require_text(checks, ("fidelity",), "Writer self-check")
        if candidate["schema"] == 4:
            require_text(checks, ("paper_title", "title_render", "proof_endings"), "rendered paper layout check")
        covered = checks.get("targets")
        require(isinstance(covered, dict) and set(covered) == set(inputs["targets"]),
                "Locate the full statement and proof of every current target in the PDF.")
        for target, locations in covered.items():
            require_text(locations, ("statement", "proof"), f"target {target}")
    else:
        require_text(checks, ("scope",), "referee scope check")
        if candidate["schema"] >= 2:
            require_text(checks, ("diagnosis_only",), "referee diagnosis check")
            issues = checks.get("issues")
            require(isinstance(issues, dict) and set(issues) == {"major", "minor"},
                    "Check both referee issue lists against the rendered report.")
            for severity, items in issues.items():
                require(isinstance(items, list), f"Expected a list of {severity} issues.")
                for index, item in enumerate(items, 1):
                    require_text(item, ("location", "quotation", "problem"), f"{severity} issue {index}")
            require(not inputs["report_findings"] or any(issues.values()),
                    "The issue lists must cover the confirmed original findings.")
            if candidate["schema"] == 3:
                import referee_markdown

                require(candidate["issue_counts"] == {key: len(items) for key, items in issues.items()},
                        "Self-check issue counts differ from the numbered Markdown issues.")
                openings = checks.get("openings")
                require_text(openings, ("summary", "assessment"), "referee opening sentences")
                for section, paragraph in candidate["opening_paragraphs"].items():
                    require(referee_markdown.is_opening(paragraph, openings[section]),
                            f"Quote the actual opening sentence of the {section}.")
                count = candidate["issue_counts"]["major"]
                require(type(openings.get("major_count")) is int and openings["major_count"] == count,
                        "The major-issue count in the opening review differs from the report.")
                require(referee_markdown.count_matches(openings["assessment"], count),
                        "State the actual number of major issues in the first assessment sentence.")
                require_text(checks, ("opening_judgment", "italics"), "referee lead and quotation review")
        if inputs.get("referee_comparison"):
            compared = checks.get("comparison")
            require(isinstance(compared, dict) and set(compared) == set(inputs["targets"]),
                    "Compare every approved target with the preserved original and locate its treatment in the report.")
            for target, locations in compared.items():
                require_text(locations, ("original", "script", "report"), f"comparison for target {target}")
        covered = checks.get("findings")
        require(isinstance(covered, dict) and set(covered) == {finding["id"] for finding in inputs["report_findings"]},
                "Locate every approved finding in the referee report.")
        for finding in inputs["report_findings"]:
            fields = ["original_location", "evidence"]
            if candidate["schema"] in (1, 2):  # Historical PDF receipts included an impact locator.
                fields.append("affected_conclusion")
            if candidate["schema"] == 1 and "confirmed_revision" in finding:
                fields.append("confirmed_revision")
            require_text(covered[finding["id"]], fields, f'finding {finding["id"]}')
        if inputs["withdrawal"]:
            require_text(checks, ("withdrawal",), "withdrawal check")


def finish_delivery(kind, bundle, checks, read_inputs):
    inputs = read_inputs()
    candidate = current_candidate(kind, bundle, inputs)
    current_schema = 3 if kind == "referee" else 4
    require(candidate["schema"] == current_schema or (bundle / "receipt.json").is_file(),
            "Prepare the unfinished legacy draft in a fresh bundle under the current Writer instructions.")
    evidence = read_record(checks)
    check_evidence(evidence, inputs, candidate)
    receipt = candidate | {"checks": evidence}
    path = bundle / "receipt.json"
    # Link a complete receipt into place atomically. A retry after a completed
    # write can return the same receipt without overwriting a durable check.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=bundle) as temporary:
        json.dump(receipt, temporary, ensure_ascii=False, sort_keys=True, indent=2)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
        try:
            os.link(temporary.name, path)
        except FileExistsError:
            require(read_record(path) == receipt, "This bundle already has a different completion receipt.")
    return receipt


def verify_delivery(kind, bundle, read_inputs):
    inputs = read_inputs()
    candidate = current_candidate(kind, bundle, inputs)
    receipt = read_record(bundle / "receipt.json")
    require(all(receipt.get(key) == value for key, value in candidate.items()),
            "Final receipt does not match the current checked candidate.")
    check_evidence(receipt.get("checks"), inputs, candidate)
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "compile", "prepare", "finish", "verify"))
    parser.add_argument("--kind", required=True, choices=("paper", "referee"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--main", type=Path, help="Filtered main.tex beside its approval.json")
    mode.add_argument("--withdrawal", type=Path, help="Authorized public final-target withdrawal")
    parser.add_argument("--target", type=Path, help="Original target.json for a referee report")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--tex", type=Path, help="Draft paper TeX entrypoint in a dedicated source directory")
    source.add_argument("--markdown", type=Path, help="Standalone Markdown referee report")
    parser.add_argument("--bundle", type=Path, help="Writer's versioned build directory")
    parser.add_argument("--engine", choices=("pdflatex", "lualatex", "xelatex"), default="pdflatex")
    parser.add_argument("--checks", type=Path, help="Actual Writer self-check evidence JSON")
    args = parser.parse_args(argv)

    def read_inputs():
        return applicable_inputs(args.kind, args.main, args.target, args.withdrawal)

    try:
        if args.action == "inspect":
            result = read_inputs()
            result["writing_guide"] = writing_guide()
            template = "writer-paper.tex" if args.kind == "paper" else "writer-referee.md"
            result["template"] = str(Path(__file__).resolve().parents[1] / "assets" / template)
            if args.kind == "paper":
                import manuscript

                clean, full, (prefix, body, _, _), resources = manuscript.read_assembly(args.main)
                require(clean["snapshot_digest"] == result["snapshot_digest"], "Snapshot changed during inspection.")
                result["cited_keys"] = sorted(manuscript.retained_citation_keys(
                    prefix, body, full["components"], resources
                ))
        else:
            require(args.bundle is not None, f"{args.action} requires --bundle.")
            if args.action == "prepare":
                require(args.kind == "referee" and args.markdown, "prepare requires --kind referee and --markdown.")
                result = prepare_report(args.markdown, args.bundle, read_inputs)
            elif args.action == "compile":
                require(args.tex is not None, "compile requires --tex.")
                result = compile_delivery(args.kind, args.tex, args.bundle, args.engine, read_inputs)
            elif args.action == "finish":
                require(args.checks is not None, "finish requires --checks.")
                result = finish_delivery(args.kind, args.bundle, args.checks, read_inputs)
            else:
                result = verify_delivery(args.kind, args.bundle, read_inputs)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Writer: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
