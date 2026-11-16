#!/usr/bin/env python3
"""Preserve specified manuscript versions and project references with resumable OCR."""

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

from sources import (
    bib_key,
    candidate,
    catalog,
    date,
    identifier,
    require_text,
    select_source,
    url,
)

TASK_STORAGE = ".proof2game"
LEGACY_TASK_STORAGE = ".mathgrove"
TASK_NAMESPACES = (TASK_STORAGE, LEGACY_TASK_STORAGE)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def write_atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, staging = tempfile.mkstemp(dir=path.parent, prefix=".intake-")
    try:
        with os.fdopen(fd, "wb") as stream:
            if hasattr(content, "read"):
                shutil.copyfileobj(content, stream)
            else:
                stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, path)
    finally:
        # Only our own unpublished transaction file can be left at this path.
        Path(staging).unlink(missing_ok=True)


def write_json(path, value):
    write_atomic(path, json_bytes(value))


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def inside(project, path):
    resolved = path.resolve()
    if not resolved.is_relative_to(project):
        raise ValueError(f"path leaves the project directory: {path}")
    return resolved


def task_directory(project, name):
    """Find a saved target version without relocating it, or choose its new path."""
    name = identifier(name)
    current, legacy = (inside(project, project / namespace / name) for namespace in TASK_NAMESPACES)
    if current != legacy and current.exists() and legacy.exists():
        raise ValueError(f"Target {name} exists in both work directories. Preserve both and resolve which is authoritative: "
                         f"{current}, {legacy}")
    return legacy if legacy.exists() else current


def resolve_task_path(path):
    """Resolve an explicit target version path written with either storage name."""
    path = Path(path).expanduser()
    if path.parent.name not in TASK_NAMESPACES:
        raise ValueError(f"The task must be in the project's {TASK_STORAGE} or legacy {LEGACY_TASK_STORAGE} directory.")
    project = path.parent.parent.resolve(strict=True)
    task = task_directory(project, path.name).resolve(strict=True)
    if not task.is_dir():
        raise ValueError(f"Expected a task work directory: {task}")
    return task


@contextlib.contextmanager
def lock(project):
    # An installed v0.1.0 client uses this lock for its task metadata and the
    # shared references/ catalog. Use it wherever the legacy root exists, and
    # also keep any modern lock already used here before the old client ran.
    modern = inside(project, project / TASK_STORAGE / "intake.lock")
    legacy = inside(project, project / LEGACY_TASK_STORAGE / "intake.lock")
    with contextlib.ExitStack() as locks:
        if modern == legacy or modern.exists() or not legacy.parent.exists():
            modern.parent.mkdir(exist_ok=True)
            stream = locks.enter_context(modern.open("a+b"))
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        if legacy.parent.exists() and legacy != modern:
            stream = locks.enter_context(legacy.open("a+b"))
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        yield


