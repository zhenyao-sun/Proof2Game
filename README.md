# MathGrove

MathGrove 把已有的数学稿件或笔记变成经过逐项审查、可以断点续接的游戏脚本，再导出可分享的本机学习游戏。你自己的未公开项目还会生成完整英文稿件。处理公开论文时，MathGrove 会对照你指定的原文版本，确认原文有硬伤时另出一份英文审稿报告。

## 把下面这段话发给你的 ChatGPT Desktop/Codex

> 请使用 macOS 上的 Codex 从 GitHub 下载 [MathGrove](https://github.com/zhenyao-sun/MathGrove)，按仓库的「启动说明」加载完整系统，然后引导我处理已有的数学稿件或笔记。草稿也可以。如果项目文件夹或要处理的稿件还不明确，请问我它们在哪。保留原稿，另建英文游戏脚本，并创建或接续一个 Codex Goal，从脚本验证一直推进到交付学习游戏。如果是我自己的未公开项目，也用同一份已验证脚本生成完整稿件。如果是公开文献项目且确认原文有硬伤，交付审稿报告。

可以同时发项目文件夹和 LaTeX、Markdown、PDF 或 arXiv 链接。处理公开文献时，你可以直接给出版本链接，例如带有 `v2` 的 arXiv 链接。

## 启动说明

MathGrove 制作端和游玩端都支持 macOS。制作需要可访问本机项目文件、终端、Codex Goal 和独立协作会话的 Codex 环境。运行工具需要 Git 和 Python 3.11+。PDF 摄取需要可读取逐页图像的会话，以及提供 `pdfinfo` 和 `pdftoppm` 的 Poppler。脚本和稿件编译需要 TeX Live 或 MacTeX。脚本的 PDF 导航检查可以使用 Poppler 的 `pdftotext` 或 Python 的 `pypdf`。游戏使用 Node.js 22+、浏览器及玩家自己的 Codex 登录。按当前任务检查所需能力。

1. 在 `~/Library/Application Support/MathGrove/releases/` 复用已安装的有效 release Git checkout。初次下载可以运行以下命令，再从该 checkout 加载 skill。

   ```sh
   mathgrove_releases="$HOME/Library/Application Support/MathGrove/releases"
   mkdir -p "$mathgrove_releases"
   git clone --depth 1 --branch v0.1.0 https://github.com/zhenyao-sun/MathGrove.git "$mathgrove_releases/v0.1.0"
   ```

2. 从 checkout 根目录运行 `python3 skills/mathgrove/scripts/release.py verify`。读取它返回的 `entrypoint`，把该文件及其相对路径资源用作本次任务的 skill。主会话按该入口检查更新并启动。现有任务恢复时，先核对该任务已经选定的 release、原稿版本以及状态，再接续同一个 Goal。
3. 指定要处理的数学项目和稿件即可。MathGrove 把处理过的参考文献放在项目自己的 `references/`，把每个目标稿件版本的游戏脚本和恢复状态保存在项目中。游戏压缩包与稿件各自通过检查后可以先后交付。

MathGrove 也支持单独摄取文献、验证已有游戏脚本，或按用户要求重构脚本。

## 打开别人分享的游戏

把 ZIP 交给你自己电脑上的 ChatGPT Desktop/Codex，说「请按压缩包中的说明在本机启动这个 MathGrove 游戏」。它会打开浏览器里的游戏地图。进度和对话保存在本机，可以手动导出或导入。AI 导师使用你的 Codex 登录与用量。

## English

On macOS, send this to ChatGPT Desktop/Codex:

> Download [MathGrove](https://github.com/zhenyao-sun/MathGrove) and follow the setup instructions above. Guide me through an existing math manuscript or note. Ask for the folder or manuscript only if it is unclear. Preserve my original, build and verify a separate English game script, and create or resume one Codex Goal through delivery. Build the learning game and, for my own unpublished work, a complete English paper from the same verified script. For a public paper, also deliver a referee report if you confirm a substantive flaw.

The input can be LaTeX, Markdown, PDF, or an arXiv link. To play a shared game, give the ZIP to Codex and ask it to start it on your Mac.

MathGrove is MIT-licensed. Bundled KaTeX code uses the [MIT License](skills/mathgrove/assets/game-runtime/vendor/LICENSE-KaTeX.txt) and the fonts use the [SIL Open Font License](skills/mathgrove/assets/game-runtime/vendor/fonts/OFL.txt).
