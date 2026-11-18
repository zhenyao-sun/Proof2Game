# Main-session startup and recovery

## Select the release

Use a real Git checkout in ChatGPT Work’s Linux workspace or on macOS with ChatGPT Desktop/Codex. In Work, use the user’s accessible workspace project or materialize the supplied research files into a project workspace. Keep the original bytes and any resources together. User-authorized delivery files can be returned as downloadable artifacts. Record checkpoints in the research project so that the active manuscript version can be identified on resumption. At first use in this user-facing session, identify the loaded release, then run `python3 scripts/release.py check` from the skill folder. The helper derives its repository from its own location and compares the actual Git commit and stable tags at the configured public upstream. Record the release tag, commit, and resolved entrypoint. The record is local to the task. For successive uses in the same main session, reuse the verified selection. Internal sessions run with paths and the release supplied by the coordinator. They do not contact GitHub.

An installation made by the v0.1.0 updater may remain in its existing release cache and have its original Git remote. Use the canonical entrypoint returned by the verifier. Use the existing project task directory when resuming. The intake helper recognizes its original storage location.

- `current`: continue.
- `offline`: say what prevented checking and continue with the verified installed release. A first installation requires obtaining the package.
- `needs-confirmation`: show the installed and proposed versions and pause for approval. On skip, keep the installed release. On approval, run `python3 scripts/release.py apply --tag TAG --commit SHA` using the exact approved pair. Verify the returned entrypoint and read it before any task mutation. A newer proposal requires its own approval. Use the ledger's [select-release operation](state.md#initialization-dispatch-and-completion) to bind the new release to an existing task at a supported boundary. Preserve the task's target edition, research data and the older installation. Save and report any compatibility failure.
- `error`: give the actual error and save the task. A failed update leaves the previous installation available and the selected workflow paused.

For a first-time mathematical project, verify Git, Python 3.11+, and the tools that the chosen action actually needs. Check TeX and either `pdftotext` or the Python `pypdf` package before verifying a new game script. Check a visual PDF-reading tool, `pdfinfo` and `pdftoppm` for OCR, and Node.js 22+ for game authoring and package checks. The recipient runtime requires Node.js 20 or later. Locate the available worker delegation tools in the host. Bind actual worker session IDs and configured model/effort to the work. Do not silently emulate independent calls or substitute models when the host lacks the capability. The coordinator is the main conversation and cannot switch its running model by writing a setting. When only exact main-model evidence is missing, distinguish that uncertainty from a confirmed mismatch.

## Track the task and any optional Goal

Use the project ledger to track the selected target version, current phase, evidence, and completion. Guided and standalone verification can start, resume, and finish on hosts without a Goal interface.

- Guided objective: process the supplied manuscript version and deliver every applicable checked output. An individual game or paper may be delivered early while other outputs continue. Complete after all required outputs are delivered or the confirmed zero-target branch ends as specified.
- Standalone verification objective: finish on the designated script after proof closure, valid mathematical review of its active dependency cone, and the applicable final route check on the same revision. Check and summarize the exact revision.

If the user requests a Codex Goal and the host supports it, inspect the current host Goal and reuse one only when it belongs to this task. Preserve an existing optional binding on resume. Record actual host receipts and use the same binding for internal refactors and replacement deliveries. Once the ledger records completion, reflect it in the host Goal when accessible. Follow the host lifecycle rules for any optional tracking.

At a real user decision or missing input, save the pending action and resume as soon as it is resolved. For Reviewer source waits, finish all review work that can run, send the accepted findings through Batcher, and hold at Fixer until the sources are available. Preserve staged work on user pause.
