#!/usr/bin/env python3
"""Task-local verification ledger. JSON operations record real role evidence."""
import argparse
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
import zipfile

import intake
from intake import resolve_task_path
import manuscript

GATES = {
    "statement": ("expression", "self_contained", "mathematics", "sources", "reuse"),
    "proof": ("expression", "decomposition", "self_contained", "mathematics", "sources", "reuse"),
    "convention": ("opening", "expression", "self_contained", "mathematics", "sources", "reuse"),
}
STATE_FILE = "state.json"
JOURNAL_FILE = "state.pending.json"
SCRIPT_SUFFIXES = {
    ".tex", ".sty", ".cls", ".def", ".cfg", ".clo", ".bib", ".bst", ".png", ".jpg",
    ".jpeg", ".svg", ".eps", ".pdf", ".ttf", ".otf", ".csv", ".dat", ".tikz",
}
RESERVED_DIRS = {"deliveries", "staging", "originals", "checkpoints", "ocr", ".git", "references"}


class Rejected(ValueError):
    """An operation failed a recorded precondition."""


def require(condition, message):
    if not condition:
        raise Rejected(message)


def evidence(value):
    require(isinstance(value, str) and value.strip(), "nonempty evidence required")
    return value


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def default_models():
    configured = read_json(Path(__file__).resolve().parents[1] / "references" / "roles.json")
    return {role: [value["model"], value["reasoning_effort"]] for role, value in configured.items()}


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=f".{path.name}-", dir=path.parent, delete=False) as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(stream.name, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def json_bytes(record):
    return (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode()


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def confined(root, name):
    require(isinstance(name, str) and name, "expected a task-relative path")
    relative = Path(name)
    output = root / relative
    require(not relative.is_absolute() and ".." not in relative.parts and output.resolve().is_relative_to(root),
            f"path leaves its working directory: {name}")
    require(output.absolute() == output.resolve(), f"symlink in managed path: {name}")
    return output


def components(snapshot):
    return {component["id"]: component for component in snapshot["components"]}


def root_target(task):
    target = read_json(task / "target.json")
    require(target["project_type"] in ("unpublished", "public"), "unknown project type")
    require(target["id"] == task.name, "target identity does not match its version work directory")
    if target["project_type"] == "public":
        require(datetime.date.fromisoformat(target["cutoff"]).isoformat() == target["cutoff"] == target["public_date"],
                "public validation requires the selected version's exact publication date")
    else:
        require(target.get("cutoff") is None, "unpublished validation has no public cutoff")
    original = confined(task, target["original_path"])
    require(file_digest(original) == target["sha256"], "target original differs from its intake record")
    return target


def init(task, target, live, request):
    entry = request["entry"]
    require(entry in ("guided", "verify", "refactor"), "unknown entry")
    tool_release = evidence(request.get("tool_release"))
    goal = request.get("goal")
    if entry != "refactor":
        require(isinstance(goal, dict), "real host Goal receipt required")
        evidence(goal.get("id"))
        evidence(goal.get("evidence"))
    coordinator = request.get("coordinator")
    models = default_models()
    for role, value in request.get("models", {}).items():
        require(role in models and isinstance(value, list) and len(value) == 2, f"bad role configuration: {role}")
        models[role] = [evidence(value[0]), evidence(value[1])]
    if entry != "refactor":
        check_identity(coordinator, models["coordinator"])
    state = {
        "schema": 1, "revision": 0, "phase": "dispatch", "entry": entry, "goal": goal,
        "coordinator": coordinator, "tool_release": tool_release, "target": target, "models": models,
        "snapshot": live, "universe": list(live["main_results"]), "safe": [],
        "round": None, "loop_active": False, "actions": {}, "used_sessions": {},
        "counters": {"rounds": 0, "loops": 0, "explorations": 0}, "history": [],
        "round_serial": 0, "optional_unavailable": {}, "findings": [], "source_results": {},
        "explored_digest": None, "route": None, "attempt": None, "checkpoints": [],
        "delivery": None, "superseded": [], "pause": None, "decision": None,
        "withdrawal": None,
    }
    if entry == "refactor":
        pause(state, "manual-refactor", evidence(request.get("reason")))
    else:
        ensure_checkpoint(task, state)
    return state


def check_identity(identity, config):
    require(isinstance(identity, dict), "real worker identity required")
    require([identity.get("model"), identity.get("effort")] == config, "host role configuration mismatch")
    evidence(identity.get("evidence"))
    return evidence(identity.get("session"))


def record(state, kind, **details):
    state["history"].append({"kind": kind, **details})


def pause(state, kind, reason):
    state["pause"] = {"kind": kind, "reason": reason, "resume": state["phase"]}
    state["phase"] = "paused"
    record(state, "pause", pause=state["pause"])


def ordered(state, ids):
    return [row["id"] for row in state["snapshot"]["components"] if row["id"] in ids]


def unsafe(state):
    return set(state["universe"]) - set(state["safe"])


def live_digest(state):
    return state["snapshot"]["snapshot_digest"]


def role_action(state, role, **context):
    token = uuid.uuid4().hex
    model, effort = state["models"][role]
    state["actions"][token] = {
        "token": token, "role": role, "snapshot_digest": live_digest(state),
        "model": model, "effort": effort, "tool_release": state["tool_release"],
        "identity": None, "waiting": None, **context,
    }
    return state["actions"][token]


def review_action(state, component, review):
    typ = components(state["snapshot"])[component]["type"]
    gate = GATES[typ][review["gate_position"]]
    return role_action(state, "reviewer", round=state["round"]["id"], component=component,
                       gate=gate, source_blind=gate not in ("sources", "reuse"),
                       independent_of_target=state["target"]["project_type"] == "public",
                       identity=review["identity"], source_resolution=review.get("source_resolution"))


def add_reviews(state):
    current = state["round"]
    reviewers = [action for action in state["actions"].values() if action["role"] == "reviewer"]
    running = sum(not action["waiting"] for action in reviewers)
    dispatched = {action["component"] for action in reviewers}
    for component, review in current["reviews"].items():
        if running == 10:
            break
        if component not in dispatched and review["verdict"] is None:
            review_action(state, component, review)
            running += 1


def queue_fixer(state, waits):
    current = state["round"]
    state["phase"] = "fix"
    role_action(state, "fixer", round=current["id"], issues=current["issues"], order=current["batch"],
                cutoff=state["target"].get("cutoff"),
                waiting={"kind": "reviewer-sources", "tokens": waits} if waits else None)


def advance_review(state):
    add_reviews(state)
    actions = state["actions"]
    if any(not action["waiting"] for action in actions.values()):
        return
    current = state["round"]
    if not actions and not current["issues"]:
        finish_round(state, set())
    elif current["batch"] is not None and set(current["batch"]) == set(current["issues"]):
        queue_fixer(state, list(actions))
    else:
        state["phase"] = "batch"
        role_action(state, "batcher", round=current["id"], issues=current["issues"], pending_source_tokens=list(actions))


def reopen_review(state):
    if state["phase"] not in ("batch", "fix"):
        return
    for token, action in list(state["actions"].items()):
        if action["role"] in ("batcher", "fixer"):
            require(action["role"] != "fixer" or not action["identity"], "cannot reopen an active Fixer")
            record(state, "review-resumed-before-fix", action=action)
            del state["actions"][token]
    state["phase"] = "review"


def dispatch(state, task):
    if state["phase"] != "dispatch" or state["actions"]:
        return
    snapshot = state["snapshot"]
    todo = unsafe(state) & set(snapshot["cone"])
    if not state["round_serial"]:
        todo |= unsafe(state) & set(snapshot["main_results"])
    if todo:
        if not state["loop_active"]:
            state["loop_active"] = True
        state["round_serial"] += 1
        reviews = {cid: {"gate_position": 0, "identity": None, "gates": [], "verdict": None}
                   for cid in ordered(state, todo)}
        state["round"] = {"id": state["round_serial"], "reviews": reviews, "issues": {},
                          "dispositions": {}, "batch": None, "staging": None}
        state["phase"] = "review"
        add_reviews(state)
        return
    if state["loop_active"]:
        state["counters"]["loops"] += 1
        state["loop_active"] = False
    if state["explored_digest"] != live_digest(state):
        state["phase"] = "explore"
        cone = set(snapshot["cone"])
        role_action(state, "explorer", cone=snapshot["cone"], added=ordered(state, cone - set(state["universe"])),
                    removed=ordered(state, set(state["universe"]) - cone), cutoff=state["target"].get("cutoff"))
        return
    require(set(snapshot["cone"]) <= set(state["safe"]), "scope is not fully safe")
    if snapshot["open_obligations"]:
        pause(state, "mathematical-blocker", "Open proof obligations: " + ", ".join(snapshot["open_obligations"]))
        return
    check_bound_sources(task, state)
    if state.get("compiled_digest") != live_digest(state):
        record(state, "compiled-script", build=compile_script(task), snapshot_digest=live_digest(state))
        state["compiled_digest"] = live_digest(state)
    if state["attempt"] is not None and state["target"]["project_type"] == "unpublished":
        state["phase"] = "compare"
        role_action(state, "simplification", checkpoint=state["attempt"]["checkpoint"],
                    prior_attempts=route_attempt_history(state))
        return
    state["phase"] = "route"
    role = "public_route" if state["target"]["project_type"] == "public" else "simplification"
    role_action(state, role, cutoff=state["target"].get("cutoff"), prior_attempts=route_attempt_history(state),
                findings=state["findings"], report_sha256=report_digest(task, state["findings"]))


def route_attempt_history(state):
    return [item for item in state["history"] if item["kind"] in ("route-attempt", "route-resolution")]


def report_digest(task, findings):
    if not findings:
        return None
    digest = file_digest(confined(task, "report.md"))
    require(digest is not None, "confirmed hard findings require project report.md")
    return digest


def get_action(state, request, *, bound=False):
    action = state["actions"].get(request.get("token"))
    require(action is not None and request.get("snapshot_digest") == action["snapshot_digest"] == live_digest(state),
            "stale or missing action binding")
    if bound:
        require(action["identity"] and request.get("session") == action["identity"]["session"],
                "the bound role session must return the result")
    return action


def bind(state, request):
    action = get_action(state, request)
    require(not action["identity"] and not action["waiting"], "action already bound or waiting")
    identity = {field: request.get(field) for field in ("session", "model", "effort", "evidence")}
    session = check_identity(identity, [action["model"], action["effort"]])
    require(session not in state["used_sessions"] and session != (state["coordinator"] or {}).get("session"),
            "a fresh independent host session is required")
    state["used_sessions"][session] = {"role": action["role"], "component": action.get("component")}
    action["identity"] = identity
    if action["role"] == "reviewer":
        state["round"]["reviews"][action["component"]]["identity"] = identity


def replace(state, request):
    action = get_action(state, request, bound=True)
    record(state, "lost-session", action=action, evidence=evidence(request.get("evidence")))
    del state["actions"][action["token"]]
    if action["role"] == "reviewer":
        reopen_review(state)
        review = state["round"]["reviews"][action["component"]]
        review.update(gate_position=0, identity=None, gates=[], source_resolution=None)
        add_reviews(state)
        return
    fields = {key: value for key, value in action.items() if key not in
              ("token", "role", "identity", "model", "effort", "tool_release", "waiting", "snapshot_digest",
               "dispositions", "staging")}
    if action["role"] == "fixer" and state["round"] is not None:
        current = state["round"]
        fields.update(dispositions=current["dispositions"], staging=current["staging"], verify_previous_repairs=True)
    role_action(state, action["role"], waiting=action["waiting"], **fields)


def source_wait_version(version):
    if version is None:
        return None
    exact_version = evidence(version)
    # Earlier reviewer prompts led workers to send this placeholder as a version.
    return None if exact_version.strip().casefold() == "unknown" else exact_version


def wait_source(state, action, request):
    if action["role"] == "reviewer":
        require(action["gate"] in ("sources", "reuse"), "source-blind gate cannot request external material")
    role_specific = request.get("required")
    require(isinstance(role_specific, bool), "mark a source as required or optional")
    source = intake.identifier(request.get("source"))
    version = source_wait_version(request.get("source_version"))
    location = evidence(request.get("location"))
    prior = state["optional_unavailable"].get(source)
    if not role_specific and prior and source_wait_version(prior.get("source_version")) == version:
        action["source_resolution"] = {**prior, "source_version": version, "location": location}
        return
    action["waiting"] = {"source": source, "source_version": version, "required": role_specific, "location": location,
                         "evidence": evidence(request.get("evidence"))}
    record(state, "source-wait", action=action["token"], **action["waiting"])
    if action["role"] == "reviewer":
        advance_review(state)


def resolve_source(task, state, request):
    action = get_action(state, request)
    wait = action["waiting"]
    require(wait is not None, "the action is not waiting for a source")
    require(wait.get("kind") != "reviewer-sources", "resolve the waiting Reviewer source using its own token")
    status = request.get("status")
    require(status in ("available", "unavailable", "waived"), "unknown source resolution")
    require(status != "waived" or not wait["required"], "a required source cannot be waived")
    if status == "unavailable" and action["role"] in ("reviewer", "fixer"):
        record(state, "source-still-unavailable", action=action["token"], evidence=evidence(request.get("evidence")))
        if state["phase"] == "review":
            advance_review(state)
        return
    version = source_wait_version(wait.get("source_version"))
    resolution = {**wait, "source_version": version, "status": status, "evidence": evidence(request.get("evidence"))}
    if status == "available":
        reference = intake.checked_record(task.parent.parent, "reference", evidence(request.get("reference_id")))
        cutoff = state["target"].get("cutoff")
        require(reference["complete"] and (not cutoff or intake.published_by(reference["public_date"], cutoff)),
                "source needs completed OCR and an eligible version before resuming")
        require(reference["work_key"] == wait["source"], "reference does not match the requested source work key")
        if version is not None:
            require(reference["version"] == version, "reference does not match the requested source version")
        resolution.update(reference_id=reference["id"], reference_version=reference["version"],
                          reference_sha256=reference["sha256"])
    if action["role"] == "reviewer":
        require(sum(row["role"] == "reviewer" and not row["waiting"] for row in state["actions"].values()) < 10,
                "all Reviewer slots are active; resume this source when a slot opens")
        reopen_review(state)
    action["waiting"] = None
    action["source_resolution"] = resolution
    if action["role"] == "reviewer":
        state["round"]["reviews"][action["component"]]["source_resolution"] = resolution
    if status != "available" and not wait["required"]:
        state["optional_unavailable"][wait["source"]] = resolution
    record(state, "source-resolution", action=action["token"], **resolution)


def verify_source_rows(task, state, rows):
    require(isinstance(rows, list), "provide sources: [] when this decision uses no outside sources")
    if rows:
        normalized = []
        for row in rows:
            require(isinstance(row, dict), "each cited source must be an object")
            item = dict(row)
            if "locators" in item:
                locators = item.pop("locators")
                require(item.get("cited_locations_physical_pages", locators) == locators,
                        "conflicting physical page locators")
                item["cited_locations_physical_pages"] = locators
            normalized.append(item)
        intake.verify_citations(task.parent.parent, {"task_id": state["target"]["id"], "sources": normalized})
    return rows


def check_bound_sources(task, state):
    for cid in state["safe"]:
        for rows in state["source_results"].get(cid, []):
            verify_source_rows(task, state, rows)


def review_result(task, state, action, request):
    current = state["round"]
    cid = action["component"]
    review = current["reviews"][cid]
    verdict = request.get("verdict")
    require(verdict in ("pass", "nonpass"), "expected pass or nonpass")
    if (resolution := action.get("source_resolution")) and resolution["required"] and resolution["status"] == "unavailable":
        require(verdict == "nonpass", "reviewer must report missing indispensable evidence as nonpass")
    result = {"gate": action["gate"], "verdict": verdict, "evidence": evidence(request.get("evidence")),
              "session": action["identity"]["session"], "snapshot_digest": live_digest(state)}
    if not action["source_blind"] and (verdict == "pass" or "sources" in request):
        result["sources"] = verify_source_rows(task, state, request.get("sources"))
    else:
        require("sources" not in request, "source-blind gate cannot receive literature evidence")
    if verdict == "pass" and resolution and resolution["required"] and resolution["status"] == "available":
        reference_id = resolution.get("reference_id")
        sha256 = resolution.get("reference_sha256")
        require(sha256 and any(row.get("id") == reference_id and row.get("sha256") == sha256
                               for row in result.get("sources", [])),
                "pass must cite the resolved required source and its original SHA-256")
        reference = intake.checked_record(task.parent.parent, "reference", reference_id)
        require(reference["work_key"] == resolution["source"] and reference["version"] == resolution.get("reference_version"),
                "resolved required source metadata changed; recheck the source")
    review["gates"].append(result)
    if verdict == "nonpass":
        result["location"] = evidence(request.get("location"))
        result["issue"] = evidence(request.get("issue"))
        current["issues"][action["token"]] = {"component": cid, **result}
        review["verdict"] = verdict
    elif review["gate_position"] + 1 == len(GATES[components(state["snapshot"])[cid]["type"]]):
        review["verdict"] = "pass"
    else:
        review["gate_position"] += 1
        review["source_resolution"] = None
        review_action(state, cid, review)
    advance_review(state)


def finish_round(state, invalidated):
    current = state["round"]
    require(not state["actions"], "worker result pending")
    require(all(item["verdict"] is not None for item in current["reviews"].values()),
            "complete every independent review before closing its round")
    require(set(current["dispositions"]) == set(current["issues"]), "each finding needs a Fixer disposition")
    passed = {cid for cid, item in current["reviews"].items() if item["verdict"] == "pass"}
    state["safe"] = ordered(state, (set(state["safe"]) | passed) & set(state["universe"]) - invalidated)
    for cid in passed & set(state["safe"]):
        state["source_results"][cid] = [gate["sources"] for gate in current["reviews"][cid]["gates"] if "sources" in gate]
    state["source_results"] = {cid: results for cid, results in state["source_results"].items() if cid in state["safe"]}
    state["round"] = None
    state["counters"]["rounds"] += 1
    record(state, "round", round=current, invalidated=ordered(state, invalidated), safe=state["safe"],
           unsafe=ordered(state, unsafe(state)))
    state["phase"] = "dispatch"


def record_fix(state, action, request):
    current = state["round"]
    if request.get("staging"):
        current["staging"] = evidence(request["staging"])
    if request.get("issues"):
        for issue, disposition in request["issues"].items():
            require(issue in current["issues"], "unknown finding")
            require(disposition.get("status") in ("fixed", "resolved", "irrelevant", "clarified", "disagreed", "blocked"),
                    "unknown finding disposition")
            evidence(disposition.get("evidence"))
            current["dispositions"][issue] = {**disposition, "session": action["identity"]["session"]}


def finding_records(task, state, items):
    require(state["target"]["project_type"] == "public", "hard findings are for public targets")
    require(isinstance(items, list), "hard findings must be a list")
    seen = set()
    for item in items:
        for field in ("id", "location", "original_conclusion", "evidence", "verification"):
            evidence(item.get(field))
        require(item["id"] not in seen, "duplicate hard finding")
        seen.add(item["id"])
        if revision := item.get("confirmed_revision"):
            evidence(revision.get("new_conclusion"))
            evidence(revision.get("user_confirmation"))
    report_digest(task, items)
    state["findings"] = items


def finish_explore(state):
    before = set(state["universe"])
    after = set(state["snapshot"]["cone"])
    state["universe"] = ordered(state, after)
    state["safe"] = ordered(state, set(state["safe"]) & after)
    state["source_results"] = {cid: rows for cid, rows in state["source_results"].items() if cid in state["safe"]}
    state["explored_digest"] = live_digest(state)
    state["counters"]["explorations"] += 1
    record(state, "exploration", added=ordered(state, after - before), removed=sorted(before - after),
           snapshot_digest=live_digest(state))
    state["phase"] = "dispatch"


def result(task, state, request):
    action = get_action(state, request, bound=True)
    require(not action["waiting"], "resolve the source wait first")
    role = action["role"]
    outcome = request.get("verdict")
    if outcome == "waiting-source":
        wait_source(state, action, request)
        return
    worker_evidence = evidence(request.get("evidence"))
    record(state, "worker-result", action=action, result=request)
    del state["actions"][action["token"]]
    if role == "reviewer":
        review_result(task, state, action, request)
    elif role == "batcher":
        current = state["round"]
        ordered_issues = request.get("issue_ids")
        require(isinstance(ordered_issues, list) and len(ordered_issues) == len(current["issues"])
                and set(ordered_issues) == set(current["issues"]), "batch must preserve every issue")
        current["batch"] = ordered_issues
        queue_fixer(state, list(state["actions"]))
    elif role == "fixer":
        if "sources" in request:
            verify_source_rows(task, state, request["sources"])
        if action.get("purpose") == "incident":
            check_incident_result(task, state, request)
            return
        record_fix(state, action, request)
        if "report_findings" in request:
            finding_records(task, state, request["report_findings"])
        if outcome == "blocked":
            if state["attempt"] and request.get("attempt_infeasible") is True:
                state["phase"] = "rollback"
                state["attempt"]["rollback_reason"] = worker_evidence
                return
            state["round"]["fixer_identity"] = action["identity"]
            state["phase"] = "fix-interrupted"
            pause(state, "mathematical-blocker", worker_evidence)
        else:
            require(outcome in ("no-change", "candidate"), "unexpected Fixer result")
            require(set(state["round"]["dispositions"]) == set(state["round"]["issues"]), "every finding needs disposition")
            if outcome == "candidate":
                state["phase"] = "apply"
                set_proposal(state, request, "proofreader")
            else:
                require(all(item["status"] not in ("fixed", "blocked") for item in state["round"]["dispositions"].values()),
                        "repairs or blocker require candidate or refactor")
                finish_round(state, set())
    elif role == "explorer":
        if "sources" in request:
            verify_source_rows(task, state, request["sources"])
        require(outcome in ("no-change", "candidate", "blocked"), "unexpected Explorer result")
        if outcome == "candidate":
            state["phase"] = "apply"
            set_proposal(state, request, "optimizer")
        elif outcome == "blocked":
            state["phase"] = "explore-interrupted"
            pause(state, "mathematical-blocker", worker_evidence)
        else:
            finish_explore(state)
    elif role in ("public_route", "simplification"):
        if "sources" in request:
            verify_source_rows(task, state, request["sources"])
        route_result(task, state, action, request)
    elif role == "refactor":
        if "sources" in request:
            verify_source_rows(task, state, request["sources"])
        require(outcome in ("candidate", "no-change", "blocked"), "unexpected implementation result")
        if outcome == "blocked":
            if state["attempt"]:
                state["phase"] = "rollback"
                state["attempt"]["rollback_reason"] = worker_evidence
            else:
                pause(state, "mathematical-blocker", worker_evidence)
        elif outcome == "candidate":
            if state["round"]:
                record_fix(state, action, {**request, "staging": request.get("candidate")})
                incomplete = set(state["round"]["issues"]) - set(state["round"]["dispositions"])
                blocked = any(value["status"] == "blocked" for value in state["round"]["dispositions"].values())
                if incomplete or blocked:
                    resume_fixer(state)
                else:
                    state["phase"] = "apply"
                    set_proposal(state, request, "proofreader")
            else:
                state["phase"] = "apply"
                set_proposal(state, request, "refactor")
        elif state["entry"] == "refactor":
            state["phase"] = "complete"
        else:
            require(not state["attempt"], "a route implementation must change the route or report failure")
            return_to_validation(state)
    else:
        raise Rejected("unknown role")


def set_proposal(state, request, updater):
    state["proposal"] = {
        "path": evidence(request.get("candidate")),
        "snapshot_digest": evidence(request.get("candidate_digest")),
        "updater": updater,
    }


def route_result(task, state, action, request):
    verdict = request.get("verdict")
    result = {"verdict": verdict, "evidence": evidence(request.get("evidence")),
              "session": action["identity"]["session"], "snapshot_digest": live_digest(state)}
    if state["phase"] == "compare":
        require(verdict in ("improved", "worse", "tradeoffs"), "a completed comparison needs its actual outcome")
        decision = request.get("decision") if verdict == "tradeoffs" else ("keep" if verdict == "improved" else "rollback")
        require(decision in ("keep", "rollback"), "coordinator must record tradeoff decision")
        reason = evidence(request.get("decision_evidence")) if verdict == "tradeoffs" else result["evidence"]
        if decision == "rollback":
            state["phase"] = "rollback"
            state["attempt"]["rollback_reason"] = reason
        else:
            record(state, "route-resolution", attempt=state["attempt"], comparison=result, decision=decision, reason=reason)
            state["attempt"] = None
            state["phase"] = "dispatch"
        return
    old_report_digest = action.get("report_sha256")
    require(old_report_digest == report_digest(task, state["findings"]), "hard finding documentation changed during route review")
    result["report_sha256"] = old_report_digest
    project_type = state["target"]["project_type"]
    require(verdict in (("pass", "nonpass") if project_type == "public" else ("no-simplification", "simplify")),
            "route verdict incompatible with project type")
    state["route"] = result
    if verdict in ("pass", "no-simplification"):
        state["phase"] = "approved" if state["entry"] == "guided" else "complete"
        return
    plan = evidence(request.get("plan"))
    checkpoint = ensure_checkpoint(task, state)
    state["attempt"] = {"checkpoint": checkpoint["commit"], "baseline": checkpoint["baseline"],
                        "plan": plan, "route_review": result}
    record(state, "route-attempt", checkpoint=checkpoint["commit"], plan=plan, route_review=result)
    state["phase"] = "implement"
    role_action(state, "refactor", plan=plan, route_result=result, cutoff=state["target"].get("cutoff"))


def script_files(root, excluded=()):
    files = {}
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in RESERVED_DIRS and not name.startswith("."))
        for name in sorted(names):
            path = Path(current) / name
            relative = str(path.relative_to(root))
            if relative in excluded or path.suffix.lower() not in SCRIPT_SUFFIXES or name.startswith("."):
                continue
            path = confined(root, relative)
            require(path.is_file(), f"script resource must be a file: {relative}")
            files[relative] = file_digest(path)
    require("main.tex" in files, f"main.tex missing in {root}")
    return files


def git(project, *args, okay=False):
    result = subprocess.run(["git", "-C", str(project), *args], capture_output=True, check=False)
    if result.returncode and not okay:
        raise Rejected("Git checkpoint failed: " + result.stderr.decode(errors="replace").strip())
    return result


def repository(task):
    project = task.parent.parent
    if git(project, "rev-parse", "--is-inside-work-tree", okay=True).returncode:
        git(project, "init")
    root = Path(git(project, "rev-parse", "--show-toplevel").stdout.decode().strip()).resolve()
    branch = git(project, "symbolic-ref", "--quiet", "--short", "HEAD", okay=True)
    require(not branch.returncode, "select a project work branch before recording checkpoints")
    return root, branch.stdout.decode().strip()


def ensure_checkpoint(task, state):
    root, branch = repository(task)
    files = live_files(task, state["target"])
    baseline = {key: copy.deepcopy(state[key]) for key in
                ("snapshot", "universe", "safe", "source_results", "explored_digest", "route", "findings")}
    same = next((entry for entry in reversed(state["checkpoints"]) if entry["files"] == files and entry["branch"] == branch
                 and entry["baseline"] == baseline), None)
    if same:
        return same
    pathspec = [str((task / path).relative_to(root)) for path in files]
    git(root, "--literal-pathspecs", "add", "--force", "--", *pathspec)
    different = git(root, "--literal-pathspecs", "diff", "--cached", "--quiet", "--", *pathspec, okay=True)
    if different.returncode == 1:
        git(root, "--literal-pathspecs", "-c", "user.name=Proof2Game checkpoint",
            "-c", "user.email=checkpoint@proof2game.invalid", "commit", "--only", "-m",
            f"Proof2Game checkpoint {task.name} {live_digest(state)[:12]}", "--", *pathspec)
    else:
        require(different.returncode == 0, different.stderr.decode(errors="replace"))
    commit = git(root, "rev-parse", "HEAD").stdout.decode().strip()
    checkpoint = {"commit": commit, "branch": branch, "files": files, "baseline": baseline}
    state["checkpoints"].append(checkpoint)
    record(state, "checkpoint", commit=commit, branch=branch)
    return checkpoint


def compile_script(source):
    return {"navigation_numbers": manuscript.verify_numbering(source / "main.tex")}


def live_files(task, target):
    files = script_files(task, (target["original_path"],))
    if target["project_type"] == "public" and (report := file_digest(confined(task, "report.md"))) is not None:
        files["report.md"] = report
    return files


def semantic_change(before, after, request):
    old = components(before)
    new = components(after)
    assessments = request.get("changes", {})
    require(isinstance(assessments, dict) and set(assessments) <= old.keys() & new.keys(),
            "classification must name stable components that still exist")
    substantive = set(old.keys() ^ new.keys())
    transitions = set()
    for cid in old.keys() & new.keys():
        prev, current = old[cid], new[cid]
        fields = ("type", "digest", "renderer_digest", "paired", "deps", "ambient")
        changed = any(prev.get(field) != current.get(field) for field in fields)
        transition = current["type"] == "statement" and prev.get("transition_digest") != current.get("transition_digest")
        supplied = assessments.get(cid, {})
        if changed or "meaning" in supplied:
            require(supplied.get("meaning") in ("equivalent", "substantive"), f"need semantic judgment for {cid}")
            evidence(supplied.get("meaning_evidence"))
            if supplied["meaning"] == "substantive" or prev["type"] != current["type"]:
                substantive.add(cid)
        if transition or "transition" in supplied:
            require(supplied.get("transition") in ("equivalent", "substantive"), f"need transition judgment for {cid}")
            evidence(supplied.get("transition_evidence"))
            if supplied["transition"] == "substantive":
                transitions.add(cid)
    invalidated = substantive | transitions
    for cid in old.keys() & new.keys():
        prev, current = old[cid], new[cid]
        used = set(prev["deps"] + current["deps"] + prev["ambient"] + current["ambient"])
        if current["type"] == "proof":
            used.update((prev.get("paired"), current.get("paired")))
        if used & substantive or prev["ambient"] != current["ambient"] or prev.get("paired") != current.get("paired"):
            invalidated.add(cid)
    target_scope = set(before["targets"]) | set(after["targets"])
    declared = set(request.get("target_meaning_changes", []))
    evidence(request.get("target_meaning_evidence"))
    mandatory = (set(before["targets"]) ^ set(after["targets"])) | (substantive & target_scope)
    require(mandatory <= declared <= target_scope, "declare all changes to target theorem meaning or membership")
    return invalidated, declared


def apply_candidate(task, state, request):
    require(state["phase"] == "apply", "no accepted worker proposal")
    proposal = state["proposal"]
    staging = confined(task, proposal["path"])
    require(staging.is_relative_to(task / "staging") and staging.is_dir(), "candidate must be isolated under staging/")
    files = script_files(staging)
    require(state["target"]["original_path"] not in files, "a candidate cannot edit the original")
    candidate = manuscript.parse(staging / "main.tex")[0]
    require(proposal["snapshot_digest"] == candidate["snapshot_digest"], "candidate differs from the accepted proposal")
    invalidated, modified_targets = semantic_change(state["snapshot"], candidate, request)
    if modified_targets:
        approval = state.get("decision") or {}
        require(approval.get("confirmation"), "target meaning requires user refactor confirmation")
        require(approval.get("candidate_digest") == candidate["snapshot_digest"]
                and set(approval.get("targets", [])) == modified_targets,
                "user refactor confirmation must bind this candidate and exact target changes")
    ensure_checkpoint(task, state)
    build = compile_script(staging)
    require(script_files(staging) == files, "candidate changed during compilation")
    writes = {}
    for name in files:
        content = confined(staging, name).read_bytes()
        require(hashlib.sha256(content).hexdigest() == files[name], f"candidate resource changed: {name}")
        writes[name] = content
    state["snapshot"] = candidate
    state["compiled_digest"] = candidate["snapshot_digest"]
    current = set(components(candidate))
    state["universe"] = ordered(state, set(state["universe"]) & current)
    state["safe"] = ordered(state, set(state["safe"]) & current)
    state["route"] = None
    state["proposal"] = None
    updater = proposal["updater"]
    record(state, "apply", updater=updater, proposal=proposal, judgment=request, build=build)
    if updater == "proofreader":
        require(all(item["status"] != "blocked" for item in state["round"]["dispositions"].values()),
                "resolve the interrupted round's blocker before applying")
        finish_round(state, invalidated)
    else:
        state["safe"] = ordered(state, set(state["safe"]) - invalidated)
        if updater == "optimizer":
            finish_explore(state)
        elif state["entry"] == "refactor":
            state["phase"] = "complete"
        else:
            return_to_validation(state)
    state["decision"] = None
    return writes


def return_to_validation(state):
    state["phase"] = "dispatch"
    state["route"] = None
    state["pause"] = None


def resume_fixer(state):
    state["phase"] = "fix"
    current = state["round"]
    role_action(state, "fixer", round=current["id"], issues=current["issues"], order=current["batch"],
                dispositions=current["dispositions"], staging=current["staging"], verify_previous_repairs=True,
                cutoff=state["target"].get("cutoff"), identity=current["fixer_identity"])


def rollback(task, state, request):
    require(state["phase"] == "rollback" and state["attempt"], "no failed route attempt pending")
    attempt = state["attempt"]
    checkpoint = next(entry for entry in reversed(state["checkpoints"]) if entry["commit"] == attempt["checkpoint"]
                      and entry["baseline"] == attempt["baseline"])
    root, branch = repository(task)
    require(checkpoint["branch"] == branch, "rollback requires the recorded project work branch")
    writes = {}
    for name, expected in checkpoint["files"].items():
        relative = str((task / name).relative_to(root))
        data = git(root, "show", f"{checkpoint['commit']}:{relative}").stdout
        require(expected == hashlib.sha256(data).hexdigest(), f"checkpoint resource mismatch: {name}")
        writes[name] = data
    for name in live_files(task, state["target"]).keys() - writes.keys():
        writes[name] = None
    record(state, "route-resolution", attempt=attempt, decision="rollback",
           reason=attempt["rollback_reason"], evidence=evidence(request.get("evidence")), discarded_round=state["round"])
    state.update(copy.deepcopy(checkpoint["baseline"]))
    state["attempt"] = None
    state["round"] = None
    state["loop_active"] = False
    state["actions"] = {}
    return_to_validation(state)
    return writes


def refactor_decision(task, state, request):
    require(state["phase"] == "paused", "record a concrete refactor pause before a decision")
    kind = request.get("decision")
    require(kind in ("implement", "resume", "no-action", "withdraw-last", "maintain-withdrawal"),
            "unknown refactor decision")
    confirmation = evidence(request.get("confirmation"))
    record(state, "user-decision", decision=request, pause=state["pause"])
    if kind == "no-action":
        state["pause"]["kind"] = "no-action"
        state["pause"]["confirmation"] = confirmation
        return
    if state["pause"]["kind"] == "no-action":
        require(request.get("replace_no_action") is True, "user must explicitly replace the agreed no-action pause")
    if kind == "withdraw-last":
        targets = request.get("targets")
        require(isinstance(targets, list) and targets and set(targets) == set(state["snapshot"]["targets"]),
                "withdraw-last requires explicit approval covering every remaining target")
        withdrawal = {"targets": targets, "evidence": evidence(request.get("evidence")), "user_confirmation": confirmation}
        if state["target"]["project_type"] == "public":
            withdrawal["counterexample"] = evidence(request.get("counterexample"))
            finding_records(task, state, request["report_findings"])
            require(state["findings"], "a withdrawal report needs verified findings")
        state["withdrawal"] = withdrawal
        supersede(state, "the user withdrew the last target")
        state["actions"] = {}
        state["round"] = None
        state["pause"] = None
        state["phase"] = "withdrawn"
        return
    if kind == "maintain-withdrawal":
        require(state["withdrawal"] and state["pause"]["kind"] == "withdrawal-evidence", "no pending withdrawal decision")
        state["withdrawal"]["maintained"] = confirmation
        state["pause"] = None
        state["phase"] = "complete"
        return
    previous = state["pause"]["resume"]
    pause_kind = state["pause"]["kind"]
    state["pause"] = None
    if state["withdrawal"]:
        record(state, "withdrawal-reopened", withdrawal=state["withdrawal"])
        state["withdrawal"] = None
    if kind == "implement":
        require(not state["round"] or state["round"]["batch"], "finish the independent reviews before merging a refactor into their repairs")
        if state["round"] and "fixer_identity" not in state["round"]:
            action = next((item for item in state["actions"].values() if item["role"] == "fixer"), None)
            require(action is not None, "no active Fixer for this round")
            state["round"]["fixer_identity"] = action["identity"]
        state["decision"] = {"confirmation": confirmation, "plan": evidence(request.get("plan")),
                             "targets": request.get("targets", []), "candidate_digest": request.get("candidate_digest")}
        state["actions"] = {}
        state["phase"] = "implement"
        role_action(state, "refactor", plan=state["decision"]["plan"], cutoff=state["target"].get("cutoff"),
                    round_state=state["round"])
    elif state["round"] and not state["actions"] and state["round"]["batch"]:
        resume_fixer(state)
    elif state["actions"] or (previous in ("dispatch", "apply", "rollback", "approved", "delivery", "withdrawn")
                             and pause_kind in ("user", "capability", "refactor", "no-action")):
        state["phase"] = previous
    else:
        return_to_validation(state)


def verify_approval(task, state):
    require(state["route"] and state["route"]["snapshot_digest"] == live_digest(state)
            and state["route"]["verdict"] in ("pass", "no-simplification"), "same-version route pass required")
    require(state["explored_digest"] == live_digest(state)
            and set(state["snapshot"]["cone"]) <= set(state["safe"])
            and not state["snapshot"]["open_obligations"], "dependency review and proof closure required")
    report = report_digest(task, state["findings"])
    require(state["route"]["report_sha256"] == report, "hard finding documentation changed after route review")
    build = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=task / "staging"))
    main = manuscript.materialize_snapshot(task / "main.tex", build)
    filtered = manuscript.parse(main)[0]
    require([row["id"] for row in filtered["components"]] == state["snapshot"]["cone"],
            "materialized snapshot differs from the verified dependency union")
    check_bound_sources(task, state)
    build_result = compile_script(build)
    require(manuscript.parse(task / "main.tex")[0]["snapshot_digest"] == live_digest(state) and root_target(task) == state["target"]
            and report_digest(task, state["findings"]) == report, "working proof or source inputs changed during delivery preparation")
    digest = filtered["snapshot_digest"]
    install = confined(task, f"deliveries/{digest}")
    install.parent.mkdir(exist_ok=True)
    if install.exists():
        existing = manuscript.parse(install / "main.tex")[0]
        require(existing["snapshot_digest"] == digest, "a stored delivery snapshot has changed")
    else:
        os.replace(build, install)
    approval = {
        "schema": 1, "snapshot_digest": digest, "components": filtered["cone"],
        "project_type": state["target"]["project_type"], "cutoff": state["target"].get("cutoff"),
        "math_review": "pass", "proof_obligations": "closed", "route_review": "pass",
        "working_snapshot_digest": live_digest(state), "route_review_result": state["route"],
        "report_findings": state["findings"], "report_sha256": report,
        "original_sha256": state["target"]["sha256"], "build": build_result,
    }
    atomic_write(install / "approval.json", json_bytes(approval))
    kinds = ["game"]
    if state["target"]["project_type"] == "unpublished":
        kinds.append("paper")
    elif state["findings"]:
        kinds.append("referee")
    state["delivery"] = {"snapshot_digest": digest, "approval_path": str((install / "approval.json").relative_to(task)),
                         "approval": approval, "products": {kind: {"status": "pending"} for kind in kinds}}
    state["phase"] = "delivery"
    record(state, "approved", route=state["route"], digest=digest, kinds=kinds)


