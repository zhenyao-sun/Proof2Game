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
   when there are no external citations. The browser tutor uses
   `deepseek-flash` for tool calls and visual review of candidate images.

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

Open the published GitHub Pages link directly in a browser, including when hosted under a repository subpath. For public literature, verify the original title, authors and exact version. The map must load without an API key or a local service.

Use AI Connection to verify the player’s DeepSeek and Bailian (Beijing) keys separately. Verification calls the configured tutor and image model. Bailian verification generates one potentially billable test image. Check that a player can focus the next house before verification and enter it once both services succeed. Replace or clear each key independently. A save, download or deployment must contain no credentials.

When a Guide passage needs a drawing, or a player requests one in Regular chat, the tutor sends the drawing instructions to Bailian. DeepSeek inspects the returned image before choosing which candidates appear with the explanation. Background preparation may plan a drawing. Only a player-triggered reply can start generation. The initial timing budget is 45 seconds per image request and 120 seconds for the drawing and review round. The 120-second value is provisional pending live measurements. In a live check, record image quality and elapsed time for a first usable drawing, a redraw and an ordinary failure followed by retry. Check key recovery and insufficient balance separately.

Check that each visible road follows the manuscript tree, including branches from a proof to its direct child statements. Verify the first house, the reveal of a new road and house, and the full village after the final level. Restore earlier progress and check that Continue learning focuses the next open house in manuscript order.

On portrait iPhone Safari and Android Chrome, check map gestures, wide formulas, inline illustrations and the keyboard. Verify that returning to a level restores its panel, reading position and Chat draft for the current page session. Check both languages, passage confirmations, manual save, delete/undo, restore after load/import and cross-device image placement. Same-origin tabs share browser storage; reject stale writes. Different browsers and devices use separate storage and can transfer progress through a downloaded save. Imports of existing same-snapshot local-runtime saves remain supported. No credentials are transferred.

Test the real deployed URL and an actual tutor request when credentials are available. Unit tests and synthetic API responses do not establish live provider availability. Record precisely which checks ran. Existing published games and their saves are left intact; re-export or deployment of a specific game requires its author's authorization.
