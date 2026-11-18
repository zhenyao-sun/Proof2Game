"""Deterministic reference version selection from local and verified discovery records."""

from calendar import monthrange
import datetime as dt
import json
import re
from urllib.parse import urlparse


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value):
        raise ValueError("Use an identifier containing letters, digits, underscores, periods or hyphens.")
    return value


def bib_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[^\s{},\\]+", value):
        raise ValueError("Attach a valid, nonempty bibliography key.")
    return value


def require_text(value, key):
    text = value.get(key)
    if not isinstance(text, str) or not text.strip():
        raise ValueError(f"Provide {key}.")
    return text.strip()


def date(raw, label):
    if not isinstance(raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raise ValueError(f"Provide an exact {label} (YYYY-MM-DD).")
    return dt.date.fromisoformat(raw).isoformat()


def publication_bounds(raw):
    if isinstance(raw, str) and re.fullmatch(r"\d{4}(?:-\d{2})?", raw):
        if len(raw) == 4:
            return date(raw + "-01-01", "reference year"), raw + "-12-31"
        first = date(raw + "-01", "reference month")
        last_day = monthrange(int(raw[:4]), int(raw[5:]))[1]
        return first, f"{raw}-{last_day:02d}"
    exact = date(raw, "reference publication date")
    return exact, exact


def published_by(public_date, cutoff):
    return publication_bounds(public_date)[1] <= cutoff


def url(raw, label):
    if not isinstance(raw, str):
        raise ValueError(f"Provide the public {label}.")
    parsed = urlparse(raw)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"Provide a public http(s) {label}.")
    return raw


def candidate(row, *, work=None):
    work_key = identifier(row.get("work_key", work) or row.get("citation_key") or row.get("id"))
    if work and work_key != work:
        raise ValueError("Publication evidence must identify the requested work.")
    edition = row.get("edition")
    if edition not in ("published", "preprint"):
        raise ValueError("Record whether this is the published edition (including online-first) or a preprint.")
    authors = row.get("authors")
    if not isinstance(authors, list) or not authors or any(not isinstance(name, str) or not name.strip() for name in authors):
        raise ValueError("Record the source's author names as a JSON list.")
    publication_date = row.get("public_date")
    publication_bounds(publication_date)
    value = {
        "work_key": work_key,
        "citation_key": bib_key(row.get("citation_key", work_key)),
        "title": require_text(row, "title"),
        "authors": authors,
        "edition": edition,
        "version": require_text(row, "version"),
        "public_date": publication_date,
        "source_url": url(row.get("source_url"), "version URL"),
        "publication_evidence": require_text(row, "publication_evidence"),
    }
    if row.get("doi") is not None:
        doi = require_text(row, "doi")
        if not re.fullmatch(r"10[.][0-9]{4,9}/[^\s]+", doi):
            raise ValueError("Provide the bare DOI of the exact selected edition.")
        value["doi"] = doi
    if "id" in row:
        value["id"] = identifier(row["id"])
    return value


def catalog(project, work=None):
    base = project / "references"
    if not base.resolve().is_relative_to(project):
        raise ValueError("references/ must resolve inside the current project.")
    results = []
    for path in sorted(base.glob("*/source.json")):
        if not path.resolve().is_relative_to(base.resolve()):
            continue
        row = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(row, dict) and row.get("kind") == "original_external_source" and "work_key" not in row:
            # Mathematician stores its own receipt here. The original PDF is
            # still discoverable through intake's PDF inventory.
            continue
        if (not isinstance(row, dict) or row.get("schema") != 1
                or row.get("id") != path.parent.name or not isinstance(row.get("work_key"), str)):
            raise ValueError(f"Unrecognized reference record: {path}")
        if work is None or row["work_key"] == work:
            results.append(row)
    return results


def version_identity(row):
    return (row["work_key"], row["edition"], row["version"], row["public_date"])


def select_source(request, local, cutoff, record, unavailable):
    """Return a coordinator action. Network searches and mathematical reading are external."""
    work = identifier(request.get("work_key"))
    required = request.get("required", True)
    if not isinstance(required, bool):
        raise ValueError("required must be a Boolean.")
    preferred = request.get("preferred_version")
    if preferred is not None and (not isinstance(preferred, str) or not preferred.strip()):
        raise ValueError("Specify a concrete reference version or reference ID.")
    checked = record is not None and record["status"] == "checked"
    local_ids = {version_identity(row) for row in local}
    online = [row for row in (record["candidates"] if record else [])
              if version_identity(row) not in local_ids]
    versions = [*online, *local]
    if preferred is not None:
        versions = [row for row in versions if preferred in (row.get("id"), row["version"])]
    uncertain = []
    if cutoff is not None:
        dated = [(row, publication_bounds(row["public_date"])) for row in versions]
        uncertain = [row for row, (first, last) in dated if first <= cutoff < last]
        versions = [row for row, (_, last) in dated if last <= cutoff]
    published = [row for row in versions if row["edition"] == "published"]
    if uncertain and (not versions or (preferred is None and not published
                                      and any(row["edition"] == "published" for row in uncertain))):
        return {"state": "check_publication", "work_key": work, "cutoff": cutoff,
                "uncertain_candidates": uncertain}
    if published and preferred is None:
        versions = published
    if not versions and checked:
        return {"state": "no_eligible_version", "work_key": work, "cutoff": cutoff}

    # A dated explicit user resolution is task-specific. If the missing PDF has
    # since arrived, use it. A new proof dependency still takes the required path.
    matching_absences = [
        entry for entry in unavailable
        if "version" not in entry
        or entry["version"] == preferred
        or any(entry["version"] in (item["version"], item.get("id")) for item in versions)
    ]
    if matching_absences and not any("pdf_path" in item for item in versions):
        absence = matching_absences[-1]
        if not required:
            return {"state": "optional_skip", "work_key": work, "reason": absence["reason"]}
        if absence["resolution"] == "unobtainable":
            return {"state": "required_unobtainable", "work_key": work, "reason": absence["reason"]}
    if not checked and not published and (preferred is None or not versions):
        return {"state": "check_publication", "work_key": work, "cutoff": cutoff,
                "local_candidates": [row for row in versions if "pdf_path" in row]}
    if not versions:
        return {"state": "no_eligible_version", "work_key": work, "cutoff": cutoff}
    versions.sort(key=lambda row: (row["public_date"], row["version"]), reverse=True)
    if len(versions) > 1:
        return {"state": "choose_version", "work_key": work, "candidates": versions}
    chosen = versions[0]
    if "pdf_path" not in chosen:
        return {"state": "need_pdf", "work_key": work, "source": chosen, "required": required}
    if not chosen["complete"]:
        return {"state": "need_ocr", "work_key": work, "source": chosen}
    if request.get("for_use", True):
        facts = request.get("result_evidence", {})
        if (not isinstance(facts, dict) or facts.get("sha256") != chosen["sha256"]
                or not isinstance(facts.get("locator"), str) or not facts["locator"].strip()):
            return {"state": "check_result", "work_key": work, "source": chosen}
    return {"state": "ready", "work_key": work, "source": chosen}
