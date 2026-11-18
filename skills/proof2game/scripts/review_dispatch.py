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
        "Check for concrete external sources used by this component. Manuscript-local references do not require an "
        "external PDF. If there is no external source usage, return pass with sources:[] without a lookup. "
        "For each external source used, verify its exact version, conditions, scope and instantiation against the "
        "eligible original PDF. A necessary missing PDF requires a source wait with its exact identity and use. "
        "A nonpublic dependency is a source defect."
    ),
    "reuse": (
        "Investigate concrete opportunities to replace nontrivial repeated derivation with a verified eligible "
        "reference. A nonpass requires a current unresolved issue in attribution, relation to known work, or needless "
        "derivation, with an exact location and evidence from the original PDF. Appropriate application and attribution "
        "can resolve even substantial overlap. If there is no concrete reuse opportunity or external source used "
        "at this gate, return pass with sources:[] without a lookup. A concrete optional opportunity with a missing "
        "PDF requires a source wait."
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
        "Check definitions, scope, notation, hypotheses and compatibility with inherited settings. A Convention may "
        "state a labelled, fully specified theorem-like interface for a directly cited external result, even if its "
        "proof is nontrivial. Treat the stated external result as a provisional premise here and verify its exact "
        "source, scope and applicability at the sources gate. Flag a manuscript claim or nontrivial transfer "
        "argument that needs its own Statement and Proof. A citation alone cannot justify such an extra deduction."
    ),
    ("statement", "expression"): (
        "Check readability with the actual preceding material and transition. "
        "A blank adjacent_prose field means no intervening prose is written. Use the supplied preceding_component "
        "or preceding_proof_transition_excerpt when present. Flag a missing transition only if the manuscript needs one. "
        "Request only a precise excerpt if unsupplied preceding material is necessary for this judgment. "
        "surrounding_heading names the enclosing section or proof node as internal context. "
        "statement_navigation describes this Statement. Use its kind, optional title, and proof location "
        "to judge the reader-visible navigation."
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

# These commands require only the detached packet and Python's standard library.
VERIFY_PACKET = r"""import hashlib, json, pathlib, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
if hashlib.sha256(data).hexdigest() != sys.argv[2]:
    raise SystemExit('review packet SHA-256 mismatch')
packet = json.loads(data)
"""

READ_CHUNK = VERIFY_PACKET + r"""
def fields(value, names=()):
    if isinstance(value, dict) and value:
        for key, child in value.items():
            yield from fields(child, (*names, key))
    elif isinstance(value, list) and value:
        for index, child in enumerate(value, 1):
            yield from fields(child, (*names, str(index)))
    else:
        label = ' / '.join(names)
        body = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        yield f'[{label}]\n{body}'

start = int(sys.argv[3])
text = '\n\n'.join(fields(packet))
if not 0 <= start < len(text):
    raise SystemExit('invalid review packet offset')
end = min(start + 4000, len(text))
print(f'packet characters [{start},{end}) of {len(text)}')
print(text[start:end], end='')
"""

FORMAT_RECEIPT = VERIFY_PACKET + r"""
binding = {key: packet[key] for key in ('token', 'snapshot_digest', 'component', 'gate')}
binding['packet_sha256'] = sys.argv[2]
verdict = json.load(sys.stdin)
if not isinstance(verdict, dict) or (binding.keys() | {'session'}) & verdict.keys():
    raise SystemExit('provide one verdict object without packet bindings or session')
print(json.dumps({**binding, **verdict}, ensure_ascii=False))
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
            "searches and PDFs. In the mathematics gate take fully stated external interfaces as provisional premises. "
            "Omit the sources field entirely at this gate."
        )
    else:
        lines.append(
            "Outside the packet, use only source material separately granted by the coordinator for this gate. For a "
            "concrete external source needed at this gate, ask the coordinator to search the project's references "
            "first and then the web if needed, and verify the eligible original PDF directly. In a Statement gate, "
            "check only sources used by that Statement or its "
            "interfaces. A paired proof passage is only for locating how those sources apply. "
            "Proof-only citations belong to the separate Proof gate. If an application check needs a missing passage, "
            "ask for that precise passage. Keep earlier gate results independent."
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
            'to arrays of integer physical PDF page numbers, e.g. {"Theorem 2": [8], "Lemma 3": [9, 10]}. '
            "Include a resolved required source with its bound ID and SHA-256. "
            "Use an empty array when no external source was used at this gate."
        )
        lines.append(
            "For a missing applicable external source, return waiting-source with source (stable project work key), "
            "required (boolean), and exact location. Set source_version to the exact known edition or omit it if unknown. "
            "Identify the missing external work and its use in evidence."
        )
    command = shlex.join(["python3", "-c", READ_CHUNK, str(path), packet_sha256, "0"])
    format_receipt = shlex.join(["python3", "-c", FORMAT_RECEIPT, str(path), packet_sha256])
    lines.extend([
        "Run the next command to read the decoded packet fields. Repeat with the last argument set to each "
        "returned chunk's end until complete. "
        "If packet verification fails or required packet input is missing from delivery, tell the coordinator separately "
        "and withhold a verdict.",
        command,
        "Write one JSON object containing verdict, a nonempty English evidence string, and any gate-specific fields. "
        "Use pass for no substantive defect or nonpass for a defect. "
        "For nonpass, include issue and location as separate nonempty top-level strings. "
        "Pass this object on stdin to the next command and return its JSON output. The command verifies the packet "
        "and adds the token, snapshot_digest, component, gate and packet_sha256. "
        "The coordinator binds the actual host session before recording the result.",
        format_receipt,
    ])
    return "\n".join(lines)


def packet_bytes(packet):
    return (json.dumps(packet, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def detach(main, packet):
    encoded = packet_bytes(packet)
    packet_sha256 = hashlib.sha256(encoded).hexdigest()
    scratch = Path(tempfile.gettempdir()).resolve()
    require(not scratch.is_relative_to(main.parent.resolve()), "detached Reviewer scratch must be outside the script directory")
    path = Path(tempfile.mkdtemp(prefix="proof2game-review-", dir=scratch)) / "gate.json"
    path.write_bytes(encoded)
    path.chmod(0o400)
    return {"path": str(path), "sha256": packet_sha256, "message": worker_prompt(packet, path, packet_sha256)}


def current_review(task, token):
    status = state.transact(task, {"op": "status"})
    require(not status["stale"], "live script and ledger differ")
    action = next((item for item in status["actions"] if item["token"] == token), None)
    require(action is not None, "no current assignment matches this review token")
    cutoff = status["state"]["target"].get("cutoff")
    packet = build_packet(task / "main.tex", action, cutoff=cutoff)
    return status["state"]["revision"], action, packet


def prepare(task, token):
    task = intake.resolve_task_path(task)
    revision, action, packet = current_review(task, token)
    result = detach(task / "main.tex", packet)
    result.update(
        revision=revision,
        token=packet["token"],
        snapshot_digest=packet["snapshot_digest"],
        operation="continue" if action["identity"] else "fresh",
        session=action["identity"]["session"] if action["identity"] else None,
        model=action["model"],
        effort=action["effort"],
        tool_release=action["tool_release"],
    )
    return result


def accept_receipt(task, token, session, receipt):
    require(isinstance(receipt, dict), "expected one Reviewer receipt object")
    task = intake.resolve_task_path(task)
    revision, action, packet = current_review(task, token)
    require(action["identity"] and session == action["identity"]["session"],
            "receipt must come from the bound Reviewer session")
    binding = {key: packet[key] for key in ("token", "snapshot_digest", "component", "gate")}
    binding["packet_sha256"] = hashlib.sha256(packet_bytes(packet)).hexdigest()
    require(all(receipt.get(key) == value for key, value in binding.items()),
            "receipt does not match the current detached review packet")
    fields = ("verdict", "evidence", "issue", "location", "sources", "source", "source_version", "required")
    request = {key: receipt[key] for key in fields if key in receipt}
    return state.transact(task, {**request, **binding, "op": "result",
                                "expected_revision": revision, "session": session})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, type=Path)
    parser.add_argument("--token", required=True)
    parser.add_argument("--receipt", help="Record the supplied receipt file, or - for stdin.")
    parser.add_argument("--session", help="Host session observed returning the receipt.")
    arguments = parser.parse_args()
    if bool(arguments.receipt) != bool(arguments.session):
        parser.error("--receipt and --session must be used together")
    try:
        if arguments.receipt:
            receipt = (json.load(sys.stdin) if arguments.receipt == "-"
                       else json.loads(Path(arguments.receipt).read_text(encoding="utf-8")))
            result = accept_receipt(arguments.task, arguments.token, arguments.session, receipt)
        else:
            result = prepare(arguments.task, arguments.token)
    except (KeyError, ValueError, TypeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
