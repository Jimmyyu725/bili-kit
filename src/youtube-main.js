(() => {
  "use strict";

  if (window.__captionLiteYouTubeHookInstalled) return;
  window.__captionLiteYouTubeHookInstalled = true;

  const {
    getYouTubeCaptionTracks,
    parseYouTubeChapters
  } = globalThis.CaptionLiteParsers;
  const SOURCE = "caption-lite-page";
  const xhrUrls = new WeakMap();
  const latestPayloads = new Map();
  const originalFetch = window.fetch;
  let latestVideoId = "";
  let latestChapters = null;
  let lastTrackSignature = "";
  let loadGeneration = 0;

  function getVideoId() {
    const pageUrl = new URL(location.href);
    return pageUrl.searchParams.get("v")
      || pageUrl.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/)?.[1]
      || "";
  }

  function normalizeUrl(input) {
    try {
      const value = input instanceof Request ? input.url : String(input);
      return new URL(value, location.href).toString();
    } catch {
      return "";
    }
  }

  function isCaptionUrl(url) {
    return url.includes("timedtext");
  }

  function isNextUrl(url) {
    try {
      return new URL(url, location.href).pathname === "/youtubei/v1/next";
    } catch {
      return false;
    }
  }

  function createPayload(url, responseText, track = {}) {
    const parsed = new URL(url, location.href);
    const language = track.language || parsed.searchParams.get("lang") || "unknown";
    const translatedLanguage = track.translatedLanguage || parsed.searchParams.get("tlang") || "";

    return {
      url,
      responseText,
      videoId: track.videoId || parsed.searchParams.get("v") || getVideoId() || "unknown",
      trackId: track.id || `${language}:${parsed.searchParams.get("kind") || "manual"}:${translatedLanguage}`,
      language,
      translatedLanguage,
      label: track.label || (translatedLanguage
        ? `${translatedLanguage}（翻译）`
        : language)
    };
  }

  function publishPayload(payload) {
    const pageVideoId = getVideoId();
    if (!payload?.responseText || (pageVideoId && payload.videoId !== pageVideoId)) return;
    if (payload.videoId !== latestVideoId) {
      latestVideoId = payload.videoId;
      latestPayloads.clear();
    }
    latestPayloads.set(payload.trackId, payload);
    window.postMessage({
      source: SOURCE,
      type: "YOUTUBE_CAPTIONS",
      payload
    }, "*");
  }

  function publish(url, responseText, track) {
    if (!url || !responseText) return;
    publishPayload(createPayload(url, responseText, track));
  }

  function publishTrackStatus(videoId, status, count = 0) {
    window.postMessage({
      source: SOURCE,
      type: "YOUTUBE_TRACKS",
      payload: { videoId, status, count }
    }, "*");
  }

  function publishChapters(input) {
    try {
      const data = typeof input === "string" ? JSON.parse(input) : input;
      const videoId = data?.currentVideoEndpoint?.watchEndpoint?.videoId || getVideoId();
      if (!videoId || videoId !== getVideoId()) return;
      const chapters = parseYouTubeChapters(data);
      if (!chapters.length) return;
      latestChapters = { videoId, chapters };
      window.postMessage({
        source: SOURCE,
        type: "YOUTUBE_CHAPTERS",
        payload: latestChapters
      }, "*");
    } catch {
      // Ignore unrelated or incomplete YouTube API responses.
    }
  }

  function getPlayerResponse() {
    const players = [
      document.querySelector("#movie_player"),
      document.querySelector("ytd-player")
    ];
    for (const player of players) {
      try {
        const response = player?.getPlayerResponse?.();
        if (response) return response;
      } catch {
        // The player may be rebuilding during YouTube SPA navigation.
      }
    }
    return window.ytInitialPlayerResponse || null;
  }

  async function loadCaptionTracks(force = false) {
    const pageVideoId = getVideoId();
    const playerResponse = getPlayerResponse();
    const playerVideoId = String(playerResponse?.videoDetails?.videoId || "");
    if (!pageVideoId || !playerVideoId || pageVideoId !== playerVideoId) return;

    const tracks = getYouTubeCaptionTracks(playerResponse);
    const signature = `${playerVideoId}:${tracks.map((track) => track.url).join("|")}`;
    if (!force && signature === lastTrackSignature) return;
    lastTrackSignature = signature;
    latestVideoId = playerVideoId;
    latestPayloads.clear();
    const generation = ++loadGeneration;

    if (!tracks.length) {
      publishTrackStatus(playerVideoId, "empty");
      return;
    }
    publishTrackStatus(playerVideoId, "loading", tracks.length);

    const payloads = (await Promise.all(tracks.map(async (track) => {
      try {
        const url = new URL(track.url, location.href);
        url.searchParams.set("fmt", "json3");
        const response = await originalFetch.call(window, url.toString(), {
          credentials: "include"
        });
        if (!response.ok) return null;
        return createPayload(url.toString(), await response.text(), {
          ...track,
          videoId: playerVideoId
        });
      } catch {
        return null;
      }
    }))).filter(Boolean);

    if (generation !== loadGeneration || getVideoId() !== playerVideoId) return;
    payloads.forEach(publishPayload);
    publishTrackStatus(playerVideoId, payloads.length ? "ready" : "error", payloads.length);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "caption-lite-extension") return;
    if (event.data?.type === "READY") {
      latestPayloads.forEach((payload) => publishPayload(payload));
      if (latestChapters?.videoId === getVideoId()) {
        window.postMessage({
          source: SOURCE,
          type: "YOUTUBE_CHAPTERS",
          payload: latestChapters
        }, "*");
      }
      loadCaptionTracks(false);
    }
    if (event.data?.type === "LOAD_YOUTUBE") {
      loadCaptionTracks(true);
    }
  });

  window.fetch = async function captionLiteFetch(...args) {
    const response = await originalFetch.apply(this, args);
    const url = normalizeUrl(args[0]) || response.url;
    if (isCaptionUrl(url)) {
      response.clone().text().then((text) => publish(url, text)).catch(() => {});
    }
    if (isNextUrl(url)) {
      response.clone().json().then(publishChapters).catch(() => {});
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function captionLiteOpen(method, url, ...rest) {
    xhrUrls.set(this, normalizeUrl(url));
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function captionLiteSend(...args) {
    const url = xhrUrls.get(this) || "";
    if (isCaptionUrl(url) || isNextUrl(url)) {
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          const text = this.responseType === "json"
            ? JSON.stringify(this.response)
            : this.responseText;
          if (isCaptionUrl(url)) publish(url, text);
          if (isNextUrl(url)) publishChapters(text);
        } catch {
          // Ignore response types that cannot be converted to text.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  window.addEventListener("yt-navigate-finish", () => {
    lastTrackSignature = "";
    loadGeneration += 1;
    loadCaptionTracks(false);
  });
  setInterval(() => loadCaptionTracks(false), 750);
  loadCaptionTracks(false);
})();
