# Writer

Writer runs inside guided delivery. Use the configured Writer model and effort (defaults `gpt-6.1-sol / ultra`). Give the worker its role, its output workspace, and the input paths for its delivery. The coordinator keeps the script and verification state read-only for Writer. Writer compares its output with accepted source material and self-checks the compiled PDF. Mathematical review and deliberate searches for errors belong to the verification workflow.

## Choose the delivery

- **Unpublished project with active targets.** Write a complete English paper from the same filtered approved snapshot used by the game. Cover every active target in Main Results. Hand the user the checked compiled PDF and the independent LaTeX source directory with all necessary resources.
- **Public project with active targets.** Write a generic English referee report for the exact original. Compare it with the same final approved script used by the game. Deliver the checked compiled PDF even when there are no confirmed flaws.
- **Public project with confirmed withdrawal of the final target.** Use the preserved original, verified findings and withdrawal record. Deliver the checked compiled referee PDF.
- In guided mode these deliveries and the game can proceed in parallel when applicable. The coordinator checks that the receipt is still current, hands over each checked artifact individually, and completes the same Goal after every applicable artifact has been checked and handed over. The coordinator retains receipt and validation records for recovery.

## Complete paper

Use the authorless `amsart` A4 12pt style with 1-inch margins and inline `amsrefs` after `hyperref`. Use one theorem counter for theorem-like environments, a separate equation counter, both section-based, and `mathtools` `showonlyrefs` with `\eqref`. Use clickable links and stable numbering under the default or user-requested format. Start with [writer-paper.tex](../assets/writer-paper.tex).

Write for an advanced PhD student in the broad subject area. Introduce the problem from a familiar concrete fact and naturally develop the known progress, real difficulty, method, and scope. State the main results exactly with all needed definitions and hypotheses already in place, then discuss related literature. Arrange the rest of the manuscript, notation, intermediate results, and appendices as the argument requires.

Retain each accepted target's strength, scope, hypotheses and proof route. Readers should be able to reconstruct the proofs from the paper and its verified references. Give reasons for nontrivial steps and explain key ideas. Where mathematical prose and formulas both carry substantive meaning, use both consistently. Retain attribution for the mathematics that remains. Verify what each specialized source establishes and how its hypothesis and scope match the paper's use. Existing relevant feedback may inform exposition within the accepted mathematics.

## Referee report

Identify the exact original version and publication date. Write a standard
English referee report addressed to the authors and applicable without a
target journal. The PDF discusses the original manuscript only. Do not refer
to a game, script, companion draft, or internal review process. Omit any
editorial disposition such as accept, reject, minor revision or major revision.

Internally compare each active target and its argument with the original.
Use the completed reviews as evidence. When no mathematical error has been
confirmed, still assess the significance and scope of the results. Include
concrete suggestions that help readers understand or check the proof, and
include warranted minor comments on wording, notation and exposition. Give
precise original section, statement, equation or page locators for specific
comments. Do not manufacture suggestions or claim certification of the
whole paper. Use [writer-referee.tex](../assets/writer-referee.tex).

For each approved finding, including one from a discarded dependency, give
the original location, checkable evidence, and affected original conclusion.
If a corrected target was independently verified, present the correction as a
suggested change to the original statement. Keep full replacement proofs
internal. For a final target withdrawal, explain the original conclusion and
the evidence showing the claim must be withdrawn.

The approved snapshot binds the preserved original by `original_sha256` and records `referee_comparison: true`. When findings exist, use the bound project `report.md` as supporting evidence and check its `report_sha256`. The `report_findings` list is empty when no hard finding was confirmed; otherwise each record has nonempty `id`, `location`, `original_conclusion`, `evidence` and `verification`, and optional `confirmed_revision` with `new_conclusion` and `user_confirmation`. The snapshot-free final-withdrawal authorization has `schema: 1`, `kind: "referee"`, `project_type: "public"`, `reason: "last-target-withdrawn"`, `snapshot_digest: null`, the fixed `cutoff`, the findings bindings, and `withdrawal` with `targets`, `counterexample`, `evidence` and `user_confirmation`.

## Compile and check

These commands are internal to guided delivery. Substitute real absolute paths. Set modes using shell array elements so paths containing spaces stay intact.

```bash
# Unpublished project
inputs=(--kind paper --main "$snapshot/main.tex")

# Or verified public project with active targets
inputs=(--kind referee --main "$snapshot/main.tex" --target "$task/target.json")

# Or final public withdrawal
inputs=(--kind referee --withdrawal "$withdrawal_record" --target "$task/target.json")

python3 "$skill/scripts/writer.py" inspect "${inputs[@]}"
python3 "$skill/scripts/writer.py" compile "${inputs[@]}" --tex "$draft/main.tex" --bundle "$bundle"
```

Keep draft TeX and local compile resources in a dedicated source directory. Put build output in a separate new bundle directory. Use MacTeX's `latexmk` and `kpsewhich` from the configured execution environment. The compile step copies local sources, compiles them using the selected engine, checks the dependency recorder for external inputs, rejects unresolved or unstable references, then emits a candidate record and actual PDF. Keep this evidence with the build.

Open the compiled PDF locally. Check document text, cross-references, citation targets, page and equation numbering, and math renderings in context. Verify the PDF against the draft and record actual observations in a JSON self-check using the candidate's `input_digest`, `source_digest` and `pdf_sha256`. Include `worker_session`, `model`, `effort`, `render` and `references`.

- For a paper, check statement and proof fidelity against the snapshot. Add `fidelity` and `targets`, an object keyed by every target label with its `statement` and `proof` PDF locations.
- For a referee report, check its wording, mathematics, source locators and claims against the exact original, the script when available, and all verified findings. Add `scope` and `findings`, an object keyed by every approved finding ID with `original_location`, `evidence` and `affected_conclusion` PDF locations. Use an empty object when there are no findings. Include a `confirmed_revision` location for each finding with a confirmed revision and a `withdrawal` location for final withdrawal. When the approval has `referee_comparison: true`, also add `comparison`, an object keyed by every active target with nonempty `original`, `script` and `report` locators. A shared assessment in the report can cover several targets.

Correct writing or transcription errors and compile a fresh candidate if needed.

```bash
python3 "$skill/scripts/writer.py" finish "${inputs[@]}" --bundle "$bundle" --checks "$checks"
python3 "$skill/scripts/writer.py" verify "${inputs[@]}" --bundle "$bundle"
```

Completion requires `receipt.json` and verification with unchanged inputs, source and PDF. Record it in the guided task state and deliver the applicable artifact paths. Mechanical checks bind observations to exact bytes. The actual Writer performs the comparison and PDF inspection.

## Incidental problems in shared inputs

When a material mathematical problem in the shared English script becomes evident during delivery work, immediately send the coordinator the snapshot digest, affected target and component labels, exact location, evidence, impact and relevant artifact version. The coordinator pauses all affected pending deliveries, informs the user of any already-delivered affected version, and returns the issue to verification. Regenerate from the revalidated snapshot and identify each superseded version.

Apply the same procedure if checked report evidence undermines a necessary detour, providing both the original counterexample and affected route. If a verified final-withdrawal report can no longer rely on its counterexample and there is no other verified evidence for the withdrawal, give the coordinator the precise mistake for `refactor`, where the user decides whether to restore verification or keep the withdrawal. Use separate versioned output directories so valid existing artifacts and recovery information remain available.