def withdrawal_delivery(task, state):
    if state["entry"] != "guided" or state["target"]["project_type"] == "unpublished":
        state["phase"] = "complete"
        return
    approval = {
        "schema": 1, "kind": "referee", "project_type": "public", "reason": "last-target-withdrawn",
        "snapshot_digest": None, "cutoff": state["target"]["cutoff"], "withdrawal": state["withdrawal"],
        "report_findings": state["findings"], "report_sha256": report_digest(task, state["findings"]),
        "original_sha256": state["target"]["sha256"],
    }
    path = "deliveries/withdrawal-approval.json"
    atomic_write(confined(task, path), json_bytes(approval))
    state["delivery"] = {"snapshot_digest": None, "approval_path": path, "approval": approval,
                         "products": {"referee": {"status": "pending"}}}
    state["phase"] = "delivery"


def verify_game_artifact(artifact, approval_path, approval):
    require(artifact.suffix == ".zip", "game must be the checked ZIP artifact")
    with zipfile.ZipFile(artifact) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "game archive contains duplicate paths")
        for name in names:
            path = Path(name)
            require(not path.is_absolute() and ".." not in path.parts, "game contains an unsafe archive path")
        require({"game.json", "START.md", "server.mjs", "app.js", "index.html"} <= set(names),
                "game archive is missing runtime files")
        package = json.loads(archive.read("game.json"))
        require(package.get("approval_snapshot_digest") == approval["snapshot_digest"]
                and package.get("project_type") == approval["project_type"] and package.get("cutoff") == approval["cutoff"],
                "game archive does not bind the active approved snapshot")
        require([level["id"] for level in package["levels"]] == approval["components"]
                and package["chinese"]["levels"].keys() == set(approval["components"]),
                "game must include the approved English and Chinese levels in scope")
        for name, expected in {**package["snapshot_files"], **package["reference_files"]}.items():
            require(hashlib.sha256(archive.read(name)).hexdigest() == expected, f"game archive resource changed: {name}")
        main = approval_path.with_name("main.tex")
        snapshot = manuscript.parse(main)[0]
        for relative in ["main.tex", *snapshot["resources"], *(row["path"] for row in snapshot["components"])]:
            expected = file_digest(confined(main.parent, relative))
            require(expected == package["snapshot_files"].get("snapshot/" + relative),
                    f"game script resource differs from its approval: {relative}")


