# Game delivery

This is an internal step of guided startup. Use the immutable filtered delivery
directory that passed math and route review. Its approval.json must match the
game script and record closed proof obligations. Game production and the Writer
may run concurrently from that same directory and deliver independently. If
either happens to identify a substantive flaw in the English snapshot, stop
both deliveries, record the finding in verification, and rebuild from the newly
reviewed snapshot. Correct a translation-only defect in the game translation.

## Translate and package

1. Run the exporter in translation-preparation mode.

   ```sh
   python3 "$SKILL/scripts/game_developer.py" --main "$DELIVERY/main.tex" --prepare-translation > "$WORK/translation-input.json"
   ```

2. Give the input JSON to the configured mathematics translator. Ask them to
   read the full script and return a JSON object with the same `schema`,
   `source_digest` and `files` keys and complete Chinese TeX content. Keep
   formulas, mathematical objects, meaning, ordering, argument IDs, file
   references, anchors, citations and numbering. Translate section/component
   titles and prose. English technical terms may remain where clearer.
   Verify fidelity and coverage against the source. The exporter checks
   structural identity and command/formula anchors; the translator and game
   producer check meaning.
3. Use the project intake `verify-citations` output as `source-bindings.json`
   if the script cites PDFs. Bind each citation key to the exact version and
   all actual physical PDF page locations. Where applicable, register the
   original target paper as that exact version before verifying a citation to
   it. Include every cited original, including a legitimately obtained
   subscription PDF. Deliver the game locally for the user to share.
4. Export on macOS with Python 3, TeX, and the configured player-tutor model.

   ```sh
   python3 "$SKILL/scripts/game_developer.py" --main "$DELIVERY/main.tex"      --translation "$WORK/translation-zh.json"      --source-bindings "$WORK/source-bindings.json" --output "$OUTPUT/game.zip"
   ```

   Omit `--source-bindings` when there are no external citations. The default
   tutor is `gpt-6.1-sol / medium`. Use `--tutor-model` and
   `--tutor-reasoning` for a player tutor override from the role configuration.
   A valid ZIP needs no author-specific directory or separate Proof2Game
   installation. Delivery includes the ZIP and the startup note.

## Check delivery

Extract a copy into a temporary folder on macOS. Follow its START.md and
verify the English map opens in the browser, displays canonical levels in
manuscript order and unlocks them sequentially. Check formulas and internal
links, including locked targets, and test an actual reference PDF at its
cited page when present. Confirm both interfaces and localized content,
persistent mode changes, and a tutor turn through the player's Codex bridge
at the requested model and reasoning. Check autosave across restart, manual
save, download and reimport, and reversible actions across levels. A live
model test should use synthetic mathematics unless the user has authorized
sending their material through the applicable authenticated bridge. Record
the actual checked host and model capabilities.

The recipient hands the ZIP to ChatGPT Desktop or Codex on their Mac and asks
it to extract and start the game. The included Node runtime script binds
to loopback and opens the browser. The recipient uses their own installed
Node 20+ and authenticated Codex CLI and quota. AI replies require their normal
connection to Codex. Player progress and diagrams live in the extracted folder
and can be exported independently. A save can move between releases when the
snapshot ID matches, including games exported before the project rename.
