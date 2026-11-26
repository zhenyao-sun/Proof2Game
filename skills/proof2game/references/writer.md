# Writer

## Complete paper

These instructions are for the coordinator. For a user's unpublished project, start a fresh, independent session with `gpt-6.2-astra / ultra` after the game script is fully verified. Use the same model and effort for the first paper and each revision. Check the actual session and configuration.

Give the session the task, a fresh output workspace, the complete verified game-script materials, and all available feedback, including the author's preferences as expressed. Tell the Writer that the script has passed verification. Use the [retained paper input](state.md#delivery) for the script binding in the ledger and the build commands. For the first paper, leave the original project manuscript out of the materials. For a revision, include the exact user-designated draft and identify it as the manuscript to revise. Keep the game script and verification state read-only.

Ask the Writer to produce the complete paper with compilable LaTeX and its local resources. Provide the materials without inherited conversation, another role's instructions, prescribed editorial choices, or a preferred source. The Writer chooses the main results, proof routes, treatment of feedback, structure, and presentation.

After the Writer finishes, the coordinator checks only that the source and resources are complete and compile. The verified snapshot identifies the script materials the Writer received. The paper can use results or arguments outside that snapshot. Run the following commands with actual absolute paths. The bundle must be a fresh version directory separate from the draft.

```bash
inputs=(--kind paper --main "$snapshot/main.tex")
python3 "$skill/scripts/writer.py" compile "${inputs[@]}" --tex "$draft_entrypoint" --bundle "$bundle"
python3 "$skill/scripts/writer.py" finish "${inputs[@]}" --bundle "$bundle"
python3 "$skill/scripts/writer.py" verify "${inputs[@]}" --bundle "$bundle"
```

The compiler records the source and PDF and checks the local build inputs. Deliver the clean compiled PDF and the independent source directory with its resources. For a guided task, record the checked and delivered outputs in the ledger, keep the receipt for recovery, and complete the same Goal after all applicable products have been delivered. The game and paper can be produced in parallel after verification. If the author confirms withdrawal of the last target in guided verification, save the unpublished task and explain the outcome.

## Revise a delivered paper

Identify the draft the user wants to revise. If the user has not selected one, ask before dispatching the fresh Writer session. The draft may be a prior Writer delivery or any draft the user designates. Give the Writer that exact draft, all feedback and the complete verified game-script materials. The Writer receives the indicated draft as the revision subject and chooses the weight of each input. Revision does not change the script, the review state, or start another verification.

Build and check the clean paper as above before generating its comparison. The helper uses PyMuPDF to check the marked PDF and latexdiff for automatic markup. The coordinator compares the actual contents of the designated draft with the clean paper. Ignore pre-existing revision colors. Color only additions and rewrites in a separate TeX source copy and compile it. The marked PDF contains the new paper's full content. Deleted material stays out.

```bash
python3 "$skill/scripts/writer_revision.py" --main "$snapshot/main.tex" \
  --bundle "$bundle" --baseline "$designated_draft"
```

For a baseline in another format, use a checked TeX rendition with `--baseline-view`, or compare the exact baseline with the checked clean draft and prepare the marked TeX in a dedicated source copy. If the automatic comparison needs correction, use the same separate source-copy procedure. Supply the coordinator's marked entrypoint with `--marked-tex`. Check the marked rendering against the clean paper and the designated baseline. Deliver the clean PDF, clean source and resources, and the TeX-generated marked PDF. Keep both the marked TeX and the comparison record with the revision history.

## Referee report

Use the configured public referee Writer model and effort (defaults `gpt-6.2-sol / ultra`). Use the preserved original and verified findings on withdrawal of the final target. For active targets, use the same filtered approved script used by the game. Deliver the checked editable Markdown even when there are no confirmed flaws.

Read the full bundled [Humanizer v4.0.0 instructions](humanizer/SKILL.md) before drafting. Use its embedded mode throughout drafting, editing and self-check. Apply every instruction that fits the public report. Resolve conflicts in favor of the Proof2Game user requirements and preserve the required headings, exact quotations, notation, hypotheses, citations, and degree of certainty. Compare the revised passages with their sources.

Identify the exact original version and publication date. Write a standard
English referee report addressed to the authors and applicable without a
target journal. The report discusses the original manuscript only. Do not refer
to a game, script, companion draft, or internal review process. Omit any
editorial disposition such as accept, reject, minor revision or major revision.

Internally compare each active target and its argument with the original. Cover every approved finding, including a finding on a discarded dependency. Draft the report using [writer-referee.md](../assets/writer-referee.md). Give the original edition and the scope reviewed. Use these four body sections in order.

1. **Summary**. Open with one objective sentence identifying the question and the paper’s main contribution. Read it on its own. Then give the hypotheses, scope, results and proof ideas. Attribute claims about what is new to the manuscript where appropriate.
2. **Assessment**. Open with one sentence giving the referee’s overall judgment. When there are major issues, state their actual number and their collective impact on the claim or proof in that sentence. Then give the reasons for the assessment. Explain how any substantive difficulty affects that judgment and refer to its numbered item below.
3. **Major Issues**. Number the issues that materially affect correctness, proof, scope or contribution, with the most consequential first.
4. **Minor Issues**. Number localized issues of exposition, notation, references or typography. In either issues section, state explicitly when there is nothing to report.