def deliverable(task, state, request):
    require(state["phase"] == "delivery", "no active delivery approval")
    delivery = state["delivery"]
    require("snapshot_digest" in request and request["snapshot_digest"] == delivery["snapshot_digest"],
            "artifact must be bound to the active delivery snapshot")
    approval_path = confined(task, delivery["approval_path"])
    require(read_json(approval_path) == delivery["approval"], "delivery approval changed on disk")
    if delivery["approval"].get("report_findings"):
        require(delivery["approval"]["report_sha256"] == report_digest(task, state["findings"]),
                "hard finding documentation changed during delivery")
    status = request.get("status")
    kind = request.get("kind")
    require(kind in delivery["products"], "this product is outside the active delivery")
    product = delivery["products"][kind]
    if status in ("blocked", "pending"):
        require(product["status"] in ("blocked", "pending"), "a checked artifact cannot go backward without an incident")
        product.update(status=status, evidence=evidence(request.get("evidence")))
    elif status == "checked":
        require(product["status"] in ("pending", "blocked"), "product check was already recorded")
        artifact = confined(task, request["artifact"])
        expected = evidence(request.get("sha256"))
        require(file_digest(artifact) == expected, "artifact bytes differ from its check receipt")
        if kind == "game":
            verify_game_artifact(artifact, approval_path, delivery["approval"])
        else:
            import writer
            main = approval_path.with_name("main.tex") if delivery["snapshot_digest"] else None
            withdrawal = approval_path if main is None else None
            target = task / "target.json" if kind == "referee" else None
            receipt = writer.verify_delivery(kind, artifact.parent,
                                             lambda: writer.applicable_inputs(kind, main, target, withdrawal))
            require(receipt["pdf"] == artifact.name, "checked artifact differs from the Writer's actual compiled PDF")
        product.update(status=status, artifact=request["artifact"], sha256=expected,
                       evidence=evidence(request.get("evidence")))
    elif status == "delivered":
        require(product["status"] == "checked", "check the artifact before delivering it")
        require(file_digest(confined(task, product["artifact"])) == product["sha256"], "checked artifact changed before delivery")
        product.update(status=status, message_receipt=evidence(request.get("evidence")))
        if all(item["status"] == "delivered" for item in delivery["products"].values()):
            state["phase"] = "complete"
    else:
        raise Rejected("unknown deliverable status")
    record(state, "deliverable", product=kind, check=copy.deepcopy(product), snapshot_digest=delivery["snapshot_digest"])


