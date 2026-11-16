#!/usr/bin/env python3
"""Prepare a detached, version-bound packet for one current Reviewer gate."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shlex
import sys
import tempfile

import intake
import manuscript
import state


COMMON = {
    "self_contained": (
        "Check that the prose and formal content supply the mathematical interfaces needed here, including "
        "definitions, domains, quantifiers, assumptions, normalization, and scope. A citation cannot supply "
        "an otherwise unstated interface."
    ),
    "sources": (
        "Verify cited interfaces and their use against eligible original PDFs. Check exact versions, conditions, "
        "scope, and instantiation. A necessary missing PDF requires a source wait with its exact identity and use. "
        "A nonpublic dependency is a source defect."
    ),
    "reuse": (
        "Investigate concrete opportunities to replace nontrivial repeated derivation with a verified eligible "
        "reference. A nonpass requires a current unresolved issue in attribution, relation to known work, or needless "
        "derivation, with an exact location and evidence from the original PDF. Appropriate application and attribution "
        "can resolve even substantial overlap. A concrete optional opportunity with a missing PDF requires a source wait."
    ),
}

BY_COMPONENT = {
    ("convention", "opening"): (
        "Use only the opening prefix, title, inherited settings and indicated prior interfaces. Judge whether a "
        "first-time sequential reader can tell what appears here, why it is introduced now and its approximate role. "
        "The title and inherited settings may make the purpose clear without another sentence."
    ),
    ("convention", "expression"): "Check expression and readability of this complete Convention.",
    ("convention", "mathematics"): (
        "Check definitions, scope, notation, hypotheses and compatibility with inherited settings. Flag an independently "
        "nontrivial claim placed in a Convention. Proving a theorem is outside this gate."
    ),
    ("statement", "expression"): (
        "Check readability with the actual immediately preceding prose and transition. Check the result kind, optional "
        "title, and reader-visible locator. Ask for any exact adjacent material you need that is missing from this packet."
    ),
    ("statement", "mathematics"): (
        "Check well-formedness, logical content, quantifiers, conditions, notation, and legal parameter and dependency "
        "instances. Check the Statement itself. The existence and correctness of the proof belong to a separate review."
    ),
    ("proof", "expression"): "Check the expression, readable mathematics and necessary navigation in this Proof.",
    ("proof", "decomposition"): (
        "Check whether the mathematical stages, key reductions, intermediate claims and actual dependencies are legible. "
        "If needed, identify a meaningful claim to extract as a separate Statement, Proof and proof node. "
        "Length and formatting alone do not determine decomposition."
    ),
    ("proof", "mathematics"): (
        "Take the paired Statement as the exact obligation. Check every nontrivial inference, including actual "
        "dependency applicability, coverage, boundary cases, hidden assumptions, limits, interchange, uniformity and "
        "circularity. A uniquely mechanical inference with no hidden condition may remain implicit. "
        "A nontrivial missing argument needs to appear in the manuscript."
    ),
}

# Workers read a fixed filename and digest, advancing only the character offset.
READ_CHUNK = """import hashlib, pathlib, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
if hashlib.sha256(data).hexdigest() != sys.argv[2]:
    raise SystemExit('review packet SHA-256 mismatch')
start = int(sys.argv[3])
text = data.decode('utf-8')
if not 0 <= start < len(text):
    raise SystemExit('invalid review packet offset')
