# Writer

Writer handles the first guided delivery and user-requested revisions of delivered unpublished papers. Use the configured Writer model and effort (defaults `gpt-6.2-sol / ultra`). Give the worker its role, its output workspace, and the input paths for its delivery. The coordinator keeps the script and verification state read-only for Writer. Writer compares its output with accepted source material and self-checks the rendered delivery. Mathematical review and deliberate searches for errors belong to the verification workflow.

For a paper, a referee report or a revision, read the full bundled [Humanizer v4.0.0 instructions](humanizer/SKILL.md) before drafting. Use its embedded mode throughout drafting, editing and self-check. Apply every instruction that fits the task. Resolve each conflict in favor of the Proof2Game user requirements and apply the rest. For example, trim repetition while preserving the required headings, exact quotations, notation, hypotheses, citations, proof route and degree of certainty. Compare the revised passages with their sources. The author-facing document contains the finished prose.

## Choose the delivery

- **Unpublished project with active targets.** Write a complete English paper from the same filtered approved snapshot used by the game. Cover every active target in Main Results. Hand the user the checked compiled PDF and the independent LaTeX source directory with all necessary resources.
- **Public project with active targets.** Write a generic English referee report for the exact original. Compare it with the same final approved script used by the game. Deliver the checked editable Markdown file even when there are no confirmed flaws.
- **Public project with confirmed withdrawal of the final target.** Use the preserved original, verified findings and withdrawal record. Deliver the checked editable Markdown referee report.
- In guided mode these deliveries and the game can proceed in parallel when applicable. The coordinator checks that the receipt is still current, hands over each checked artifact individually, and completes the same Goal after every applicable artifact has been checked and handed over. The coordinator retains receipt and validation records for recovery.

## Complete paper

Use the authorless `amsart` A4 12pt style with 1-inch margins and inline `amsrefs` after `hyperref`. Use one theorem counter for theorem-like environments, a separate equation counter, both section-based, and `mathtools` `showonlyrefs` with `\eqref`. Use clickable links and stable numbering under the default or user-requested format. Start with [writer-paper.tex](../assets/writer-paper.tex). Use the supplied paper title when applicable, or write a descriptive English title for the approved result. Typeset it prominently on page one above the abstract or introduction. Read the actual title on the rendered page and check that the byline is empty.

Read every work actually cited by the final approved script in full. Use the citation keys from `writer.py inspect --kind paper` and the project’s reference records to locate the corresponding editions. Include citations in retained narrative, proofs and rendering resources. If a source is missing, follow the project’s reference intake procedure and retain the writing checkpoint. Assess the exposition from the perspective of an advanced PhD student in the broad subject area who is new to the specialty. Choose works or passages that would help this reader, and draw on their sentence structure, choice of words and rhythm. Write original prose in plain, precise language and explain why each key step enters the argument. Keep the verified mathematics and proof route. The Writer chooses the exemplars and its writing process.

Write for this reader. Introduce the problem from a familiar concrete fact and naturally develop the known progress, real difficulty, method, and scope. State the main results exactly with all needed definitions and hypotheses already in place, then discuss related literature. Arrange the rest of the manuscript, notation, intermediate results, and appendices as the argument requires.

Place one end-of-proof square on the last substantive line of each proof. For prose, close the proof in the same paragraph and check the line wrap. For a display, put the square on the final mathematical row. With a compatible AMS display use `\qedhere` on that row. Inspect the rendered PDF for a stranded or duplicated square, a displaced equation number or an overlap. If the line is crowded, reflow the prose or display and render it again.

Retain each accepted target's strength, scope, hypotheses and proof route. Readers should be able to reconstruct the proofs from the paper and its verified references. Give reasons for nontrivial steps and explain key ideas. Where mathematical prose and formulas both carry substantive meaning, use both consistently. Retain attribution for the mathematics that remains. Verify what each specialized source establishes and how its hypothesis and scope match the paper's use. Existing relevant feedback may inform exposition within the accepted mathematics.