def supersede(state, reason):
    if state["delivery"]:
        state["superseded"].append({**state["delivery"], "reason": reason, "status": "invalidated"})
        state["delivery"] = None


def incident(task, state, request):
    require(state["phase"] in ("delivery", "complete") and state["delivery"], "there is no active delivery to suspend")
    require(request.get("snapshot_digest") == state["delivery"]["snapshot_digest"], "incident applies to an earlier delivery")
    reason = evidence(request.get("evidence"))
    require(request.get("kind") in ("script", "counterexample"), "only shared substantial math incidents suspend deliveries")
    require(not state["withdrawal"] or request["kind"] == "counterexample",
            "report-only withdrawal requires a counterexample incident")
    cites = set(request.get("components", []))
    require(cites <= set(state["snapshot"]["cone"]), "incident components must lie in the delivery dependency union")
    record(state, "incident", details=request)
    approval_path = confined(task, state["delivery"]["approval_path"])
    previous = state["delivery"]["approval"]
    revoked = {**previous, "math_review": "invalidated", "route_review": "invalidated", "revoked": reason}
    atomic_write(approval_path, json_bytes(revoked))
    supersede(state, reason)
    state["route"] = None
    state["safe"] = ordered(state, set(state["safe"]) - (cites or set(state["snapshot"]["cone"])))
    state["explored_digest"] = None
    state["goal_complete"] = None
    if request["kind"] == "counterexample":
        state["phase"] = "incident-check"
        role_action(state, "fixer", purpose="incident", incident=request, withdrawal=state["withdrawal"],
                    findings=state["findings"], cutoff=state["target"].get("cutoff"))
    else:
        return_to_validation(state)