def git(project, *arguments):
    return subprocess.run(
        ["git", "-C", str(project), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )


def init_git(project):
    shown = git(project, "rev-parse", "--show-toplevel")
    if shown.returncode == 0:
        return {"repository": shown.stdout.strip(), "created": False}
    if "not a git repository" not in shown.stderr.lower() or (project / ".git").exists():
        raise ValueError(shown.stderr.strip() or "Existing Git metadata cannot be read.")
    started = git(project, "init")
    if started.returncode:
        raise ValueError(started.stderr.strip() or "Git initialization failed.")
    return {"repository": str(project), "created": True}


def page_count(path):
    with path.open("rb") as stream:
        if not stream.read(1024).startswith(b"%PDF-"):
            raise ValueError("The selected file is not a PDF.")
    result = subprocess.run(
        ["pdfinfo", str(path)], capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"},
        timeout=60,
    )
    count = re.search(r"^Pages:\s+([1-9]\d*)\s*$", result.stdout, flags=re.MULTILINE)
    if result.returncode or count is None:
        raise ValueError(f"pdfinfo could not read the original: {result.stderr.strip()[-1000:]}")
    return int(count.group(1))


def store_original(source, destination, expected):
    if not destination.exists():
        with source.open("rb") as stream:
            write_atomic(destination, stream)
    if not destination.is_file() or digest(destination) != expected:
        raise ValueError("Original bytes changed during intake or conflict with a preserved original.")


def arxiv_link(raw):
    url(raw, "arXiv URL")
    parsed = urlparse(raw)
    if parsed.hostname not in ("arxiv.org", "www.arxiv.org", "export.arxiv.org") or parsed.scheme != "https":
        raise ValueError("Use an https://arxiv.org manuscript URL.")
    match = re.fullmatch(
        r"/(?:abs|pdf|html|format|src)/((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*/\d{7}))(v[1-9]\d*)?(?:\.pdf)?/?",
        unquote(parsed.path),
    )
    if not match:
        raise ValueError("Identify a specific arXiv manuscript, using its abstract or PDF link.")
    identifier, version = match.groups()
    return {"arxiv_id": identifier, "requested_version": version}


def public_target(request, extension):
    version = require_text(request, "version")
    public_date = date(request.get("public_date"), "target version publication date")
    evidence = require_text(request, "publication_evidence")
    source_url = url(request.get("source_url"), "target version URL")
    selected_link = request.get("arxiv_link")
    if selected_link:
        if extension != ".pdf":
            raise ValueError("An arXiv target must preserve its downloaded original PDF.")
        requested = arxiv_link(selected_link)
        pinned = arxiv_link(source_url)
        if (
            pinned["arxiv_id"] != requested["arxiv_id"]
            or pinned["requested_version"] != version
            or not re.fullmatch(r"v[1-9]\d*", version)
            or requested["requested_version"] not in (None, version)
        ):
            raise ValueError("The arXiv evidence must bind the exact requested manuscript version.")
    return {
        "version": version,
        "public_date": public_date,
        "cutoff": public_date,
        "source_url": source_url,
        "publication_evidence": evidence,
    }


def init_target(project, request):
    path = Path(require_text(request, "input")).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError("The manuscript input must be a file.")
    extension = path.suffix.lower()
    if extension not in (".tex", ".md", ".markdown", ".pdf"):
        raise ValueError("Supply an existing LaTeX, Markdown or PDF manuscript, or an arXiv link.")
    project_type = request.get("project_type")
    if project_type == "public":
        version = public_target(request, extension)
    elif project_type == "unpublished":
        if request.get("arxiv_link"):
            raise ValueError("An arXiv manuscript has a public version. Resolve the project type first.")
        version = {
            "version": request.get("version", "provided manuscript"),
            "cutoff": None,
            "public_date": None,
            "source_url": None,
            "publication_evidence": None,
        }
    else:
        raise ValueError("Resolve the project type with the user: unpublished or public.")
    sha = digest(path)
    identity = [sha, project_type, version["version"], version["public_date"], version["source_url"]]
    suffix = hashlib.sha256(json_bytes(identity)).hexdigest()[:16]
    task_id = identifier(request.get("id", f"target-{suffix}"))
    task = task_directory(project, task_id)
    record = inside(project, task / "target.json")
    original = inside(project, task / f"original{extension}")
    metadata = {
        "schema": 1,
        "id": task_id,
        "project_type": project_type,
        "original_name": path.name,
        "original_path": original.name,
        "sha256": sha,
        **version,
    }
    if extension == ".pdf":
        metadata.update({
            "page_count": page_count(path),
            "sidecar_path": "original.md",
            "proof_source_path": None,
            "complete": False,
            "page_sha256": {},
        })
    else:
        metadata.update({"proof_source_path": original.name, "complete": True})
    if record.exists():
        old = checked_record(project, "target", task_id)
        for field in ("id", "project_type", "version", "cutoff", "sha256", "source_url"):
            if old.get(field) != metadata.get(field):
                raise ValueError("This task is already bound to a different original, version, or source.")
        return public_record(record, old)
    store_original(path, original, sha)
    write_json(record, metadata)
    return public_record(record, metadata)


def register_reference(project, request):
    info = candidate(request)
    path = Path(require_text(request, "pdf")).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError("The reference original must be a PDF file.")
    sha = digest(path)
    ref_id = identifier(request.get("id") or f"{info['work_key'][:100]}-{sha[:16]}")
    folder = inside(project, project / "references" / ref_id)
    record = inside(project, folder / "source.json")
    original = inside(project, folder / "original.pdf")
    count = page_count(path)
    metadata = {
        **info,
        "schema": 1,
        "id": ref_id,
        "original_name": path.name,
        "pdf_path": original.name,
        "sha256": sha,
        "page_count": count,
        "sidecar_path": "sidecar.md",
        "complete": False,
        "page_sha256": {},
    }
    if "cited_locations_physical_pages" in request:
        metadata["cited_locations_physical_pages"] = checked_locations(request, count)
    if record.exists():
        old = checked_record(project, "reference", ref_id)
        for field in ("citation_key", "version", "edition", "public_date", "sha256", "source_url"):
            if old[field] != metadata[field]:
                raise ValueError("This reference ID already names a different original, version, or source.")
        return public_record(record, old)
    def place_reference(destination):
        destination_record = destination / record.name
        if reuse := request.get("reuse_target"):
            previous = copy_target_transcription(project, reuse, destination_record, metadata)
            metadata.update(previous)
        store_original(path, destination / original.name, sha)
        write_json(destination_record, metadata)

    if folder.exists():
        # Preserve an unregistered folder that may already contain user material.
        if original.exists() and (not original.is_file() or digest(original) != sha):
            raise ValueError("Original bytes conflict with a preserved original.")
        place_reference(folder)
    else:
        folder.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".proof2game-reference-", dir=project) as scratch:
            staged = Path(scratch) / "reference"
            staged.mkdir()
            place_reference(staged)
            staged.rename(folder)
    return public_record(record, metadata)


