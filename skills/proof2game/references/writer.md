# Writer

Writer runs inside guided delivery. Use the configured Writer model and effort (defaults `gpt-6.1-sol / ultra`). Give the worker its role, its output workspace, and the input paths for its delivery. The coordinator keeps the script and verification state read-only for Writer. Writer compares its output with accepted source material and self-checks the compiled PDF. Mathematical review and deliberate searches for errors belong to the verification workflow.

## Choose the delivery

- **Unpublished project with active targets.** Write a complete English paper from the same filtered approved snapshot used by the game. Cover every active target in Main Results. Hand the user the checked compiled PDF and the independent LaTeX source directory with all necessary resources.
- **Public project with approved original-text findings.** Write an English referee report using the exact original, the project's `report.md`, and the approved version of the game script. When the user confirms withdrawal of the final target on verified evidence, start the report directly using the preserved original and the withdrawal record. Hand the user the checked compiled referee PDF.
- In guided mode these deliveries and the game can proceed in parallel when applicable. The coordinator checks that the receipt is still current, hands over each checked artifact individually, and completes the same Goal after every applicable artifact has been checked and handed over. The coordinator retains receipt and validation records for recovery.

## Complete paper

Use the authorless `amsart` A4 12pt style with 1-inch margins and inline `amsrefs` after `hyperref`. Use one theorem counter for theorem-like environments, a separate equation counter, both section-based, and `mathtools` `showonlyrefs` with `\eqref`. Use clickable links and stable numbering under the default or user-requested format. Start with [writer-paper.tex](../assets/writer-paper.tex).

Write for an advanced PhD student in the broad subject area. Introduce the problem from a familiar concrete fact and naturally develop the known progress, real difficulty, method, and scope. State the main results exactly with all needed definitions and hypotheses already in place, then discuss related literature. Arrange the rest of the manuscript, notation, intermediate results, and appendices as the argument requires.

Retain each accepted target's strength, scope, hypotheses and proof route. Readers should be able to reconstruct the proofs from the paper and its verified references. Give reasons for nontrivial steps and explain key ideas. Where mathematical prose and formulas both carry substantive meaning, use both consistently. Retain attribution for the mathematics that remains. Verify what each specialized source establishes and how its hypothesis and scope match the paper's use. Existing relevant feedback may inform exposition within the accepted mathematics.

## Referee report

Identify the exact processed original version and publication date. For every approved finding, state the precise source locator (e.g. page and equation), the verified counterexample or other checkable evidence, and the affected original conclusion. Include approved findings from discarded dependencies. A necessary detour and replacement proof stay in the game script and project verification record. When the user has confirmed a revised target, state the original conclusion, counterexample and confirmed new conclusion. For a final target withdrawal, state the documented withdrawal after explaining the original conclusion and verified evidence. Start with [writer-referee.tex](../assets/writer-referee.tex).

Use the project's preserved original and `report.md` to check the structured findings and locators. The coordinator binds the approved report to the original's SHA-256 in `original_sha256` and the report's SHA-256 in `report_sha256`. Its `report_findings` has one record per approved finding, with nonempty `id`, `location`, `original_conclusion`, `evidence` and `verification`, and optional `confirmed_revision` containing `new_conclusion` and `user_confirmation`. These are locatable records from the underlying mathematical work. The snapshot-free final-withdrawal authorization has `schema: 1`, `kind: "referee"`, `project_type: "public"`, `reason: "last-target-withdrawn"`, `snapshot_digest: null`, the fixed `cutoff`, the same findings bindings, and `withdrawal` with `targets` (list of withdrawn target labels), `counterexample`, `evidence` and `user_confirmation`.

## Compile and check

These commands are internal to guided delivery. Substitute real absolute paths. Set modes using shell array elements so paths containing spaces stay intact.

```bash
# Unpublished project
inputs=(--kind paper --main "$snapshot/main.tex")

# Or verified public project with approved findings
inputs=(--kind referee --main "$snapshot/main.tex" --target "$task/target.json")

# Or final public withdrawal
inputs=(--kind referee --withdrawal "$withdrawal_record" --target "$task/target.json")

python3 "$skill/scripts/writer.py" inspect "${inputs[@]}"
python3 "$skill/scripts/writer.py" compile "${inputs[@]}" --tex "$draft/main.tex" --bundle "$bundle"
```

Keep draft TeX and local compile resources in a dedicated source directory. Put build output in a separate new bundle directory. Use MacTeX's `latexmk` and `kpsewhich` from the configured execution environment. The compile step copies local sources, compiles them using the selected engine, checks the dependency recorder for external inputs, rejects unresolved or unstable references, then emits a candidate record and actual PDF. Keep this evidence with the build.

Open the compiled PDF locally. Check document text, cross-references, citation targets, page and equation numbering, and math renderings in context. Check that the checked PDF and draft correspond. For the paper, compare all target statements and proof locations, assumptions and proof fidelity against the snapshot. For a referee report, compare wording, displayed math, citations, source locators and claims with the exact original and verified findings. Document actual observations and locations in a JSON self-check using the candidate's `input_digest`, `source_digest` and `pdf_sha256`. Include `worker_session`, `model`, `effort`, `render` and `references`. For paper add `fidelity` and `targets`, an object keyed by all target labels with `statement` and `proof` PDF locations. For referee add `scope` and `findings`, an object keyed by all approved finding IDs with `original_location`, `evidence` and `affected_conclusion` PDF locations. Include `confirmed_revision` location for findings with a confirmed revision and `withdrawal` location for final withdrawal. Correct ordinary writing or report transcription errors and compile a fresh candidate if needed.

```bash
python3 "$skill/scripts/writer.py" finish "${inputs[@]}" --bundle "$bundle" --checks "$checks"
python3 "$skill/scripts/writer.py" verify "${inputs[@]}" --bundle "$bundle"
```

Completion requires `receipt.json` and verification with unchanged inputs, source and PDF. Record it in the guided task state and deliver the applicable artifact paths. Mechanical checks bind observations to exact bytes. The actual Writer performs the comparison and PDF inspection.

## Incidental problems in shared inputs

When a material mathematical problem in the shared English script becomes evident during delivery work, immediately send the coordinator the snapshot digest, affected target and component labels, exact location, evidence, impact and relevant artifact version. The coordinator pauses all affected pending deliveries, informs the user of any already-delivered affected version, and returns the issue to verification. Regenerate from the revalidated snapshot and identify each superseded version.

Apply the same procedure if checked report evidence undermines a necessary detour, providing both the original counterexample and affected route. If a verified final-withdrawal report can no longer rely on its counterexample and there is no other verified evidence for the withdrawal, give the coordinator the precise mistake for `refactor`, where the user decides whether to restore verification or keep the withdrawal. Use separate versioned output directories so valid existing artifacts and recovery information remain available.