def check_incident_result(task, state, request):
    verdict = request.get("verdict")
    require(verdict in ("confirmed", "refuted", "blocked"), "counterexample recheck needs an evidenced outcome")
    if "report_findings" in request:
        finding_records(task, state, request["report_findings"])
    if verdict == "blocked":
        pause(state, "withdrawal-evidence" if state["withdrawal"] else "mathematical-blocker", request["evidence"])
    elif state["withdrawal"]:
        if verdict == "confirmed":
            require(state["findings"], "a confirmed withdrawal needs a verified report finding")
            state["phase"] = "withdrawn"
        else:
            pause(state, "withdrawal-evidence", request["evidence"])
    else:
        return_to_validation(state)


def select_release(state, request):
    selected = evidence(request.get("tool_release"))
    require(selected != state["tool_release"], "the task already uses this release")
    evidence(request.get("approval"))
    evidence(request.get("compatibility"))
    require(request.get("schema") == state["schema"], "new release must support the exact task state schema")
    require(state["phase"] not in ("apply", "approved", "delivery"),
            "settle the staged write or prepared delivery before switching its loaded release")
    previous = state["tool_release"]
    state["tool_release"] = selected
    for action in list(state["actions"].values()):
        if action["token"] not in state["actions"]:
            continue
        if action["identity"] is None:
            action["tool_release"] = selected
        else:
            replace(state, {"token": action["token"], "snapshot_digest": action["snapshot_digest"],
                            "session": action["identity"]["session"],
                            "evidence": "The approved release changed. Restart this unfinished session under its selected version."})
    record(state, "release-selection", previous=previous, current=selected, approval=request["approval"],
           compatibility=request["compatibility"])


