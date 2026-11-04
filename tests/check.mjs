import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function context(globals = {}) {
  const ctx = vm.createContext({ URL, console, ...globals });
  vm.runInContext(read('settings.js'), ctx);
  return ctx;
}
const Settings = context().ImageFilterSettings;
// Network partitions must agree with the inherited content policy.
for (const strength of ['basic', 'strict']) {
  for (const siteMode of ['only', 'exclude']) {
    const policy = Settings.normalize({ strength, siteMode, sites: ['example.com', 'skip.deep.example.com'],
      siteStrengths: { 'example.com': 'basic', 'deep.example.com': 'strict', 'leaf.deep.example.com': 'basic', 'back.leaf.deep.example.com': 'strict' } });
    for (const host of ['other.test', 'example.com', 'a.example.com', 'deep.example.com', 'skip.deep.example.com', 'leaf.deep.example.com', 'back.leaf.deep.example.com']) {
      const blocked = Settings.rules(policy).some(({ condition }) =>
        (!condition.topDomains || Settings.matches(host, condition.topDomains)) &&
        !Settings.matches(host, condition.excludedTopDomains || []));
      assert.equal(blocked, Settings.shouldBlock(policy, host) && Settings.strengthFor(policy, host) === 'strict', `${siteMode}/${strength}/${host}`);
    }
  }
}
const manifest = JSON.parse(read('manifest.json'));
assert.equal(manifest.minimum_chrome_version, '145');
assert.deepEqual(manifest.permissions, ['storage', 'declarativeNetRequest', 'activeTab']);
for (const file of [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(script => script.js), 'popup.js', 'popup.css']) {
  assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `Missing ${file}`);
}

assert.deepEqual(plain(Settings.normalize()), { enabled: true, siteMode: 'exclude', sites: [], siteStrengths: {}, strength: 'strict', layout: 'preserve' });
assert.deepEqual(plain(Settings.normalize({ enabled: false })), { enabled: false, siteMode: 'exclude', sites: [], siteStrengths: {}, strength: 'strict', layout: 'preserve' });
assert.equal(Settings.normalize({ layout: 'invalid' }).layout, 'preserve');
assert.equal(Settings.normalize({ layout: 'collapse' }).layout, 'collapse');
assert.equal(Settings.normalize({ strength: 'invalid' }).strength, 'strict');
assert.deepEqual(plain(Settings.rules(Settings.normalize({ strength: 'basic' }))), []);
assert.equal(Settings.normalizeSite('https://EXAMPLE.com:8080/path?q=1'), 'example.com');
assert.equal(Settings.normalizeSite('*.example.com'), 'example.com');
assert.equal(Settings.normalizeSite('example.com.'), 'example.com');
assert.equal(Settings.normalizeSite('https://例子.测试/'), 'xn--fsqu00a.xn--0zwm56d');
assert.equal(Settings.normalizeSite('localhost:8080'), 'localhost');
assert.equal(Settings.normalizeSite('127.0.0.1'), '127.0.0.1');
assert.deepEqual(plain(Settings.parseSites('example.com\nhttps://EXAMPLE.com/path，foo.example;bar.test')), ['example.com', 'foo.example', 'bar.test']);
for (const input of ['file:///tmp/a', 'ftp://example.com', 'chrome://settings', 'bad..com', '-bad.com', 'a*b.com', 'https://user:pass@example.com', '[::1]', 'https://']) {
  assert.throws(() => Settings.normalizeSite(input), undefined, input);
}
assert.throws(() => Settings.parseSites(Array.from({ length: 501 }, (_, i) => `s${i}.test`).join('\n')), /500/);
for (const mode of ['only', 'exclude']) {
  const value = Settings.normalize({ siteMode: mode, sites: ['example.com'] });
  for (const host of ['example.com', 'a.example.com', 'deep.a.example.com']) {
    assert.equal(Settings.shouldBlock(value, host), mode === 'only');
  }
  for (const host of ['notexample.com', 'example.com.evil.test', 'other.test']) {
    assert.equal(Settings.shouldBlock(value, host), mode === 'exclude');
  }
  assert.equal(Settings.shouldBlock({ ...value, enabled: false }, 'example.com'), false);
}
assert.deepEqual(plain(Settings.rules(Settings.normalize({ siteMode: 'only' }))), []);
assert.equal(Settings.rules(Settings.normalize())[0].condition.topDomains, undefined);
assert.deepEqual(plain(Settings.rules(Settings.normalize({ siteMode: 'only', sites: ['example.com'] }))[0].condition), {
  urlFilter: '*', resourceTypes: ['image'], topDomains: ['example.com']
});

