// Run from the hosted-export fixture. Only its files and the DeepSeek text API are served.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit, devices } = require('playwright');
const { expect } = require('playwright/test');

const site = path.resolve(process.argv[2]);
const base = new URL('https://example.test/games/synthetic/');
const contentTypes = {'.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.html':'text/html',
  '.json':'application/json', '.woff2':'font/woff2', '.woff':'font/woff', '.webp':'image/webp'};
const cors = {'access-control-allow-origin':'*', 'access-control-allow-headers':'authorization,content-type',
  'access-control-allow-methods':'POST, OPTIONS'};
const noUnderstanding = {kind:'none', scope:'partial', description:'', quote:'', level_id:null};

async function check(browserType, device) {
  const browser = await browserType.launch();
  let page, stage = 'Create browser context';
  const pageErrors = [], unexpected = [], failedRequests = [];
  const requests = {verification:0, guide:0, chat:0, preflight:0};
  try {
    const context = await browser.newContext({...device, locale:'en-US', reducedMotion:'reduce', serviceWorkers:'block'});
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      failedRequests.push([request.method(), url.origin+url.pathname, request.failure()?.errorText]);
    });
    // Keep only control names and event order from the credential form.
    await page.addInitScript(() => {
      window.verificationEvents = [];
      for (const type of ['touchend','pointerup','change','focusout','click','submit']) {
        document.addEventListener(type, event => {
          const form = event.target.closest?.('.provider-connection');
          if (!form) return;
          const control = event.target.closest('button,input') || form;
          window.verificationEvents.push([form.querySelector('input').id, type, control.id || control.type || control.tagName]);
          if (window.verificationEvents.length > 32) window.verificationEvents.shift();
        }, {capture:true, passive:true});
      }
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) {
        const relative = decodeURIComponent(url.pathname.slice(base.pathname.length)) || 'index.html';
        const filename = path.resolve(site, relative);
        assert(filename.startsWith(site + path.sep));
        try {
          return await route.fulfill({body:await fs.readFile(filename), contentType:contentTypes[path.extname(filename)] || 'application/octet-stream'});
        } catch {
          return route.fulfill({status:404, body:'Missing test fixture asset'});
        }
      }
      if (url.href === 'https://api.deepseek.com/chat/completions' && request.method() === 'OPTIONS') {
        requests.preflight++;
        return route.fulfill({status:204, headers:cors});
      }
      if (url.href === 'https://api.deepseek.com/chat/completions') {
        const body = request.postDataJSON();
        const prompt = body.messages[0].content;
        let content;
        if (prompt === 'Reply with OK.') { requests.verification++; content = 'OK'; }
        else {
          const instructions = typeof prompt === 'string' ? prompt : prompt[0].text;
          assert(!(body.tools || []).some(tool => /draw|illustrat|image/i.test(tool.function.name)));
          const chat = instructions.startsWith('Respond to');
          const reply = {message:chat ? 'A synthetic chat answer.' : 'A synthetic guided explanation.', understanding:noUnderstanding};
          if (chat) requests.chat++;
          else {
            requests.guide++;
            Object.assign(reply, {phase:'step', step_goal:'Is the convention clear?'});
          }
          content = JSON.stringify(reply);
        }
        return route.fulfill({headers:cors, json:{choices:[{finish_reason:'stop', message:{content}}]}});
      }
      unexpected.push(url.origin+url.pathname);
      return route.abort();
    });

    const house = page.locator('.level-node[data-level-id="setting"]');
    const guide = page.locator('#level-dialog');
    const keys = page.locator('#ai-dialog');
    const focused = house.locator('.node-title');
    const progress = page.locator('#progress-count');
    stage = 'Browse the map and focus the first level';
    await page.goto(base.href);
    await expect(house).toBeVisible();
    await expect(page.locator('.level-node')).toHaveCount(1);
    await expect(page.locator('#next-level')).toBeInViewport({ratio:1});
    await expect(page.locator('#map-scroll')).toBeInViewport({ratio:0.75});
    await page.locator('#next-level').tap();
    await expect(focused).toBeVisible();
    await expect(keys).toBeHidden();
    stage = 'Open AI Connection at the level entrance';
    await house.tap();
    await expect(keys).toBeVisible();
    await expect(guide).toBeHidden();
    stage = 'Verify DeepSeek by touch and resume entry';
    await expect(keys.locator('input[type="password"]')).toHaveCount(1);
    await keys.locator('#deepseek-key').fill('synthetic-deepseek');
    await keys.getByRole('button',{name:'Verify', exact:true}).tap();
    await expect(keys).toBeHidden();
    await expect(guide).toHaveAttribute('data-panel','guide');
    stage = 'Read the first Guide passage';
    const avatar = guide.locator('.guide-confirmation .guide-avatar').first();
    await expect(avatar).toBeVisible();
    await avatar.evaluate(image=>image.decode());
    await expect(guide.locator('#messages')).toContainText('A synthetic guided explanation.');
    await expect(guide.locator('#messages')).toContainText('Is the convention clear?');
    await expect(guide.locator('.understand-button').first()).toBeInViewport({ratio:1});
    await expect(guide.locator('#chat-form')).toBeHidden();
    stage = 'Ask a Guide question';
    await guide.locator('.guide-ask').first().tap();
    await expect(guide.locator('#chat-input')).toBeVisible();
    await guide.locator('#chat-input').fill('Please explain this convention.');
    await guide.locator('#send-message').tap();
    await expect(guide.locator('#chat-form')).toBeHidden();
    await expect(guide.locator('.guide-confirmation')).toHaveCount(2);
    stage = 'Restore a Chat draft after a map visit';
    await guide.locator('#mobile-chat').tap();
    await expect(guide).toHaveAttribute('data-panel','chat');
    await guide.locator('#chat-input').fill('A draft for this level');
    await guide.locator('#close-level-small').tap();
    await expect(guide).toBeHidden();
    await house.tap();
    await expect(guide).toHaveAttribute('data-panel','chat');
    await expect(guide.locator('#chat-input')).toHaveValue('A draft for this level');

    await guide.locator('#close-level-small').tap();
    stage = 'Save and reopen the game';
    await page.locator('#save-game').tap();
    await expect(page.locator('#save-toast')).toContainText(/save/i);
    await page.reload();
    await house.tap();
    await expect(keys).toBeHidden();
    await expect(guide).toHaveAttribute('data-panel','guide');
    await guide.locator('#mobile-chat').tap();
    await expect(guide.locator('#chat-input')).toHaveValue('');
    stage = 'Read a text Chat reply to a drawing request';
    await guide.locator('#chat-input').fill('Can you draw a diagram of the convention?');
    await guide.locator('#send-message').tap();
    await expect(guide.locator('#messages')).toContainText('A synthetic chat answer.');
    stage = 'Complete the first level and restore its earlier save';
    await guide.locator('#mobile-content').tap();
    await guide.locator('#understand-all').tap();
    await expect(guide).toBeHidden();
    await expect(progress).toHaveText(/^1\s*\//);
    await page.locator('#open-saves').tap();
    await page.locator('.save-record').getByRole('button',{name:/^Load /}).tap();
    await expect(progress).toHaveText(/^0\s*\//);
    await page.locator('#save-toast button').tap();
    await expect(progress).toHaveText(/^1\s*\//);
    assert.equal(requests.verification, 1);
    assert(requests.guide >= 2);
    assert.equal(requests.chat, 1);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
    console.log(browserType.name()+' '+browser.version()+': exported phone layout, DeepSeek setup, Guide, Chat, draft and saves passed');
  } catch (error) {
    const screen = page && await page.evaluate(() => ({
      dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id),
      panel: document.querySelector('#level-dialog')?.dataset.panel,
      providers: [...document.querySelectorAll('.provider-connection')].map(form=>({
        input:form.querySelector('input').id, state:form.querySelector('.provider-status').dataset.state
      })),
      errors: [...document.querySelectorAll('[role="alert"]:not([hidden])')].map(node=>node.textContent),
      verificationEvents: window.verificationEvents
    })).catch(diagnosticError=>({error:String(diagnosticError)}));
    console.error(JSON.stringify({browser:browserType.name(), version:browser.version(), stage,
      requests, pageErrors, unexpected, failedRequests, screen}, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
}

(async () => {
  await check(chromium, devices['Pixel 7']);
  await check(webkit, devices['iPhone 13']);
})().catch(error=>{console.error(error);process.exitCode=1;});