def copy_target_transcription(project, target_id, record, reference):
    target_path = record_path(project, "target", target_id)
    target = checked_record(project, "target", target_id)
    if (
        target["project_type"] != "public" or not target["complete"] or "sidecar_sha256" not in target
        or any(target.get(key) != reference[key] for key in ("sha256", "public_date", "version", "page_count"))
    ):
        raise ValueError("Reuse requires the exact completed public target PDF edition.")
    for page, sha in target["page_sha256"].items():
        name = f"{int(page):05d}-{sha}.json"
        source = inside(project, target_path.parent / "ocr" / "pages" / name)
        destination = inside(project, record.parent / "ocr" / "pages" / name)
        store_original(source, destination, sha)
    original = inside(project, target_path.parent / target["sidecar_path"])
    sidecar = inside(project, record.parent / reference["sidecar_path"])
    store_original(original, sidecar, target["sidecar_sha256"])
    return {key: target[key] for key in ("complete", "page_sha256", "sidecar_sha256")}


def record_path(project, kind, name):
    name = identifier(name)
    if kind == "target":
        return inside(project, task_directory(project, name) / "target.json")
    if kind == "reference":
        return inside(project, project / "references" / name / "source.json")
    raise ValueError("kind must be target or reference")


def checked_record(project, kind, name):
    path = record_path(project, kind, name)
    value = read_json(path)
    original = inside(project, path.parent / value.get("original_path", value.get("pdf_path")))
    if not original.is_file() or digest(original) != value["sha256"]:
        raise ValueError(f"Original missing or changed; restore the exact preserved bytes: {original}")
    if value.get("sidecar_sha256") and value["complete"]:
        sidecar = inside(project, path.parent / value["sidecar_path"])
        if not sidecar.is_file() or digest(sidecar) != value["sidecar_sha256"]:
            raise ValueError(f"Completed transcription missing or changed; reverify before use: {sidecar}")
    return value


def public_record(path, value):
    pending = []
    if not value["complete"]:
        for page in range(1, value.get("page_count", 0) + 1):
            sha = value["page_sha256"].get(str(page))
            checkpoint = path.parent / "ocr" / "pages" / f"{page:05d}-{sha}.json"
            if not sha or not checkpoint.is_file() or digest(checkpoint) != sha:
                pending.append(page)
    return {**value, "directory": str(path.parent), "pending_pages": pending}


