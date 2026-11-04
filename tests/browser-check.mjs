import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// Edge on Windows uses the port transport; current Chrome requires the pipe to
// install an unpacked extension through DevTools.
const usePipe = !/^(?:msedge|microsoft-edge(?:-stable|-beta|-dev)?)(?:\.exe)?$/i.test(path.basename(executable));
if (!usePipe) assert.equal(typeof WebSocket, 'function', 'Edge checks require Node.js 22+ (built-in WebSocket).');
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
  '--headless=new', `--user-data-dir=${profile}`,
  ...(usePipe ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging'] : [
    '--remote-debugging-port=0', `--disable-extensions-except=${root}`, `--load-extension=${root}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch'
  ]),
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--no-proxy-server', '--host-resolver-rules=MAP *.test 127.0.0.1', 'about:blank'
], { windowsHide: true, stdio: usePipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'] });
let socket;
let nextId = 0;
const pending = new Map();
let stderr = '';
browser.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
if (usePipe) {
  let incoming = Buffer.alloc(0);
  browser.stdio[4].on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    let end;
    while ((end = incoming.indexOf(0)) !== -1) {
      onMessage(incoming.subarray(0, end).toString('utf8'));
      incoming = incoming.subarray(end + 1);
    }
  });
  browser.stdio[3].on('error', () => {});
}
function onMessage(data) {
  const message = JSON.parse(data);
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
    if (usePipe ? browser.stdio[3].destroyed : socket?.readyState !== 1) return reject(new Error('Browser connection is not open'));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    const message = JSON.stringify({ id, method, params, sessionId });
    if (usePipe) browser.stdio[3].write(message + '\0');
    else socket.send(message);
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
  if (usePipe) {
    await send('Browser.getVersion');
    await send('Extensions.loadUnpacked', { path: root });
  } else {
    const connection = await until(() => {
      try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); }
      catch { return null; }
    }, 'browser debugging port');
    socket = new WebSocket(`ws://127.0.0.1:${connection[0]}${connection[1]}`);
    socket.addEventListener('message', event => onMessage(event.data));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser connection timed out')), 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed')); }, { once: true });
    });
  }
  const worker = await until(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  }, 'extension service worker');
  const { sessionId: workerSession } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await until(() => evaluate(workerSession, 'typeof synchronize === "function"'), 'background startup');
  // Run the controls with a delayed worker stub to exercise races and count scans.
  // about:blank has no extension content script, so this uses the actual DOM in isolation.
  const { targetId: controlsId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: controlsSession } = await send('Target.attachToTarget', { targetId: controlsId, flatten: true });
  await evaluate(controlsSession, `(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) {
      const result = attach.call(this, options);
      window.testPanel = result;
      return result;
    };
    window.scanCount = 0;
    const query = document.querySelectorAll.bind(document);
    document.querySelectorAll = selector => {
      if (selector === 'img:not([data-image-filter-revealed])') window.scanCount++;
      return query(selector);
    };
    window.replies = [];
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      runtime: { sendMessage: () => new Promise(resolve => window.replies.push(resolve)) }
    }});
    window.testImage = document.createElement('img');
    testImage.width = 120; testImage.height = 80;
    testImage.src = 'data:image/png;base64,${png.toString('base64')}';
    document.body.appendChild(testImage);
    window.afterFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  })()`);
  await evaluate(controlsSession, fs.readFileSync(new URL('../reveal.js', import.meta.url), 'utf8'));
  await evaluate(controlsSession, `ImageRevealControls.watch(document); ImageRevealControls.setEnabled(true, 'preserve'); afterFrames()`);
  await until(() => evaluate(controlsSession, `testPanel.querySelectorAll('button').length === 1`), 'isolated controls created');
  assert.equal(await evaluate(controlsSession, `(async () => {
    await afterFrames(); const before = scanCount;
    for (let i = 0; i < 5; i++) {
      dispatchEvent(new Event('scroll')); dispatchEvent(new Event('resize')); await afterFrames();
    }
    return scanCount - before;
  })()`), 0, 'scroll and resize reposition controls without rescanning the document');
  await evaluate(controlsSession, `testPanel.querySelector('button').click(); testImage.src += '#changed'; afterFrames()`);
  await evaluate(controlsSession, `replies.shift()({ok:true}); afterFrames()`);
  assert.equal(await evaluate(controlsSession, `!testImage.hasAttribute('data-image-filter-revealed') && !testPanel.querySelector('button').disabled`), true, 'late approval does not overwrite a changed image source');
  await evaluate(controlsSession, `testPanel.querySelector('button').click(); replies.shift()({error:'测试请求失败'});`);
  await until(() => evaluate(controlsSession, `testPanel.querySelector('button')?.title === '测试请求失败'`), 'worker failure displayed');
  await evaluate(controlsSession, `testImage.alt = '更新说明'; dispatchEvent(new Event('scroll')); afterFrames()`);
  assert.equal(await evaluate(controlsSession, `testPanel.querySelector('button').textContent`), '加载失败，点击重试', 'updates preserve retry feedback');
  await evaluate(controlsSession, `testPanel.querySelector('button').click(); ImageRevealControls.setEnabled(false, 'preserve'); replies.shift()({ok:true}); afterFrames()`);
  assert.equal(await evaluate(controlsSession, `testImage.hasAttribute('data-image-filter-revealed')`), false, 'late worker reply cannot reveal after disabling');
  await evaluate(controlsSession, `ImageRevealControls.setEnabled(true, 'preserve'); testImage.src = 'data:image/png;base64,invalid'; afterFrames()`);
  await until(() => evaluate(controlsSession, `!testImage.complete || testImage.naturalWidth === 0`), 'broken source selected');
  await evaluate(controlsSession, `testPanel.querySelector('button').click(); replies.shift()({ok:true});`);
  await until(() => evaluate(controlsSession, `testPanel.querySelector('button')?.textContent === '加载失败，点击重试' && !testImage.hasAttribute('data-image-filter-revealed')`), 'load failure restores retry control');
  await evaluate(controlsSession, `testImage.src = 'data:image/png;base64,${png.toString('base64')}'; afterFrames()`);
  await until(() => evaluate(controlsSession, `testPanel.querySelector('button')?.textContent === '显示图片：更新说明'`), 'new source clears old error');
  await evaluate(controlsSession, `testPanel.querySelector('button').click(); replies.shift()({ok:true});`);
  await until(() => evaluate(controlsSession, `testImage.hasAttribute('data-image-filter-revealed') && testImage.naturalWidth === 1 && !testPanel.querySelector('button')`), 'retry succeeds');
  await send('Target.closeTarget', { targetId: controlsId });
  async function settings(value) {
    return evaluate(workerSession, `(async () => {
      await chrome.storage.local.set(${JSON.stringify({ strength: 'strict', layout: 'preserve', siteStrengths: {}, ...value })});
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
  // Exact third-level exclusions must also allow CDN images and embedded frames.
  await settings({ enabled: true, siteMode: 'exclude', sites: ['news.blocked.test'],
    siteStrengths: { 'blocked.test': 'strict', 'news.blocked.test': 'strict' } });
  await checkPage('news.blocked.test', false);
  await checkPage('deep.news.blocked.test', false);
  await checkPage('other.blocked.test', true);
  await checkPage('blocked.test', true);
  await settings({ enabled: true, siteMode: 'exclude', sites: [], siteStrengths: { 'blocked.test': 'basic', 'deep.blocked.test': 'strict' } });
  await checkPage('blocked.test', true, false);
  await checkPage('sub.blocked.test', true, false);
  await checkPage('deep.blocked.test', true, true);
  await settings({ enabled: true, strength: 'basic', siteMode: 'only', sites: ['blocked.test'], siteStrengths: { 'blocked.test': 'strict' } });
  await checkPage('blocked.test', true, true);
  await checkPage('allowed.test', false);
  await settings({ enabled: true, siteMode: 'exclude', sites: [] });
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
  await evaluate(revealSession, `document.getElementById('network').alt = '山间的湖泊';`);
  await until(async () => {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, revealSession);
    return JSON.stringify(root).includes('显示图片：山间的湖泊');
  }, 'alt description appears in actual reveal control');
  await evaluate(revealSession, `document.getElementById('network').alt = '<b>更新描述</b>';`);
  await until(async () => {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, revealSession);
    return JSON.stringify(root).includes('显示图片：<b>更新描述</b>');
  }, 'dynamic alt updates as plain text');
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
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${tabId}}).then(text => text === 'TEMP')`), 'temporary allowance toolbar badge');
  assert.equal(await evaluate(revealSession, `document.getElementById('inline').getBoundingClientRect().height`), 80, 'temporary allowance bypasses collapse');
  await checkPage('allowed.test', true);
  assert.equal(await evaluate(workerSession, `chrome.action.getBadgeText({tabId:${tabId}})`), 'TEMP', 'other tabs do not overwrite the temporary badge');
  await send('Target.closeTarget', { targetId: revealId });
  await until(() => evaluate(workerSession, `(async () => (await tabRules(${tabId})).length === 0)()`), 'tab closure cleans exceptions');
  // Exercise the toolbar popup itself: unlike an extension page opened in a tab,
  // Chrome sizes this view from its initial content dimensions.
  const { targetId: actionHostId } = await send('Target.createTarget', { url: `http://news.blocked.test:${port}/` });
  const { sessionId: actionHostSession } = await send('Target.attachToTarget', { targetId: actionHostId, flatten: true });
  await until(() => evaluate(actionHostSession, `document.readyState === 'complete' && document.getElementById('inline') && getComputedStyle(document.getElementById('inline')).visibility === 'hidden'`), 'toolbar test website ready');
  const actionTabId = await evaluate(workerSession, `(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id)()`);
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${actionTabId}}).then(text => text === 'ON')`), 'strict toolbar badge');
  const popupUrl = worker.url.replace('background.js', 'popup.html');
  await evaluate(workerSession, 'chrome.action.openPopup()');
  const actionPopup = await until(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find(target => target.url === popupUrl);
  }, 'toolbar action popup');
  const { sessionId: actionSession } = await send('Target.attachToTarget', { targetId: actionPopup.targetId, flatten: true });
  await until(() => evaluate(actionSession, `!!document.getElementById('sites') && !document.getElementById('sites').disabled`), 'toolbar popup initialization');
  assert.equal(await evaluate(actionSession, `document.getElementById('diagnostic-host').textContent`), 'news.blocked.test', 'diagnosis reads the top-level page without additional permissions');
  assert.equal(await evaluate(actionSession, `document.getElementById('diagnostic-summary').textContent`), '状态一致');
  const popupSize = await evaluate(actionSession, `({
    viewport: innerWidth,
    height: innerHeight,
    body: document.body.getBoundingClientRect().width,
    titleHeight: document.querySelector('h1').getBoundingClientRect().height,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    footerBottom: document.querySelector('footer').getBoundingClientRect().bottom
  })`);
  assert.ok(popupSize.viewport >= 360 && popupSize.body >= 360 && popupSize.height >= 350 && popupSize.scrollWidth <= popupSize.clientWidth && popupSize.titleHeight < 36 && popupSize.footerBottom <= popupSize.height + 1,
    `toolbar popup must have enough width for its content: ${JSON.stringify(popupSize)}`);
  fs.mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true });
  const actionScreenshot = await send('Page.captureScreenshot', { format: 'png' }, actionSession);
  fs.writeFileSync(new URL('./artifacts/site-filter-toolbar-popup.png', import.meta.url), Buffer.from(actionScreenshot.data, 'base64'));
  // The actual popup can be shorter than 600px. Its content must remain reachable
  // between the sticky header and footer when the settings are expanded.
  await evaluate(actionSession, `document.querySelector('.defaults').open = true; document.getElementById('layout').scrollIntoView({block:'center'});`);
  assert.equal(await evaluate(actionSession, `(() => {
    const header = document.querySelector('header').getBoundingClientRect();
    const footer = document.querySelector('footer').getBoundingClientRect();
    const field = document.getElementById('layout').getBoundingClientRect();
    return field.top >= header.bottom && field.bottom <= footer.top && footer.bottom <= innerHeight + 1;
  })()`), true, 'settings remain reachable in the toolbar popup');
  await evaluate(actionSession, `document.getElementById('sites').value = 'news.blocked.test'; document.getElementById('save-reload').click();`);
  await until(() => evaluate(actionHostSession, `document.readyState === 'complete' && document.getElementById('network')?.naturalWidth === 1 && getComputedStyle(document.getElementById('inline')).visibility === 'visible'`), 'save and refresh restores previously blocked CDN images');
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${actionTabId}}).then(text => text === 'PASS')`), 'site exclusion toolbar badge');
  await evaluate(actionSession, `document.getElementById('refresh-diagnostic').click();`);
  await until(() => evaluate(actionSession, `document.getElementById('diagnostic-summary').textContent === '状态一致' && document.getElementById('diagnostic-match').textContent === 'news.blocked.test'`), 'diagnosis confirms saved exclusion after refresh');
  await evaluate(actionSession, `document.querySelector('.diagnostics').open = true; document.getElementById('diagnostic-reason').scrollIntoView({block:'center'});`);
  const diagnosticScreenshot = await send('Page.captureScreenshot', { format: 'png' }, actionSession);
  fs.writeFileSync(new URL('./artifacts/site-filter-diagnostics.png', import.meta.url), Buffer.from(diagnosticScreenshot.data, 'base64'));
  await send('Target.closeTarget', { targetId: actionPopup.targetId });
  await send('Page.enable', {}, actionHostSession);
  await send('Page.navigate', { url: `http://other.blocked.test:${port}/` }, actionHostSession);
  await until(() => evaluate(actionHostSession, `document.readyState === 'complete' && document.getElementById('inline') && getComputedStyle(document.getElementById('inline')).visibility === 'hidden'`), 'navigation leaves excluded third-level site');
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${actionTabId}}).then(text => text === 'ON')`), 'navigation updates the toolbar badge');
  await settings({ enabled: true, siteMode: 'exclude', sites: [], strength: 'basic' });
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${actionTabId}}).then(text => text === 'IMG')`), 'basic toolbar badge after settings change');
  await settings({ enabled: false, siteMode: 'exclude', sites: [] });
  await until(() => evaluate(workerSession, `chrome.action.getBadgeText({tabId:${actionTabId}}).then(text => text === 'OFF')`), 'paused toolbar badge');
  await settings({ enabled: true, siteMode: 'exclude', sites: [] });
  await send('Target.closeTarget', { targetId: actionHostId });
  const { targetId: popupId } = await send('Target.createTarget', { url: worker.url.replace('background.js', 'popup.html') });
  const { sessionId: popupSession } = await send('Target.attachToTarget', { targetId: popupId, flatten: true });
  await until(() => evaluate(popupSession, `!!document.getElementById('sites') && !document.getElementById('sites').disabled`), 'popup initialization');
  await evaluate(popupSession, `document.getElementById('sites').value = 'news.example.com'; document.getElementById('sites').dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(popupSession, `document.getElementById('sites-count').textContent`), '1 / 500');
  assert.match(await evaluate(popupSession, `document.getElementById('list-state').textContent`), /尚未保存/);
  await evaluate(popupSession, `document.getElementById('sites').value = 'ftp://invalid.test'; document.getElementById('sites').dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(popupSession, `document.getElementById('sites').getAttribute('aria-invalid')`), 'true');
  await evaluate(popupSession, `document.getElementById('sites').value = ''; document.getElementById('sites').dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate(popupSession, `document.getElementById('sites').getAttribute('aria-invalid')`), 'false');
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
  await send('Emulation.setDeviceMetricsOverride', { width: 384, height: 600, deviceScaleFactor: 1, mobile: false }, popupSession);
  assert.equal(await evaluate(popupSession, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, 'popup fits a narrow browser window');
  await evaluate(popupSession, `document.querySelector('.defaults').open = true; window.scrollTo(0, document.documentElement.scrollHeight);`);
  assert.equal(await evaluate(popupSession, `(() => {
    const footer = document.querySelector('footer').getBoundingClientRect();
    const select = document.getElementById('layout').getBoundingClientRect();
    return footer.bottom <= innerHeight && select.bottom <= footer.top && select.top >= document.querySelector('header').getBoundingClientRect().bottom;
  })()`), true, 'default controls scroll into view while refresh stays visible');
  await evaluate(popupSession, `document.querySelector('.defaults').open = false; window.scrollTo(0, 0);`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, popupSession);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, popupSession);
  fs.mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('./artifacts/site-filter-popup.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  await evaluate(popupSession, `window.scrollTo(0, document.documentElement.scrollHeight);`);
  const rulesScreenshot = await send('Page.captureScreenshot', { format: 'png' }, popupSession);
  fs.writeFileSync(new URL('./artifacts/site-filter-rules.png', import.meta.url), Buffer.from(rulesScreenshot.data, 'base64'));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, popupSession);
  await evaluate(popupSession, `window.scrollTo(0, 0);`);
  const darkScreenshot = await send('Page.captureScreenshot', { format: 'png' }, popupSession);
  fs.writeFileSync(new URL('./artifacts/site-filter-popup-dark.png', import.meta.url), Buffer.from(darkScreenshot.data, 'base64'));
  console.log('PASS: Chromium extension, scan reuse, failure/retry, stale reveal replies, site rules, CDN/frames, network/data/responsive/shadow reveal, temporary allowance, tab isolation, cleanup and popup save.');
} finally {
  await send('Browser.close').catch(() => {});
  socket?.close();
  browser.kill();
  await new Promise(resolve => server.close(resolve));
  // Keep the isolated temporary profile for inspection; never touch the user's browser profile.
  for (const task of pending.values()) clearTimeout(task.timer);
}