async function background(initial = {}) {
  const listeners = {};
  let stored = { ...initial };
  let rules = [];
  let badge;
  const tabBadges = new Map();
  let sessionRules = [];
  let fail = false;
  let pageOverride;
  const chrome = {
    tabs: {
      get: async id => ({ id, url: 'https://example.com/' }),
      query: async () => [{ id: 7 }],
      sendMessage: async id => {
        if (pageOverride === null) throw new Error('no content script');
        if (pageOverride) return pageOverride;
        const policy = Settings.diagnose(Settings.normalize(stored), 'example.com', sessionRules.some(r => r.priority === 3 && r.condition.tabIds?.includes(id)));
        return { url: 'https://example.com/', enabled: policy.blocked, strength: policy.strength, layout: Settings.normalize(stored).layout, ready: true };
      },
      onActivated: { addListener: fn => { listeners.activate = fn; } },
      onUpdated: { addListener: fn => { listeners.update = fn; } },
      onRemoved: { addListener: fn => { listeners.removed = fn; } }
    },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onInstalled: { addListener: fn => { listeners.install = fn; } },
      onStartup: { addListener: fn => { listeners.start = fn; } },
      onMessage: { addListener: fn => { listeners.message = fn; } }
    },
    storage: {
      local: {
        get: async () => ({ ...stored }),
        set: async value => { stored = { ...stored, ...plain(value) }; listeners.change(value, 'local'); }
      },
      onChanged: { addListener: fn => { listeners.change = fn; } }
    },
    declarativeNetRequest: {
      getSessionRules: async () => plain(sessionRules),
      getDynamicRules: async () => plain(rules),
      isRegexSupported: async () => ({ isSupported: true }),
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        sessionRules = [...sessionRules.filter(rule => !removeRuleIds.includes(rule.id)), ...plain(addRules)];
      },
      updateDynamicRules: async update => {
      if (fail) { fail = false; throw new Error('test failure'); }
      assert.deepEqual(Array.from(update.removeRuleIds), Array.from({ length: 501 }, (_, i) => i + 1));
      rules = plain(update.addRules);
    } },
    action: {
      setBadgeText: async ({ text, tabId }) => { if (tabId === undefined) badge = text; else tabBadges.set(tabId, text); },
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {}
    }
  };
  const ctx = context({ chrome, console: { error() {} } });
  ctx.importScripts = file => vm.runInContext(read(file), ctx);
  vm.runInContext(read('background.js'), ctx);
  await flush();
  const message = (value, sender = { url: chrome.runtime.getURL('popup.html') }) => new Promise(resolve => {
    assert.equal(listeners.message(value, sender, resolve), true);
  });
  const save = settings => message({ type: 'saveImageSettings', settings });
  return { listeners, message, save, tabBadges, dropRules() { rules = []; }, setPage(value) { pageOverride = value; }, get sessionRules() { return sessionRules; }, get rules() { return rules; }, get stored() { return stored; }, get badge() { return badge; }, failNext() { fail = true; } };
}
const bg = await background();
assert.equal(bg.tabBadges.get(7), 'ON');
const diagnosis = await bg.message({ type: 'getImageDiagnostics', tabId: 7 });
assert.equal(diagnosis.networkApplied, true);
assert.equal(diagnosis.pageApplied, true);
assert.equal(diagnosis.policy.code, 'ON');
const mismatch = await background();
mismatch.dropRules();
assert.equal((await mismatch.message({ type: 'getImageDiagnostics', tabId: 7 })).networkApplied, false);
mismatch.setPage({ url: 'https://example.com/', enabled: false, strength: 'strict', layout: 'preserve', ready: true });
assert.equal((await mismatch.message({ type: 'getImageDiagnostics', tabId: 7 })).pageApplied, false);
mismatch.setPage(null);
mismatch.listeners.activate({ tabId: 7 });
await flush();
assert.equal(mismatch.tabBadges.get(7), '—', 'unconnected pages do not claim to be blocked');
assert.equal((await mismatch.message({ type: 'getImageDiagnostics', tabId: 7 })).pageConnected, false);
mismatch.setPage(undefined);
mismatch.listeners.update(7, { status: 'complete' });
await flush();
assert.equal(mismatch.tabBadges.get(7), 'ON', 'navigation completion refreshes the badge');
assert.equal(Settings.diagnose(Settings.normalize({ sites: ['example.com'] }), 'news.example.com').matchedSite, 'example.com');
assert.equal(Settings.diagnose(Settings.normalize({ sites: ['news.example.com'] }), 'other.example.com').code, 'ON');
assert.equal(Settings.diagnose(Settings.normalize({ sites: ['news.example.com'] }), 'news.example.com').code, 'PASS');
assert.equal(Settings.diagnose(Settings.normalize({ strength: 'basic' }), 'example.com').code, 'IMG');
assert.equal(Settings.diagnose(Settings.normalize(), '').code, 'NA');
const perSite = await background({ strength: 'basic', siteStrengths: { 'example.com': 'strict' } });
assert.equal((await perSite.message({ type: 'getImagePolicy' }, { tab: { url: 'https://sub.example.com' }, url: 'https://frame.test' })).strength, 'strict');
assert.equal((await perSite.message({ type: 'getImagePolicy' }, { frameId: 0, url: 'https://other.test' })).strength, 'basic');
assert.equal((await background(perSite.stored)).rules.length, 1);
assert.equal(bg.rules.length, 1);
assert.equal(bg.badge, 'ON');
const only = { enabled: true, siteMode: 'only', sites: ['example.com'] };
assert.equal((await bg.save(only)).ok, true);
assert.deepEqual(bg.rules[0].condition.topDomains, ['example.com']);
// The top-level URL controls a CDN or cross-origin iframe policy.
assert.equal((await bg.message({ type: 'getImagePolicy' }, { tab: { url: 'https://example.com/page' }, url: 'https://frame.other.test/' })).enabled, true);
assert.equal((await bg.message({ type: 'getImagePolicy' }, { tab: { url: 'https://other.test/' }, url: 'https://example.com/frame' })).enabled, false);
await bg.save({ ...only, siteMode: 'exclude' });
assert.equal(bg.tabBadges.get(7), 'PASS');
assert.deepEqual(bg.rules[0].condition.excludedTopDomains, ['example.com']);
assert.equal((await bg.message({ type: 'getImagePolicy' }, { tab: { url: 'https://example.com/' } })).enabled, false);
// First navigation may still expose about:blank or the previous URL in tab.url.
for (const url of ['about:blank', 'https://other.test/']) {
  assert.equal((await bg.message({ type: 'getImagePolicy' }, {
    frameId: 0, tab: { url }, url: 'https://example.com/page'
  })).enabled, false, 'excluded document is allowed even with a stale tab URL');
}
assert.equal((await bg.message({ type: 'getImagePolicy' }, {
  frameId: 0, tab: { url: 'https://example.com/' }, url: 'https://other.test/'
})).enabled, true, 'navigation away from an excluded site blocks images');
await bg.save(only);
assert.equal((await bg.message({ type: 'getImagePolicy' }, {
  frameId: 0, tab: { url: 'https://other.test/' }, url: 'https://example.com/'
})).enabled, true, 'only mode also uses the current document');
await bg.save({ ...only, enabled: false });
assert.deepEqual(bg.rules, []);
assert.deepEqual(plain(bg.stored.sites), ['example.com']);
assert.equal(bg.badge, 'OFF');
const restored = await background(bg.stored);
assert.deepEqual(restored.rules, []);
await restored.listeners.start();
assert.equal(restored.badge, 'OFF');
await bg.save({ ...only, sites: [] });
assert.deepEqual(bg.rules, []);
const before = plain(bg.stored);
assert.ok((await bg.save({ ...only, sites: ['ftp://bad.test'] })).error);
assert.deepEqual(bg.stored, before);
await Promise.all([bg.save(only), bg.save({ ...only, enabled: false })]);
await flush();
assert.deepEqual(bg.rules, []);
bg.failNext();
await bg.save(only);
await bg.listeners.start();
assert.equal(bg.rules.length, 1, 'queue recovers after an API error');
assert.equal((await bg.save({ enabled: true, strength: 'basic' })).settings.strength, 'basic');
assert.deepEqual(bg.rules, [], 'basic mode permits background and icon downloads');
assert.equal((await bg.message({ type: 'getImagePolicy' }, { frameId: 0, url: 'https://example.com/' })).strength, 'basic');
assert.equal((await background(bg.stored)).stored.strength, 'basic', 'strength survives restart');
await bg.message({ type: 'revealImage', url: 'https://cdn.test/one.png' }, { tab: { id: 7 } });
assert.equal(bg.sessionRules.length, 0, 'basic reveal needs no network exception');