In both lists each item gives, in order, the location in the original, the shortest sufficient verbatim quotation, and the problem. Include the original page and, where available, the theorem, equation or paragraph. Italicize every verbatim excerpt throughout the report, including short inline quotations, quoted symbols, and quoted formulas. For a standalone passage use a Markdown block quote with emphasis inside it. Use an emphasized inline math span for a quoted equation, with a display-style formula when needed. Preserve the original math notation, upright operators, conditions and punctuation. Check each excerpt against the original rendering. Keep the location and diagnosis in regular text.

State exactly what is wrong in the quoted passage and give only the evidence needed to check it. For a false claim, a verified counterexample suffices. If a counterexample covers only part of a parameter range, state where the quoted claim fails. For a proof gap, identify the unsupported inference. For inconsistent notation, point to the discrepancy. End the item there. Keep any analysis of consequences for later results in the private comparison. Leave proposed assumptions, repairs, revised constants or statements, alternative proofs, symbol mappings and replacement wording to the authors throughout the report, including in the Assessment. With a confirmed final withdrawal, describe the original claim and the evidence bearing on it.

For a requested new report on an existing approval, use the preserved original and the same sealed snapshot (or final-withdrawal authorization), and write to a fresh versioned bundle. The prior delivery and the mathematical review remain available.

The approved snapshot binds the preserved original by `original_sha256` and records `referee_comparison: true`. When findings exist, use the bound project `report.md` as supporting evidence and check its `report_sha256`. The `report_findings` list is empty when no hard finding was confirmed; otherwise each record has nonempty `id`, `location`, `original_conclusion`, `evidence` and `verification`, and optional `confirmed_revision` with `new_conclusion` and `user_confirmation`. The snapshot-free final-withdrawal authorization has `schema: 1`, `kind: "referee"`, `project_type: "public"`, `reason: "last-target-withdrawn"`, `snapshot_digest: null`, the fixed `cutoff`, the findings bindings, and `withdrawal` with `targets`, `counterexample`, `evidence` and `user_confirmation`.

## Prepare and check the referee report

Use these commands for a guided report or its replacement. Substitute actual absolute paths.

```bash
# Verified public project with active targets
inputs=(--kind referee --main "$snapshot/main.tex" --target "$task/target.json")

# Or final public withdrawal
inputs=(--kind referee --withdrawal "$withdrawal_record" --target "$task/target.json")

python3 "$skill/scripts/writer.py" inspect "${inputs[@]}"
python3 "$skill/scripts/writer.py" prepare "${inputs[@]}" --markdown "$draft/referee.md" --bundle "$bundle"
```

Preview the referee Markdown locally with math support. Check the text, mathematics and all locators in context. Record the actual observations in a JSON self-check. Include the candidate's `input_digest` and `artifact_sha256`, along with `worker_session`, `model`, `effort`, `render` and `references`. In `humanizer`, describe a concrete editing decision and how you checked mathematical fidelity or handled a conflict with the writing guide. Keep this note in the private receipt.

- Add `scope` and `findings`, an object keyed by every approved finding ID with `original_location` and `evidence` pointing to the quoted passage and its local diagnosis in the report. Use an empty object when there are no findings. Include a `withdrawal` location for final withdrawal. Any verified repair in the approval is private. With `referee_comparison: true`, add `comparison`, keyed by each active target with `original`, `script` and `report` locators. A shared Summary or Assessment passage can cover several targets.
- Check the two issue lists against the rendered Markdown. Record `issues` as an object with `major` and `minor` arrays in report order. For each numbered issue record its `location`, `quotation` and `problem`: identify the passage checked in the original, the words or formula reproduced, and the error or proof gap supported by the evidence there. An empty list corresponds to an explicit statement in its section. In `diagnosis_only`, record how you checked that each item ends at the local diagnosis and its direct evidence. Also check that any proposed repair stays private.

Record the actual first sentences under `openings.summary` and `openings.assessment`, and the integer number of major items under `openings.major_count`. Read each opening sentence on its own. In `opening_judgment`, record how the first conveys the paper’s contribution and how the second conveys the judgment, count and combined impact. In `italics`, record where and how you checked the styling of the original passages and quoted formulas. Preview the editable file after the final change.

Correct writing or transcription errors and prepare a fresh candidate if needed.

```bash
python3 "$skill/scripts/writer.py" finish "${inputs[@]}" --bundle "$bundle" --checks "$checks"
python3 "$skill/scripts/writer.py" verify "${inputs[@]}" --bundle "$bundle"
```

Completion requires `receipt.json` and verification against the same inputs and the exact delivered file. Historical sealed PDF reports and paper receipts remain verifiable. Record the current receipt in the guided task state and deliver the applicable artifact paths. Mechanical checks bind observations to exact bytes. The actual public referee Writer performs the comparison and document inspection.

## Incidental problems in shared inputs

During guided delivery, when a material mathematical problem in the shared English script becomes evident during game or public referee delivery work, immediately send the coordinator the snapshot digest, affected target and component labels, exact location, evidence, impact and relevant artifact version. The coordinator pauses the affected game and applicable public referee report, informs the user of any already-delivered affected version, and returns the issue to verification. Regenerate from the revalidated snapshot and identify each superseded version.

Apply the same procedure if checked report evidence undermines a necessary detour, providing both the original counterexample and affected route. If a verified final-withdrawal report can no longer rely on its counterexample and there is no other verified evidence for the withdrawal, give the coordinator the precise mistake for `refactor`, where the user decides whether to restore verification or keep the withdrawal. Use separate versioned output directories so valid existing artifacts and recovery information remain available.