def start_entry(task, state, request):
    require(state["phase"] == "complete" or (state["phase"] == "paused"
             and request.get("abandon_evidence")), "finish or explicitly abandon the existing task first")
    entry = request.get("entry")
    require(entry in ("guided", "verify", "refactor"), "unknown starting entry")
    if state["phase"] == "paused":
        evidence(request["abandon_evidence"])
        record(state, "abandoned", round=state["round"], pause=state["pause"], evidence=request["abandon_evidence"])
    state["entry"] = entry
    state["phase"] = "dispatch"
    state["goal"] = request.get("goal")
    state["goal_complete"] = None
    state["coordinator"] = request.get("coordinator")
    state["tool_release"] = evidence(request.get("tool_release"))
    for role, config in request.get("models", {}).items():
        require(role in state["models"] and isinstance(config, list) and len(config) == 2, f"invalid role: {role}")
        state["models"][role] = [evidence(config[0]), evidence(config[1])]
    if entry != "refactor":
        goal = state["goal"]
        require(isinstance(goal, dict), "real host Goal receipt required")
        evidence(goal.get("id"))
        evidence(goal.get("evidence"))
        check_identity(state["coordinator"], state["models"]["coordinator"])
    state["pause"] = None
    state["round"] = None
    state["route"] = None
    state["actions"] = {}
    state["attempt"] = None
    state["loop_active"] = False
    state["decision"] = None
    if state["withdrawal"]:
        require(entry == "refactor", "restore withdrawn targets by a user refactor decision")
    if entry == "refactor":
        pause(state, "manual-refactor", evidence(request.get("reason")))
    else:
        ensure_checkpoint(task, state)