def validated_page(project, request):
    kind, name = request.get("kind"), request.get("id")
    value = checked_record(project, kind, name)
    path = record_path(project, kind, name)
    n = request.get("page")
    if type(n) is not int or not 1 <= n <= value.get("page_count", 0):
        raise ValueError("Provide a physical PDF page number starting at 1.")
    return path, value, n


def render_page(project, request):
    record, value, n = validated_page(project, request)
    dpi = request.get("dpi", 150)
    if type(dpi) is not int or not 72 <= dpi <= 400:
        raise ValueError("Choose a PDF page rendering resolution between 72 and 400 dpi.")
    image = inside(project, record.parent / "ocr" / "rendered" / f"{n:05d}-{dpi}.png")
    evidence = inside(project, image.with_suffix(".json"))
    if evidence.exists() and image.exists():
        rendered = read_json(evidence)
        if rendered["source_sha256"] == value["sha256"] and rendered["image_sha256"] == digest(image):
            return {**rendered, "image_path": str(image)}
    original = inside(project, record.parent / value.get("original_path", value.get("pdf_path")))
    result = subprocess.run(
        ["pdftoppm", "-f", str(n), "-l", str(n), "-r", str(dpi), "-png", "-singlefile", str(original)],
        capture_output=True, timeout=60,
    )
    if result.returncode or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        detail = result.stderr.decode(errors="replace").strip()[-1000:]
        raise ValueError(f"Could not render PDF page {n}: {detail}")
    write_atomic(image, result.stdout)
    rendered = {"page": n, "dpi": dpi, "source_sha256": value["sha256"], "image_sha256": digest(image)}
    write_json(evidence, rendered)
    return {**rendered, "image_path": str(image)}


def record_page(project, request):
    record, value, n = validated_page(project, request)
    rendered = render_page(project, request)
    if request.get("method") != "codex_pdf_image_ocr" or request.get("image_sha256") != rendered["image_sha256"]:
        raise ValueError("OCR evidence must identify the actual rendered page image and visual OCR method.")
    require_text(request, "markdown")
    reviewer = require_text(request, "reviewer")
    uncertainties = request.get("uncertainties")
    if not isinstance(uncertainties, list) or any(not isinstance(x, str) or not x.strip() for x in uncertainties):
        raise ValueError("Provide an explicit list of uncertainties; an empty list means none.")
    result = {k: rendered[k] for k in ("page", "dpi", "source_sha256", "image_sha256")}
    result.update({"reviewer": reviewer, "method": "codex_pdf_image_ocr", "markdown": request["markdown"],
                   "uncertainties": uncertainties})
    content = json_bytes(result)
    sha = hashlib.sha256(content).hexdigest()
    old_hash = value["page_sha256"].get(str(n))
    if old_hash and old_hash != sha and request.get("replace_sha256") != old_hash:
        raise ValueError("The page already has an OCR record; bind an explicit correction to its prior SHA-256.")
    page_path = inside(project, record.parent / "ocr" / "pages" / f"{n:05d}-{sha}.json")
    if not page_path.is_file() or digest(page_path) != sha:
        write_atomic(page_path, content)
    if old_hash != sha:
        value["page_sha256"][str(n)] = sha
        value["complete"] = False
        if request["kind"] == "target":
            value["proof_source_path"] = None
        write_json(record, value)
    return {"page": n, "page_sha256": sha}


