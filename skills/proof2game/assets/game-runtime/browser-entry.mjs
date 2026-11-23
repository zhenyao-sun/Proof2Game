import {loadBrowserGame} from './browser-engine.mjs';

const $ = id => document.getElementById(id);
const dialog = $('ai-dialog');
const services = {
  deepseek: {name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys'},
  bailian: {name: 'Bailian', url: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'}
};
const copy = {
  en: {
    description: 'This browser stores each key for future visits. Tutor requests go directly to DeepSeek. Image requests go directly to Alibaba Cloud Bailian (Beijing). Each service bills your own account.',
    missing: 'Key needed', unverified: 'Verify key', verifying: 'Verifying…', verified: 'Verified ✓',
    failed: 'Verification failed. Check the key, model access and network, then retry.',
    invalid_key: 'Key rejected. Replace it and verify again.', balance: 'Insufficient balance. Top up and verify again.',
    apply: 'Get an API key ↗', verify: 'Verify', clear: 'Clear', warning: 'Verification generates a test image and may incur a charge.',
    existing: 'Saved key · enter a new key to replace it', enter: 'Enter your API key', invalid: 'Enter a key without spaces.', close: 'Close'
  },
  zh: {
    description: '两把 Key 分别保存在当前浏览器，重开游戏后可继续使用。导师请求直连 DeepSeek，绘图请求直连阿里云百炼（北京），费用分别计入你的对应账户。',
    missing: '待配置', unverified: '待验证', verifying: '验证中…', verified: '已验证 ✓', failed: '验证失败。请检查 Key、模型访问权限和网络后重试。',
    invalid_key: 'Key 已失效，请更换并重新验证。', balance: '余额不足，请充值后重新验证。',
    apply: '申请 API Key ↗', verify: '验证', clear: '清除', warning: '验证会生成一张测试图，可能计费',
    existing: '已保存，可输入新 Key 更换', enter: '输入 API Key', invalid: '请输入不含空格的 Key。', close: '关闭'
  }
};
const chinese = () => document.documentElement.lang.startsWith('zh');
const words = () => chinese() ? copy.zh : copy.en;
const nameOf = (service, zh) => service === 'bailian' && zh ? '百炼' : services[service].name;
const rows = new Map();
let whenReady;
let autoClose = false;
let lastConnection;
function node(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}
function makeRow(service) {
  const form = node('form', 'provider-connection');
  const label = node('label'), link = node('a');
  const input = node('input'), status = node('span', 'provider-status');
  const actions = node('div', 'save-tools'), verify = node('button', 'primary-button'), clear = node('button', 'plain-button');
  const warning = node('small');
  label.htmlFor = input.id = service+'-key';
  link.href = services[service].url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 1024;
  status.setAttribute('role', 'status');
  verify.type = 'submit'; clear.type = 'button';
  actions.append(verify, clear);
  form.append(label, link, input, status, actions);
  if (service === 'bailian') form.append(warning);
  $('ai-providers').append(form);
  const engine = window.proof2gameBrowser;
  function saveInput() {
    const value = input.value.trim();
    if (!value) return true;
    try {
      engine.setKey(service, value);
      input.value = '';
      return true;
    } catch {
      input.setCustomValidity(words().invalid); input.reportValidity(); return false;
    }
  }
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('change', saveInput);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saveInput()) return;
    if (engine.connection().providers[service].state === 'missing') {
      input.setCustomValidity(words().enter); input.reportValidity(); return;
    }
    try {await engine.verifyKey(service, {force: true});} catch {render(engine.connection());}
  });
  clear.addEventListener('click', () => {
    input.value = ''; input.setCustomValidity('');
    engine.setKey(service, '');
    render(engine.connection());
  });
  rows.set(service, {label, link, input, status, verify, clear, warning});
}
function render(connection) {
  lastConnection = connection;
  const text = words();
  $('ai-title').textContent = chinese() ? 'AI Connection · AI 连接' : 'AI Connection';
  $('close-ai').setAttribute('aria-label', text.close);
  $('ai-description').textContent = text.description;
  for (const [service,row] of rows) {
    const state = connection.providers[service].state;
    row.label.textContent = nameOf(service, chinese())+' API Key';
    row.link.textContent = text.apply;
    row.input.placeholder = state === 'missing' ? text.enter : text.existing;
    row.status.textContent = text[state];
    row.status.dataset.state = state;
    row.verify.textContent = text.verify;
    row.verify.disabled = state === 'verifying';
    row.clear.textContent = text.clear;
    row.warning.textContent = text.warning;
  }
}
window.proof2gameConnectionStatus = (providers, language) => {
  const zh = language === '中文', text = zh ? copy.zh : copy.en;
  const compact = {invalid_key: zh ? '失效' : 'rejected', balance: zh ? '余额不足' : 'low balance', failed: zh ? '失败' : 'failed'};
  return Object.entries(providers).map(([service, {state}]) => nameOf(service, zh)+' '+(compact[state] || text[state])).join(' · ');
};
window.openProof2GameConnection = (reason = {}) => {
  render(reason.connection || window.proof2gameBrowser.connection());
  if (reason.whenReady) whenReady = reason.whenReady;
  if (reason.whenReady || reason.paused) autoClose = true;
  if (!dialog.open) dialog.showModal();
};
function onConnectionChange(connection) {
  const previous = lastConnection;
  render(connection);
  window.dispatchEvent(new CustomEvent('ai-connection-change', {detail: connection}));
  if (!connection.authenticated && previous?.authenticated && $('level-dialog').open) {
    window.openProof2GameConnection({connection, paused: true});
  } else if (connection.authenticated && autoClose && dialog.open) {
    const enter = whenReady;
    whenReady = undefined; autoClose = false;
    dialog.close();
    enter?.();
  }
}
try {
  const engine = await loadBrowserGame({onMissingKey: window.openProof2GameConnection, onConnectionChange});
  window.proof2gameBrowser = engine;
  Object.keys(services).forEach(makeRow);
  $('close-ai').addEventListener('click', () => dialog.close());
  // A history navigation supersedes the house or citation that opened setup.
  window.addEventListener('popstate', () => {
    whenReady = undefined; autoClose = false;
    if (dialog.open) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    whenReady = undefined; autoClose = false;
    for (const {input} of rows.values()) {input.value = ''; input.setCustomValidity('');}
  });
  render(engine.connection());
  const result = await engine.request('/api/game');
  if (result.game.paper) {
    $('paper-title').textContent = result.game.paper.title;
    $('paper-byline').textContent = result.game.paper.authors.join(', ')+' · '+result.game.paper.version;
    $('paper-credit').hidden = false;
  }
  await import('./app.js');
} catch(error) {
  const target = $('global-error'); target.hidden = false; target.textContent = error.message;
}
