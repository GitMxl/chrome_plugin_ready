const Settings = ImageFilterSettings;
const toggle = document.getElementById("enabled");
const status = document.getElementById("status");
const reload = document.getElementById("reload");
const mode = document.getElementById("site-mode");
const strength = document.getElementById("strength");
const siteStrength = document.getElementById("site-strength");
const layout = document.getElementById("layout");
const sites = document.getElementById("sites");
const sitesLabel = document.getElementById("sites-label");
const sitesCount = document.getElementById("sites-count");
const listState = document.getElementById("list-state");
const currentSite = document.getElementById("current-site");
const siteStatus = document.getElementById("site-status");
const addCurrent = document.getElementById("add-current");
const saveSites = document.getElementById("save-sites");
const saveReload = document.getElementById("save-reload");
const refreshDiagnostic = document.getElementById("refresh-diagnostic");
const temporaryTab = document.getElementById("temporary-tab");
const controls = [toggle, mode, strength, siteStrength, layout, sites, addCurrent, saveSites, saveReload, reload, temporaryTab, refreshDiagnostic];
let busy = false;
let temporarilyAllowed = false;
let settings;
let tab;
let host = "";

async function loadDiagnostics(initial = false) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getImageDiagnostics", tabId: tab?.id });
    if (!result?.ok) throw new Error(result?.error || "读取诊断失败");
    const p = result.policy;
    if (initial) { host = p.host; temporarilyAllowed = result.temporaryAllowed; }
    const text = (id, value) => { document.getElementById(`diagnostic-${id}`).textContent = value; };
    text("host", p.host || "不支持或尚未连接页面");
    text("reason", `${p.label}：${p.reason}`);
    text("match", p.matchedSite || "未命中任何列表条目");
    text("strength", `${p.strength === "basic" ? "普通" : "严格"} · ${p.strengthSite || "默认设置"}`);
    text("network", result.networkApplied ? "已应用保存的规则" : "与保存的设置不一致，请重新保存");
    text("page", !result.pageConnected ? "未连接页面脚本，请刷新网页" : result.pageApplied ? "与保存的规则一致" : "尚未完整应用，请刷新网页");
    text("exceptions", `${result.imageExceptions} 条（仅当前标签页）`);
    text("summary", !p.host ? "不支持或未连接" : result.networkApplied && result.pageApplied ? "状态一致" : "需要检查");
  } catch (error) {
    document.getElementById("diagnostic-summary").textContent = error.message;
  }
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.className = error ? "notice error" : "notice";
}

function render() {
  toggle.checked = settings.enabled;
  mode.value = settings.siteMode;
  strength.value = settings.strength;
  siteStrength.value = settings.siteStrengths[host] || "inherit";
  layout.value = settings.layout;
  sites.value = settings.sites.join("\n");
  sitesLabel.textContent = settings.siteMode === "only" ? "屏蔽的网站" : "不屏蔽的网站";
  setStatus(settings.enabled ? "图片屏蔽已开启" : "图片屏蔽已暂停，网站规则已保留");
  currentSite.textContent = host || "当前页面不支持网站规则";
  siteStatus.textContent = host
    ? `本站：${temporarilyAllowed ? "当前标签页已临时放行" : Settings.shouldBlock(settings, host) ? "屏蔽图片" : "正常显示图片"}（以刷新后为准）` : "";
  siteStatus.className = temporarilyAllowed || !Settings.shouldBlock(settings, host) ? "site-status allowed" : "site-status";
  controls.forEach(control => { control.disabled = false; });
  siteStrength.disabled = !host;
  if (host) siteStatus.textContent += `；生效强度：${Settings.strengthFor(settings, host) === "basic" ? "普通" : "严格"}`;
  reload.disabled = !tab?.id;
  saveReload.disabled = !host || !tab?.id;
  refreshDiagnostic.disabled = !tab?.id;
  temporaryTab.disabled = !host || !tab?.id;
  temporaryTab.textContent = temporarilyAllowed ? "取消当前标签页临时放行" : "临时放行当前标签页";
  updateAddButton();
}

function updateAddButton() {
  let listed = false;
  try {
    const draft = Settings.parseSites(sites.value);
    listed = Settings.matches(host, draft);
    sitesCount.textContent = `${draft.length} / 500`;
    const dirty = JSON.stringify(draft) !== JSON.stringify(settings.sites);
    listState.textContent = dirty ? "列表有修改，尚未保存" : "列表已保存";
    listState.className = dirty ? "list-state pending" : "list-state";
    sites.ariaInvalid = "false";
  } catch (error) {
    sitesCount.textContent = "请检查输入";
    listState.textContent = error.message;
    listState.className = "list-state error";
    sites.ariaInvalid = "true";
  }
  addCurrent.disabled = !host || listed;
  addCurrent.textContent = listed ? "当前网站已被列表覆盖" : "添加当前网站到列表";
}