def finish_ocr(project, request):
    kind, name = request.get("kind"), request.get("id")
    value = checked_record(project, kind, name)
    record = record_path(project, kind, name)
    if "page_count" not in value:
        raise ValueError("OCR applies only to PDF manuscripts or PDF references.")
    if value["complete"]:
        return public_record(record, value)
    chunks = ["# Original PDF transcription\n", f"\nOriginal SHA-256: `{value['sha256']}`\n"]
    for page in range(1, value["page_count"] + 1):
        sha = value["page_sha256"].get(str(page))
        if not sha:
            raise ValueError(f"OCR remains incomplete: PDF page {page} has no visual transcription.")
        path = inside(project, record.parent / "ocr" / "pages" / f"{page:05d}-{sha}.json")
        if not path.is_file() or digest(path) != sha:
            raise ValueError(f"OCR checkpoint for page {page} is missing or changed; recheck that page.")
        row = read_json(path)
        if row["page"] != page or row["source_sha256"] != value["sha256"]:
            raise ValueError(f"OCR checkpoint for page {page} is bound to a different original.")
        chunks.append(f"\n## PDF page {page}\n\n{row['markdown']}\n")
        if row["uncertainties"]:
            chunks.append("\nTranscription uncertainties\n\n")
            chunks.extend(f"- {item}\n" for item in row["uncertainties"])
    sidecar = inside(project, record.parent / value["sidecar_path"])
    content = "".join(chunks).encode()
    sha = hashlib.sha256(content).hexdigest()
    if sidecar.exists() and digest(sidecar) not in (value.get("sidecar_sha256"), sha):
        raise ValueError(f"Transcription exists with unrecorded changes; preserve it before continuing: {sidecar}")
    write_atomic(sidecar, content)
    value.update({"complete": True, "sidecar_sha256": sha})
    if kind == "target":
        value["proof_source_path"] = value["sidecar_path"]
    write_json(record, value)
    return public_record(record, value)


def checked_locations(value, page_count):
    locators = value.get("cited_locations_physical_pages")
    if not isinstance(locators, dict) or not locators:
        raise ValueError("Attach the actual result locators and physical PDF pages used.")
    for locator, pages in locators.items():
        if (
            not isinstance(locator, str) or not locator.strip()
            or not isinstance(pages, list) or not pages
            or any(type(n) is not int or not 1 <= n <= page_count for n in pages)
        ):
            raise ValueError("Each result locator needs verified physical pages in the original PDF.")
    return locators


def verify_citations(project, request):
    cutoff = cutoff_for(project, request)
    entries = request.get("sources")
    if not isinstance(entries, list):
        raise ValueError("Provide the sources list; use [] when no source is used.")
    sources = []
    for row in entries:
        ref_id = require_text(row, "id")
        record = record_path(project, "reference", ref_id)
        value = checked_record(project, "reference", ref_id)
        if cutoff and value["public_date"] > cutoff:
            raise ValueError(f"{ref_id} was published after the target version cutoff ({cutoff}).")
        if not value["complete"]:
            raise ValueError(f"{ref_id} is missing a completed OCR transcription.")
        if row.get("sha256") != value["sha256"]:
            raise ValueError(f"{ref_id} citation evidence must bind the original's SHA-256.")
        checked = checked_locations(row, value["page_count"])
        actual = inside(project, record.parent / value["pdf_path"])
        sources.append({**value, "citation_key": bib_key(row.get("citation_key", value["citation_key"])),
                        "pdf_path": str(actual), "cited_locations_physical_pages": checked})
    if len({item["citation_key"] for item in sources}) != len(sources):
        raise ValueError("Each citation key must bind exactly one verified source version.")
    return {"sources": sources}


def cutoff_for(project, request):
    if request.get("task_id"):
        target = checked_record(project, "target", request["task_id"])
        if "cutoff" in request and request["cutoff"] != target["cutoff"]:
            raise ValueError("The request must use the exact saved target version cutoff.")
        return target["cutoff"]
    return date(request["cutoff"], "cutoff") if request.get("cutoff") else None


def missing_path(project, request):
    if not request.get("task_id"):
        return None
    task_id = identifier(request.get("task_id"))
    checked_record(project, "target", task_id)
    work = identifier(request.get("work_key"))
    return inside(project, task_directory(project, task_id) / "unavailable-sources" / f"{work}.json")


