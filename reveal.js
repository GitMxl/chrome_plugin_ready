(() => {
  const roots = new Set();
  const buttons = new Map();
  const anchors = new Map();
  let enabled = false;
  let layout = "preserve";
  let scheduled = false;
  let panel;
  let host;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }
  const resize = new ResizeObserver(schedule);
  const observer = new MutationObserver(schedule);

  function removeAnchor(image) {
    const anchor = anchors.get(image);
    if (!anchor) return;
    resize.unobserve(anchor);
    anchor.remove();
    anchors.delete(image);
  }

  function createPanel() {
    if (panel || !document.documentElement) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;visibility:visible!important;";
    panel = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `button { position:fixed; box-sizing:border-box; pointer-events:auto;
      border:1px solid #94a3b8; border-radius:4px; background:#f1f5f9; color:#334155;
      font:12px/1.3 system-ui,sans-serif; cursor:pointer; padding:2px; overflow:hidden; }
      button:focus-visible { outline:3px solid #2563eb; }`;
    panel.appendChild(style);
    document.documentElement.appendChild(host);
  }

  async function reveal(image, button) {
    button.disabled = true;
    button.textContent = "加载中…";
    try {
      const url = image.currentSrc || image.src;
      if (!url) throw new Error("图片尚无地址，请稍后重试");
      const result = await chrome.runtime.sendMessage({ type: "revealImage", url });
      if (!result?.ok) throw new Error(result?.error || "无法显示图片，请重试");
      // Freeze the selected responsive candidate so only the approved URL loads.
      const picture = image.parentElement?.tagName === "PICTURE" ? image.parentElement : null;
      const sources = picture ? [...picture.querySelectorAll("source")] : [];
      const attributes = [image, ...sources].map(element => [element, element.getAttribute("srcset")]);
      for (const [element] of attributes) element.removeAttribute("srcset");
      image.setAttribute("data-image-filter-revealed", "");
      removeAnchor(image);
      image.style.setProperty("visibility", "visible", "important");
      image.loading = "eager";
      // Assigning src again retries requests previously rejected by the blocker.
      button.remove();
      buttons.delete(image);
      resize.unobserve(image);
      const restore = () => {
        image.removeEventListener("load", restore);
        image.removeEventListener("error", failed);
        // Keep the selected candidate for this document; restoring srcset could
        // immediately request a different (still blocked) responsive image.
      };
      const failed = () => {
        restore();
        image.removeAttribute("data-image-filter-revealed");
        image.style.removeProperty("visibility");
        for (const [element, value] of attributes) {
          if (value !== null) element.setAttribute("srcset", value);
        }
        schedule();
      };
      image.addEventListener("load", restore, { once: true });
      image.addEventListener("error", failed, { once: true });
      image.src = url;
    } catch (error) {
      button.disabled = false;
      button.textContent = "重试";
      button.title = error.message;
      button.setAttribute("aria-label", error.message + "，点击重试");
    }
  }

  function update() {
    scheduled = false;
    for (const [image, button] of buttons) {
      if (!enabled || !image.isConnected || image.hasAttribute("data-image-filter-revealed")) {
        button.remove();
        removeAnchor(image);
        resize.unobserve(image);
        buttons.delete(image);
      }
    }
    if (!enabled) return;
    createPanel();
    if (!panel) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    for (const root of roots) {
      if (root !== document && !root.host.isConnected) { roots.delete(root); continue; }
      for (const image of root.querySelectorAll("img:not([data-image-filter-revealed])")) {
        if (!buttons.has(image)) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "显示图片";
          button.title = image.alt ? `显示图片：${image.alt}` : "仅显示这张图片";
          button.setAttribute("aria-label", button.title);
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); reveal(image, button); });
          panel.appendChild(button);
          buttons.set(image, button);
          resize.observe(image);
        }
      }
    }
    for (const [image, button] of buttons) {
      const description = (image.alt || "").trim().replace(/\s+/g, " ");
      if (!button.disabled) {
        const label = description ? `显示图片：${description}` : "显示图片";
        if (button.textContent !== label) button.textContent = label;
        button.title = description ? `显示图片：${description}` : "仅显示这张图片";
        button.setAttribute("aria-label", button.title);
      }
      let target = image;
      if (layout === "collapse") {
        let anchor = anchors.get(image);
        if (!anchor) {
          anchor = document.createElement("span");
          anchor.setAttribute("aria-hidden", "true");
          anchor.setAttribute("data-image-filter-anchor", "");
          anchor.style.cssText = "all:initial!important;display:inline-block!important;width:76px!important;height:24px!important;margin:0!important;padding:0!important;border:0!important;vertical-align:middle!important;pointer-events:none!important;visibility:hidden!important;";
          anchors.set(image, anchor);
          resize.observe(anchor);
        }
        if (anchor.parentNode !== image.parentNode || anchor.nextSibling !== image) image.before(anchor);
        const width = description ? "220px" : "76px";
        const height = description ? "48px" : "24px";
        if (anchor.style.width !== width) anchor.style.setProperty("width", width, "important");
        if (anchor.style.height !== height) anchor.style.setProperty("height", height, "important");
        target = anchor;
      } else {
        removeAnchor(image);
      }
      const rect = target.getBoundingClientRect();
      const visible = target.getClientRects().length && rect.bottom >= 0 && rect.right >= 0 && rect.top < innerHeight && rect.left < innerWidth;
      button.hidden = !visible;
      if (visible) {
        button.style.left = `${Math.max(0, rect.left)}px`;
        button.style.top = `${Math.max(0, rect.top)}px`;
        button.style.width = `${Math.max(32, Math.min(rect.width || 72, description ? 240 : 120))}px`;
        button.style.height = `${Math.max(24, Math.min(rect.height || 28, description ? 64 : 36))}px`;
      }
    }
  }
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  globalThis.ImageRevealControls = {
    watch(root) {
      roots.add(root);
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "alt", "class", "style", "hidden"] });
      schedule();
    },
    setEnabled(value, nextLayout) { enabled = value; layout = nextLayout; schedule(); }
  };
})();