## Revise a delivered paper

When the user requests a revision of their unpublished paper, locate the last official Writer delivery for this task and the approved snapshot. Run `writer.py verify --kind paper --main "$snapshot/main.tex" --bundle "$prior_bundle"` before drafting. Start with the checked source in that delivery. If a separately authorized verification changed the snapshot, verify the prior bundle against its own archived approved snapshot and use the current approved mathematics for the new version. Use a fresh draft directory and versioned output bundle for the new paper. A collaborator’s edited manuscript can supply feedback, serve as the comparison baseline, or do both. Keep the exact supplied file and the official starting manuscript distinct.

Feedback can take any form, including comments, correspondence, a referee report, a hand-edited draft or an unfinished game save. Establish who supplied it, in what circumstances, which version it addresses and how it relates to the current draft. Ask the user when the answer would change the interpretation. Exercise editorial judgment: a comment can warrant the requested edit, no change, an edit in the opposite direction, or a different exposition that resolves the underlying difficulty.

Keep the approved game script and review state read-only. If a requested change needs different mathematics or a new verification, explain the location and reason to the user. The user decides whether to start a separate verification task. Continue any revision possible within the approved route. The guided-delivery escalation below applies only during guided delivery.

1. Produce the complete clean English paper, including the independent TeX source and resources. Compile, inspect, finish and verify it as a paper using the commands below. Start the comparison only after the clean version is checked.
2. Compare against the actual contents of the user’s designated file. When none was designated, use the PDF in the previous official Writer bundle. For a TeX, Word or other formatted baseline, render the exact supplied version with its resources to PDF, or extract the visible text. Check that version and text, including any edits in colored passages. For an image-only or partly scanned PDF, use a checked transcription. Existing revision colors have no bearing on the comparison.
3. Run the comparison helper with PyMuPDF installed in the Writer environment. It adds highlights to a copy of the complete clean PDF. It uses the words on the new pages to mark approximate additions and rewrites. Deleted old text stays out of the revision.

```bash
# Default baseline is the previous official paper.pdf.
python3 "$skill/scripts/writer_revision.py" --main "$snapshot/main.tex" \
  --previous "$prior_bundle" --bundle "$new_bundle"

# For a designated PDF or UTF-8 .txt file, append --baseline "$selected_file".
# For a converted or transcribed file, also append --baseline-view "$checked_rendition".
# If the prior paper used an earlier approval, append --previous-main "$previous_snapshot/main.tex".
```

Inspect the marked PDF beside the clean version and the selected baseline, including changed equations, line wraps and figure-heavy pages where word extraction can be approximate. If markup needs adjustment, use the checked clean PDF to prepare and inspect a corrected marked copy. Deliver the clean PDF, its source bundle and the marked PDF. Record the official clean bundle, baseline and delivered copy in the project's revision history so a later revision starts from the correct clean version. Keep the previous valid delivery available.

## Referee report

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

## Prepare and check

Use these commands for guided delivery and for the clean paper in a revision. Substitute real absolute paths. Set modes using shell array elements so paths containing spaces stay intact.

```bash
# Unpublished project
inputs=(--kind paper --main "$snapshot/main.tex")

# Or verified public project with active targets
inputs=(--kind referee --main "$snapshot/main.tex" --target "$task/target.json")

# Or final public withdrawal
inputs=(--kind referee --withdrawal "$withdrawal_record" --target "$task/target.json")

python3 "$skill/scripts/writer.py" inspect "${inputs[@]}"
# For a paper
python3 "$skill/scripts/writer.py" compile "${inputs[@]}" --tex "$draft/main.tex" --bundle "$bundle"

# For a referee report
python3 "$skill/scripts/writer.py" prepare "${inputs[@]}" --markdown "$draft/referee.md" --bundle "$bundle"
```

