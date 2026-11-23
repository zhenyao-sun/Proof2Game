// Run from the hosted-export fixture. All requests are intercepted, including both providers.
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
  try {
    const context = await browser.newContext({...device, locale:'en-US', reducedMotion:'reduce', serviceWorkers:'block'});
    const page = await context.newPage();
    const pageErrors = [], unexpected = [];
    const verification = {deepseek:0, bailian:0};
    page.on('pageerror', error => pageErrors.push(String(error)));
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
      if (['api.deepseek.com', 'dashscope.aliyuncs.com'].includes(url.hostname) && request.method() === 'OPTIONS')
        return route.fulfill({status:204, headers:cors});
      if (url.href === 'https://api.deepseek.com/chat/completions') {
        const prompt = request.postDataJSON().messages[0].content;
        let content;
        if (prompt === 'Reply with OK.') { verification.deepseek++; content = 'OK'; }
        else {
          assert(Array.isArray(prompt));
          const reply = {message:'A synthetic guided explanation.', illustrations:[], understanding:noUnderstanding};
          if (!prompt[0].text.startsWith('Respond to')) Object.assign(reply, {phase:'step', step_goal:'Is the convention clear?'});
          content = JSON.stringify(reply);
        }
        return route.fulfill({headers:cors, json:{choices:[{finish_reason:'stop', message:{content}}]}});
      }
      if (url.href === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation') {
        verification.bailian++;
        return route.fulfill({headers:cors, json:{output:{choices:[{message:{content:[
          {image:'https://dashscope-test.oss-cn-beijing.aliyuncs.com/verification.png'}
        ]}}]}}});
      }
      unexpected.push(url.origin+url.pathname);
      return route.abort();
    });

    const house = page.locator('.level-node[data-level-id="setting"]');
    const guide = page.locator('#level-dialog');
    const keys = page.locator('#ai-dialog');
    const focused = house.locator('.node-title');
    const progress = page.locator('#progress-count');
    const verify = service => keys.locator('form').filter({has:page.locator('#'+service+'-key')});
    await page.goto(base.href);
    await expect(house).toBeVisible();
    await expect(page.locator('.level-node')).toHaveCount(1);
    await expect(page.locator('#next-level')).toBeInViewport({ratio:1});
    await expect(page.locator('#map-scroll')).toBeInViewport({ratio:0.75});
    await page.locator('#next-level').tap();
    await expect(focused).toBeVisible();
    await expect(keys).toBeHidden();
    await house.tap();
    await expect(keys).toBeVisible();
    await expect(guide).toBeHidden();
    await keys.locator('#bailian-key').fill('synthetic-bailian');
    await verify('bailian').getByRole('button',{name:'Verify', exact:true}).tap();
    await expect(verify('bailian').locator('.provider-status')).toHaveAttribute('data-state','verified');
    assert.deepEqual(verification, {deepseek:0,bailian:1});
    await expect(keys.locator('img')).toHaveCount(0);
    await keys.locator('#deepseek-key').fill('synthetic-deepseek');
    await verify('deepseek').getByRole('button',{name:'Verify', exact:true}).tap();
    await expect(keys).toBeHidden();
    await expect(guide).toHaveAttribute('data-panel','guide');
    const avatar = guide.locator('.guide-confirmation .guide-avatar').first();
    await expect(avatar).toBeVisible();
    await avatar.evaluate(image=>image.decode());
    await expect(guide.locator('#messages')).toContainText('A synthetic guided explanation.');
    await expect(guide.locator('#messages')).toContainText('Is the convention clear?');
    await expect(guide.locator('.understand-button').first()).toBeInViewport({ratio:1});
    await expect(guide.locator('#chat-form')).toBeHidden();
    await guide.locator('.guide-ask').first().tap();
    await expect(guide.locator('#chat-input')).toBeVisible();
    await guide.locator('#chat-input').fill('Please explain this convention.');
    await guide.locator('#send-message').tap();
    await expect(guide.locator('#chat-form')).toBeHidden();
    await expect(guide.locator('.guide-confirmation')).toHaveCount(2);
    await guide.locator('#mobile-chat').tap();
    await expect(guide).toHaveAttribute('data-panel','chat');
    await guide.locator('#chat-input').fill('A draft for this level');
    await guide.locator('#close-level-small').tap();
    await expect(guide).toBeHidden();
    await house.tap();
    await expect(guide).toHaveAttribute('data-panel','chat');
    await expect(guide.locator('#chat-input')).toHaveValue('A draft for this level');

    await guide.locator('#close-level-small').tap();
    await page.locator('#save-game').tap();
    await expect(page.locator('#save-toast')).toContainText(/save/i);
    await page.reload();
    await house.tap();
    await expect(keys).toBeHidden();
    await expect(guide).toHaveAttribute('data-panel','guide');
    await guide.locator('#mobile-chat').tap();
    await expect(guide.locator('#chat-input')).toHaveValue('');
    await guide.locator('#mobile-content').tap();
    await guide.locator('#understand-all').tap();
    await expect(guide).toBeHidden();
    await expect(progress).toHaveText(/^1\s*\//);
    await page.locator('#open-saves').tap();
    await page.locator('.save-record').getByRole('button',{name:/^Load /}).tap();
    await expect(progress).toHaveText(/^0\s*\//);
    await page.locator('#save-toast button').tap();
    await expect(progress).toHaveText(/^1\s*\//);
    assert.deepEqual(verification, {deepseek:1,bailian:1});
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
    console.log(browserType.name()+' '+browser.version()+': exported phone layout, credentials, Guide, draft and saves passed');
  } finally {
    await browser.close();
  }
}

(async () => {
  await check(chromium, devices['Pixel 7']);
  await check(webkit, devices['iPhone 13']);
})().catch(error=>{console.error(error);process.exitCode=1;});
