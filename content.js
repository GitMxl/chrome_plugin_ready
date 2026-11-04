(() => {
  // Visibility preserves layout and suppresses broken-image icons and alt text.
  // The universal rules also cover dynamically added elements and pseudo-elements.
  const basicCss = `
    img:not([data-image-filter-revealed]) {
      visibility: hidden !important;
    }
  `;
  const strictCss = basicCss + `
    input[type="image"], svg image { visibility: hidden !important; }
    *, *::before, *::after, *::marker {
      background-image: none !important;
      border-image-source: none !important;
      list-style-image: none !important;
      mask-image: none !important;
      -webkit-mask-image: none !important;
    }
    *::before, *::after { content: none !important; }
  `;
  // Resolve the top-level site's policy before hiding anything in an allowed site.
  let enabled = false;
  let strength = "strict";
  let layout = "preserve";
  const roots = new Map();

  function addStyle(root) {
    let style = roots.get(root);
    if (!style) {
      style = document.createElement("style");
      roots.set(root, style);
    }
    const collapseSelector = strength === "basic" ? 'img:not([data-image-filter-revealed])' : 'img:not([data-image-filter-revealed]), input[type="image"], svg image';
    const css = (strength === "basic" ? basicCss : strictCss) +
      (layout === "collapse" ? `${collapseSelector} { display: none !important; }` : "");
    if (style.textContent !== css) style.textContent = css;
    const parent = root === document ? document.documentElement : root;
    if (enabled && parent && style.parentNode !== parent) parent.appendChild(style);
    if (!enabled) style.remove();
  }

  function inspect(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.shadowRoot) watch(node.shadowRoot);
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot) watch(element.shadowRoot);
    }
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) inspect(node);
    }
    for (const root of roots.keys()) {
      if (root !== document && !root.host.isConnected) {
        roots.get(root).remove();
        roots.delete(root);
      } else {
        addStyle(root);
      }
    }
  });

  function watch(root) {
    if (roots.has(root)) return;
    addStyle(root);
    ImageRevealControls.watch(root);
    observer.observe(root, { childList: true, subtree: true });
    if (root === document) {
      if (document.documentElement) inspect(document.documentElement);
    } else {
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) watch(element.shadowRoot);
      }
    }
  }

  function setEnabled(value, nextStrength, nextLayout) {
    enabled = value !== false;
    strength = nextStrength === "basic" ? "basic" : "strict";
    layout = nextLayout === "collapse" ? "collapse" : "preserve";
    ImageRevealControls.setEnabled(enabled, layout);
    for (const root of roots.keys()) addStyle(root);
  }

  watch(document);
  // Discard stale replies if a setting changes while a request is in flight.
  let revision = 0;
  let policyReady = false;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "getImageFilterState") {
      respond({ url: location.href, enabled, strength, layout, ready: policyReady });
    }
  });
  async function refreshPolicy() {
    const current = ++revision;
    try {
      const policy = await chrome.runtime.sendMessage({ type: "getImagePolicy" });
      if (current === revision && typeof policy?.enabled === "boolean") {
        setEnabled(policy.enabled, policy.strength, policy.layout);
        policyReady = true;
      }
    } catch (error) {
      console.error("无法读取图片屏蔽设置", error);
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ImageFilterSettings.keys.some(key => key in changes)) refreshPolicy();
  });
  refreshPolicy();
})();
