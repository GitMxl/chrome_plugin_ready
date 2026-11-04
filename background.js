importScripts("settings.js");
const Settings = ImageFilterSettings;
const IMAGE_RULE_ID = 1;
const badgeRevisions = new Map();

async function pageState(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: "getImageFilterState" }, { frameId: 0 }); }
  catch { return null; }
}

async function refreshBadge(tabId, knownUrl) {
  const revision = (badgeRevisions.get(tabId) || 0) + 1;
  badgeRevisions.set(tabId, revision);
  try {
    const [value, rules, tab, page] = await Promise.all([
      chrome.storage.local.get(Settings.keys), tabRules(tabId), chrome.tabs.get(tabId),
      pageState(tabId)
    ]);
    const policy = Settings.diagnose(Settings.normalize(value), page ? Settings.hostname(page.url || knownUrl || tab.url) : "", rules.some(rule => rule.priority === 3));
    if (badgeRevisions.get(tabId) !== revision) return;
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: policy.code === "NA" ? "—" : policy.code }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: policy.blocked ? "#087f73" : policy.code === "TEMP" ? "#a66b15" : "#64748b" }),
      chrome.action.setTitle({ tabId, title: `图片屏蔽 · ${policy.label}\n${policy.host || "当前页面"}：${policy.reason}\n修改规则后刷新网页以完整应用` })
    ]);
  } catch { /* The tab may have closed or navigated while its state was read. */ }
}

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => refreshBadge(tab.id)));
}

chrome.tabs.onActivated.addListener(({ tabId }) => { refreshBadge(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status || change.url) refreshBadge(tabId);
});

// Session rules survive worker suspension, but never become permanent settings.
let sessionPending = Promise.resolve();
function sessionChange(task) {
  const result = sessionPending.catch(() => {}).then(task);
  sessionPending = result;
  return result;
}
async function tabRules(tabId) {
  return (await chrome.declarativeNetRequest.getSessionRules())
    .filter(rule => rule.condition.tabIds?.includes(tabId));
}
async function addSessionRule(condition, priority) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const id = Math.max(1, ...rules.map(rule => rule.id)) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{ id, priority, action: { type: "allow" }, condition }]
  });
}
chrome.tabs.onRemoved.addListener(tabId => {
  badgeRevisions.delete(tabId);
  sessionChange(async () => {
    const rules = await tabRules(tabId);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
  }).catch(error => console.error("无法清理临时图片规则", error));
});

// Serialize changes so a fast toggle cannot leave an older rule active.
let pending = Promise.resolve();
function synchronize() {
  pending = pending.catch(() => {}).then(async () => {
    const settings = Settings.normalize(await chrome.storage.local.get(Settings.keys));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: Array.from({ length: 501 }, (_, index) => IMAGE_RULE_ID + index),
      addRules: Settings.rules(settings)
    });
    await chrome.action.setBadgeText({ text: settings.enabled ? "ON" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? "#2563eb" : "#64748b" });
    await refreshAllBadges();
  });
  pending.catch(error => console.error("无法更新图片屏蔽规则", error));
  return pending;
}

