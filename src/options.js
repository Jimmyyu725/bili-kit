(() => {
  "use strict";

  const API_KEY_STORAGE = "openaiApiKey";
  const MODEL = "gpt-transcribe";

  const form = document.querySelector("#key-form");
  const input = document.querySelector("#api-key");
  const toggleButton = document.querySelector("#toggle-button");
  const saveButton = document.querySelector("#save-button");
  const clearButton = document.querySelector("#clear-button");
  const status = document.querySelector("#status");

  function setStatus(message, tone = "") {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  // Asks OpenAI whether this key can see the transcription model.
  async function checkKey(apiKey) {
    try {
      const response = await fetch(`https://api.openai.com/v1/models/${MODEL}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (response.ok) return { ok: true, message: `已保存，Key 可以使用 ${MODEL}。` };
      if (response.status === 401) return { ok: false, message: "这个 Key 无效，没有保存。请检查后重试。" };
      return { ok: false, message: `这个 Key 无法使用 ${MODEL}（HTTP ${response.status}），没有保存。` };
    } catch {
      return { ok: null, message: "已保存，但现在连不上 OpenAI，暂时无法验证。" };
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = input.value.trim();
    if (!apiKey) {
      setStatus("请先填入 API Key。", "error");
      input.focus();
      return;
    }
    saveButton.disabled = true;
    setStatus("正在验证…");
    const result = await checkKey(apiKey);
    if (result.ok !== false) await chrome.storage.local.set({ [API_KEY_STORAGE]: apiKey });
    setStatus(result.message, result.ok ? "success" : result.ok === false ? "error" : "");
    saveButton.disabled = false;
  });

  clearButton.addEventListener("click", async () => {
    await chrome.storage.local.remove(API_KEY_STORAGE);
    input.value = "";
    setStatus("已清除保存的 Key。");
  });

  toggleButton.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    toggleButton.textContent = reveal ? "隐藏" : "显示";
    toggleButton.setAttribute("aria-pressed", String(reveal));
  });

  chrome.storage.local.get(API_KEY_STORAGE).then((stored) => {
    const apiKey = String(stored[API_KEY_STORAGE] || "");
    input.value = apiKey;
    if (apiKey) setStatus("已保存 Key。");
  });
})();