def record_unavailable(project, request):
    path = missing_path(project, request)
    if not path:
        raise ValueError("A source unavailability record belongs to an active target-version task.")
    resolution = request.get("resolution")
    if resolution not in ("unobtainable", "waived_optional"):
        raise ValueError("Record whether the user confirmed the PDF is unobtainable or waived this optional use.")
    if request.get("required") is True and resolution == "waived_optional":
        raise ValueError("A source the current proof needs cannot be waived as optional.")
    history = read_json(path) if path.exists() else []
    value = {
        "work_key": identifier(request.get("work_key")),
        "resolution": resolution,
        "reason": require_text(request, "reason"),
        "date": dt.date.today().isoformat(),
    }
    if "version" in request:
        value["version"] = require_text(request, "version")
    if value not in history:
        write_json(path, [*history, value])
    return value


def publication_path(project, work, cutoff):
    suffix = cutoff or "current"
    return inside(project, project / "references" / ".publication" / work / f"{suffix}.json")


def record_publication(project, request):
    work = identifier(request.get("work_key"))
    cutoff = cutoff_for(project, request)
    raw = request.get("candidates", [])
    if not isinstance(raw, list):
        raise ValueError("Provide a list of discovered reference candidates.")
    versions = [candidate(row, work=work) for row in raw]
    status = request.get("status")
    if status not in ("checked", "unresolved"):
        raise ValueError("Publication status is checked or unresolved.")
    path = publication_path(project, work, cutoff)
    evidence = {
        "work_key": work,
        "cutoff": cutoff,
        "status": status,
        "checked_at": date(request.get("checked_at"), "publication check date"),
        "evidence": require_text(request, "evidence"),
        "candidates": versions,
    }
    if path.exists():
        previous = read_json(path)
        if previous != evidence:
            sha = hashlib.sha256(json_bytes(previous)).hexdigest()
            history = inside(project, path.parent / "history" / f"{path.stem}-{sha}.json")
            if not history.exists():
                write_json(history, previous)
    write_json(path, evidence)
    return evidence


def choose_source(project, request):
    work = identifier(request.get("work_key"))
    cutoff = cutoff_for(project, request)
    local = catalog(project, work)
    path = publication_path(project, work, cutoff)
    evidence = read_json(path) if path.exists() else None
    missing = missing_path(project, request)
    unavailable = read_json(missing) if missing is not None and missing.exists() else []
    result = select_source(request, local, cutoff, evidence, unavailable)
    if result.get("state") == "ready":
        ref = checked_record(project, "reference", result["source"]["id"])
        result["source"].update(public_record(record_path(project, "reference", ref["id"]), ref))
    return result


def list_references(project):
    return {"references": catalog(project), "pdfs": [
        str(path.relative_to(project))
        for path in sorted((project / "references").rglob("*"))
        if path.suffix.lower() == ".pdf" and path.resolve().is_relative_to(project)
    ]}


def main():
    with_request = {
        "init-target": init_target, "register-reference": register_reference, "render-page": render_page,
        "record-page": record_page, "finish-ocr": finish_ocr, "verify-citations": verify_citations,
        "record-unavailable": record_unavailable, "record-publication": record_publication,
        "select-source": choose_source,
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("action", choices=[
        *with_request, "target-status", "reference-status", "init-git", "list-references", "arxiv-link",
    ])
    parser.add_argument("input", nargs="?")
    args = parser.parse_args()
    try:
        if sys.platform != "darwin":
            raise ValueError("Proof2Game's authoring environment is macOS with ChatGPT Desktop/Codex.")
        project = args.project.expanduser().resolve(strict=True)
        if not project.is_dir():
            raise ValueError("The project location must be an existing folder.")
        if args.action in with_request:
            if not args.input:
                raise ValueError("Provide a JSON request path or '-' for standard input.")
            request = json.load(sys.stdin) if args.input == "-" else read_json(Path(args.input))
            if args.action in ("verify-citations", "select-source"):
                result = with_request[args.action](project, request)
            else:
                with lock(project):
                    result = with_request[args.action](project, request)
        elif args.action == "init-git":
            result = init_git(project)
        elif args.action == "list-references":
            result = list_references(project)
        elif args.action == "arxiv-link":
            result = arxiv_link(args.input)
        else:
            kind = args.action.removesuffix("-status")
            record = record_path(project, kind, args.input)
            result = public_record(record, checked_record(project, kind, args.input))
    except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        parser.exit(2, f"Proof2Game intake: {error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
