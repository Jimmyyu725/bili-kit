(() => {
  "use strict";

  const GRID = ".recommended-container_floor-aside > .container";
  const CARDS = ":scope > .feed-card, :scope > .floor-single-card, :scope > .bili-feed-card, :scope > .bili-video-card";
  const OWN = "#caption-lite-home-nav, #caption-lite-home-history";

  function safeUrl(value, image = false) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, "https://www.bilibili.com/");
      const host = url.hostname;
      const allowed = image
        ? host === "hdslb.com" || host.endsWith(".hdslb.com")
        : ["www.bilibili.com", "bilibili.com", "live.bilibili.com", "space.bilibili.com"].includes(host);
      if (!allowed || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
      url.protocol = "https:";
      if (!image) { url.search = ""; url.hash = ""; }
      return url.href;
    } catch { return ""; }
  }

  function isAdCard(card) {
    return Boolean(card.querySelector(".bili-video-card__info--ad, .bili-video-card__info--ad-tag"))
      || [...card.querySelectorAll("a[href]")].some((link) => {
        try { return new URL(link.getAttribute("href"), "https://www.bilibili.com").hostname === "cm.bilibili.com"; }
        catch { return false; }
      });
  }

  function readCard(card) {
    if (isAdCard(card)) return null;
    const title = card.querySelector(".bili-video-card__info--tit a, a.font-medium");
    const url = safeUrl(title?.getAttribute("href") || "");
    if (!url || !title?.textContent.trim()) return null;
    const image = card.querySelector("picture img, img");
    const owner = card.querySelector(".bili-video-card__info--owner, a.sub-title");
    return {
      title: title.textContent.trim().slice(0, 300), url,
      cover: safeUrl(image?.getAttribute("src") || image?.getAttribute("data-src") || "", true),
      owner: owner?.textContent.trim().slice(0, 120) || "",
      ownerUrl: safeUrl(owner?.getAttribute("href") || ""),
      duration: card.querySelector(".bili-video-card__stats__duration")?.textContent.trim() || ""
    };
  }

  const fingerprint = (cards) => cards.map((card) => card.url).join("\n");

  function createHistory(limit = 10) {
    let entries = [];
    let cursor = -1;
    return {
      record(before, after) {
        if (!before.length || !after.length) return false;
        if (fingerprint(before) === fingerprint(after)) return false;
        entries = entries.slice(0, cursor + 1);
        if (!entries.length) entries.push(before);
        else entries[entries.length - 1] = before;
        entries = [...entries, after].slice(-limit - 1);
        cursor = entries.length - 1;
        return true;
      },
      undo(live) {
        if (cursor <= 0) return null;
        if (cursor === entries.length - 1) entries[cursor] = live;
        return entries[--cursor];
      },
      redo() {
        if (cursor >= 0 && cursor < entries.length - 1) cursor++;
        return this.current;
      },
      latest() { cursor = entries.length - 1; },
      get current() { return cursor >= 0 && cursor < entries.length - 1 ? entries[cursor] : null; },
      get count() { return Math.max(0, cursor); },
      get viewing() { return this.current !== null; }
    };
  }

  function mount(doc) {
    const win = doc.defaultView;
    const history = createHistory();
    let grid = null;
    let navigation = null;
    let historyView = null;
    let undoButton, nextButton, status;
    let pending = null;
    let settleTimer = null;
    let refreshTimer = null;
    let scanTimer = null;
    let disposed = false;
    let notice = "";

    function node(tag, className, text) {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    }
    function snapshot() {
      return grid ? [...grid.querySelectorAll(CARDS)].map(readCard).filter(Boolean).slice(0, 100) : [];
    }
    function updateControls() {
      if (!navigation) return;
      undoButton.disabled = Boolean(pending) || !history.count;
      nextButton.disabled = Boolean(pending) || !history.viewing;
      const text = pending ? "正在换一换…" : notice || (history.viewing ? "正在查看之前的推荐" : `可撤回 ${history.count} 次 · 仅保留本页`);
      if (status.textContent !== text) status.textContent = text;
    }
    function applyFilters() {
      doc.documentElement.classList.add("caption-lite-home", "cl-home-hide-ads", "cl-home-hide-promotions");
    }
    function renderHistory(cards) {
      historyView?.remove();
      historyView = null;
      grid?.classList.toggle("cl-home-history-active", Boolean(cards));
      if (!cards || !grid) return;
      historyView = node("div");
      historyView.id = "caption-lite-home-history";
      historyView.setAttribute("aria-label", "之前的首页推荐");
      for (const card of cards) {
        const item = node("article", "cl-home-card");
        const coverLink = node("a", "cl-home-cover");
        coverLink.href = card.url;
        coverLink.target = "_blank";
        coverLink.rel = "noopener noreferrer";
        coverLink.setAttribute("aria-label", card.title);
        if (card.cover) {
          const image = node("img");
          image.src = card.cover;
          image.alt = "";
          image.loading = "lazy";
          coverLink.append(image);
        }
        if (card.duration) coverLink.append(node("span", "cl-home-duration", card.duration));
        const title = node("a", "cl-home-title", card.title);
        title.href = card.url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
        const owner = node(card.ownerUrl ? "a" : "span", "cl-home-owner", card.owner);
        if (card.ownerUrl) { owner.href = card.ownerUrl; owner.target = "_blank"; owner.rel = "noopener noreferrer"; }
        item.append(coverLink, title, owner);
        historyView.append(item);
      }
      grid.append(historyView);
    }
    function makeNavigation() {
      navigation = node("div");
      navigation.id = "caption-lite-home-nav";
      navigation.setAttribute("role", "group");
      navigation.setAttribute("aria-label", "推荐历史");
      undoButton = node("button", "", "←");
      undoButton.type = "button";
      undoButton.title = "上一批推荐";
      undoButton.setAttribute("aria-label", undoButton.title);
      undoButton.addEventListener("click", () => {
        if (pending) return;
        const cards = history.undo(snapshot());
        if (!cards) return;
        notice = "";
        renderHistory(cards);
        updateControls();
      });
      nextButton = node("button", "", "→");
      nextButton.type = "button";
      nextButton.title = "下一批推荐";
      nextButton.setAttribute("aria-label", nextButton.title);
      nextButton.addEventListener("click", () => {
        if (pending || !history.viewing) return;
        history.redo();
        notice = "";
        renderHistory(history.current);
        updateControls();
      });
      status = node("span", "cl-home-status");
      status.setAttribute("role", "status");
      navigation.append(undoButton, nextButton, status);
      updateControls();
    }
    function finishRefresh() {
      const after = snapshot();
      if (!pending || !after.length || fingerprint(after) === pending.nativeKey) return;
      if (!history.record(pending.before, after)) history.latest();
      pending = null;
      renderHistory(null);
      win.clearTimeout(refreshTimer);
      notice = "";
      updateControls();
    }
    function scan() {
      scanTimer = null;
      if (disposed) return;
      const nextGrid = doc.querySelector(GRID);
      if (!nextGrid) return;
      if (grid !== nextGrid) {
        grid?.classList.remove("cl-home-history-active");
        grid = nextGrid;
      }
      const refreshButton = grid.parentElement.querySelector(".feed-roll-btn .roll-btn");
      if (refreshButton) {
        if (!navigation) makeNavigation();
        if (refreshButton.nextElementSibling !== navigation) refreshButton.after(navigation);
      }
      for (const card of grid.querySelectorAll(CARDS)) {
        card.toggleAttribute("data-caption-lite-ad", isAdCard(card));
      }
      if (!pending && history.viewing && !historyView?.isConnected) renderHistory(history.current);
      if (pending) {
        win.clearTimeout(settleTimer);
        settleTimer = win.setTimeout(finishRefresh, 400);
      }
    }
    function onRefresh(event) {
      const button = event.target.closest?.(".feed-roll-btn .roll-btn");
      if (!button || !grid || !button.closest(".recommended-container_floor-aside")) return;
      if (pending) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const live = snapshot();
      const before = history.current || live;
      if (!before.length) return;
      const nativeKey = fingerprint(live);
      renderHistory(null);
      pending = { before, nativeKey };
      updateControls();
      refreshTimer = win.setTimeout(() => {
        finishRefresh();
        if (!pending) return;
        pending = null;
        renderHistory(history.current);
        notice = "暂未收到新推荐，可再次换一换";
        updateControls();
      }, 8000);
    }
    const observer = new win.MutationObserver((records) => {
      if (records.every((record) => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(OWN))) return;
      if (scanTimer === null) scanTimer = win.setTimeout(scan, 80);
    });
    applyFilters();
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    doc.addEventListener("click", onRefresh, true);
    scan();
    return {
      dispose() {
        disposed = true;
        observer.disconnect();
        for (const timer of [scanTimer, settleTimer, refreshTimer]) win.clearTimeout(timer);
        doc.removeEventListener("click", onRefresh, true);
        grid?.classList.remove("cl-home-history-active");
        doc.querySelectorAll("[data-caption-lite-ad]").forEach((card) => card.removeAttribute("data-caption-lite-ad"));
        navigation?.remove();
        historyView?.remove();
        doc.documentElement.classList.remove("caption-lite-home", "cl-home-hide-ads", "cl-home-hide-promotions");
      }
    };
  }

  globalThis.CaptionLiteHome = { safeUrl, isAdCard, readCard, createHistory, mount };
  if (typeof document !== "undefined" && ["www.bilibili.com", "bilibili.com"].includes(location.hostname)
      && ["/", "/index.html"].includes(location.pathname)) mount(document);
})();
