import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(typeof WebSocket, 'function', 'Browser checks require Node.js 22+ (built-in WebSocket).');
const executable = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'image-filter-browser-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let port;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url.startsWith('/pixel.png')) {
    response.setHeader('Content-Type', 'image/png');
    response.end(png);
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const frame = request.url === '/frame';
  response.end(`<!doctype html><html><head><title>Image filtering test</title></head><body>
    <img id="network" width="120" height="80" src="http://cdn.test:${port}/pixel.png?${frame ? 'frame' : 'main'}">
    <img id="inline" width="120" height="80" src="data:image/png;base64,${png.toString('base64')}">
    <div id="background" style="width:50px;height:50px;background-image:url(http://cdn.test:${port}/pixel.png?background)">background</div>
    <input id="image-button" type="image" width="32" height="32" src="http://cdn.test:${port}/pixel.png?button">
    <style>#decoration::before { content: '装饰'; background-image: url(http://cdn.test:${port}/pixel.png?decoration); }</style>
    <span id="decoration"></span>
    ${frame ? '' : `<iframe src="http://frame.test:${port}/frame"></iframe>`}
    <script>
    ${frame ? `const report = () => parent.postMessage({kind:'frame', visibility:getComputedStyle(document.getElementById('inline')).visibility, width:document.getElementById('network').naturalWidth}, '*');
      new MutationObserver(report).observe(document.documentElement, {childList:true,subtree:true});
      addEventListener('load', report);` : `addEventListener('message', event => { if(event.data.kind === 'frame') window.frameResult = event.data; });`}
    </script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
const browser = spawn(executable, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${root}`, `--load-extension=${root}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--no-proxy-server', '--host-resolver-rules=MAP *.test 127.0.0.1', 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let nextId = 0;
const pending = new Map();
let stderr = '';
browser.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
function onMessage(event) {
  const message = JSON.parse(event.data);
  const task = pending.get(message.id);
  if (task) {
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  }
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== 1) return reject(new Error('Browser connection is not open'));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}\n${stderr}`);
}