function readForm() {
  const siteStrengths = { ...settings.siteStrengths };
  if (host) {
    if (siteStrength.value === "inherit") delete siteStrengths[host];
    else siteStrengths[host] = siteStrength.value;
  }
  if (Object.keys(siteStrengths).length > 500) throw new Error("最多保存 500 个网站强度设置");
  return { enabled: toggle.checked, siteMode: mode.value, strength: strength.value, layout: layout.value, sites: Settings.parseSites(sites.value), siteStrengths };
}

async function save(addHost = false, reloadAfter = false) {
  if (busy) return;
  let next;
  try {
    next = readForm();
    if (reloadAfter && (!host || !tab?.id)) throw new Error("当前页面不支持保存并刷新");
    if (addHost && host && !Settings.matches(host, next.sites)) next.sites.push(host);
    next.sites = Settings.parseSites(next.sites.join("\n"));
  } catch (error) {
    updateAddButton();
    setStatus(error.message, true);
    return;
  }
  controls.forEach(control => { control.disabled = true; });
  busy = true;
  setStatus("正在保存并应用…");
  let saved = false;
  let message;
  let failed = false;
  try {
    const result = await chrome.runtime.sendMessage({ type: "saveImageSettings", settings: next });
    if (!result?.ok) throw new Error(result?.error || "保存失败，请重试");
    settings = Settings.normalize(result.settings);
    saved = true;
    await loadDiagnostics();
    if (reloadAfter) await chrome.tabs.reload(tab.id);
    message = reloadAfter ? "设置已保存并刷新当前网页" : "设置已保存，请刷新网页以完整应用";
  } catch (error) {
    // A storage write may have succeeded even if applying the network rule failed.
    try { settings = Settings.normalize(await chrome.storage.local.get(Settings.keys)); } catch { /* Keep the last known settings. */ }
    failed = true;
    message = saved ? "设置已保存，但刷新失败，请手动刷新网页" : error.message;
  }
  busy = false;
  render();
  if (failed && !saved) { sites.value = next.sites.join("\n"); updateAddButton(); }
  if (saved && reloadAfter && !failed) document.getElementById("diagnostic-page").textContent = "网页正在刷新，完成后可重新诊断";
  setStatus(message, failed);
}

Promise.all([
  chrome.storage.local.get(Settings.keys),
  chrome.tabs.query({ active: true, currentWindow: true })
]).then(async ([value, tabs]) => {
  settings = Settings.normalize(value);
  tab = tabs[0];
  host = Settings.hostname(tab?.url);
  if (host && tab?.id) {
    const result = await chrome.runtime.sendMessage({ type: "getTemporaryTabState", tabId: tab.id });
    if (!result?.ok) throw new Error(result?.error || "读取临时放行状态失败");
    temporarilyAllowed = result.allowed === true;
  }
  if (tab?.id) await loadDiagnostics(true);
  render();
}).catch(() => { setStatus("读取设置失败，请重新打开插件。", true); });

toggle.addEventListener("change", () => save());
mode.addEventListener("change", () => save());
strength.addEventListener("change", () => save());
siteStrength.addEventListener("change", () => save());
layout.addEventListener("change", () => save());
sites.addEventListener("input", updateAddButton);
saveSites.addEventListener("click", () => save());
saveReload.addEventListener("click", () => save(false, true));
refreshDiagnostic.addEventListener("click", async () => {
  refreshDiagnostic.disabled = true;
  await loadDiagnostics();
  refreshDiagnostic.disabled = false;
});
addCurrent.addEventListener("click", () => save(true));

temporaryTab.addEventListener("click", async () => {
  controls.forEach(control => { control.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({ type: "setTemporaryTabState", tabId: tab.id, allowed: !temporarilyAllowed });
    if (!result?.ok) throw new Error(result?.error || "无法修改临时放行状态");
    temporarilyAllowed = result.allowed;
    await loadDiagnostics();
    render();
    await chrome.tabs.reload(tab.id);
    setStatus(temporarilyAllowed ? "已临时放行当前标签页并刷新" : "已取消临时放行并刷新");
  } catch (error) {
    render();
    setStatus(`${error.message}。如状态已改变，请手动刷新网页。`, true);
  }
});

reload.addEventListener("click", async () => {
  reload.disabled = true;
  try {
    if (!tab?.id) throw new Error("没有当前网页");
    // Use the tab whose hostname is shown, even if the user changes active tabs.
    await chrome.tabs.reload(tab.id);
    window.close();
  } catch {
    setStatus("无法刷新，请手动刷新当前网页。", true);
    reload.disabled = false;
  }
});