await bg.save({ enabled: true, sites: [], siteMode: 'exclude' });
const tabSender = { frameId: 0, tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' };
assert.equal((await bg.message({ type: 'setTemporaryTabState', tabId: 7, allowed: true })).allowed, true);
assert.equal(bg.tabBadges.get(7), 'TEMP');
assert.equal((await bg.message({ type: 'getImageDiagnostics', tabId: 7 })).policy.reason, '当前标签页已临时放行');
assert.equal((await bg.message({ type: 'getImagePolicy' }, tabSender)).enabled, false);
assert.equal((await bg.message({ type: 'getImagePolicy' }, { ...tabSender, tab: { ...tabSender.tab, id: 8 } })).enabled, true);
assert.equal((await bg.message({ type: 'getTemporaryTabState', tabId: 7 })).allowed, true);
assert.deepEqual(bg.sessionRules[0].condition.tabIds, [7]);
await bg.message({ type: 'setTemporaryTabState', tabId: 7, allowed: false });
assert.equal((await bg.message({ type: 'getImagePolicy' }, tabSender)).enabled, true);
const imageUrl = 'https://cdn.example/a.png?q=one.two+three&x=1';
assert.equal((await bg.message({ type: 'revealImage', url: imageUrl }, tabSender)).ok, true);
assert.equal(bg.sessionRules.length, 1);
const exact = new RegExp(bg.sessionRules[0].condition.regexFilter);
assert.equal(exact.test(imageUrl), true);
assert.equal(exact.test(imageUrl + 'extra'), false);
assert.equal(exact.test(imageUrl.replace('one.two', 'oneXtwo')), false);
await bg.message({ type: 'revealImage', url: imageUrl }, tabSender);
assert.equal(bg.sessionRules.length, 1, 'repeat clicks reuse the exception');
assert.ok((await bg.message({ type: 'revealImage', url: 'file:///secret' }, tabSender)).error);
await bg.listeners.removed(7);
await flush();
assert.equal(bg.sessionRules.length, 0, 'closing a tab removes all its exceptions');

async function content() {
  let change;
  let observerCallback;
  const replies = [];
  const styles = [];
  const document = {
    documentElement: null,
    createElement: () => ({ parentNode: null, remove() { this.parentNode = null; } })
  };
  const html = {
    nodeType: 1,
    querySelectorAll: () => [],
    appendChild(style) { style.parentNode = this; styles.push(style); }
  };
  const ctx = context({
    ImageRevealControls: { watch() {}, setEnabled() {} },
    document, Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    chrome: {
      runtime: { sendMessage: () => new Promise(resolve => replies.push(resolve)), onMessage: { addListener() {} } },
      storage: { onChanged: { addListener: fn => { change = fn; } } }
    }
  });
  vm.runInContext(read('content.js'), ctx);
  document.documentElement = html;
  observerCallback([{ addedNodes: [html] }]);
  assert.equal(styles.length, 0, 'allowed sites are not hidden while policy loads');
  replies.shift()({ enabled: true });
  await flush();
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /background-image: none !important/);
  change({ sites: { newValue: ['example.com'] } }, 'local');
  replies.shift()({ enabled: false });
  await flush();
  assert.equal(styles[0].parentNode, null);
  change({ siteMode: {} }, 'local');
  change({ enabled: {} }, 'local');
  const old = replies.shift();
  replies.shift()({ enabled: true });
  await flush();
  old({ enabled: false });
  await flush();
  assert.equal(styles[0].parentNode, html, 'out-of-order policy replies cannot revert the latest policy');
  change({ strength: {} }, 'local');
  replies.shift()({ enabled: true, strength: 'basic' });
  await flush();
  assert.match(styles[0].textContent, /img:not/);
  assert.doesNotMatch(styles[0].textContent, /background-image|content: none|input\[type|svg image/);
  change({ strength: {} }, 'local');
  replies.shift()({ enabled: true, strength: 'strict' });
  await flush();
  assert.match(styles[0].textContent, /background-image: none/);
  change({ layout: {} }, 'local');
  replies.shift()({ enabled: true, strength: 'basic', layout: 'collapse' });
  await flush();
  assert.match(styles[0].textContent, /display: none !important/);
  assert.doesNotMatch(styles[0].textContent, /input\[type|svg image/);
  change({ layout: {} }, 'local');
  replies.shift()({ enabled: true, strength: 'strict', layout: 'collapse' });
  await flush();
  assert.match(styles[0].textContent, /input\[type="image"\], svg image;?/);
  change({ layout: {} }, 'local');
  replies.shift()({ enabled: true, strength: 'strict', layout: 'preserve' });
  await flush();
  assert.doesNotMatch(styles[0].textContent, /display: none/);
}
await content();

async function popup(url = 'https://www.example.com/page') {
  const elements = new Map();
  const saves = [];
  const events = [];
  let stored = {};
  let temporary = false;
  let saveError = false;
  let reloadError = false;
  let reloaded;
  const ctx = context({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', textContent: '', disabled: true, checked: false, handlers: {},
        addEventListener(event, fn) { this.handlers[event] = fn; }
      });
      return elements.get(id);
    } },
    window: { close() {} },
    chrome: {
      storage: { local: { get: async () => stored } },
      tabs: { query: async () => [{ id: 7, url }], reload: async id => { events.push('reload'); if (reloadError) throw new Error('reload failed'); reloaded = id; } },
      runtime: { sendMessage: async message => {
        if (message.type === 'getImageDiagnostics') return { ok: true, policy: plain(Settings.diagnose(Settings.normalize(stored), Settings.hostname(url), temporary)), temporaryAllowed: temporary, pageApplied: true, pageConnected: true, networkApplied: true, imageExceptions: 0 };
        if (message.type === 'getTemporaryTabState') return { ok: true, allowed: false };
        if (message.type === 'setTemporaryTabState') { temporary = message.allowed; return { ok: true, allowed: message.allowed }; }
        events.push('save');
        if (saveError) return { error: '测试保存失败' };
        saves.push(plain(message.settings));
        stored = plain(message.settings);
        return { ok: true, settings: stored };
      } }
    }
  });
  vm.runInContext(read('popup.js'), ctx);
  await flush();
  return { elements, saves, events, failSave() { saveError = true; }, failReload() { reloadError = true; }, get reloaded() { return reloaded; } };
}
const ui = await popup();
const el = id => ui.elements.get(id);
assert.equal(el('strength').value, 'strict');
assert.equal(el('layout').value, 'preserve');
el('site-strength').value = 'basic';
await el('site-strength').handlers.change();
assert.deepEqual(ui.saves.at(-1).siteStrengths, { 'www.example.com': 'basic' });
el('layout').value = 'collapse';
await el('layout').handlers.change();
assert.deepEqual(ui.saves.at(-1).siteStrengths, { 'www.example.com': 'basic' });
el('site-strength').value = 'inherit';
await el('site-strength').handlers.change();
assert.deepEqual(ui.saves.at(-1).siteStrengths, {});
el('layout').value = 'collapse';
await el('layout').handlers.change();
assert.equal(ui.saves.at(-1).layout, 'collapse');
el('strength').value = 'basic';
await el('strength').handlers.change();
assert.equal(ui.saves.at(-1).strength, 'basic');
assert.equal(el('current-site').textContent, 'www.example.com');
await el('add-current').handlers.click();
assert.deepEqual(ui.saves.at(-1).sites, ['www.example.com']);
assert.equal(el('add-current').disabled, true);
el('site-mode').value = 'only';
await el('site-mode').handlers.change();
assert.equal(el('sites-label').textContent, '屏蔽的网站');
assert.match(el('site-status').textContent, /屏蔽图片/);
el('sites').value = 'example.com\nhttps://news.test/a';
await el('save-sites').handlers.click();
assert.deepEqual(ui.saves.at(-1).sites, ['example.com', 'news.test']);
el('sites').value = 'ftp://invalid.test';
const count = ui.saves.length;
await el('save-sites').handlers.click();
assert.equal(ui.saves.length, count, 'invalid input is not saved');
assert.match(el('status').textContent, /无效/);
el('sites').value = '';
await el('save-sites').handlers.click();
assert.deepEqual(ui.saves.at(-1).sites, []);
el('enabled').checked = false;
await el('enabled').handlers.change();
assert.equal(ui.saves.at(-1).enabled, false);
await el('reload').handlers.click();
assert.equal(ui.reloaded, 7);
await el('temporary-tab').handlers.click();
assert.match(el('temporary-tab').textContent, /取消/);
assert.match(el('site-status').textContent, /临时放行/);
await el('temporary-tab').handlers.click();
assert.equal(el('temporary-tab').textContent, '临时放行当前标签页');
const internal = await popup('chrome://extensions');
assert.equal(internal.elements.get('add-current').disabled, true);
assert.equal(internal.elements.get('save-reload').disabled, true);
const combined = await popup();
combined.elements.get('sites').value = 'example.com';
await combined.elements.get('save-reload').handlers.click();
assert.deepEqual(combined.events, ['save', 'reload']);
assert.match(combined.elements.get('diagnostic-match').textContent, /example.com/);
assert.equal(combined.reloaded, 7);
const failedSave = await popup();
failedSave.failSave();
await failedSave.elements.get('save-reload').handlers.click();
assert.deepEqual(failedSave.events, ['save'], 'never refresh after failed save');
const failedReload = await popup();
failedReload.failReload();
await failedReload.elements.get('save-reload').handlers.click();
assert.match(failedReload.elements.get('status').textContent, /已保存，但刷新失败/);
console.log('PASS: domain validation, modes, subdomains, top-level/CDN/iframe policies, persistence, rapid changes, stale replies, style restoration and popup actions.');