def operation(task, state, request):
    op = request["op"]
    writes = {}
    if op == "advance":
        if state["phase"] == "approved":
            verify_approval(task, state)
        elif state["phase"] == "withdrawn":
            withdrawal_delivery(task, state)
        elif state["phase"] == "review":
            advance_review(state)
        else:
            dispatch(state, task)
    elif op == "bind":
        require(state["phase"] != "paused", "the task is paused")
        bind(state, request)
    elif op == "result":
        require(state["phase"] != "paused", "the task is paused")
        result(task, state, request)
    elif op == "source-resolve":
        resolve_source(task, state, request)
    elif op == "replace":
        require(state["phase"] != "paused", "the task is paused")
        replace(state, request)
    elif op == "fixer-progress":
        action = get_action(state, request, bound=True)
        require(state["phase"] == "fix" and action["role"] == "fixer", "no active Fixer")
        require(not action["waiting"], "resolve the source wait first")
        record_fix(state, action, request)
    elif op == "apply-candidate":
        writes = apply_candidate(task, state, request)
    elif op == "pause":
        require(state["phase"] not in ("paused", "complete"), "task cannot be paused in this phase")
        kind = request.get("kind")
        require(kind in ("user", "capability", "refactor"), "unknown pause kind")
        pause(state, kind, evidence(request.get("evidence")))
    elif op == "refactor-decision":
        refactor_decision(task, state, request)
    elif op == "checkpoint":
        ensure_checkpoint(task, state)
    elif op == "rollback":
        writes = rollback(task, state, request)
    elif op == "deliverable":
        deliverable(task, state, request)
    elif op == "incident":
        incident(task, state, request)
    elif op == "start":
        start_entry(task, state, request)
    elif op == "select-release":
        select_release(state, request)
    elif op == "goal-complete":
        require(state["phase"] == "complete" and state["goal"]
                and request.get("goal_id") == state["goal"]["id"], "the active Goal is not ready")
        state["goal_complete"] = evidence(request.get("evidence"))
    else:
        raise Rejected(f"unknown operation: {op}")
    return writes


