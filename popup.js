const Settings = ImageFilterSettings;
const toggle = document.getElementById("enabled");
const status = document.getElementById("status");
const reload = document.getElementById("reload");
const mode = document.getElementById("site-mode");
const sites = document.getElementById("sites");
const sitesLabel = document.getElementById("sites-label");
const currentSite = document.getElementById("current-site");
const siteStatus = document.getElementById("site-status");
const addCurrent = document.getElementById("add-current");
const saveSites = document.getElementById("save-sites");
const temporaryTab = document.getElementById("temporary-tab");
const controls = [toggle, mode, sites, addCurrent, saveSites, reload, temporaryTab];
let temporarilyAllowed = false;
let settings;
let tab;
let host = "";

function render() {
  toggle.checked = settings.enabled;
  mode.value = settings.siteMode;
  sites.value = settings.sites.join("\n");
  sitesLabel.textContent = settings.siteMode === "only" ? "屏蔽的网站" : "不屏蔽的网站";
  status.textContent = settings.enabled ? "图片屏蔽已开启" : "图片屏蔽已暂停，网站规则已保留";
  currentSite.textContent = host || "当前页面不支持网站规则";
  siteStatus.textContent = host
    ? `本站：${temporarilyAllowed ? "当前标签页已临时放行" : Settings.shouldBlock(settings, host) ? "屏蔽图片" : "正常显示图片"}（以刷新后为准）` : "";
  controls.forEach(control => { control.disabled = false; });
  reload.disabled = !tab?.id;
  temporaryTab.disabled = !host || !tab?.id;
  temporaryTab.textContent = temporarilyAllowed ? "取消当前标签页临时放行" : "临时放行当前标签页";
  updateAddButton();
}

function updateAddButton() {
  let listed = false;
  try { listed = Settings.matches(host, Settings.parseSites(sites.value)); } catch { /* Validate on save. */ }
  addCurrent.disabled = !host || listed;
  addCurrent.textContent = listed ? "当前网站已被列表覆盖" : "添加当前网站到列表";
}

function readForm() {
  return { enabled: toggle.checked, siteMode: mode.value, sites: Settings.parseSites(sites.value) };
}

async function save(addHost = false) {
  let next;
  try {
    next = readForm();
    if (addHost && host && !Settings.matches(host, next.sites)) next.sites.push(host);
    next.sites = Settings.parseSites(next.sites.join("\n"));
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  controls.forEach(control => { control.disabled = true; });
  status.textContent = "正在保存并应用…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "saveImageSettings", settings: next });
    if (!result?.ok) throw new Error(result?.error || "保存失败，请重试");
    settings = Settings.normalize(result.settings);
    render();
    status.textContent = "设置已保存，请刷新网页以完整应用";
  } catch (error) {
    // A storage write may have succeeded even if applying the network rule failed.
    try { settings = Settings.normalize(await chrome.storage.local.get(Settings.keys)); } catch { /* Keep the last known settings. */ }
    render();
    sites.value = next.sites.join("\n");
    updateAddButton();
    status.textContent = error.message;
  }
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
  render();
}).catch(() => { status.textContent = "读取设置失败，请重新打开插件。"; });

toggle.addEventListener("change", () => save());
mode.addEventListener("change", () => save());
sites.addEventListener("input", updateAddButton);
saveSites.addEventListener("click", () => save());
addCurrent.addEventListener("click", () => save(true));

temporaryTab.addEventListener("click", async () => {
  controls.forEach(control => { control.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({ type: "setTemporaryTabState", tabId: tab.id, allowed: !temporarilyAllowed });
    if (!result?.ok) throw new Error(result?.error || "无法修改临时放行状态");
    temporarilyAllowed = result.allowed;
    render();
    await chrome.tabs.reload(tab.id);
    status.textContent = temporarilyAllowed ? "已临时放行当前标签页并刷新" : "已取消临时放行并刷新";
  } catch (error) {
    render();
    status.textContent = `${error.message}。如状态已改变，请手动刷新网页。`;
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
    status.textContent = "无法刷新，请手动刷新当前网页。";
    reload.disabled = false;
  }
});