For a paper, keep draft TeX and local compile resources in a dedicated source directory. Put build output in a separate new bundle directory. Use MacTeX's `latexmk` and `kpsewhich` from the configured execution environment. The compile step copies local sources, compiles them using the selected engine, checks the dependency recorder for external inputs, rejects unresolved or unstable references, then emits a candidate record and actual PDF. Keep this evidence with the build.

Open the paper PDF or preview the referee Markdown locally with math support. Check the text, mathematics and all locators in context. Record the actual observations in a JSON self-check. Include the candidate’s `input_digest`. For a paper also include `source_digest` and `pdf_sha256`. For a referee report include `artifact_sha256`. Include `worker_session`, `model`, `effort`, `render` and `references`. In `humanizer`, describe a concrete editing decision and how you checked mathematical fidelity or handled a conflict with the writing guide. Keep this note in the private receipt.

- For a paper, record the visible first-page title under `paper_title` and its position relative to the abstract or introduction under `title_render`. Under `proof_endings`, record how many proof endings you inspected in the compiled PDF, where they occur, and how the squares align with the final prose line or equation row. Include display endings and any page or line break you corrected. Check statement and proof fidelity against the snapshot. Add `fidelity` and `targets`, an object keyed by every target label with its `statement` and `proof` PDF locations.
- For a referee report, add `scope` and `findings`, an object keyed by every approved finding ID with `original_location` and `evidence` pointing to the quoted passage and its local diagnosis in the report. Use an empty object when there are no findings. Include a `withdrawal` location for final withdrawal. Any verified repair in the approval is private. With `referee_comparison: true`, add `comparison`, keyed by each active target with `original`, `script` and `report` locators. A shared Summary or Assessment passage can cover several targets.
- Check the two issue lists against the rendered Markdown. Record `issues` as an object with `major` and `minor` arrays in report order. For each numbered issue record its `location`, `quotation` and `problem`: identify the passage checked in the original, the words or formula reproduced, and the error or proof gap supported by the evidence there. An empty list corresponds to an explicit statement in its section. In `diagnosis_only`, record how you checked that each item ends at the local diagnosis and its direct evidence. Also check that any proposed repair stays private.

For a referee report, record the actual first sentences under `openings.summary` and `openings.assessment`, and the integer number of major items under `openings.major_count`. Read each opening sentence on its own. In `opening_judgment`, record how the first conveys the paper’s contribution and how the second conveys the judgment, count and combined impact. In `italics`, record where and how you checked the styling of the original passages and quoted formulas. Preview the editable file after the final change.

Correct writing or transcription errors and prepare a fresh candidate if needed.

```bash
python3 "$skill/scripts/writer.py" finish "${inputs[@]}" --bundle "$bundle" --checks "$checks"
python3 "$skill/scripts/writer.py" verify "${inputs[@]}" --bundle "$bundle"
```

Completion requires `receipt.json` and verification against the same inputs and the exact delivered file. Historical sealed PDF reports remain verifiable. Record it in the guided task state and deliver the applicable artifact paths. Mechanical checks bind observations to exact bytes. The actual Writer performs the comparison and rendered-document inspection.

## Incidental problems in shared inputs

During guided delivery, when a material mathematical problem in the shared English script becomes evident during delivery work, immediately send the coordinator the snapshot digest, affected target and component labels, exact location, evidence, impact and relevant artifact version. The coordinator pauses all affected pending deliveries, informs the user of any already-delivered affected version, and returns the issue to verification. Regenerate from the revalidated snapshot and identify each superseded version.

Apply the same procedure if checked report evidence undermines a necessary detour, providing both the original counterexample and affected route. If a verified final-withdrawal report can no longer rely on its counterexample and there is no other verified evidence for the withdrawal, give the coordinator the precise mistake for `refactor`, where the user decides whether to restore verification or keep the withdrawal. Use separate versioned output directories so valid existing artifacts and recovery information remain available.