chrome.runtime.onInstalled.addListener(synchronize);
chrome.runtime.onStartup.addListener(synchronize);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Settings.keys.some(key => key in changes)) synchronize();
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "getImagePolicy") {
    Promise.all([chrome.storage.local.get(Settings.keys), sessionPending.catch(() => {}).then(() => tabRules(sender.tab?.id))]).then(([value, rules]) => {
      const settings = Settings.normalize(value);
      // At document_start the tab URL can still describe the previous navigation.
      // Use the requesting document for the main frame; embedded frames inherit
      // the top-level site's policy.
      const url = sender.frameId === 0 ? sender.url : sender.tab?.url || sender.url;
      const host = Settings.hostname(url || "");
      if (sender.frameId === 0 && Number.isInteger(sender.tab?.id)) refreshBadge(sender.tab.id, url);
      respond({ enabled: !rules.some(rule => rule.priority === 3) && Settings.shouldBlock(settings, host), strength: Settings.strengthFor(settings, host), layout: settings.layout });
    }).catch(() => respond({ error: "无法读取网站设置" }));
    return true;
  }
  if (message?.type === "getImageDiagnostics" && sender.url === chrome.runtime.getURL("popup.html")) {
    (async () => {
      await pending.catch(() => {});
      await sessionPending.catch(() => {});
      const [tab, page, value, rules, dynamic] = await Promise.all([
        chrome.tabs.get(message.tabId), pageState(message.tabId), chrome.storage.local.get(Settings.keys),
        tabRules(message.tabId), chrome.declarativeNetRequest.getDynamicRules()
      ]);
      const settings = Settings.normalize(value);
      const policy = Settings.diagnose(settings, Settings.hostname(page?.url || tab.url), rules.some(rule => rule.priority === 3));
      // Compare the fields used by this extension, independent of API key order.
      const signature = list => JSON.stringify(list.map(rule => [rule.id, rule.priority, rule.action.type,
        rule.condition.urlFilter, ...["resourceTypes", "topDomains", "excludedTopDomains"].map(key => [...(rule.condition[key] || [])].sort())
      ]).sort((a, b) => a[0] - b[0]));
      const networkApplied = signature(dynamic) === signature(Settings.rules(settings));
      const pageApplied = !!page?.ready && page.enabled === policy.blocked &&
        page.strength === policy.strength && page.layout === settings.layout;
      respond({ ok: true, policy, networkApplied, pageApplied, pageConnected: !!page, temporaryAllowed: rules.some(rule => rule.priority === 3),
        imageExceptions: rules.filter(rule => rule.priority === 2).length });
      refreshBadge(tab.id, page?.url || tab.url);
    })().catch(() => respond({ error: "无法读取诊断，请刷新网页后重试" }));
    return true;
  }
  if (["getTemporaryTabState", "setTemporaryTabState"].includes(message?.type) &&
      sender.url === chrome.runtime.getURL("popup.html")) {
    sessionChange(async () => {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("没有当前标签页");
      const tab = await chrome.tabs.get(message.tabId);
      if (!Settings.hostname(tab.url || "")) throw new Error("当前页面不支持临时放行");
      const rules = await tabRules(tab.id);
      if (message.type === "setTemporaryTabState") {
        if (message.allowed === true) {
          if (!rules.some(rule => rule.priority === 3)) {
            await addSessionRule({ tabIds: [tab.id], resourceTypes: ["image"] }, 3);
          }
        } else {
          // Re-blocking also revokes individual image exceptions in this tab.
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
        }
      }
      await refreshBadge(tab.id, tab.url);
      respond({ ok: true, allowed: (await tabRules(tab.id)).some(rule => rule.priority === 3) });
    }).catch(error => respond({ error: error.message }));
    return true;
  }
  if (message?.type === "revealImage" && Number.isInteger(sender.tab?.id)) {
    sessionChange(async () => {
      const settings = Settings.normalize(await chrome.storage.local.get(Settings.keys));
      const host = Settings.hostname(sender.frameId === 0 ? sender.url : sender.tab?.url || sender.url);
      if (Settings.strengthFor(settings, host) === "basic") return;
      const url = new URL(message.url);
      if (["data:", "blob:"].includes(url.protocol)) return;
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("不支持此图片地址");
      url.hash = "";
      const regexFilter = "^" + url.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
      const rules = await tabRules(sender.tab.id);
      if (rules.some(rule => rule.condition.regexFilter === regexFilter || rule.priority === 3)) return;
      if (rules.length >= 200) throw new Error("本标签页查看图片已达上限，请使用临时放行");
      const supported = await chrome.declarativeNetRequest.isRegexSupported({ regex: regexFilter, isCaseSensitive: true });
      if (!supported.isSupported) throw new Error("图片地址过长或不受支持，请使用临时放行");
      await addSessionRule({ tabIds: [sender.tab.id], resourceTypes: ["image"], regexFilter, isUrlFilterCaseSensitive: true }, 2);
    }).then(() => respond({ ok: true })).catch(error => respond({ error: error.message }));
    return true;
  }
  if (message?.type === "saveImageSettings" && sender.url === chrome.runtime.getURL("popup.html")) {
    (async () => {
      const settings = Settings.normalize(message.settings);
      // Validate the entire list before writing anything.
      settings.sites = Settings.parseSites((message.settings?.sites || []).join("\n"));
      await chrome.storage.local.set(settings);
      await synchronize();
      respond({ ok: true, settings });
    })().catch(() => respond({ error: "保存或应用设置失败，请重试" }));
    return true;
  }
});
synchronize();
