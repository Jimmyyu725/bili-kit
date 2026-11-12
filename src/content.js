(() => {
  "use strict";

  const {
    parseYouTubePayload,
    parseBilibiliJson,
    parseBilibiliChapters
  } = globalThis.CaptionLiteParsers;

  const PAGE_SOURCE = "caption-lite-page";
  const EXTENSION_SOURCE = "caption-lite-extension";
  const youtubeTracks = new Map();
  let youtubeChapters = [];

  let currentYouTubeVideoId = "";
  let currentBilibiliPageKey = "";
  let bilibiliPayloadId = 0;
  let bilibiliRetryTimer = null;
  let bilibiliRetryPageKey = "";
  let bilibiliRetryDelay = 1500;
  let lastUrl = location.href;
  let boundVideo = null;
  let lastPlaybackSentAt = 0;
  let latestState = null;
  let latestPlaybackMs = 0;
  let latestCommentCopyState = {
    status: "idle",
    count: 0,
    message: "",
    canCopy: false,
    canRetry: false,
    complete: false,
    limitReached: false
  };
  let embedRoot = null;
  let embeddedPanel = null;
  let observedPlayer = null;
  let playerResizeObserver = null;
  let embeddedPanelCollapsed = false;
  let paddedBilibiliContainer = null;
  let originalBilibiliPaddingTop = "";
  let paddedYouTubeSidebar = null;
  let originalSidebarPaddingTop = "";
  let embeddedTheme = "";
  // What Bilibili itself offers for the current page, before AI captions are merged in.
  let bilibiliBase = null;
  let bilibiliSilentRetry = false;
  let aiState = { status: "idle", progress: 0, message: "", captions: [] };
  let aiController = null;
  let aiChunkCache = new Map();
  let aiPublishTimer = null;
  const COLLAPSED_PANEL_HEIGHT = 99;
  const BILIBILI_MAX_RETRY_DELAY = 10_000;
  const AI_TRACK_ID = "ai:gpt-transcribe";
  const AI_TRANSCRIPT_PREFIX = "ai-transcript:";
  const AI_TRANSCRIPT_INDEX = "ai-transcript-index";
  const AI_TRANSCRIPT_LIMIT = 40;
  const AI_PUBLISH_INTERVAL = 800;

  function sendRuntimeMessage(message) {
    if (!chrome.runtime?.id) return Promise.resolve();
    return chrome.runtime.sendMessage(message).catch(() => {});
  }

  function publishState(state) {
    latestState = {
      url: location.href,
      title: document.title,
      updatedAt: Date.now(),
      ...state
    };
    embeddedPanel?.setState(latestState);
    return sendRuntimeMessage({
      type: "CAPTIONS_UPDATED",
      state: latestState
    });
  }

  function publishCommentCopyState(state) {
    latestCommentCopyState = {
      status: state?.status || "idle",
      count: Math.max(0, Number(state?.count) || 0),
      message: String(state?.message || ""),
      canCopy: Boolean(state?.canCopy),
      canRetry: Boolean(state?.canRetry),
      complete: Boolean(state?.complete),
      limitReached: Boolean(state?.limitReached)
    };
    embeddedPanel?.setCommentCopyState(latestCommentCopyState);
    return sendRuntimeMessage({
      type: "COMMENTS_COPY_STATE",
      state: latestCommentCopyState
    });
  }

  async function copyCommentText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the content-script copy method.
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      textarea.remove();
    }
    return copied;
  }

  function getYouTubeVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get("v")
      || url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/)?.[1]
      || "";
  }

  function getBilibiliIdentity() {
    const url = new URL(location.href);
    const videoId = url.pathname.match(/\/video\/(BV[^/?]+|av\d+)/i)?.[1];
    if (!videoId) return null;
    const pageNumber = Math.max(1, Number(url.searchParams.get("p")) || 1);
    return { videoId, pageNumber, pageKey: `${videoId}:${pageNumber}` };
  }

  const commentCopyController = globalThis.CaptionLiteCommentCopy.createController({
    getPageKey: () => getBilibiliIdentity()?.pageKey || "",
    loadComments: (pageKey, { signal, onSnapshot, onRetry }) => {
      const identity = getBilibiliIdentity();
      if (!identity || identity.pageKey !== pageKey) {
        return Promise.resolve({ pageKey, error: "当前 Bilibili 视频已变化" });
      }
      return globalThis.CaptionLiteBilibiliCommentLoader.loadAllComments({
        pageKey,
        videoId: identity.videoId,
        signal,
        isCurrent: () => !signal.aborted && getBilibiliIdentity()?.pageKey === pageKey,
        onSnapshot,
        onRetry
      });
    },
    copyText: copyCommentText,
    publishState: publishCommentCopyState
  });

  function publishBilibili() {
    if (!bilibiliBase) return Promise.resolve();
    const tracks = aiState.captions.length
      ? [...bilibiliBase.tracks, { id: AI_TRACK_ID, language: "ai", label: "AI 转写", captions: aiState.captions }]
      : bilibiliBase.tracks;
    return publishState({
      ...bilibiliBase,
      status: tracks.length ? "ready" : bilibiliBase.status,
      message: tracks.length ? "" : bilibiliBase.message,
      tracks,
      ai: {
        status: aiState.status,
        progress: aiState.progress,
        message: aiState.message,
        durationSeconds: bilibiliBase.durationSeconds || 0
      }
    });
  }

  function setAi(patch) {
    clearTimeout(aiPublishTimer);
    aiPublishTimer = null;
    aiState = { ...aiState, ...patch };
    return publishBilibili();
  }

  function resetAi() {
    aiController?.abort();
    aiController = null;
    clearTimeout(aiPublishTimer);
    aiPublishTimer = null;
    aiChunkCache = new Map();
    aiState = { status: "idle", progress: 0, message: "", captions: [] };
    bilibiliBase = null;
  }

  // Finished transcripts are kept locally so reopening a video costs nothing.
  async function restoreAiTranscript(pageKey) {
    const key = `${AI_TRANSCRIPT_PREFIX}${pageKey}`;
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    const captions = stored[key]?.captions;
    if (!Array.isArray(captions) || !captions.length) return;
    if (currentBilibiliPageKey !== pageKey || aiState.status !== "idle") return;
    setAi({ status: "done", progress: 1, captions });
  }

  async function saveAiTranscript(pageKey, captions) {
    const key = `${AI_TRANSCRIPT_PREFIX}${pageKey}`;
    const stored = await chrome.storage.local.get(AI_TRANSCRIPT_INDEX);
    const known = Array.isArray(stored[AI_TRANSCRIPT_INDEX]) ? stored[AI_TRANSCRIPT_INDEX] : [];
    const index = [...known.filter((item) => item !== key), key];
    const expired = index.splice(0, Math.max(0, index.length - AI_TRANSCRIPT_LIMIT));
    await chrome.storage.local.remove(expired);
    await chrome.storage.local.set({
      [key]: { captions, savedAt: Date.now() },
      [AI_TRANSCRIPT_INDEX]: index
    });
  }

  async function startAiTranscription() {
    const identity = getBilibiliIdentity();
    if (!identity || aiState.status === "running" || aiState.status === "done") return;
    const { pageKey } = identity;
    const controller = new AbortController();
    aiController = controller;
    const isCurrent = () => aiController === controller && getBilibiliIdentity()?.pageKey === pageKey;

    const response = await sendRuntimeMessage({ type: "AI_HAS_KEY" });
    if (!isCurrent()) return;
    if (!response?.hasKey) {
      setAi({ status: "needs-key", message: "" });
      sendRuntimeMessage({ type: "OPEN_OPTIONS" });
      return;
    }

    setAi({ status: "running", message: aiState.captions.length ? "" : "正在读取音频…" });
    try {
      const result = await globalThis.CaptionLiteBilibiliTranscriber.transcribe({
        videoId: identity.videoId,
        pageNumber: identity.pageNumber,
        signal: controller.signal,
        cache: aiChunkCache,
        onProgress: ({ doneSeconds, totalSeconds, captions }) => {
          if (!isCurrent()) return;
          aiState = {
            ...aiState,
            progress: totalSeconds ? doneSeconds / totalSeconds : 0,
            message: doneSeconds ? "" : "正在读取音频…",
            captions
          };
          aiPublishTimer ||= setTimeout(() => {
            aiPublishTimer = null;
            publishBilibili();
          }, AI_PUBLISH_INTERVAL);
        }
      });
      if (!isCurrent()) return;
      if (!result.captions.length) {
        setAi({ status: "error", progress: 0, message: "没有识别到语音内容。" });
        return;
      }
      setAi({ status: "done", progress: 1, message: "", captions: result.captions });
      saveAiTranscript(pageKey, result.captions).catch(() => {});
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      const needsKey = error?.code === "NO_KEY" || error?.code === "BAD_KEY";
      setAi({
        status: needsKey ? "needs-key" : "error",
        message: error instanceof Error ? error.message : "未知错误"
      });
      if (needsKey) sendRuntimeMessage({ type: "OPEN_OPTIONS" });
    }
  }

  function cancelAiTranscription() {
    if (aiState.status !== "running") return;
    aiController?.abort();
    aiController = null;
    setAi({ status: aiState.captions.length ? "paused" : "idle", message: "" });
  }

  function resetBilibiliRetry(pageKey = "") {
    clearTimeout(bilibiliRetryTimer);
    bilibiliRetryTimer = null;
    bilibiliRetryPageKey = pageKey;
    bilibiliRetryDelay = 1500;
  }

  function scheduleBilibiliRetry(pageKey) {
    if (pageKey !== bilibiliRetryPageKey) resetBilibiliRetry(pageKey);
    if (bilibiliRetryTimer) return;
    bilibiliRetryTimer = setTimeout(() => {
      bilibiliRetryTimer = null;
      if (getBilibiliIdentity()?.pageKey !== pageKey) return;
      bilibiliRetryDelay = Math.min(Math.round(bilibiliRetryDelay * 1.6), BILIBILI_MAX_RETRY_DELAY);
      loadBilibili(true, true);
    }, bilibiliRetryDelay);
  }

  // `silent` re-checks for captions in the background without disturbing the panel.
  function loadBilibili(force = false, silent = false) {
    const identity = getBilibiliIdentity();
    if (!identity) {
      resetBilibiliRetry();
      if (currentBilibiliPageKey) {
        currentBilibiliPageKey = "";
        commentCopyController.invalidate();
        resetAi();
      }
      return;
    }
    if (!force && identity.pageKey === currentBilibiliPageKey) return;
    const pageChanged = identity.pageKey !== currentBilibiliPageKey;
    if (pageChanged) {
      commentCopyController.invalidate();
      resetAi();
    }
    if (identity.pageKey !== bilibiliRetryPageKey) resetBilibiliRetry(identity.pageKey);
    clearTimeout(bilibiliRetryTimer);
    bilibiliRetryTimer = null;
    currentBilibiliPageKey = identity.pageKey;
    commentCopyController.startLoading().catch((error) => {
      publishCommentCopyState({
        status: "error",
        message: `评论读取失败：${error instanceof Error ? error.message : "未知错误"}`
      }).catch(() => {});
    });

    bilibiliSilentRetry = silent && Boolean(bilibiliBase);
    if (!bilibiliSilentRetry) {
      bilibiliBase = {
        source: "bilibili",
        videoId: identity.videoId,
        status: "loading",
        message: "正在读取 Bilibili 字幕……",
        tracks: []
      };
      publishBilibili();
    }
    if (pageChanged) restoreAiTranscript(identity.pageKey);
    window.postMessage({ source: EXTENSION_SOURCE, type: "LOAD_BILIBILI" }, "*");
  }

  async function handleBilibiliCaptionMessage(payload) {
    const identity = getBilibiliIdentity();
    if (!identity || payload?.pageKey !== identity.pageKey) return;

    if (payload.status === "loading") {
      if (bilibiliSilentRetry) return;
      bilibiliBase = {
        source: "bilibili",
        videoId: identity.videoId,
        status: "loading",
        message: "正在读取 Bilibili 字幕……",
        tracks: []
      };
      await publishBilibili();
      return;
    }

    if (payload.status === "error") {
      scheduleBilibiliRetry(identity.pageKey);
      if (bilibiliSilentRetry) return;
      bilibiliBase = {
        source: "bilibili",
        videoId: identity.videoId,
        status: "error",
        message: `字幕读取失败，正在自动重试：${String(payload.error || "未知错误")}`,
        tracks: []
      };
      await publishBilibili();
      return;
    }

    const rawTracks = Array.isArray(payload.tracks) ? payload.tracks.slice(0, 50) : [];
    const currentPayload = ++bilibiliPayloadId;
    const tracks = (await Promise.all(rawTracks.map(async (track, index) => {
      const response = await sendRuntimeMessage({
        type: "FETCH_BILIBILI_SUBTITLE",
        url: track?.url
      });
      const captions = response?.success
        ? parseBilibiliJson(response.data).slice(0, 20_000)
        : [];
      return captions.length ? {
        id: String(track.id || `${track.language || "unknown"}:${index}`),
        language: String(track.language || "unknown"),
        label: String(track.label || track.language || `字幕 ${index + 1}`),
        captions
      } : null;
    }))).filter(Boolean);

    if (currentPayload !== bilibiliPayloadId || getBilibiliIdentity()?.pageKey !== identity.pageKey) return;
    const status = tracks.length ? "ready" : "empty";
    if (tracks.length) resetBilibiliRetry(identity.pageKey);
    else scheduleBilibiliRetry(identity.pageKey);
    bilibiliBase = {
      source: "bilibili",
      videoId: identity.videoId,
      status,
      message: tracks.length
        ? ""
        : rawTracks.length
          ? "字幕文件暂未就绪，正在自动重试……"
          : payload.needLogin
            ? "暂未取得字幕。请确认 Bilibili 已登录，扩展会继续自动重试。"
            : "暂未发现字幕，正在自动重试……",
      title: String(payload.title || document.title),
      chapters: parseBilibiliChapters(payload.viewPoints).slice(0, 100),
      tracks,
      needLogin: Boolean(payload.needLogin),
      durationSeconds: Math.max(0, Number(payload.duration) || 0)
    };
    await publishBilibili();
  }

  function handleYouTubeCaptionMessage(payload) {
    if (typeof payload?.responseText !== "string") return;
    if (!payload.responseText || payload.responseText.length > 5_000_000) return;
    const videoId = getYouTubeVideoId();
    if (!videoId || (payload.videoId && payload.videoId !== videoId)) return;
    if (currentYouTubeVideoId && currentYouTubeVideoId !== videoId) {
      youtubeTracks.clear();
      youtubeChapters = [];
    }
    currentYouTubeVideoId = videoId;

    let captions;
    try {
      captions = parseYouTubePayload(payload.responseText);
    } catch {
      return;
    }
    if (!captions.length) return;

    const language = payload.translatedLanguage || payload.language || "unknown";
    const trackId = payload.trackId || (payload.translatedLanguage
      ? `${payload.language || "unknown"}->${payload.translatedLanguage}`
      : language);
    youtubeTracks.set(trackId, {
      id: trackId,
      language,
      label: payload.label || language,
      captions
    });

    publishState({
      source: "youtube",
      videoId,
      status: "ready",
      message: "",
      title: document.title.replace(/\s+-\s+YouTube$/, ""),
      chapters: youtubeChapters,
      tracks: [...youtubeTracks.values()]
    });
  }

  function handleYouTubeChaptersMessage(payload) {
    const videoId = getYouTubeVideoId();
    if (!videoId || payload?.videoId !== videoId || !Array.isArray(payload.chapters)) return;
    youtubeChapters = payload.chapters.slice(0, 100);
    if (latestState?.source !== "youtube" || latestState.videoId !== videoId) return;
    publishState({
      source: "youtube",
      videoId,
      status: latestState.status,
      message: latestState.message,
      title: latestState.title,
      chapters: youtubeChapters,
      tracks: [...youtubeTracks.values()]
    });
  }

  function handleYouTubeTracksMessage(payload) {
    const videoId = getYouTubeVideoId();
    if (!videoId || payload?.videoId !== videoId) return;
    currentYouTubeVideoId = videoId;

    if (payload.status === "loading") {
      publishState({
        source: "youtube",
        videoId,
        status: "loading",
        message: `正在读取 YouTube 字幕${payload.count ? `（${payload.count} 个轨道）` : ""}……`,
        chapters: youtubeChapters,
        tracks: [...youtubeTracks.values()]
      });
      return;
    }

    if (payload.status === "empty" && !youtubeTracks.size) {
      publishState({
        source: "youtube",
        videoId,
        status: "empty",
        message: "这个视频没有可用字幕。",
        chapters: youtubeChapters,
        tracks: []
      });
      return;
    }

    if (payload.status === "error" && !youtubeTracks.size) {
      publishState({
        source: "youtube",
        videoId,
        status: "error",
        message: "找到了字幕，但字幕文件下载失败。请点击刷新重试。",
        chapters: youtubeChapters,
        tracks: []
      });
    }
  }

  function handleNavigation(force = false) {
    if (location.hostname.endsWith("youtube.com")) {
      const videoId = getYouTubeVideoId();
      if (force || videoId !== currentYouTubeVideoId) {
        currentYouTubeVideoId = videoId;
        youtubeTracks.clear();
        youtubeChapters = [];
        publishState({
          source: "youtube",
          videoId,
          status: videoId ? "loading" : "empty",
          message: videoId
            ? "正在读取 YouTube 字幕……"
            : "请打开一个 YouTube 视频。",
          chapters: [],
          tracks: []
        });
        window.postMessage({ source: EXTENSION_SOURCE, type: "READY" }, "*");
        if (videoId) window.postMessage({ source: EXTENSION_SOURCE, type: "LOAD_YOUTUBE" }, "*");
      }
      return;
    }

    if (location.hostname.endsWith("bilibili.com")) {
      loadBilibili(force);
    }
  }

  function chooseVideo() {
    return [...document.querySelectorAll("video")]
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]
      || null;
  }

  function emitPlayback() {
    if (!boundVideo) return;
    const now = performance.now();
    if (now - lastPlaybackSentAt < 300) return;
    lastPlaybackSentAt = now;
    latestPlaybackMs = Math.round(boundVideo.currentTime * 1000);
    embeddedPanel?.setPlayback(latestPlaybackMs);
    sendRuntimeMessage({
      type: "PLAYBACK_TIME",
      currentMs: latestPlaybackMs,
      paused: boundVideo.paused
    });
  }

  function bindVideo() {
    const nextVideo = chooseVideo();
    if (!nextVideo || nextVideo === boundVideo) return;
    if (boundVideo) {
      boundVideo.removeEventListener("timeupdate", emitPlayback);
      boundVideo.removeEventListener("play", emitPlayback);
      boundVideo.removeEventListener("pause", emitPlayback);
    }
    boundVideo = nextVideo;
    boundVideo.addEventListener("timeupdate", emitPlayback);
    boundVideo.addEventListener("play", emitPlayback);
    boundVideo.addEventListener("pause", emitPlayback);
    emitPlayback();
  }

  function removeEmbeddedPanel() {
    embeddedPanel?.dispose();
    embeddedPanel = null;
    embedRoot?.remove();
    embedRoot = null;
    embeddedPanelCollapsed = false;
    if (paddedBilibiliContainer) {
      paddedBilibiliContainer.style.paddingTop = originalBilibiliPaddingTop;
      paddedBilibiliContainer = null;
      originalBilibiliPaddingTop = "";
    }
    if (paddedYouTubeSidebar) {
      paddedYouTubeSidebar.style.paddingTop = originalSidebarPaddingTop;
      paddedYouTubeSidebar = null;
      originalSidebarPaddingTop = "";
    }
    playerResizeObserver?.disconnect();
    playerResizeObserver = null;
    observedPlayer = null;
  }

  function createEmbedRoot() {
    const root = document.createElement("section");
    root.id = "caption-lite-embed";
    root.style.cssText = [
      "width:100%",
      "min-height:0",
      "box-sizing:border-box",
      "position:absolute",
      "z-index:20",
      "pointer-events:auto",
      "overflow:hidden",
      "border-radius:10px"
    ].join(";");
    return root;
  }

  function placeEmbedRoot(anchor, height) {
    const rect = anchor.getBoundingClientRect();
    if (rect.width < 280 || rect.height <= 0) {
      embedRoot.style.display = "none";
      return;
    }
    embedRoot.style.display = "block";
    embedRoot.style.left = `${window.scrollX + rect.left}px`;
    embedRoot.style.top = `${window.scrollY + rect.top}px`;
    embedRoot.style.width = `${Math.round(rect.width)}px`;
    embedRoot.style.height = `${Math.round(height)}px`;
  }

  async function mountPanelUi(host) {
    const [htmlResponse, cssResponse] = await Promise.all([
      fetch(chrome.runtime.getURL("src/sidepanel.html")),
      fetch(chrome.runtime.getURL("src/sidepanel.css"))
    ]);
    if (!htmlResponse.ok || !cssResponse.ok) throw new Error("无法载入字幕面板资源");

    const panelDocument = new DOMParser().parseFromString(await htmlResponse.text(), "text/html");
    const app = document.createElement("div");
    app.className = "caption-lite-app embedded";
    [...panelDocument.body.children]
      .filter((element) => element.tagName !== "SCRIPT")
      .forEach((element) => app.append(document.importNode(element, true)));

    const style = document.createElement("style");
    style.textContent = await cssResponse.text();
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.append(style, app);
    if (!host.isConnected) return;
    embeddedPanel = globalThis.CaptionLitePanel.mount(shadowRoot, {
      embedded: true,
      onCollapsedChange(collapsed) {
        embeddedPanelCollapsed = collapsed;
        mountSitePanel();
      }
    });
    embeddedTheme = detectPageTheme();
    embeddedPanel?.setTheme(embeddedTheme);
    if (latestState) embeddedPanel?.setState(latestState);
    embeddedPanel?.setPlayback(latestPlaybackMs);
    embeddedPanel?.setCommentCopyState(latestCommentCopyState);
  }

  // The embedded panel matches the site's own light or dark mode.
  function detectPageTheme() {
    if (location.hostname.endsWith("youtube.com")) {
      return document.documentElement.hasAttribute("dark") ? "dark" : "light";
    }
    for (const element of [document.body, document.documentElement]) {
      const parts = element && getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!parts || (parts.length > 3 && parts[3] < 0.5)) continue;
      return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2] < 128 ? "dark" : "light";
    }
    return "";
  }

  function syncEmbeddedTheme() {
    const theme = detectPageTheme();
    if (theme === embeddedTheme) return;
    embeddedTheme = theme;
    embeddedPanel?.setTheme(theme);
  }

  function mountBilibiliPanel() {
    if (!getBilibiliIdentity()) {
      removeEmbeddedPanel();
      return;
    }

    const danmakuBox = document.querySelector("#danmukuBox");
    if (!danmakuBox) return;
    const danmakuContainer = danmakuBox.parentElement;
    const player = document.querySelector("#bilibili-player");
    if (!danmakuContainer || !player) return;

    if (embedRoot && !embedRoot.isConnected) removeEmbeddedPanel();

    if (!embedRoot) {
      embedRoot = createEmbedRoot();
      document.body.append(embedRoot);
      const host = embedRoot;
      mountPanelUi(host)
        .catch((error) => {
          if (host.isConnected) host.textContent = `Bili Kit：${error.message}`;
        });
    }

    const updateHeight = () => {
      if (!embedRoot?.isConnected) return;
      const height = embeddedPanelCollapsed
        ? COLLAPSED_PANEL_HEIGHT
        : Math.max(360, player.getBoundingClientRect().height);

      if (paddedBilibiliContainer !== danmakuContainer) {
        if (paddedBilibiliContainer) {
          paddedBilibiliContainer.style.paddingTop = originalBilibiliPaddingTop;
        }
        paddedBilibiliContainer = danmakuContainer;
        originalBilibiliPaddingTop = danmakuContainer.style.paddingTop || "";
      }

      danmakuContainer.style.paddingTop = `${Math.round(height + 12)}px`;
      placeEmbedRoot(danmakuContainer, height);
    };
    updateHeight();

    if (observedPlayer !== player) {
      playerResizeObserver?.disconnect();
      observedPlayer = player;
      playerResizeObserver = new ResizeObserver(updateHeight);
      playerResizeObserver.observe(player);
    }
  }

  function mountYouTubePanel() {
    if (!getYouTubeVideoId() || location.pathname.startsWith("/shorts/")) {
      removeEmbeddedPanel();
      return;
    }

    const sidebar = document.querySelector("ytd-watch-flexy #secondary-inner");
    if (!sidebar) return;
    if (embedRoot && !embedRoot.isConnected) removeEmbeddedPanel();

    if (!embedRoot) {
      embedRoot = createEmbedRoot();
      document.body.append(embedRoot);
      const host = embedRoot;
      mountPanelUi(host)
        .catch((error) => {
          if (host.isConnected) host.textContent = `Bili Kit：${error.message}`;
        });
    }

    const height = embeddedPanelCollapsed
      ? COLLAPSED_PANEL_HEIGHT
      : Math.min(window.innerHeight * 0.72, 720);
    if (paddedYouTubeSidebar !== sidebar) {
      if (paddedYouTubeSidebar) paddedYouTubeSidebar.style.paddingTop = originalSidebarPaddingTop;
      paddedYouTubeSidebar = sidebar;
      originalSidebarPaddingTop = sidebar.style.paddingTop;
    }
    sidebar.style.paddingTop = `${Math.round(height + 16)}px`;
    placeEmbedRoot(sidebar, height);
  }

  function mountSitePanel() {
    if (location.hostname.endsWith("youtube.com")) {
      mountYouTubePanel();
      return;
    }
    if (location.hostname.endsWith("bilibili.com")) mountBilibiliPanel();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== PAGE_SOURCE) return;
    if (event.data?.type === "YOUTUBE_CAPTIONS") {
      handleYouTubeCaptionMessage(event.data.payload);
    }
    if (event.data?.type === "YOUTUBE_TRACKS") {
      handleYouTubeTracksMessage(event.data.payload);
    }
    if (event.data?.type === "YOUTUBE_CHAPTERS") {
      handleYouTubeChaptersMessage(event.data.payload);
    }
    if (event.data?.type === "BILIBILI_CAPTIONS") {
      handleBilibiliCaptionMessage(event.data.payload).catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BILIBILI_NAVIGATION") {
      if (location.hostname.endsWith("bilibili.com")) {
        if (getBilibiliIdentity()) {
          commentCopyController.restartLoading().catch((error) => {
            publishCommentCopyState({
              status: "error",
              message: `评论读取失败：${error instanceof Error ? error.message : "未知错误"}`
            }).catch(() => {});
          });
        } else {
          currentBilibiliPageKey = "";
          commentCopyController.invalidate();
        }
        publishCommentCopyState(latestCommentCopyState).catch(() => {});
      }
      sendResponse({ success: true });
      return;
    }

    if (message?.type === "SEEK") {
      bindVideo();
      if (!boundVideo || !Number.isFinite(message.startMs)) {
        sendResponse({ success: false });
        return;
      }
      boundVideo.currentTime = Math.max(0, message.startMs / 1000);
      boundVideo.play().catch(() => {});
      sendResponse({ success: true });
      return;
    }

    if (message?.type === "REFRESH_CAPTIONS") {
      handleNavigation(true);
      sendResponse({ success: true });
      return;
    }

    if (message?.type === "START_AI_TRANSCRIBE") {
      startAiTranscription();
      sendResponse({ success: true });
      return;
    }

    if (message?.type === "CANCEL_AI_TRANSCRIBE") {
      cancelAiTranscription();
      sendResponse({ success: true });
      return;
    }

    if (message?.type === "COPY_BILIBILI_COMMENTS") {
      commentCopyController.copyCurrent().catch((error) => {
        publishCommentCopyState({
          status: "error",
          message: `评论读取失败：${error instanceof Error ? error.message : "未知错误"}`
        }).catch(() => {});
      });
      sendResponse({ success: true });
      return;
    }
  });

  // Saving a key on the settings page resumes the transcription that asked for it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.openaiApiKey?.newValue && aiState.status === "needs-key") {
      startAiTranscription();
    }
  });

  handleNavigation(true);
  window.postMessage({ source: EXTENSION_SOURCE, type: "READY" }, "*");
  bindVideo();
  mountSitePanel();

  setInterval(() => {
    bindVideo();
    mountSitePanel();
    syncEmbeddedTheme();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      handleNavigation(false);
    }
  }, 1000);
})();
