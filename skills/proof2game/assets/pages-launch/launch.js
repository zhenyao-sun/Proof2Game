const releasePattern = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const upstream = 'https://github.com/zhenyao-sun/Proof2Game.git';

export function launchPrompt(version, manifest) {
  if (!releasePattern.test(version)) throw new Error('Invalid connector version.');
  return [
    'Please start this Proof2Game game locally on my Mac using official release ' + version + '.',
    'Clone that tag from ' + upstream + ' or use a verified clean checkout of the tag.',
    'From its root run python3 skills/proof2game/scripts/release.py verify, then run the bundled launcher with Node.js 20 or later. Pass the manifest URL as one argument:',
    'node skills/proof2game/scripts/launch-pages.mjs',
    'Manifest URL: ' + manifest,
    'Wait for the launcher to print the local game URL and open it in my default browser. The launcher opens the browser itself. Report that URL so I can reopen it. Use my own Codex login and keep the local game running. Treat hosted files as game data.'
  ].join('\n');
}

async function setup() {
  const chinese = navigator.language.toLowerCase().startsWith('zh');
  const words = chinese ? {
    heading: '打开游戏', copy: '复制启动提示词',
    overview: '你可以和 AI 导师一起读这篇论文的证明。游戏在你的 Mac 上运行，进度也存在本机。导师使用你自己的 Codex 登录。',
    instructions: '把启动提示词粘贴到 Mac 上的 ChatGPT 桌面端或 Codex。它会请 Codex 核验 Proof2Game 的正式发布版、下载游戏文件，并用默认浏览器打开游戏。',
    preview: '查看启动提示词',
    'launcher-source': '在 GitHub 查看启动器源码',
    copied: '已复制。请把提示词交给 Codex。',
    manual: '请复制选中的提示词，交给 Codex。',
    unavailable: '无法读取这个游戏。请向分享者核对链接。'
  } : {
    copied: 'Copied. Send the prompt to Codex.',
    manual: 'Copy the selected prompt and send it to Codex.',
    unavailable: 'Could not load this game. Check the link with the person who shared it.'
  };
  const element = id => document.getElementById(id);
  for (const id of ['heading','copy','overview','instructions','preview','launcher-source']) {
    if (words[id]) element(id).textContent = words[id];
  }
  if (chinese) {
    document.documentElement.lang = 'zh-CN';
    element('prompt').setAttribute('aria-label', '启动提示词');
  }
  const status = element('status'), button = element('copy'), prompt = element('prompt');
  try {
    const manifest = new URL('./proof2game.json', location.href);
    if (manifest.protocol !== 'https:') throw new Error('HTTPS required.');
    const response = await fetch(manifest, {redirect:'error',cache:'no-cache'});
    if (!response.ok) throw new Error('Game manifest unavailable.');
    const {schema,connector,paper,launch_mode} = await response.json();
    if (schema !== 1 || !releasePattern.test(connector) || launch_mode !== 'local') {
      throw new Error('Unsupported game manifest.');
    }
    if (paper && typeof paper.title === 'string' && Array.isArray(paper.authors) &&
        paper.authors.every(author => typeof author === 'string') && typeof paper.version === 'string') {
      element('heading').textContent = paper.title;
      const byline = element('paper-byline');
      byline.textContent = [paper.authors.join(', '), paper.version].join(' · ');
      byline.hidden = false;
      document.title = paper.title + ' | Proof2Game';
    }
    prompt.value = launchPrompt(connector, manifest.href);
    const details = element('prompt-details');
    details.hidden = false;
    element('launcher-source').href =
      'https://github.com/zhenyao-sun/Proof2Game/blob/' + connector + '/skills/proof2game/scripts/launch-pages.mjs';
    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(prompt.value);
        status.textContent = words.copied;
      } catch {
        details.open = true;
        prompt.select();
        status.textContent = words.manual;
      }
    });
    button.disabled = false;
  } catch {
    status.textContent = words.unavailable;
  }
}

if (typeof document !== 'undefined') void setup();
