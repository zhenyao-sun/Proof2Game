---
name: proof2game
description: Turn a supplied mathematics manuscript, draft, note, or arXiv link into a verified game script and a locally playable bilingual learning game. Use for Proof2Game guided setup, automated game-script verification, manual refactor, paper ingestion, or revising a delivered unpublished paper from feedback. For unpublished work, guided setup also produces a complete English paper. Public-paper projects keep the selected version and its proof route. Author on macOS with Codex or in ChatGPT Work with a Linux workspace.
---

# Proof2Game

Work from the manuscript or note the user supplies. Preserve the original. Use Chinese with the user unless they prefer English. Write and verify the game script in English. English is also the language for papers and referee reports.

## First use and recovery

The face-to-face Codex main session selects the release and owns the workflow. Use the actual loaded checkout, resolve paths relative to this file, and follow [startup.md](references/startup.md) to check updates, confirm host capabilities, and resume from the project ledger. Workers inherit that selection. An unreadable or changed release, or an unavailable required capability, needs a concrete saved stopping point. Report what the host actually ran.

Identify the authorized action using the routes below. Use guided setup when the user asks Proof2Game to process a manuscript and names no narrower action.

| User action | Start and finish |
| --- | --- |
| Guided setup | Read [intake.md](references/intake.md). Use information already supplied, ask for the project folder and manuscript only when missing, and accept LaTeX, Markdown, PDF, or an arXiv link. If the user has no draft, explain that Proof2Game needs an existing manuscript or math note. Determine whether this is the user's unpublished work or a public-literature project if unclear. Save the exact input/version, create a separate two-section English [game script](references/manuscript.md), and automatically start [verification](references/verification.md). Follow through to the applicable checked deliveries. |
| Automated script verification | Read [verification.md](references/verification.md). Resume or start verification of the identified existing game script. Finish when the active dependency cone, proof obligations, and project-specific final route review pass on the same revision. |
| Revise a delivered unpublished manuscript (`revising`) | Follow [Writer revision](references/writer.md#revise-a-delivered-paper). Start from the last official Writer manuscript, interpret the feedback, and deliver both the clean revision and a copy marked against the chosen baseline. The user decides whether to launch separate script verification. |
| `refactor` | Read the manual-refactor section of [verification.md](references/verification.md). Establish the actual blocker and agreed scope, implement the agreed action, and stop at the safe refactor boundary with its receipt. |
| `paper_ingest` | Read the reference-only intake section of [intake.md](references/intake.md). Find and preserve the appropriate reference version in the current project's `references/`, and report the preserved PDF and version. |

Use a separate task folder and state for a different original version. For a resumed task, reuse verified evidence and real recoverable sessions. Unknown project, manuscript, type, or target scope warrants a question only when the resulting action or delivered theorem set would actually differ.

## Verify and deliver

Read [workers.md](references/workers.md) for independent role configuration and exact information boundaries. Read [state.md](references/state.md) for mechanical state operations. The coordinator advances the real actions, dispatches bounded roles, and accepts their actual evidence. The ledger protects ordering and revision bindings. Mathematical decisions come from the corresponding real reviewer. Keep drafts, proof work, checkpoints, accepted results and source records on the local research project.

In public-literature mode, bind verification to the actual selected target version and its public date. Apply that cutoff before reference version preference. Explorer and Fixer work from the exact original. Ordinary mathematical Reviewers judge the submitted argument independently of the target paper, then a separate final route reviewer compares the same mathematically verified script to that paper. In unpublished mode a separate final reviewer keeps pursuing actual proof simplifications as described in the verification workflow. Present material changes to a target theorem to the user in refactor before applying them.

Guided verification hands one filtered, sealed game script to the [game exporter](references/game.md) and the [Writer](references/writer.md). Start both independently and deliver each output when it passes its own checks. Deliver a static website for GitHub Pages. Publish a specific game only with the author’s authorization. The launch page gives the player a prompt for their local Codex, which starts and opens the game at its local address. Writer produces an English paper with compilable TeX for unpublished work. For public work, Writer uses the sealed script for internal comparison and delivers a checked generic English referee report addressed to the authors of the original manuscript. When the user confirms withdrawal of the last target, follow the public report-only or unpublished save-and-explain branch. Relay incidental substantive shared script errors to verification and pause every dependent delivery. Fix a local translation or rendering issue at its own stage. The same ledger tracks all applicable deliveries and their replacements through completion.
