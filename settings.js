(() => {
  const keys = ["enabled", "siteMode", "sites", "strength", "layout", "siteStrengths"];
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
    const siteStrengths = Object.create(null);
    for (const [site, strength] of Object.entries(value.siteStrengths && typeof value.siteStrengths === "object" ? value.siteStrengths : {}).slice(0, maxSites)) {
      try {
        if (["basic", "strict"].includes(strength)) siteStrengths[normalizeSite(site)] = strength;
      } catch { /* Ignore invalid stored overrides. */ }
    }
    return { enabled: value.enabled !== false, siteMode: value.siteMode === "only" ? "only" : "exclude", sites, siteStrengths,
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
    if (!settings.enabled || (settings.siteMode === "only" && !settings.sites.length)) return [];
    const overrides = Object.entries(settings.siteStrengths || {});
    const result = [];
    const condition = { urlFilter: "*", resourceTypes: ["image"] };
    if (settings.sites.length) {
      // Match the top-level website, not the image CDN or an embedded frame.
      condition[settings.siteMode === "only" ? "topDomains" : "excludedTopDomains"] = settings.sites;
    }
    if (settings.strength === "strict") {
      condition.excludedTopDomains = [...new Set([...(condition.excludedTopDomains || []), ...overrides.map(([site]) => site)])];
      if (!condition.excludedTopDomains.length) delete condition.excludedTopDomains;
      result.push({ id: 1, priority: 1, action: { type: "block" }, condition });
    }
    overrides.forEach(([site, strength], index) => {
      if (strength !== "strict") return;
      let domains = [site];
      if (settings.siteMode === "only") domains = settings.sites.flatMap(listed =>
        matches(site, [listed]) ? [site] : matches(listed, [site]) ? [listed] : []);
      if (!domains.length) return;
      const excluded = [...new Set([
        ...(settings.siteMode === "exclude" ? settings.sites : []),
        ...overrides.filter(([child]) => child !== site && matches(child, [site])).map(([child]) => child)
      ])];
      const condition = { urlFilter: "*", resourceTypes: ["image"], topDomains: [...new Set(domains)] };
      if (excluded.length) condition.excludedTopDomains = excluded;
      result.push({ id: index + 2, priority: 1, action: { type: "block" }, condition });
    });
    return result;
  }

  function strengthFor(settings, host) {
    const site = Object.keys(settings.siteStrengths || {}).filter(site => matches(host, [site]))
      .sort((a, b) => b.length - a.length)[0];
    return site ? settings.siteStrengths[site] : settings.strength;
  }

  globalThis.ImageFilterSettings = Object.freeze({ keys, normalizeSite, parseSites, normalize, hostname, matches, shouldBlock, rules, strengthFor });
})();
