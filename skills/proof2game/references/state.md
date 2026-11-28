# State and checkpoint commands

Run `python3 scripts/state.py --task TASK --status` from the skill directory.
`TASK` is the target-version work directory reported by intake. New tasks use
`PROJECT/.proof2game/<id>`. Existing `PROJECT/.mathgrove/<id>` tasks are opened
in place with their original Git and source records. The command resolves the
work directory by version ID in either location and stops if the ID occurs in
both. Its entrypoints are
`target.json` (intake receipt), `main.tex` (working assembly), and `state.json` (the verification
ledger). The original named by `target.json` is checked before using the ledger. Use script
operations to change the ledger. The commands record accepted judgments and real host
identities. Mathematical judgment belongs to the workers described in [workers.md](workers.md).

Send one operation as a JSON object on stdin or with `--request JSON_FILE`. The command returns
`state`, current dispatchable `actions`, the full `unsafe` list, any pending
`theorem_supplements`, and the stale and pending-write flags.
Each mutation after initialization takes `expected_revision` from the latest state. Reads and
recovery are revision-free. For parallel reviews, collect actual worker responses in parallel
and record them against the current revision one at a time. Retry a request rejected solely for
a concurrent revision after checking the action is still pending. A superseded token, changed
script or different host session never counts as a result.

To check session capacity, use `python3 scripts/state.py --task TASK --host-sessions -` with the normalized actual host inventory. It returns a read-only retirement plan; the coordinator verifies actual session state before acting.

## Initialization, dispatch, and completion

| Operation | Additional fields |
| --- | --- |
| `init` | `entry` (`guided`, `verify`, or `refactor`), actual `tool_release`, and optional `models` mapping role names from [roles.json](roles.json) to `[model,effort]`. Guided and verify require actual `goal:{id,evidence}` and `coordinator:{session,model,effort,evidence}`. Manual refactor takes the concrete `reason`. |
| `start` | Same fields as init. Starts a new entry from completed state, or after an explicit abandonment at a paused boundary (`abandon_evidence`). Valid classifications and accumulated evidence remain. |
| `advance` | No extra fields. Call while awaiting next dispatch, after a guided route pass, or after confirmed last-target withdrawal. On a legacy approval or delivery that still needs a theorem supplement it returns to review first. |
| `goal-complete` | The same `goal_id` and verifiable host completion `evidence`. Call the actual Goal tool only once the ledger shows `phase:complete`, then record its return. |
| `select-release` | Actual approved `tool_release`, user `approval` receipt, verified `compatibility` evidence, and the supported ledger `schema` (currently 1). Retains completed results and rebinds unfinished actions. Finish an active application or delivery before switching their release. When an upgrade needs supplemental theorem review, the ledger can suspend a pending approval or delivery while it obtains that review. |

The first round contains all Main Results components. Subsequently each new round schedules
unsafe components in the dependency union and any required supplemental theorem reviews.
A supplement uses the component's bound legacy `sources` result and schedules only
`external_theorems`. The `reuse` result alone does not create a supplement. An unfinished
legacy round can finish with its saved gate positions. The ledger supplements any resulting
relevant old safe pass at the next boundary. A failed supplement goes through Fixer and a
fresh full review. `dispatch` schedules Explorer when no review work remains.
Explorer carries the computed union, proposed additions
and removals. The ledger applies the final structural union in manuscript order, removes the
old classification of each retired component, and marks an admitted or readmitted component
unsafe. Files and earlier results are retained. The loop counter increases only at completed
loop boundaries, and the round counter only after its updater. Each re-queued Reviewer action
contains its one gate and exact binding. Use [workers.md](workers.md) to prepare a scoped packet.
Keep all ledgers, sibling role output, paper URLs, and blocked evidence outside blind gates.

## Action receipts

Every action-specific operation includes the action's `token` and `snapshot_digest`.
`bind` also needs actual `session`, `model`, `effort`, and `evidence`. Bind a session only once;
a Reviewer continues with the same identity on subsequent gate tokens. `result`,
`replace`, and `fixer-progress` repeat the bound `session`. Each completed result or
replacement includes checkable `evidence`.

- Reviewer verdicts are `pass`, `nonpass`, and `waiting-source`. Nonpass also takes
  `location` and `issue`. Sources and reuse pass need `sources` with the actual intake
  records used (an explicit empty list when none). Include an ID, original SHA-256,
  and locators with nonempty physical page lists per [intake.md](intake.md). The runtime
  validates date, version, original digest, and intake completeness. A sources
  pass also reports `theorem_uses`, one object per theorem actually used, with
  `id`, `sha256` and `locator` matching `sources`, plus `statement` and `use`.
  A saved older sources receipt may omit `theorem_uses`. Source-blind gates receive
  no literature material or receipt.