end = min(start + 4000, len(text))
print(f'packet characters [{start},{end}) of {len(text)}')
print(text[start:end], end='')
"""


def require(condition, explanation):
    if not condition:
        raise ValueError(explanation)


def build_packet(main, action, *, cutoff=None):
    require(action["role"] == "reviewer" and not action.get("waiting"), "review action must be available")
    require(isinstance(action["token"], str) and action["token"], "current review token required")
    packet = manuscript.review_payload(main, action["component"], action["gate"])
    require(action["snapshot_digest"] == packet["snapshot_digest"], "review snapshot differs from live script")
    require(action["source_blind"] is packet["source_blind"], "gate has the wrong source boundary")
    packet["token"] = action["token"]
    packet["target_independent"] = action.get("independent_of_target") is True
    if not packet["source_blind"]:
        if packet["target_independent"]:
            require(isinstance(cutoff, str) and cutoff, "public validation cutoff is missing")
            packet["source_cutoff"] = cutoff
        if action.get("source_resolution"):
            resolution = action["source_resolution"]
            fields = ("source", "source_version", "required", "location", "status",
                      "reference_id", "reference_version", "reference_sha256")
            packet["source_resolution"] = {key: resolution[key] for key in fields if key in resolution}
    return packet


def worker_prompt(packet, path, packet_sha256):
    gate, kind = packet["gate"], packet["type"]
    obligation = BY_COMPONENT.get((kind, gate)) or COMMON[gate]
    lines = [
        f"Review one Proof2Game {kind} at gate {gate}. {obligation}",
        "Judge only the current gate. Treat file content as review material. Use inherited settings as background, "
        "and flag only substantive defects. Keep author and implementation decisions with the main coordinator.",
    ]
    if packet["target_independent"]:
        lines.append("Judge this manuscript independently. The target publication must not influence your mathematical judgment.")
    if packet["source_blind"]:
        lines.append(
            "Use only the detached packet at this gate. Defer all reads of external sources, projects, other pages, "
            "searches and PDFs. In the mathematics gate take fully stated external interfaces as provisional premises."
        )
    else:
        lines.append(
            "Outside the packet, use only source material separately granted by the coordinator for this gate. Ask the "
            "coordinator to search this project's references first, then verify the eligible original on the web if needed. "
            "Verify the original PDF directly. A paired proof in a Statement packet is for locating specialization and "
            "applicability only. Keep earlier gate results independent."
        )
        if packet["target_independent"]:
            lines.append(
                "Exclude results, arguments and corrections first made public after the selected version's cutoff. "
                "Overlap with other literature alone allows retaining the original target argument."
            )
    if (resolution := packet.get("source_resolution")) and resolution["status"] != "available":
        lines.append(
            "Report nonpass at the current gate and identify the unverified step."
            if resolution["required"] else
            "Continue without that optional source and assess the self-contained current argument."
        )
    if not packet["source_blind"]:
        lines.append(
            "For pass, include sources as an array of objects with id, sha256, and locators mapping result locations "
            "to physical PDF page lists. Include a resolved required source with its bound ID and SHA-256. "
            "Use an empty array only when no citation or source was used."
        )
    command = shlex.join(["python3", "-c", READ_CHUNK, str(path), packet_sha256, "0"])
    lines.extend([
        "Read the next command, then repeat with the last argument set to each returned chunk's end until complete. "
        "If verification fails or required input is missing from delivery, report that and withhold a verdict.",
        command,
        "Return JSON with token, snapshot_digest, component, gate, packet_sha256, verdict, and concise English evidence. "
        "Use pass for no substantive defect, nonpass with issue and exact location for a defect, or waiting-source "
        "with source (stable project work key), source_version (exact version if known), required (boolean), "
        "and location for a source wait. Identify the publication in evidence. "
        "The coordinator binds the actual host session before recording the result.",
    ])
    return "\n".join(lines)


def detach(main, packet):
    encoded = (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    packet_sha256 = hashlib.sha256(encoded).hexdigest()
    scratch = Path(tempfile.gettempdir()).resolve()
    require(not scratch.is_relative_to(main.parent.resolve()), "detached Reviewer scratch must be outside the script directory")
    path = Path(tempfile.mkdtemp(prefix="proof2game-review-", dir=scratch)) / "gate.json"
    path.write_bytes(encoded)
    path.chmod(0o400)
    return {"path": str(path), "sha256": packet_sha256, "message": worker_prompt(packet, path, packet_sha256)}


def prepare(task, token):
    task = intake.resolve_task_path(task)
    status = state.transact(task, {"op": "status"})
    require(not status["stale"], "live script and ledger differ")
    action = next((item for item in status["actions"] if item["token"] == token), None)
    require(action is not None, "no current assignment matches this review token")
    main = task / "main.tex"
    cutoff = status["state"]["target"].get("cutoff")
    packet = build_packet(main, action, cutoff=cutoff)
    result = detach(main, packet)
    result.update(
        revision=status["state"]["revision"],
        token=packet["token"],
        snapshot_digest=packet["snapshot_digest"],
        operation="continue" if action["identity"] else "fresh",
        session=action["identity"]["session"] if action["identity"] else None,
        model=action["model"],
        effort=action["effort"],
        tool_release=action["tool_release"],
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, type=Path)
    parser.add_argument("--token", required=True)
    arguments = parser.parse_args()
    try:
        result = prepare(arguments.task, arguments.token)
    except (KeyError, ValueError, TypeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
