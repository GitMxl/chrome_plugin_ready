(() => {
  const keys = ["enabled", "siteMode", "sites", "strength", "layout"];
  const maxSites = 500;

  function normalizeSite(value) {
    const input = String(value).trim().replace(/^\*\./, "");
    if (!input || /\s/.test(input)) throw new Error(`无效的网站：${value}`);
    let url;
    try {
      url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      throw new Error(`无效的网站：${value}`);
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        host.length > 253 || !host.split(".").every(label =>
          /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) {
      throw new Error(`无效的网站：${value}，请输入域名或 HTTP/HTTPS 网址`);
    }
    return host;
  }

  function parseSites(text) {
    const sites = [...new Set(String(text).split(/[\s,，;；]+/).filter(Boolean).map(normalizeSite))];
    if (sites.length > maxSites) throw new Error(`最多保存 ${maxSites} 个网站`);
    return sites;
  }

  function normalize(value = {}) {
    const sites = [];
    for (const site of Array.isArray(value.sites) ? value.sites : []) {
      try {
        const host = normalizeSite(site);
        if (!sites.includes(host) && sites.length < maxSites) sites.push(host);
      } catch { /* Ignore corrupt stored entries instead of disabling all rules. */ }
    }
    return { enabled: value.enabled !== false, siteMode: value.siteMode === "only" ? "only" : "exclude", sites,
      strength: value.strength === "basic" ? "basic" : "strict",
      layout: value.layout === "collapse" ? "collapse" : "preserve" };
  }

  function hostname(url) {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol)
        ? parsed.hostname.toLowerCase().replace(/\.$/, "") : "";
    } catch { return ""; }
  }

  function matches(host, sites) {
    return sites.some(site => host === site || host.endsWith(`.${site}`));
  }

  function shouldBlock(settings, host) {
    if (!settings.enabled) return false;
    const listed = matches(host, settings.sites);
    return settings.siteMode === "only" ? listed : !listed;
  }

  function rules(settings) {
    // Network image requests do not distinguish inline content from CSS icons.
    if (!settings.enabled || settings.strength === "basic" || (settings.siteMode === "only" && !settings.sites.length)) return [];
    const condition = { urlFilter: "*", resourceTypes: ["image"] };
    if (settings.sites.length) {
      // Match the top-level website, not the image CDN or an embedded frame.
      condition[settings.siteMode === "only" ? "topDomains" : "excludedTopDomains"] = settings.sites;
    }
    return [{ id: 1, priority: 1, action: { type: "block" }, condition }];
  }

  globalThis.ImageFilterSettings = Object.freeze({ keys, normalizeSite, parseSites, normalize, hostname, matches, shouldBlock, rules });
})();
