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
   `deepseek-flash` (DeepSeek API). Use the role configuration for any tutor override.

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

Use AI Connection to add, replace and clear the player's own DeepSeek key. The key is stored only in the current browser and is sent only to `https://api.deepseek.com/chat/completions`. It is excluded from saves, downloads, deployment files and diagnostics. Usage is billed to the player's account. The default model is `deepseek-flash`, which supports manuscript images. Verify actual official API compatibility before claiming a live tutor test.

Check canonical order and unlocks, formulas and links, both languages and conversation modes, Guide and Regular chat diagrams, undo, reload, manual save downloads and imports. Same-origin tabs share browser storage; reject stale writes. Different browsers and devices use separate storage and can transfer progress through a downloaded save. Imports of existing same-snapshot local-runtime saves remain supported. No credentials are transferred.

Test the real deployed URL and an actual tutor request when credentials are available. Unit tests and synthetic API responses do not establish live provider availability. Record precisely which checks ran. Existing published games and their saves are left intact; re-export or deployment of a specific game requires its author's authorization.
