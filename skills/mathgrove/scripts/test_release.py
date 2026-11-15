import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.checkout = Path(tmp.name)
        env = dict(os.environ, GIT_AUTHOR_NAME="Example", GIT_AUTHOR_EMAIL="test@example.com",
                   GIT_COMMITTER_NAME="Example", GIT_COMMITTER_EMAIL="test@example.com")
        subprocess.run(["git", "init", "-q", self.checkout], env=env, check=True)
        release.git("remote", "add", "origin", release.UPSTREAM, cwd=self.checkout)
        entry = self.checkout / "skills/mathgrove/SKILL.md"
        entry.parent.mkdir(parents=True)
        entry.write_text("example", encoding="utf-8")
        (self.checkout / "VERSION").write_text("v0.1.0\n", encoding="ascii")
        release.git("add", ".", cwd=self.checkout)
        subprocess.run(["git", "commit", "-qm", "release"], cwd=self.checkout, env=env, check=True)
        release.git("tag", "v0.1.0", cwd=self.checkout)
        self.commit = release.git("rev-parse", "HEAD", cwd=self.checkout)

    def test_version_check_and_temporary_unreachable_upstream(self):
        with patch.object(release, "remote_tags", return_value={"v0.1.0": self.commit}):
            self.assertEqual(release.check(self.checkout)["status"], "current")
        with patch.object(release, "remote_tags", side_effect=release.Unreachable("timeout")):
            self.assertEqual(release.check(self.checkout)["status"], "offline")
        with patch.object(release, "remote_tags", side_effect=release.GitError("HTTP 403")):
            with self.assertRaises(release.GitError):
                release.check(self.checkout)

    def test_new_release_needs_approval(self):
        with patch.object(release, "remote_tags", return_value={
            "v0.1.0": self.commit, "v0.2.9": "1" * 40, "v0.2.10": "2" * 40,
        }):
            result = release.check(self.checkout)
            self.assertEqual(result["status"], "needs-confirmation")
            self.assertEqual(result["candidate"]["tag"], "v0.2.10")
            with self.assertRaisesRegex(release.ReleaseError, "candidate changed"):
                release.apply(self.checkout, "v0.2.9", "1" * 40)

    def test_different_tag_commit_needs_investigation(self):
        with patch.object(release, "remote_tags", return_value={"v0.1.0": "1" * 40}):
            with self.assertRaisesRegex(release.ReleaseError, "commit changed"):
                release.check(self.checkout)

    def test_edited_release_cannot_be_reused_offline(self):
        (self.checkout / "skills/mathgrove/SKILL.md").write_text("local change", encoding="utf-8")
        with self.assertRaisesRegex(release.ReleaseError, "local changes"):
            release.check(self.checkout)

    def test_updates_install_separately_and_verify_the_approved_commit(self):
        with tempfile.TemporaryDirectory() as workspace:
            remote, cache = (Path(workspace) / name for name in ("upstream", "installed"))
            release.git("clone", "--quiet", str(self.checkout), str(remote))
            (remote / "VERSION").write_text("v0.2.0\n", encoding="ascii")
            release.git("add", "VERSION", cwd=remote)
            release.git("-c", "user.name=Example", "-c", "user.email=test@example.com",
                        "commit", "-qm", "update", cwd=remote)
            release.git("tag", "v0.2.0", cwd=remote)
            candidate = release.git("rev-parse", "HEAD", cwd=remote)
            real_git = release.git

            def clone_locally(*args, cwd=None):
                if args[0] == "clone":
                    result = real_git(*[remote.as_uri() if arg == release.UPSTREAM else arg for arg in args], cwd=cwd)
                    real_git("remote", "set-url", "origin", release.UPSTREAM, cwd=Path(args[-1]))
                    return result
                return real_git(*args, cwd=cwd)

            with patch.object(release, "git", side_effect=clone_locally), patch.object(
                release, "remote_tags", return_value={"v0.1.0": self.commit, "v0.2.0": candidate}
            ):
                selection = release.apply(self.checkout, "v0.2.0", candidate, cache)
                self.assertEqual(selection["installed"]["commit"], candidate)
                self.assertEqual(release.verify(self.checkout)["commit"], self.commit)
                self.assertEqual(release.apply(self.checkout, "v0.2.0", candidate, cache), selection)


if __name__ == "__main__":
    unittest.main()
