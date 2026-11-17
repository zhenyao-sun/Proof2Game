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
   it. Record the verified DOI of the selected edition when available. Use a
   stable official HTTPS record for an exact version without a DOI.
4. For a public paper, create a paper metadata JSON object with `title`,
   `authors` (a list), `version`, and `sha256` (the preserved original PDF or
   manuscript hash in its target record). Read the title and author credit
   from the original and use the exact version that was reviewed.

   ```sh
   python3 "$SKILL/scripts/game_developer.py" --main "$DELIVERY/main.tex" \
     --translation "$WORK/translation-zh.json" --source-bindings "$WORK/source-bindings.json" \
     --paper-metadata "$WORK/paper.json" --output "$OUTPUT/game-site"
   ```

   Omit `--paper-metadata` for an unpublished project. Omit `--source-bindings`
   when there are no external citations. The default tutor is
   `gpt-6.1-sol / medium`. Use the role configuration for any tutor override.

## Publish the website

Register the website directory and the exporter’s `artifact_sha256` with the
guided delivery ledger. Deliver the checked site to the author. Deploy to GitHub
Pages only when authorized for that game. Share the HTTPS URL ending in a
slash. One site is tied to one original version and one approved snapshot.
A new version of the original leaves that site and its saves intact. A
separately requested game for the new manuscript gets its own deployment.

Publish only the game website. The directory includes the bilingual game
content and figures needed to play. External sources appear as links only.
The site excludes external reference PDFs, reference text and transcriptions,
source bindings, approvals, review records, original uploads and player
saves. Use the DOI of the cited edition or its official HTTPS record, with
verified locators retained in the game.

## Check delivery

Open the published link in a browser on macOS. The public-literature page
shows the original paper's title, authors and version. Copy its prompt into
Codex. The tagged official launcher downloads and validates the game data,
then starts the local runtime and opens its local address in the default
browser. Only the manifest URL is required. The launcher prints the local
address so the player can reopen it or open it in another browser. All
browsers on the same Mac using that address share the running game and its
local saves. The player uses their own Codex account.

Verify launch from the real published link and opening the printed local
address. Check canonical level order and unlocks, formulas, internal links,
external links and citation locators, both languages and modes, and a live
tutor turn at the configured model and effort. Check progress after a
restart, plus manual save export and reimport. Use synthetic mathematics for
live tutor checks unless the user has authorized this material. Record the
browser and model actually tested.
