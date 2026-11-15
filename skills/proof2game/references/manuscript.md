# Game script

Create an English script alongside the preserved original. The two-section assembly in
[script-template.tex](../assets/script-template.tex) demonstrates the structure.
Copy it as `main.tex` and [script-example/](../assets/script-example/) as `components/`,
then replace the example material and declarations with the project’s mathematics.
Use `\MSgap{...}` for a specific missing proof obligation. A gap stays open for verification.

## Structure and scope

- **Main Results** declares the target statements and their conventions. When a common convention
  applies, place it before the statements that adopt it. Optional numbered context blocks each
  start with a convention. Conventions accumulate along the Main Results, with no retroactive
  changes, overrides or shadowing.
- **Detailed Proofs** has one root per target in Main Results order. Open a root with
  `\MSnode{statement-id}{N}`, where `N` counts all Main Results conventions adopted
  at the target’s declaration. Open a child with `\MSnode{statement-id}{}` to inherit
  the context of its own declaration. End each node with `\MSendnode`.
- Within a node, declare at most one local convention first, followed by the new child
  statements in order, then that node’s paired proof. After the proof, expand the
  child nodes in declaration order. Give each dependency a single statement/proof
  pair. Place new lemmas under the first direct proof that uses them, and reference
  previously closed results by stable labels. A local convention passes to descendants
  and has no effect on sibling nodes or a target’s mathematical meaning.
- Declare each component with `\MScomponent{ID}{type}{path}{pair}{kind}{title}`.
  Use `convention`, `statement` and `proof` as the component types. Supply a
  reciprocal paired ID for statements and proofs, and a theorem kind for a statement.
  The title is optional. Paths are relative to `main.tex`. Declare every component in a
  separate visible TeX file and keep assembly literal. Use `\ref{ms:ID}` for
  mathematical uses of statements. `\ref{proof:ID}` links to a paired proof; use a
  proof ID there. The assembly prints each statement's proof locator from the paired
  labels and gives each proof node a depth-specific section number.
- Keep branch prose in its components so the source and associated resources can be
  excluded if that branch retires. Active nodes can refer to declared results once
  the required proof has closed in tree order. Use explicit references for mathematical
  dependencies, rather than relying on earlier appearance.

The components of the dependency union are the targets, reciprocal statement/proof
pairs, transitive referenced interfaces and applicable conventions. The calculator
checks declaration order, first direct use, scope and cycles in the visible structure.
It cannot find a mathematical dependency left implicit in the text or determine
whether a proof establishes its paired statement. Reviewers check those questions.

## External interfaces and compile checks

Write any used definition, normalization, hypotheses, parameter domain and exact
conclusion locally. Cite the exact publication or preprint and location. An externally
proved existence specification can live in a convention; fix one witness when multiple
consumers need the same one. A separately invoked external result is a labelled
theorem-like interface inside a convention. Give nontrivial transfer arguments their
own statements and proofs. Keep inline amsrefs bibliographic records in `main.tex`,
including confirmed zbMATH identifiers as nonprinting comments. Use literal local
paths for figures and TeX support files.

Run the helpers relative to the installed skill, supplying the project path:

```sh
python3 scripts/manuscript.py inspect /path/to/main.tex
python3 scripts/manuscript.py verify-pdf /path/to/main.tex
```

Compile the actual source associated with structural edits, and check its rendered
numbering and references. The verification helper compiles a private copy of the
active assembly with local TeX, checks unresolved cross-references and compares
the extracted PDF text to the real proof levels and adoption locations. It needs
`pdftotext` or Python's `pypdf`. Compilation checks the rendering and references;
mathematical and route verdicts come from the verification workflow.

## Runtime interfaces

- `parse(main)` yields a public structural dictionary and a full dictionary with
  private TeX body and transition excerpts. `targets`, `main_results`, `cone`
  and `open_obligations` are ordered component ID lists. The digest covers the
  current assembly, component bodies and declared local rendering resources.
- `review_payload(main, component, gate)` prepares a detached packet for the
  current review gate. The coordinator supplies its dispatch/worker binding and
  attaches sources only for the source and reuse gates. A convention's opening
  packet uses only its first nonempty paragraph, local heading and adoption,
  inherited conventions, and explicitly cited prior statement interfaces.
- `materialize_snapshot(main, empty_directory)` atomically creates the filtered
  `main.tex` and its TeX/graphics resources. It preserves the working sources,
  removes inactive inputs and subtrees, and prunes inline bibliography entries
  without retained citations. Apply the review/route eligibility checks before
  producing a delivery snapshot and then give the same snapshot to both exporters.
  The game exporter attaches the PDFs cited by the retained script.