- An `external_theorems` pass takes `theorems`, with `id`, `sha256`, `locator`
  and a one-sentence `reason` per theorem, or `[]` when none applies. If the
  Reviewer used specific material, include `materials` as a list of
  `{source,locator}` objects. A nonpass reports `issue` and `location`, and
  for a bound external theorem includes `theorem_finding` with the same
  identity fields, `kind` of `uncertain`, `proof-error` or `counterexample`,
  and `materials` if used. This evidence is distinct from `sources` and can
  include material after the script cutoff. If the Reviewer cannot resolve
  a doubt, return `nonpass`.
- Waiting-source takes `source` (the reference's stable project work key), `source_version`
  when an exact edition is required, `location`, and boolean `required`. Omit `source_version` when unknown.
  The runtime treats the earlier literal `unknown` as an omitted version. Identify the work in `evidence`.
  The other Reviewers may continue. Use `source-resolve` with `status` of `available`,
  `unavailable`, or optional-only `waived`, with the actual check or user response as
  `evidence`. For `available`, provide the ingested reference ID. Its work key and any specified version must match the wait.
  If the user explicitly chooses another eligible edition of the same work, include
  `version_override: {version, user_confirmation}` with the exact registered version and the user's decision.
  Both versions are recorded and the same Reviewer continues from the waiting gate.
  A pass after a required wait must cite the resolved reference ID and original SHA-256 with physical pages.
  An `unavailable` response leaves a Reviewer or Fixer source wait in place. An explicit optional waiver
  can resume the gate and is reusable while the same work remains optional.
- Batcher returns `issue_ids`, a lossless ordered list of the entire batch. The runtime
  queues one serial Fixer after the batch. A Fixer action with `waiting.kind: reviewer-sources`
  cannot bind or accept progress. Use one of `waiting.tokens` to resolve the corresponding Reviewer
  source. Arrival reopens the original review, and a changed set of finding IDs requires a new Batcher handoff.
  `fixer-progress` and Fixer results take optional `issues`, a map from issue ID to
  `{status,evidence}` for `fixed`, `resolved`, `irrelevant`, `clarified`, `disagreed`, or
  `blocked`, and the task-relative `staging` directory. The whole round must be
  accounted for. A blocked Fixer reports `blocked` and may set `attempt_infeasible:true`
  for a failed route attempt. Otherwise it returns `no-change` or `candidate`.
  For a concrete proof error or counterexample, the completed disposition also
  gives `theorem_resolution:{status,evidence,affected_components}` with
  `confirmed` or `refuted` and any additional actual affected component IDs.
  The ledger reopens matching uses when the finding is confirmed, including
  when a component's text did not change. List additional consumers that
  depend on the same claim through other citations or interfaces. Any `sources`
  submitted by the Fixer remain bound to the script cutoff.
- Explorer returns `no-change`, `candidate`, or a concretely evidenced `blocked`.
  Use `blocked` when a real refactor decision is needed. A failed attempt to weaken a
  lemma, or an incidental defect Explorer cannot reliably address, goes to ordinary
  review as specified in [verification.md](verification.md).
- The public route reviewer returns `pass` or `nonpass`. The simplification reviewer
  returns `no-simplification` or `simplify`. A negative public verdict or proposed
  private simplification also takes the concrete repair/simplification `plan`.
  After implementation and new mathematical review, private comparison returns
  `improved`, `worse`, or `tradeoffs`. Tradeoffs also require the main coordinator's
  `decision` (`keep` or `rollback`) and `decision_evidence`.
- A Refactor implementation returns `candidate`, `no-change`, or `blocked`. A
  candidate from Fixer, Explorer, or Refactor supplies task-relative `candidate`
  (under `staging/`, a complete staged game script) and the parsed `candidate_digest`.
  This does not apply it. The coordinator inspects compilation, evidence and the proposed
  effect, then submits the operation below. For a merged round, pass any newly resolved
  issues with their independent supporting reason. If issues remain, the Fixer continues
  the original batch with staged refactor changes.
- To replace a confirmed lost session, submit `replace`. The replacement Reviewer
  restarts only that component at its first assigned gate. A supplement retries
  only the external-theorem gate. A replacement Fixer gets original
  issues, dispositions and staging for verification and continuation. Neither step
  invents a result or increments a completed-round counter.

When Fixer confirms a hard flaw in the original public target, maintain `TASK/report.md`
with the exact version, locator, checkable grounds, impact, and any necessary detour.
Include `report_findings` with structured `id`, `location`, `original_conclusion`,
`evidence`, `verification`, and optional user-confirmed `confirmed_revision:
{new_conclusion,user_confirmation}`. See [writer.md](writer.md) for the downstream
meaning of these fields. The route action and delivery receipt bind the report hash.
External file or classification issues should be diagnosed, not marked passed.

## Writes, user decisions, and rollback

`apply-candidate` takes `target_meaning_evidence` and the list `target_meaning_changes`.
`changes` maps stable component IDs to an evidenced `meaning` or `transition` judgment
where the corresponding structural inputs or reader context changed. Each is
`equivalent` or `substantive`, with `meaning_evidence` / `transition_evidence` as applicable.
A renderer or hash change is a reason to obtain a judgment, not an automatic finding
about the underlying mathematics. Substantive dependency, convention, proof-pair and
statement-transition changes trigger affected existing reviews. Newly created and
previously retired components enter through Explorer. The command independently checks
the staged binding, recompiles and checks cross-references, and uses just the originating
updater.

Use `pause` with `kind` (`user`, `capability`, or `refactor`) and `evidence` for a
concrete blocking condition. The paused phase and live action tokens are retained.
For a real user decision use `refactor-decision` with exact `confirmation` and
`decision` of `implement`, `resume`, `no-action`, `withdraw-last`, or
`maintain-withdrawal`. Implementation takes `plan`. A change to a target theorem's
mathematical meaning or membership also takes the exact list `targets` and the
confirmed staged `candidate_digest`. Do not edit the working script during discussion.
A confirmed no-action pause requires `replace_no_action:true` and evidence of explicit
user authorization before leaving it. Last-target withdrawal binds all remaining target
IDs and verified evidence. In a public project provide the verified `counterexample`
and `report_findings` for the report-only branch.

The runtime creates local Git checkpoints for the managed script and scripts' assets.
It uses the active project branch and preserves unrelated changes. It does not push a
project. `checkpoint` records an additional baseline if needed. When the phase is
`rollback`, call `rollback` with evidence of the failed attempt. It restores recorded
resource bytes and effective classifications without pruning the audit trail. New files
from a discarded route are archived. All counters and attempted-route records survive.

If an application or rollback is interrupted, `recover` resumes its journal only from
the bound old or already applied bytes. It stops on unrelated external changes. If status
is stale without a journal, inspect the live files and existing checkpoint with the
coordinator. Preserve the user's independent edits separately and stage any approved
changes using the same workflow. Never reinitialize around an existing legacy ledger.

## Delivery

After `advance` at a guided approval, read `state.delivery`. Its immutable filtered
`main.tex` and `approval.json` supply the game and the applicable public referee
report. Public approvals schedule both `game` and `referee`. Their
`referee_comparison: true` binds the referee comparison to the preserved original,
and confirmed original-text findings are included when present. Report-only
withdrawal has `snapshot_digest: null` and a distinct certificate that authorizes
the public referee report. The unpublished last-target branch ends without a game
or paper.

Unpublished approvals schedule `game` and `paper`. For the paper, use
`state.delivery.paper_approval_path` and its adjacent `main.tex` as the retained
approved script input. Earlier approvals without this field use `approval_path`
and its adjacent `main.tex`. Follow the [paper handoff](writer.md#complete-paper)
to provide the other materials to the independent Writer. The paper receipt
binds exact delivered files and the script input it received. The coordinator checks
compilation and file completeness.

Submit `deliverable` for each product (`game`, `paper`, or `referee`) with the exact
`snapshot_digest` (including null for withdrawal), its `kind`, `status`, and `evidence`.
Statuses are `pending`, `blocked`, `checked`, and `delivered`. Checked takes the
task-relative `artifact` and its actual `sha256`; Writer receipts are revalidated.
Record actual user delivery after check. The guide ends only once all applicable
products are delivered. Independent output problems block only the affected product.

For a user-requested replacement referee report on the same approval, finish and verify the new Writer bundle, then hand over its editable Markdown file. Record a `deliverable` for `kind: referee` with `status: replacement-delivered`, the usual snapshot, artifact, sha256 and verification evidence, the previous report's `previous_sha256`, and a `message_receipt` for the new handoff. This replaces the referee entry in one transaction and records its predecessor in history. Use a fresh bundle. The same operation works after the guided task has finished.

For an incidental substantial math concern in the game or public referee report, the
`incident` operation takes `kind` (`script` or `counterexample`), the exact current
`snapshot_digest`, affected `components` when known, and specific `evidence`.
It revokes the affected approval, records prior receipts for replacement notices,
and reenters validation. A counterexample concern is first rechecked by the queued
Fixer. Its result is `confirmed`, `refuted`, or `blocked`, with any revised
`report_findings`. A failed withdrawal ground can return to user refactor. Use the
game production flow for translation corrections.

For a concrete external-theorem defect found at delivery, use `incident` with
`kind: external-theorem`, the active snapshot and `theorem_finding` as above.
The ledger suspends the affected handoffs while Fixer checks the claim. A
`refuted` result resumes the earlier delivery. A `confirmed` result revokes
the approval and reopens matching consumers. Include any additional
`affected_components` as an array of IDs. If the check is `blocked`, the
delivery remains suspended.

During an unpublished game's shared-script incident, the current paper moves to
`state.independent_paper`. Use its `approval_path`, adjacent `main.tex`,
`snapshot_digest`, and `products.paper` to continue checking or delivering that
paper under its original input. A replacement `state.delivery` covers the game.
Complete the guided Goal after both applicable outputs have been delivered. Use
a current verified script for a new paper or revision. The retained input remains
available to check an already bound paper or its marked copy.
