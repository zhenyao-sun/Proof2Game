#!/usr/bin/env python3
"""Select an installed MathGrove release without writing to a research project."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

UPSTREAM = "https://github.com/zhenyao-sun/MathGrove.git"
CACHE = Path.home() / "Library/Application Support/MathGrove/releases"
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
OID = re.compile(r"[0-9a-f]{40}\Z")
OFFLINE_ERRORS = (
    "could not resolve", "unable to connect", "failed to connect",
    "connection timed out", "connection reset", "network is unreachable",
    "the requested url returned error: 502", "the requested url returned error: 503",
    "the requested url returned error: 504", "operation timed out",
)


class ReleaseError(Exception):
    pass


class GitError(ReleaseError):
    pass


class Unreachable(ReleaseError):
    pass


def git(*args, cwd=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, env=env, text=True, capture_output=True, timeout=45
        )
    except subprocess.TimeoutExpired as exc:
        raise Unreachable("Git timed out") from exc
    except OSError as exc:
        raise ReleaseError(str(exc)) from exc
    if result.returncode:
        message = result.stderr.strip() or f"Git exited with status {result.returncode}"
        if any(error in message.lower() for error in OFFLINE_ERRORS):
            raise Unreachable(message)
        raise GitError(message)
    return result.stdout.strip()


def order(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ReleaseError(f"Invalid release tag: {tag}")
    return tuple(map(int, match.groups()))


def verify(repo):
    repo = Path(repo).resolve()
    if Path(git("rev-parse", "--show-toplevel", cwd=repo)).resolve() != repo:
        raise ReleaseError("The release must be the root of its own Git checkout")
    if git("config", "--get", "remote.origin.url", cwd=repo) != UPSTREAM:
        raise ReleaseError("The checkout origin differs from the MathGrove upstream")
    if git("status", "--porcelain=v1", "--untracked-files=all", cwd=repo):
        raise ReleaseError("The installed checkout contains local changes. Preserve it and use a clean release.")
    tag = (repo / "VERSION").read_text(encoding="ascii").strip()
    order(tag)
    head = git("rev-parse", "--verify", "HEAD^{commit}", cwd=repo)
    if git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", cwd=repo) != head:
        raise ReleaseError("The loaded commit does not match the release tag")
    entry = repo / "skills/mathgrove/SKILL.md"
    if not entry.is_file() or entry.resolve() != entry:
        raise ReleaseError("The release is missing its local skill entrypoint")
    return {"tag": tag, "commit": head, "entrypoint": str(entry)}


def remote_tags():
    output = git("ls-remote", "--tags", UPSTREAM)
    tags = {}
    annotated = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            raise ReleaseError("Unexpected remote Git output")
        oid, ref = parts
        if not ref.startswith("refs/tags/"):
            raise ReleaseError("Unexpected remote Git ref")
        name = ref.removeprefix("refs/tags/")
        peeled = name.endswith("^{}")
        name = name.removesuffix("^{}")
        if TAG.fullmatch(name):
            if not OID.fullmatch(oid):
                raise ReleaseError("Invalid object ID in upstream release")
            (annotated if peeled else tags)[name] = oid
    tags.update(annotated)
    if not tags:
        raise ReleaseError("Upstream supplied no stable MathGrove release tags")
    return tags


def advertised_update(installed, tags):
    tag = installed["tag"]
    if tags.get(tag) != installed["commit"]:
        raise ReleaseError("The installed release tag is missing upstream or its commit changed")
    newest = max(tags, key=order)
    if order(newest) > order(tag):
        return {"tag": newest, "commit": tags[newest]}
    return None


def check(repo):
    installed = verify(repo)
    try:
        candidate = advertised_update(installed, remote_tags())
    except Unreachable as exc:
        return {"status": "offline", "installed": installed, "reason": str(exc)}
    if candidate:
        return {"status": "needs-confirmation", "installed": installed, "candidate": candidate}
    return {"status": "current", "installed": installed}


def apply(repo, tag, commit, cache=CACHE):
    installed = verify(repo)
    proposed = advertised_update(installed, remote_tags())
    if proposed != {"tag": tag, "commit": commit}:
        raise ReleaseError("The upstream candidate changed. Check again before asking for approval.")
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / tag
    if destination.is_symlink():
        raise ReleaseError("The update destination is a symbolic link")
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix=".mathgrove-stage-", dir=cache) as stage:
            clone = Path(stage) / "release"
            git("clone", "--quiet", "--depth", "1", "--branch", tag, UPSTREAM, str(clone))
            if verify(clone)["commit"] != commit:
                raise ReleaseError("The downloaded release commit differs from the approved commit")
            try:
                clone.rename(destination)
            except OSError:
                # A concurrently completed install may already be present. Verify its bytes below.
                if not destination.is_dir() or destination.is_symlink():
                    raise
    selected = verify(destination)
    if selected["tag"] != tag or selected["commit"] != commit:
        raise ReleaseError("The installed update differs from the approved commit")
    return {"status": "updated", "installed": selected}


def main():
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("verify")
    sub.add_parser("check")
    update = sub.add_parser("apply")
    update.add_argument("--tag", required=True)
    update.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        if sys.platform != "darwin":
            raise ReleaseError("MathGrove requires macOS")
        if args.command == "apply":
            if not OID.fullmatch(args.commit):
                raise ReleaseError("Invalid approved commit")
            result = apply(root, args.tag, args.commit)
        elif args.command == "check":
            result = check(root)
        else:
            result = {"status": "verified", "installed": verify(root)}
    except (ReleaseError, OSError, UnicodeError) as exc:
        print(json.dumps({"status": "error", "reason": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
