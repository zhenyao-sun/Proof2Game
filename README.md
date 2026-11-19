# Proof2Game

**Turn a math manuscript into a game you can play.**

Give Proof2Game a paper, a draft, or your math notes. A team of Codex agents reviews the argument and builds a bilingual browser game where you can explore the proof one step at a time.

[Quick start](#quick-start) · [Meet the team](#meet-the-team) · [Play a shared game](#play-a-shared-game)

## Quick start

**Copy the entire block into ChatGPT Desktop or Codex on your Mac.**

```text
Set up and run Proof2Game from this repository.
https://github.com/zhenyao-sun/Proof2Game

Follow Manual setup in the repository README and load skills/proof2game/SKILL.md.
Ask for my project folder and math manuscript or notes if I haven't provided them.
Preserve my original, create or resume a Codex Goal, and run the guided workflow through delivery.
```

You can attach a LaTeX file, Markdown notes, or a PDF, or paste an arXiv link. An unfinished draft is enough to get started.

## What you get

| Bring | Take away |
| --- | --- |
| **Your unpublished work** | A shareable game and a complete English paper in PDF and LaTeX, built from the same reviewed script. |
| **A public paper** | A game that follows the edition you chose, plus a generic English referee report in Markdown based on the original paper and the final reviewed game script. |

Proof2Game keeps your original and builds a separate English game script. Independent Codex reviewers check the argument and the cited results. For public papers, a separate reviewer checks the route against the exact edition you supplied. For unpublished work, the team explores whether the proof can be made simpler.

The Summary opens with one sentence stating the paper’s main contribution. The Assessment opens with the overall judgment, including the number of major issues and their collective impact when any are present. Major Issues and Minor Issues follow. Each item locates the original passage, quotes it in italics and explains the problem and its impact. All verbatim excerpts appear in italics, including inline quotations and quoted formulas. The authors decide how to address it. You can request a fresh report from the same approved manuscript. Writer uses the bundled [Humanizer v4.0.0](skills/proof2game/references/humanizer/SKILL.md) when drafting, revising and checking its prose.

## What it's like to play

- **Follow the proof map.** Statements, lemmas, and proofs become levels. Unlock the next part as you go.
- **Get help when you want it.** Ask the tutor to work through a step with you, or switch to open chat. Play in English or Chinese.
- **See the source.** Follow citations to the DOI or official source and use the displayed locator.
- **Pick up where you left off.** Save progress in your browser, undo a step, or export a save to continue the same game on another device.

## Meet the team

One Codex session coordinates the work. Each specialist takes a different part of the journey from manuscript to game.

<table>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/explorer.webp" width="144" alt="A fox tracing branches on a proof map"></p>
      <strong>Explorer</strong><br>
      <em>“What does this theorem depend on?”</em><br>
      Maps the lemmas behind the main results and looks for simpler ways to prove them.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/reviewer.webp" width="144" alt="An owl examining a proof page with a magnifying glass"></p>
      <strong>Reviewer</strong><br>
      <em>“Does this step follow?”</em><br>
      Independently checks definitions, assumptions, deductions, and what each citation supports.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/fixer.webp" width="144" alt="A beaver fitting a missing piece into a puzzle"></p>
      <strong>Fixer</strong><br>
      <em>“Let's see where the argument breaks.”</em><br>
      Checks reported problems, repairs gaps where possible, and sends the revisions back for a fresh review.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/game-developer.webp" width="144" alt="An otter assembling tiles for a game map"></p>
      <strong>Game Developer</strong><br>
      <em>“Try following that argument on a map.”</em><br>
      Builds an unlockable, bilingual game from the reviewed script and links to the cited sources.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/writer.webp" width="144" alt="A heron with a fountain pen and manuscript pages"></p>
      <strong>Writer</strong><br>
      <em>“Let's get the argument onto the page.”</em><br>
      Writes an English paper for unpublished work or a referee report comparing a public paper with the final reviewed game script.
    </td>
    <td width="50%" valign="top">
      <p align="center"><img src="docs/agents/tutor.webp" width="144" alt="A tortoise teaching with a chalkboard"></p>
      <strong>Tutor</strong><br>
      <em>“Where would you like to slow down?”</em><br>
      Walks through the proof with you and answers questions as you play.
    </td>
  </tr>
</table>

[Agent responsibilities](skills/proof2game/references/workers.md) · [Default model settings](skills/proof2game/references/roles.json)

## Play a shared game

Open the shared GitHub Pages link to enter the game directly in your browser. No Codex installation or local server is needed to play.

Use **AI Connection** in the top right to add, replace or clear your own DeepSeek API key. It stays in this browser, is excluded from saves, and is sent only to the official DeepSeek API for tutor requests. Your DeepSeek account pays for usage. You can browse the map without a key. Progress and conversations are saved in this browser; download a save to move them to another device.

Authors can [export and publish a game directory to GitHub Pages](skills/proof2game/references/game.md#publish-the-website) from the approved bilingual snapshot. Existing published games keep their original runtime until their author explicitly requests a new export.

## Examples

- [Local smoothing for the Euclidean wave equation](https://zhenyao-sun.github.io/Proof2Game-OpenAI-Local-Smoothing/) — based on the OpenAI manuscript dated October 25, 2026. Play directly in your browser with your own DeepSeek API key.

## Revise an unpublished paper

After Writer delivers a paper, ask Proof2Game to revise it and share your feedback. For example, “Start from your last paper, use my collaborator’s comments, and mark the changes against their attached draft.” Writer delivers the clean paper and its LaTeX sources, plus a highlighted PDF. The default comparison is the previous official Writer paper. [Writer instructions](skills/proof2game/references/writer.md#revise-a-delivered-paper)

## Manual setup

Use macOS with ChatGPT Desktop or Codex, local terminal access, Codex Goals, and independent agent sessions. Proof2Game uses Git and Python 3.11 or later. Use Pandoc for checking Markdown referee reports, Poppler for PDF intake, TeX Live or MacTeX for compilation, and Node.js 22 or later for authoring checks. Players only need a browser and their own DeepSeek API key for tutor conversations. The PDF navigation check uses `pdftotext` or `pypdf`. Writer revision comparisons also need `PyMuPDF>=1.24.11,<2` in the Writer environment.

If you already have a verified release checkout, use it and let Proof2Game check for updates. For a fresh setup, run:

```sh
proof2game_releases="$HOME/Library/Application Support/Proof2Game/releases"
mkdir -p "$proof2game_releases"
git clone --depth 1 --branch v0.1.37 https://github.com/zhenyao-sun/Proof2Game.git "$proof2game_releases/v0.1.37"
python3 "$proof2game_releases/v0.1.37/skills/proof2game/scripts/release.py" verify
```

Load the skill at the `entrypoint` returned by the verifier. You can run the full guided workflow, ingest a reference PDF, verify an existing game script, or request a refactor. [Skill documentation](skills/proof2game/SKILL.md)

## License

Proof2Game is released under the [MIT License](LICENSE). The bundled KaTeX code uses the [MIT License](skills/proof2game/assets/game-runtime/vendor/LICENSE-KaTeX.txt), and its fonts use the [SIL Open Font License](skills/proof2game/assets/game-runtime/vendor/fonts/OFL.txt).

Writer includes the full instructions from [Humanizer v4.0.0](https://github.com/blader/humanizer/tree/b48c832f0f809c1b5658edbb838c2521b72f2413), distributed with its [MIT license](skills/proof2game/references/humanizer/LICENSE).