try {
  const connection = await until(() => {
    try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); }
    catch { return null; }
  }, 'browser debugging port');
  socket = new WebSocket(`ws://127.0.0.1:${connection[0]}${connection[1]}`);
  socket.addEventListener('message', onMessage);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser connection timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed')); }, { once: true });
  });
  const worker = await until(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  }, 'extension service worker');
  const { sessionId: workerSession } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await until(() => evaluate(workerSession, 'typeof synchronize === "function"'), 'background startup');
  async function settings(value) {
    return evaluate(workerSession, `(async () => {
      await chrome.storage.local.set(${JSON.stringify({ strength: 'strict', layout: 'preserve', ...value })});
      await synchronize();
      return chrome.declarativeNetRequest.getDynamicRules();
    })()`);
  }
  async function checkPage(host, blocked, networkBlocked = blocked) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: `http://${host}:${port}/` }, sessionId);
    await until(() => evaluate(sessionId, `document.readyState === 'complete' && !!document.getElementById('inline') &&
      getComputedStyle(document.getElementById('inline')).visibility === '${blocked ? 'hidden' : 'visible'}' &&
      window.frameResult?.visibility === '${blocked ? 'hidden' : 'visible'}'`), `${host}: ${blocked ? 'blocked' : 'allowed'} styles and iframe`);
    const state = await evaluate(sessionId, `({
      width: document.getElementById('network').naturalWidth,
      background: getComputedStyle(document.getElementById('background')).backgroundImage,
      buttonVisibility: getComputedStyle(document.getElementById('image-button')).visibility,
      decoration: getComputedStyle(document.getElementById('decoration'), '::before').content,
      frame: window.frameResult
    })`);
    assert.equal(state.width, networkBlocked ? 0 : 1, `${host}: CDN network image`);
    assert.equal(state.frame.width, networkBlocked ? 0 : 1, `${host}: cross-origin iframe image`);
    assert.equal(state.background === 'none', networkBlocked, `${host}: background style`);
    assert.equal(state.buttonVisibility, networkBlocked ? 'hidden' : 'visible', `${host}: image button`);
    assert.equal(state.decoration === 'none', networkBlocked, `${host}: pseudo-element decoration`);
    await send('Target.closeTarget', { targetId });
  }
  const onlyRules = await settings({ enabled: true, siteMode: 'only', sites: ['blocked.test'] });
  assert.deepEqual(onlyRules[0].condition.topDomains, ['blocked.test']);
  await checkPage('blocked.test', true);
  await checkPage('sub.blocked.test', true);
  await checkPage('notblocked.test', false);
  await checkPage('allowed.test', false);
  assert.deepEqual(await settings({ enabled: true, siteMode: 'only', sites: ['blocked.test'], strength: 'basic' }), []);
  await checkPage('blocked.test', true, false);
  await checkPage('allowed.test', false);
  await settings({ enabled: true, siteMode: 'exclude', sites: ['blocked.test'], strength: 'basic' });
  await checkPage('blocked.test', false);
  await checkPage('allowed.test', true, false);
  const excludeRules = await settings({ enabled: true, siteMode: 'exclude', sites: ['blocked.test'] });
  assert.deepEqual(excludeRules[0].condition.excludedTopDomains, ['blocked.test']);
  await checkPage('blocked.test', false);
  await checkPage('allowed.test', true);
  await settings({ enabled: false, siteMode: 'only', sites: ['blocked.test'] });
  await checkPage('blocked.test', false);
  await settings({ enabled: true, siteMode: 'only', sites: [] });
  await checkPage('blocked.test', false);
  await settings({ enabled: true, siteMode: 'exclude', sites: [] });
  await checkPage('allowed.test', true);
  // Exercise actual content-script controls, including their closed shadow UI.
  const { targetId: revealId } = await send('Target.createTarget', { url: `http://blocked.test:${port}/` });
  const { sessionId: revealSession } = await send('Target.attachToTarget', { targetId: revealId, flatten: true });
  await until(() => evaluate(revealSession, `document.getElementById('network') && getComputedStyle(document.getElementById('network')).visibility === 'hidden'`), 'single image initially blocked');
  await send('DOM.enable', {}, revealSession);
  const changeLayout = (layout, strength = 'strict', enabled = true) => settings({ enabled, siteMode: 'exclude', sites: [], layout, strength });
  await changeLayout('collapse');
  await until(() => evaluate(revealSession, `document.getElementById('network').getBoundingClientRect().height === 0 && document.querySelectorAll('[data-image-filter-anchor]').length === 2`), 'collapse removes image space and retains compact controls');
  assert.equal(await evaluate(revealSession, `document.getElementById('image-button').getBoundingClientRect().height`), 0, 'strict collapse also removes image buttons');
  await changeLayout('preserve');
  await until(() => evaluate(revealSession, `document.getElementById('inline').getBoundingClientRect().height === 80 && document.querySelectorAll('[data-image-filter-anchor]').length === 0`), 'preserve restores original space and removes compact anchors');
  await changeLayout('collapse', 'basic');
  await until(() => evaluate(revealSession, `document.getElementById('network').getBoundingClientRect().height === 0 && document.getElementById('image-button').getBoundingClientRect().height === 32`), 'basic collapse keeps functional image buttons');
  await changeLayout('collapse', 'strict', false);
  await until(() => evaluate(revealSession, `document.getElementById('inline').getBoundingClientRect().height === 80 && document.querySelectorAll('[data-image-filter-anchor]').length === 0 && getComputedStyle(document.getElementById('inline')).visibility === 'visible'`), 'disabling restores layout and cleans anchors');
  await changeLayout('collapse');
  await until(() => evaluate(revealSession, `document.querySelectorAll('[data-image-filter-anchor]').length === 2`), 'collapse restored for individual reveal');
  async function clickReveal(index = 0) {
    const node = await until(async () => {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, revealSession);
      const found = [];
      function visit(item, inControls = false) {
        const controls = inControls || item.nodeName === '#document-fragment' && item.shadowRootType === 'closed';
        if (controls && item.nodeName === 'BUTTON') found.push(item);
        for (const child of [...(item.children || []), ...(item.shadowRoots || [])]) visit(child, controls);
      }
      visit(root);
      return found[index];
    }, 'image reveal button');
    const { object } = await send('DOM.resolveNode', { nodeId: node.nodeId }, revealSession);
    await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { this.click(); }' }, revealSession);
  }
  await clickReveal();
  await until(() => evaluate(revealSession, `document.getElementById('network').naturalWidth === 1 && getComputedStyle(document.getElementById('network')).visibility === 'visible'`), 'clicked image loads and becomes visible');
  assert.equal(await evaluate(revealSession, `document.getElementById('network').getBoundingClientRect().height`), 80, 'revealed image recovers full height');
  assert.equal(await evaluate(revealSession, `document.getElementById('inline').getBoundingClientRect().height`), 0, 'other image stays collapsed');
  assert.equal(await evaluate(revealSession, `getComputedStyle(document.getElementById('inline')).visibility`), 'hidden', 'other image stays hidden');
  assert.equal(await evaluate(revealSession, `getComputedStyle(document.getElementById('background')).backgroundImage`), 'none');
  await clickReveal();
  await until(() => evaluate(revealSession, `getComputedStyle(document.getElementById('inline')).visibility === 'visible'`), 'data URL image reveal');
  await evaluate(revealSession, `(() => {
    const picture = document.createElement('picture');
    picture.innerHTML = '<source srcset="http://cdn.test:${port}/pixel.png?responsive"><img id="responsive" width="100" height="60" src="http://cdn.test:${port}/pixel.png?fallback">';
    document.body.appendChild(picture);
  })()`);
  await until(() => evaluate(revealSession, `document.getElementById('responsive').currentSrc.includes('responsive') && getComputedStyle(document.getElementById('responsive')).visibility === 'hidden'`), 'dynamic responsive image blocked');
  assert.equal(await evaluate(revealSession, `document.getElementById('responsive').getBoundingClientRect().height`), 0, 'dynamic responsive image collapses');
  await clickReveal();
  await until(() => evaluate(revealSession, `document.getElementById('responsive').naturalWidth === 1 && getComputedStyle(document.getElementById('responsive')).visibility === 'visible'`), 'responsive candidate reveal');
  await evaluate(revealSession, `(() => {
    const host = document.createElement('div'); host.id = 'open-shadow';
    host.attachShadow({mode:'open'}).innerHTML = '<img width="100" height="60" src="http://cdn.test:${port}/pixel.png?shadow">';
    document.body.appendChild(host);
  })()`);
  await until(() => evaluate(revealSession, `getComputedStyle(document.getElementById('open-shadow').shadowRoot.querySelector('img')).visibility === 'hidden'`), 'shadow image blocked');
  await clickReveal();
  await until(() => evaluate(revealSession, `document.getElementById('open-shadow').shadowRoot.querySelector('img').naturalWidth === 1 && getComputedStyle(document.getElementById('open-shadow').shadowRoot.querySelector('img')).visibility === 'visible'`), 'shadow image reveal');
  const tabId = await evaluate(workerSession, `(async () => (await chrome.declarativeNetRequest.getSessionRules())[0].condition.tabIds[0])()`);
  await evaluate(workerSession, `sessionChange(() => addSessionRule({ tabIds: [${tabId}], resourceTypes: ['image'] }, 3))`);
  await send('Page.reload', {}, revealSession);
  await until(() => evaluate(revealSession, `document.readyState === 'complete' && document.getElementById('network')?.naturalWidth === 1 && getComputedStyle(document.getElementById('inline')).visibility === 'visible' && window.frameResult?.width === 1`), 'temporary tab allowance and frames after reload');
  assert.equal(await evaluate(revealSession, `document.getElementById('inline').getBoundingClientRect().height`), 80, 'temporary allowance bypasses collapse');
  await checkPage('allowed.test', true);
  await send('Target.closeTarget', { targetId: revealId });
  await until(() => evaluate(workerSession, `(async () => (await tabRules(${tabId})).length === 0)()`), 'tab closure cleans exceptions');
  const { targetId: popupId } = await send('Target.createTarget', { url: worker.url.replace('background.js', 'popup.html') });
  const { sessionId: popupSession } = await send('Target.attachToTarget', { targetId: popupId, flatten: true });
  await until(() => evaluate(popupSession, `!!document.getElementById('sites') && !document.getElementById('sites').disabled`), 'popup initialization');
  await evaluate(popupSession, `document.getElementById('layout').value = 'collapse'; document.getElementById('layout').dispatchEvent(new Event('change'));`);
  await until(() => evaluate(workerSession, `(async () => (await chrome.storage.local.get('layout')).layout === 'collapse')()`), 'popup saves collapse layout');
  await until(() => evaluate(popupSession, `!document.getElementById('layout').disabled`), 'layout save complete');
  await send('Page.reload', {}, popupSession);
  await until(() => evaluate(popupSession, `document.getElementById('layout')?.value === 'collapse' && !document.getElementById('layout').disabled`), 'layout persists after popup reopens');
  await evaluate(popupSession, `document.getElementById('strength').value = 'basic'; document.getElementById('strength').dispatchEvent(new Event('change'));`);
  await until(() => evaluate(workerSession, `(async () => (await chrome.storage.local.get('strength')).strength === 'basic' && (await chrome.declarativeNetRequest.getDynamicRules()).length === 0)()`), 'popup basic strength save');
  await until(() => evaluate(popupSession, `!document.getElementById('strength').disabled`), 'strength save complete');
  await evaluate(popupSession, `document.getElementById('strength').value = 'strict'; document.getElementById('strength').dispatchEvent(new Event('change'));`);
  await until(() => evaluate(workerSession, `(async () => (await chrome.storage.local.get('strength')).strength === 'strict' && (await chrome.declarativeNetRequest.getDynamicRules()).length === 1)()`), 'popup strict strength restoration');
  await until(() => evaluate(popupSession, `!document.getElementById('strength').disabled`), 'strict save complete');
  await evaluate(popupSession, `document.getElementById('sites').value = 'blocked.test'; document.getElementById('site-mode').value = 'only'; document.getElementById('save-sites').click();`);
  await until(() => evaluate(popupSession, `document.getElementById('status').textContent.includes('设置已保存')`), 'real popup save');
  assert.equal((await evaluate(workerSession, 'chrome.storage.local.get("siteMode")')).siteMode, 'only');
  await checkPage('blocked.test', true);
  await send('Emulation.setDeviceMetricsOverride', { width: 384, height: 780, deviceScaleFactor: 1, mobile: false }, popupSession);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, popupSession);
  fs.mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('./artifacts/site-filter-popup.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  console.log('PASS: Chromium extension, site rules, CDN/frames, single network/data/responsive/shadow image reveal, temporary tab allowance, tab isolation, cleanup and popup save.');
} finally {
  await send('Browser.close').catch(() => {});
  socket?.close();
  browser.kill();
  await new Promise(resolve => server.close(resolve));
  // Keep the isolated temporary profile for inspection; never touch the user's browser profile.
  for (const task of pending.values()) clearTimeout(task.timer);
}