def journal_writes(task, old, state, before, writes):
    import base64

    for name in writes:
        require(file_digest(confined(task, name)) == before.get(name), f"concurrent change in {name}; keep the original candidate")
    require(manuscript.parse(task / "main.tex")[0]["snapshot_digest"] == live_digest(old),
            "live script changed during candidate compilation or rollback preparation")
    journal = {
        "expected_revision": old["revision"],
        "state": state,
        "changes": {name: {"before": before.get(name),
                           "data": base64.b64encode(content).decode() if content is not None else None}
                    for name, content in writes.items()},
    }
    atomic_write(task / JOURNAL_FILE, json_bytes(journal))
    replay_journal(task)


def clear_journal(task):
    archive = task / "staging" / ".receipts"
    archive.mkdir(parents=True, exist_ok=True)
    os.replace(task / JOURNAL_FILE, archive / f"transaction-{uuid.uuid4().hex}.json")


def replay_journal(task):
    import base64

    journal = read_json(task / JOURNAL_FILE)
    old = read_json(task / STATE_FILE)
    state = journal["state"]
    require(old["revision"] in (journal["expected_revision"], state["revision"]),
            "pending write journal does not match the ledger")
    if old["revision"] == state["revision"]:
        clear_journal(task)
        return old
    decoded = {}
    for name, change in journal["changes"].items():
        path = confined(task, name)
        data = base64.b64decode(change["data"]) if change["data"] is not None else None
        expected = hashlib.sha256(data).hexdigest() if data is not None else None
        actual = file_digest(path)
        require(actual in (change["before"], expected), f"concurrent change in {name}; retain pending journal")
        if actual != expected:
            decoded[name] = data
    archive = task / "staging" / ".discarded" / str(state["revision"])
    for name, data in decoded.items():
        path = confined(task, name)
        require(file_digest(path) == journal["changes"][name]["before"], f"concurrent change in {name}; retain pending journal")
        if data is None:
            saved = archive / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            os.replace(path, saved)
        else:
            atomic_write(path, data)
    require(manuscript.parse(task / "main.tex")[0]["snapshot_digest"] == live_digest(state),
            "saved script differs from the staged candidate; retain pending journal")
    ensure_checkpoint(task, state)
    atomic_write(task / STATE_FILE, json_bytes(state))
    clear_journal(task)
    return state


def display(state, *, stale=None, pending=False):
    if state is None:
        return {"state": None, "actions": [], "unsafe": [], "stale": stale, "pending_write": pending}
    actions = [] if stale or pending or state["phase"] == "paused" else list(state["actions"].values())
    return {"state": state, "actions": actions, "unsafe": ordered(state, unsafe(state)), "stale": stale,
            "pending_write": pending}


def transact(task, request):
    task = resolve_task_path(task)
    path = task / STATE_FILE
    pending = task / JOURNAL_FILE
    op = request.get("op")
    with (task / "state.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_json(path) if path.is_file() else None
        if op == "status":
            try:
                stale = state is not None and (
                    root_target(task) != state["target"] or
                    manuscript.parse(task / "main.tex")[0]["snapshot_digest"] != live_digest(state))
            except (OSError, ValueError, KeyError, TypeError):
                stale = True
            return display(state, stale=stale, pending=pending.exists())
        if op == "recover":
            require(pending.is_file(), "no interrupted candidate transaction")
            return display(replay_journal(task))
        require(not pending.exists(), "candidate write interrupted; run recover")
        target = root_target(task)
        live = manuscript.parse(task / "main.tex")[0]
        if not state:
            require(op == "init", "initialize or resume a task before mutating it")
            (task / "staging").mkdir(exist_ok=True)
            require(not (task / "blackboard.json").exists(), "preserve and reconcile the legacy state before initialization")
            state = init(task, target, live, request)
            atomic_write(path, json_bytes(state))
            return display(state)
        require(state["schema"] == 1, "unsupported state schema")
        require(request.get("expected_revision") == state["revision"], "stale ledger revision; reload status")
        require(target == state["target"] and live["snapshot_digest"] == live_digest(state),
                "target or live script changed outside the saved transaction; reject stale results")
        old = copy.deepcopy(state)
        before = live_files(task, target) if op in ("apply-candidate", "rollback") else None
        writes = operation(task, state, request)
        state["revision"] += 1
        if writes:
            journal_writes(task, old, state, before, writes)
            return display(read_json(path))
        atomic_write(path, json_bytes(state))
        return display(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--request", type=Path)
    parser.add_argument("--status", action="store_true")
    arguments = parser.parse_args()
    if arguments.request and arguments.status:
        parser.error("choose --status or --request")
    try:
        request = {"op": "status"} if arguments.status else (
            read_json(arguments.request) if arguments.request else json.load(sys.stdin))
        print(json.dumps(transact(arguments.task, request), ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        print(json.dumps({"error": str(exc), "committed": False}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
