(() => {
  "use strict";

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
      refreshButton: root.querySelector("#refresh-button"),
      collapseButton: root.querySelector("#collapse-button"),
      searchInput: root.querySelector("#search-input"),
      status: root.querySelector("#status"),
      count: root.querySelector("#count"),
      captionList: root.querySelector("#caption-list"),
      copyButton: root.querySelector("#copy-button"),
      downloadSrtButton: root.querySelector("#download-srt-button"),
      downloadTxtButton: root.querySelector("#download-txt-button")
    };

    if (Object.values(elements).some((element) => !element)) {
      mountedRoots.delete(root);
      throw new Error("Caption Lite panel markup is incomplete");
    }

  let activeTabId = null;
  let currentState = null;
  let currentTrackId = "";
  let currentTimeMs = 0;
  let activeRow = null;
  let autoScrollActive = true;
  let autoScrollResumeTimer = null;
  let collapsed = false;

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function getSelectedTrack() {
    const tracks = currentState?.tracks || [];
    return tracks.find((track) => track.id === currentTrackId) || tracks[0] || null;
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

  function renderCaptions() {
    const track = getSelectedTrack();
    const query = elements.searchInput.value.trim().toLocaleLowerCase();
    const captions = track?.captions || [];
    const visibleCaptions = query
      ? captions.filter((caption) => caption.text.toLocaleLowerCase().includes(query))
      : captions;

    elements.captionList.replaceChildren();
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
        heading.addEventListener("click", () => {
          if (activeTabId == null) return;
          sendMessage({ type: "SEEK", tabId: activeTabId, startMs: chapter.startMs });
        });
        elements.captionList.append(heading);
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
      text.textContent = caption.text;

      row.append(time, text);
      row.addEventListener("click", () => {
        if (activeTabId == null) return;
        sendMessage({ type: "SEEK", tabId: activeTabId, startMs: caption.startMs });
      });
      elements.captionList.append(row);
    });

    elements.count.textContent = captions.length
      ? query
        ? `显示 ${visibleCaptions.length} / ${captions.length} 条`
        : `共 ${captions.length} 条字幕`
      : "";
    const enabled = captions.length > 0;
    elements.copyButton.disabled = !enabled;
    elements.downloadSrtButton.disabled = !enabled;
    elements.downloadTxtButton.disabled = !enabled;
    highlightCurrentCaption();
  }

  function renderState() {
    const state = currentState;
    elements.videoTitle.textContent = state?.title || "等待视频";
    elements.sourceBadge.textContent = state?.source === "youtube"
      ? "YouTube"
      : state?.source === "bilibili"
        ? "Bilibili"
        : "本地";
    elements.status.textContent = state?.message
      || (state?.status === "ready" ? "字幕已读取。点击任意字幕可跳转。" : "打开支持的视频后再试。");
    renderTrackOptions();
    renderCaptions();
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
      activeRow = nextRow;
      activeRow?.classList.add("active");
    }
    if (activeRow && autoScrollActive && (changed || forceScroll)) {
      const rowRect = activeRow.getBoundingClientRect();
      const listRect = elements.captionList.getBoundingClientRect();
      elements.captionList.scrollTo({
        top: elements.captionList.scrollTop
          + rowRect.top
          - listRect.top
          - (listRect.height - rowRect.height) / 2,
        behavior: "smooth"
      });
    }
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
    currentState = response?.state ?? null;
    renderState();
  }

  elements.trackSelect.addEventListener("change", () => {
    currentTrackId = elements.trackSelect.value;
    renderCaptions();
  });
  const pauseAutoScrollTemporarily = () => {
    autoScrollActive = false;
    clearTimeout(autoScrollResumeTimer);
    autoScrollResumeTimer = setTimeout(() => {
      autoScrollActive = true;
      autoScrollResumeTimer = null;
      highlightCurrentCaption(true);
    }, 3000);
  };
  const wheelTarget = embedded && root.host ? root.host : root;
  const handleWheel = (event) => {
    pauseAutoScrollTemporarily();
    if (!embedded || collapsed) return;
    event.stopPropagation();
    if (!event.deltaY) return;
    if (!event.composedPath().includes(elements.captionList)) {
      event.preventDefault();
      elements.captionList.scrollTop += event.deltaY;
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
  elements.searchInput.addEventListener("input", renderCaptions);
  elements.refreshButton.addEventListener("click", () => {
    if (activeTabId == null) return;
    elements.status.textContent = "正在刷新……";
    sendMessage({ type: "REFRESH_CAPTIONS", tabId: activeTabId });
  });
  elements.collapseButton.addEventListener("click", () => {
    if (!embedded) return;
    collapsed = !collapsed;
    root.querySelector(".caption-lite-app")?.classList.toggle("collapsed", collapsed);
    elements.collapseButton.textContent = collapsed ? "⌄" : "⌃";
    elements.collapseButton.title = collapsed ? "展开字幕" : "折叠字幕";
    elements.collapseButton.setAttribute("aria-label", elements.collapseButton.title);
    elements.collapseButton.setAttribute("aria-expanded", String(!collapsed));
    onCollapsedChange?.(collapsed);
  });
  elements.copyButton.addEventListener("click", async () => {
    const captions = getSelectedTrack()?.captions || [];
    const copied = await copyText(captions
      .map((caption) => `[${formatClock(caption.startMs)}] ${caption.text}`)
      .join("\n"));
    elements.status.textContent = copied ? "字幕已复制（含时间戳）。" : "复制失败，请使用下载 TXT。";
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
      renderState();
    }
    if (message?.type === "PLAYBACK_BROADCAST" && message.tabId === activeTabId) {
      currentTimeMs = message.currentMs;
      highlightCurrentCaption();
    }
  };
  if (!embedded) chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  loadActiveState();

    return {
      setState(state) {
        currentState = state;
        renderState();
      },
      setPlayback(currentMs) {
        currentTimeMs = currentMs;
        highlightCurrentCaption();
      },
      dispose() {
        mountedRoots.delete(root);
        clearTimeout(autoScrollResumeTimer);
        wheelTarget.removeEventListener("wheel", handleWheel, true);
        if (!embedded) chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      }
    };
  }

  globalThis.CaptionLitePanel = { mount };
  if (document.body?.hasAttribute("data-caption-lite-panel")) mount(document);
})();
