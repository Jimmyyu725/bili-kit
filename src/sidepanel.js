(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-3.6-3.6"],
    refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
    settings: ["M20 7h-9", "M14 17H5", "M17 14a3 3 0 1 0 0 6a3 3 0 0 0 0-6z", "M7 4a3 3 0 1 0 0 6a3 3 0 0 0 0-6z"],
    "chevron-up": ["M18 15l-6-6-6 6"],
    "chevron-down": ["M6 9l6 6 6-6"],
    "arrow-up": ["M12 19V5", "M5 12l7-7 7 7"],
    "arrow-down": ["M12 5v14", "M19 12l-7 7-7-7"],
    copy: [
      "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
      "M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"
    ],
    download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
    message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    sparkles: ["M11 5Q11.7 12.3 19 13Q11.7 13.7 11 21Q10.3 13.7 3 13Q10.3 12.3 11 5Z", "M19 3v4", "M17 5h4"],
    captions: [
      "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
      "M7 15h4",
      "M15 15h2",
      "M7 11h2",
      "M13 11h4"
    ],
    alert: ["M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z", "M12 8v4.5", "M12 16h.01"],
    loader: ["M12 3a9 9 0 1 0 9 9"]
  };
  const FONT_SIZES = [14, 16, 18];
  const FONT_SIZE_STORAGE = "panelFontSize";
  const AI_PRICE_PER_MINUTE = 0.0045;

  const mountedRoots = new WeakSet();

  function mount(root = document, { embedded = false, onCollapsedChange = null } = {}) {
    if (mountedRoots.has(root)) return null;
    mountedRoots.add(root);

    const doc = root.ownerDocument || root;
    const {
      formatSrt,
      sanitizeFileName
    } = globalThis.CaptionLiteParsers;

    const elements = {
      videoTitle: root.querySelector("#video-title"),
      sourceBadge: root.querySelector("#source-badge"),
      trackSelect: root.querySelector("#track-select"),
      fontButton: root.querySelector("#font-button"),
      refreshButton: root.querySelector("#refresh-button"),
      settingsButton: root.querySelector("#settings-button"),
      collapseButton: root.querySelector("#collapse-button"),
      searchInput: root.querySelector("#search-input"),
      count: root.querySelector("#count"),
      banner: root.querySelector("#banner"),
      bannerIcon: root.querySelector("#banner-icon"),
      bannerText: root.querySelector("#banner-text"),
      bannerAction: root.querySelector("#banner-action"),
      bannerBar: root.querySelector("#banner-bar"),
      captionList: root.querySelector("#caption-list"),
      emptyState: root.querySelector("#empty-state"),
      emptyIcon: root.querySelector("#empty-icon"),
      emptyTitle: root.querySelector("#empty-title"),
      emptyText: root.querySelector("#empty-text"),
      emptyProgress: root.querySelector("#empty-progress"),
      emptyBar: root.querySelector("#empty-bar"),
      emptyAction: root.querySelector("#empty-action"),
      emptyNote: root.querySelector("#empty-note"),
      commentTraffic: root.querySelector("#comment-traffic"),
      followButton: root.querySelector("#follow-button"),
      followIcon: root.querySelector("#follow-icon"),
      toast: root.querySelector("#toast"),
      copyCommentsButton: root.querySelector("#copy-comments-button"),
      copyCommentsLabel: root.querySelector("#copy-comments-label"),
      copyButton: root.querySelector("#copy-button"),
      downloadSrtButton: root.querySelector("#download-srt-button"),
      downloadTxtButton: root.querySelector("#download-txt-button")
    };

    if (Object.values(elements).some((element) => !element)) {
      mountedRoots.delete(root);
      throw new Error("Bili Kit panel markup is incomplete");
    }

    const app = root.querySelector(".caption-lite-app") || doc.body;
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let activeTabId = null;
    let currentState = null;
    let currentTrackId = "";
    let currentTimeMs = 0;
    let activeRow = null;
    let following = true;
    let collapsed = false;
    let fontSize = 16;
    let toastTimer = null;
    let emptyActionType = "";
    let bannerActionType = "";
    let commentCopyState = {
      status: "idle",
      count: 0,
      message: "",
      canCopy: false,
      canRetry: false,
      complete: false,
      limitReached: false
    };

    function sendMessage(message) {
      return chrome.runtime.sendMessage(message).catch(() => null);
    }

    function createIcon(name) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("icon");
      for (const data of ICONS[name] || []) {
        const path = doc.createElementNS(SVG_NS, "path");
        path.setAttribute("d", data);
        svg.append(path);
      }
      return svg;
    }

    function setIcon(element, name, spinning = false) {
      if (element.dataset.icon === name && element.firstChild) return;
      element.dataset.icon = name;
      const icon = createIcon(name);
      icon.classList.toggle("spin", spinning);
      element.replaceChildren(icon);
    }

    function showToast(message) {
      if (!message) return;
      elements.toast.textContent = message;
      elements.toast.classList.add("visible");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2400);
    }

    function getSelectedTrack() {
      const tracks = currentState?.tracks || [];
      return tracks.find((track) => track.id === currentTrackId) || tracks[0] || null;
    }

    function getCommentCopyButtonLabel() {
      if (commentCopyState.limitReached) return `复制 ${commentCopyState.count} 条（上限）`;
      if (commentCopyState.complete) return `复制全部 ${commentCopyState.count} 条`;
      if (commentCopyState.count > 0) return `复制当前 ${commentCopyState.count} 条`;
      return "正在加载评论…";
    }

    function renderCommentCopyButton() {
      const visible = currentState?.source === "bilibili";
      elements.copyCommentsButton.hidden = !visible;
      const traffic = globalThis.CaptionLiteCommentTraffic.describe(commentCopyState.traffic);
      elements.commentTraffic.hidden = !visible || !commentCopyState.traffic;
      elements.commentTraffic.textContent = traffic.text;
      elements.commentTraffic.title = traffic.title;
      if (!visible) return;
      const loading = !commentCopyState.complete && !commentCopyState.limitReached
        && commentCopyState.status !== "error";
      elements.copyCommentsButton.disabled = activeTabId == null || !commentCopyState.canCopy;
      elements.copyCommentsButton.title = [getCommentCopyButtonLabel(), traffic.title].filter(Boolean).join("\n\n");
      elements.copyCommentsButton.setAttribute("aria-label", `评论：${getCommentCopyButtonLabel()}`);
      elements.copyCommentsLabel.textContent = commentCopyState.count > 0
        ? `评论 ${commentCopyState.count}${commentCopyState.limitReached ? "+" : ""}`
        : "评论";
      const iconHolder = elements.copyCommentsButton.querySelector("[data-icon]");
      if (iconHolder) setIcon(iconHolder, loading ? "loader" : "message", loading);
    }

    function normalizeCommentCopyState(state = {}) {
      const value = state && typeof state === "object" ? state : {};
      return {
        status: value.status || "idle",
        count: Math.max(0, Number(value.count) || 0),
        message: String(value.message || ""),
        canCopy: Boolean(value.canCopy),
        canRetry: Boolean(value.canRetry),
        complete: Boolean(value.complete),
        limitReached: Boolean(value.limitReached),
        traffic: globalThis.CaptionLiteCommentTraffic.normalize(value.traffic)
      };
    }

    function setCommentCopyState(state = {}) {
      const previousMessage = commentCopyState.message;
      commentCopyState = normalizeCommentCopyState(state);
      renderCommentCopyButton();
      // Progress stays on the button; only copy results and failures interrupt.
      const { message, status } = commentCopyState;
      if (message && message !== previousMessage && (status === "error" || message.includes("复制"))) {
        showToast(message);
      }
    }

    function formatClock(milliseconds) {
      const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return hours
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    // What to say about AI transcription for the current Bilibili video, or null.
    function getAiView() {
      const ai = currentState?.source === "bilibili" ? currentState.ai : null;
      if (!ai) return null;
      const percent = Math.round(Math.min(1, Math.max(0, Number(ai.progress) || 0)) * 100);
      if (ai.status === "running") {
        return {
          tone: "ai",
          icon: "sparkles",
          title: "正在转写…",
          text: ai.message || `已完成 ${percent}%`,
          brief: `AI 转写中 ${percent}%`,
          progress: percent / 100,
          action: "取消",
          actionType: "CANCEL_AI_TRANSCRIBE",
          quiet: true
        };
      }
      if (ai.status === "paused") {
        return {
          tone: "ai",
          icon: "sparkles",
          title: "转写已暂停",
          text: `已完成 ${percent}%，继续时不会重复计费。`,
          brief: `转写已暂停 ${percent}%`,
          progress: percent / 100,
          action: "继续",
          actionType: "START_AI_TRANSCRIBE"
        };
      }
      if (ai.status === "needs-key") {
        return {
          tone: "ai",
          icon: "settings",
          title: "需要 OpenAI API Key",
          text: ai.message || "在设置页填入 Key 后会自动开始转写。",
          brief: "需要 OpenAI API Key",
          action: "打开设置",
          actionType: "OPEN_OPTIONS"
        };
      }
      if (ai.status === "error") {
        return {
          tone: "error",
          icon: "alert",
          title: "转写失败",
          text: ai.message || "请稍后重试。",
          brief: ai.message || "转写失败",
          action: "重试",
          actionType: "START_AI_TRANSCRIBE"
        };
      }
      if (ai.status === "idle" && currentState.status === "empty") {
        const seconds = Number(ai.durationSeconds) || 0;
        const cost = Math.max(0.01, seconds / 60 * AI_PRICE_PER_MINUTE);
        return {
          tone: "ai",
          icon: "sparkles",
          title: "这个视频没有字幕",
          text: currentState.needLogin
            ? "登录 Bilibili 后可能会有官方字幕；也可以直接用 gpt-transcribe 转写。"
            : "用 gpt-transcribe 把语音转写成带时间轴的字幕。",
          note: [
            seconds ? `${formatClock(seconds * 1000)} · 约 $${cost.toFixed(2)}` : "",
            "音频会发送到 OpenAI"
          ].filter(Boolean).join(" · "),
          action: "AI 转写字幕",
          actionType: "START_AI_TRANSCRIBE"
        };
      }
      return null;
    }

    function runAction(type) {
      if (type === "OPEN_OPTIONS") {
        sendMessage({ type });
        return;
      }
      if (activeTabId == null) return;
      if (type === "REFRESH_CAPTIONS") showToast("正在重新读取字幕…");
      sendMessage({ type, tabId: activeTabId });
    }

    function renderTrackOptions() {
      const tracks = currentState?.tracks || [];
      const previousTrackId = currentTrackId;
      elements.trackSelect.replaceChildren();

      tracks.forEach((track) => {
        const option = doc.createElement("option");
        option.value = track.id;
        option.textContent = track.label || track.language || track.id;
        elements.trackSelect.append(option);
      });

      currentTrackId = tracks.some((track) => track.id === previousTrackId)
        ? previousTrackId
        : tracks[0]?.id || "";
      elements.trackSelect.value = currentTrackId;
      elements.trackSelect.disabled = tracks.length < 2;
    }

    function appendHighlighted(element, text, query) {
      if (!query) {
        element.textContent = text;
        return;
      }
      const lower = text.toLocaleLowerCase();
      let cursor = 0;
      for (let index = lower.indexOf(query); index !== -1; index = lower.indexOf(query, cursor)) {
        element.append(text.slice(cursor, index));
        const mark = doc.createElement("mark");
        mark.textContent = text.slice(index, index + query.length);
        element.append(mark);
        cursor = index + query.length;
      }
      element.append(text.slice(cursor));
    }

    function renderSkeleton() {
      const rows = [72, 94, 58, 86, 66, 90, 48].map((width) => {
        const row = doc.createElement("div");
        row.className = "skeleton";
        const time = doc.createElement("i");
        const text = doc.createElement("i");
        text.style.width = `${width}%`;
        row.append(time, text);
        return row;
      });
      elements.captionList.replaceChildren(...rows);
    }

    function renderEmptyState(view) {
      elements.emptyState.hidden = !view;
      if (!view) return;
      elements.emptyState.dataset.tone = view.tone || "";
      setIcon(elements.emptyIcon, view.icon);
      elements.emptyTitle.textContent = view.title;
      elements.emptyText.textContent = view.text || "";
      elements.emptyNote.textContent = view.note || "";
      elements.emptyProgress.hidden = view.progress == null;
      elements.emptyBar.style.setProperty("--progress", String(view.progress || 0));
      elements.emptyAction.hidden = !view.action;
      elements.emptyAction.textContent = view.action || "";
      elements.emptyAction.classList.toggle("quiet", Boolean(view.quiet));
      emptyActionType = view.actionType || "";
    }

    function renderBanner(view) {
      elements.banner.hidden = !view;
      if (!view) return;
      elements.banner.dataset.tone = view.tone || "";
      setIcon(elements.bannerIcon, view.icon);
      elements.bannerText.textContent = view.brief;
      elements.bannerText.title = view.brief;
      elements.bannerBar.style.setProperty("--progress", String(view.progress || 0));
      elements.bannerAction.textContent = view.action;
      bannerActionType = view.actionType;
    }

    // Shown in place of the list when the selected track has nothing to show.
    function getPlaceholder(query) {
      if (query) {
        return { icon: "search", title: "没有匹配的字幕", text: `没有包含“${query}”的字幕。` };
      }
      const ai = getAiView();
      if (ai) return ai;
      const state = currentState;
      if (state?.status === "error") {
        return {
          tone: "error",
          icon: "alert",
          title: "字幕读取失败",
          text: state.message || "",
          action: "重试",
          actionType: "REFRESH_CAPTIONS",
          quiet: true
        };
      }
      if (state?.status === "empty") {
        return { icon: "captions", title: "这个视频没有字幕", text: state.message || "" };
      }
      return {
        icon: "captions",
        title: "等待视频",
        text: state?.message || "打开 YouTube 或 Bilibili 视频后，字幕会显示在这里。"
      };
    }

    function renderCaptions() {
      const track = getSelectedTrack();
      const query = elements.searchInput.value.trim().toLocaleLowerCase();
      const captions = track?.captions || [];
      const visibleCaptions = query
        ? captions.filter((caption) => caption.text.toLocaleLowerCase().includes(query))
        : captions;

      const scrollTop = elements.captionList.scrollTop;
      const rows = [];
      activeRow = null;
      const chapters = currentState?.chapters || [];
      let previousChapterIndex = -2;

      visibleCaptions.forEach((caption) => {
        const chapterIndex = chapters.findLastIndex((chapter) => chapter.startMs <= caption.startMs);
        if (chapterIndex >= 0 && chapterIndex !== previousChapterIndex) {
          const chapter = chapters[chapterIndex];
          const heading = doc.createElement("button");
          heading.type = "button";
          heading.className = "chapter-row";
          const chapterTitle = doc.createElement("span");
          chapterTitle.textContent = chapter.title;
          const chapterTime = doc.createElement("time");
          chapterTime.textContent = formatClock(chapter.startMs);
          heading.append(chapterTitle, chapterTime);
          heading.addEventListener("click", () => seekTo(chapter.startMs));
          rows.push(heading);
        }
        previousChapterIndex = chapterIndex;

        const row = doc.createElement("button");
        row.type = "button";
        row.className = "caption-row";
        row.dataset.startMs = String(caption.startMs);
        row.dataset.endMs = String(caption.endMs);

        const time = doc.createElement("span");
        time.className = "time";
        time.textContent = formatClock(caption.startMs);

        const text = doc.createElement("span");
        text.className = "text";
        appendHighlighted(text, caption.text, query);

        row.append(time, text);
        row.addEventListener("click", () => seekTo(caption.startMs));
        rows.push(row);
      });

      if (!captions.length && currentState?.status === "loading") {
        renderSkeleton();
        renderEmptyState(null);
      } else {
        elements.captionList.replaceChildren(...rows);
        elements.captionList.scrollTop = scrollTop;
        renderEmptyState(visibleCaptions.length ? null : getPlaceholder(captions.length ? query : ""));
      }

      // While captions are on screen, a running or stalled transcription moves to the banner.
      const ai = captions.length ? getAiView() : null;
      renderBanner(ai?.brief ? ai : null);

      elements.count.textContent = captions.length
        ? query
          ? `${visibleCaptions.length} / ${captions.length}`
          : `${captions.length} 条`
        : "";
      const enabled = captions.length > 0;
      elements.copyButton.disabled = !enabled;
      elements.downloadSrtButton.disabled = !enabled;
      elements.downloadTxtButton.disabled = !enabled;
      highlightCurrentCaption();
    }

    function renderState() {
      const state = currentState;
      elements.videoTitle.parentElement.hidden = !state?.source;
      elements.videoTitle.textContent = state?.title || "";
      elements.sourceBadge.textContent = state?.source === "youtube"
        ? "YouTube"
        : state?.source === "bilibili"
          ? "Bilibili"
          : "本地";
      renderTrackOptions();
      renderCaptions();
      renderCommentCopyButton();
    }

    function seekTo(startMs) {
      if (activeTabId == null) return;
      following = true;
      sendMessage({ type: "SEEK", tabId: activeTabId, startMs });
    }

    function scrollToActive() {
      if (!activeRow) return;
      const rowRect = activeRow.getBoundingClientRect();
      const listRect = elements.captionList.getBoundingClientRect();
      elements.captionList.scrollTo({
        top: elements.captionList.scrollTop
          + rowRect.top
          - listRect.top
          - (listRect.height - rowRect.height) * 0.4,
        behavior: reducedMotion ? "auto" : "smooth"
      });
    }

    function renderFollowButton() {
      const visible = !following && Boolean(activeRow) && !collapsed;
      elements.followButton.hidden = !visible;
      if (!visible) return;
      const above = activeRow.getBoundingClientRect().top < elements.captionList.getBoundingClientRect().top;
      setIcon(elements.followIcon, above ? "arrow-up" : "arrow-down");
    }

    function highlightCurrentCaption(forceScroll = false) {
      const rows = [...elements.captionList.querySelectorAll(".caption-row")];
      const nextRow = rows.find((row) => {
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        return currentTimeMs >= startMs && currentTimeMs < endMs;
      }) || null;

      const changed = nextRow !== activeRow;
      if (changed) {
        activeRow?.classList.remove("active");
        activeRow?.removeAttribute("aria-current");
        activeRow = nextRow;
        activeRow?.classList.add("active");
        activeRow?.setAttribute("aria-current", "true");
      }
      if (activeRow && following && (changed || forceScroll)) scrollToActive();
      renderFollowButton();
    }

    // Scrolling by hand stops the list from following playback until asked back.
    function stopFollowing() {
      if (!following) return;
      following = false;
      renderFollowButton();
    }

    function applyFontSize(size) {
      fontSize = FONT_SIZES.includes(size) ? size : 16;
      app.style.setProperty("--caption-size", `${fontSize}px`);
    }

    function download(extension, content) {
      const track = getSelectedTrack();
      if (!track) return;
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const link = doc.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${sanitizeFileName(currentState?.title)}-${sanitizeFileName(track.label)}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    async function copyText(value) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        // Fall through to the user-gesture copy method.
      }

      const textarea = doc.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:fixed;left:-9999px;top:0";
      doc.body.append(textarea);
      textarea.select();
      const copied = doc.execCommand("copy");
      textarea.remove();
      return copied;
    }

    async function loadActiveState() {
      const response = await sendMessage({ type: "GET_ACTIVE_STATE" });
      activeTabId = response?.tabId ?? null;
      if (!embedded) commentCopyState = normalizeCommentCopyState(response?.commentCopyState);
      if (!embedded || response?.state) {
        currentState = response?.state ?? null;
        renderState();
      }
    }

    root.querySelectorAll("[data-icon]").forEach((element) => {
      element.replaceChildren(createIcon(element.dataset.icon));
    });

    elements.trackSelect.addEventListener("change", () => {
      currentTrackId = elements.trackSelect.value;
      renderCaptions();
    });

    const wheelTarget = embedded && root.host ? root.host : root;
    const handleWheel = (event) => {
      if (event.composedPath().includes(elements.captionList)) stopFollowing();
      if (!embedded || collapsed) return;
      event.stopPropagation();
      if (!event.deltaY) return;
      if (!event.composedPath().includes(elements.captionList)) {
        event.preventDefault();
        elements.captionList.scrollTop += event.deltaY;
        stopFollowing();
        return;
      }
      const atTop = elements.captionList.scrollTop <= 0;
      const atBottom = elements.captionList.scrollTop + elements.captionList.clientHeight
        >= elements.captionList.scrollHeight - 1;
      if ((atTop && event.deltaY < 0) || (atBottom && event.deltaY > 0)) {
        event.preventDefault();
      }
    };
    wheelTarget.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    elements.captionList.addEventListener("touchmove", stopFollowing, { passive: true });
    elements.captionList.addEventListener("pointerdown", (event) => {
      // A press on the list itself (not a row) is the scrollbar.
      if (event.target === elements.captionList) stopFollowing();
    });
    elements.captionList.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) stopFollowing();
    });
    elements.captionList.addEventListener("scroll", renderFollowButton, { passive: true });

    // Keep the site's own keyboard shortcuts from firing while typing in the panel.
    const stopKeys = (event) => event.stopPropagation();
    if (embedded) {
      ["keydown", "keyup", "keypress"].forEach((type) => root.addEventListener(type, stopKeys));
    }

    elements.searchInput.addEventListener("input", renderCaptions);
    elements.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !elements.searchInput.value) return;
      elements.searchInput.value = "";
      renderCaptions();
    });
    elements.refreshButton.addEventListener("click", () => runAction("REFRESH_CAPTIONS"));
    elements.settingsButton.addEventListener("click", () => runAction("OPEN_OPTIONS"));
    elements.fontButton.addEventListener("click", () => {
      applyFontSize(FONT_SIZES[(FONT_SIZES.indexOf(fontSize) + 1) % FONT_SIZES.length]);
      chrome.storage.local.set({ [FONT_SIZE_STORAGE]: fontSize }).catch(() => {});
      highlightCurrentCaption(true);
    });
    elements.collapseButton.addEventListener("click", () => {
      if (!embedded) return;
      collapsed = !collapsed;
      app.classList.toggle("collapsed", collapsed);
      setIcon(elements.collapseButton.querySelector("[data-icon]"), collapsed ? "chevron-down" : "chevron-up");
      elements.collapseButton.title = collapsed ? "展开字幕" : "折叠字幕";
      elements.collapseButton.setAttribute("aria-label", elements.collapseButton.title);
      elements.collapseButton.setAttribute("aria-expanded", String(!collapsed));
      onCollapsedChange?.(collapsed);
      if (!collapsed) highlightCurrentCaption(true);
    });
    elements.followButton.addEventListener("click", () => {
      following = true;
      highlightCurrentCaption(true);
    });
    elements.emptyAction.addEventListener("click", () => runAction(emptyActionType));
    elements.bannerAction.addEventListener("click", () => runAction(bannerActionType));
    elements.copyButton.addEventListener("click", async () => {
      const captions = getSelectedTrack()?.captions || [];
      const copied = await copyText(captions
        .map((caption) => `[${formatClock(caption.startMs)}] ${caption.text}`)
        .join("\n"));
      showToast(copied ? `已复制 ${captions.length} 条字幕（含时间戳）` : "复制失败，请改用下载 TXT");
    });
    elements.copyCommentsButton.addEventListener("click", async () => {
      if (activeTabId == null) return;
      const response = await sendMessage({
        type: "COPY_BILIBILI_COMMENTS",
        tabId: activeTabId
      });
      if (!response?.success) {
        setCommentCopyState({
          ...commentCopyState,
          status: "error",
          message: response?.error || "无法开始读取评论。"
        });
      }
    });
    elements.downloadSrtButton.addEventListener("click", () => {
      download("srt", formatSrt(getSelectedTrack()?.captions || []));
    });
    elements.downloadTxtButton.addEventListener("click", () => {
      download("txt", (getSelectedTrack()?.captions || []).map((caption) => caption.text).join("\n"));
    });

    const handleRuntimeMessage = (message) => {
      if (message?.type === "CAPTIONS_BROADCAST" && message.tabId === activeTabId) {
        currentState = message.state;
        renderState();
      }
      if (message?.type === "ACTIVE_TAB_STATE") {
        activeTabId = message.tabId;
        currentState = message.state;
        currentTrackId = "";
        following = true;
        commentCopyState = normalizeCommentCopyState(message.commentCopyState);
        renderState();
      }
      if (message?.type === "COMMENTS_COPY_STATE" && message.tabId === activeTabId) {
        setCommentCopyState(message.state);
      }
      if (message?.type === "PLAYBACK_BROADCAST" && message.tabId === activeTabId) {
        currentTimeMs = message.currentMs;
        highlightCurrentCaption();
      }
    };
    if (!embedded) chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    chrome.storage.local.get(FONT_SIZE_STORAGE)
      .then((stored) => applyFontSize(Number(stored[FONT_SIZE_STORAGE])))
      .catch(() => {});
    renderState();
    loadActiveState();

    return {
      setState(state) {
        if (state?.videoId !== currentState?.videoId) following = true;
        currentState = state;
        renderState();
      },
      setPlayback(currentMs) {
        currentTimeMs = currentMs;
        highlightCurrentCaption();
      },
      setCommentCopyState,
      setTheme(theme) {
        if (theme) app.dataset.theme = theme;
        else delete app.dataset.theme;
      },
      dispose() {
        mountedRoots.delete(root);
        clearTimeout(toastTimer);
        wheelTarget.removeEventListener("wheel", handleWheel, true);
        if (!embedded) chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      }
    };
  }

  globalThis.CaptionLitePanel = { mount };
  if (document.body?.hasAttribute("data-caption-lite-panel")) mount(document);
})();
