importScripts("settings.js");
const Settings = ImageFilterSettings;
const IMAGE_RULE_ID = 1;

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
      removeRuleIds: [IMAGE_RULE_ID],
      addRules: Settings.rules(settings)
    });
    await chrome.action.setBadgeText({ text: settings.enabled ? "ON" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? "#2563eb" : "#64748b" });
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
      respond({ enabled: !rules.some(rule => rule.priority === 3) && Settings.shouldBlock(settings, host), strength: settings.strength, layout: settings.layout });
    }).catch(() => respond({ error: "无法读取网站设置" }));
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
      respond({ ok: true, allowed: (await tabRules(tab.id)).some(rule => rule.priority === 3) });
    }).catch(error => respond({ error: error.message }));
    return true;
  }
  if (message?.type === "revealImage" && Number.isInteger(sender.tab?.id)) {
    sessionChange(async () => {
      const settings = Settings.normalize(await chrome.storage.local.get(Settings.keys));
      if (settings.strength === "basic") return;
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
