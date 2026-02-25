/**
 * Background service worker: DeepSeek translation, Notion save, storage.
 */

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const NOTION_URL = "https://api.notion.com/v1/pages";
const DEFAULT_TARGET_LANG = "Simplified Chinese";

function getStoredOptions() {
  return browser.storage.local.get({
    deepseekApiKey: "",
    notionToken: "",
    notionDatabaseId: "",
    targetLanguage: DEFAULT_TARGET_LANG,
    maxSelectionLength: 120,
  });
}

function parseTranslationResponse(text) {
  const out = { translation: "", synonyms: [], word_class: "" };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.translation === "string") out.translation = parsed.translation;
    if (Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter(function (s) { return typeof s === "string"; });
    if (parsed && typeof parsed.word_class === "string") out.word_class = parsed.word_class.trim();
    return out;
  } catch (_) {}

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return out;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed && typeof parsed.translation === "string") out.translation = parsed.translation;
    if (Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter(function (s) { return typeof s === "string"; });
    if (parsed && typeof parsed.word_class === "string") out.word_class = parsed.word_class.trim();
  } catch (_) {}
  return out;
}

function translateWithDeepSeek(text, apiKey, targetLanguage) {
  const lang = targetLanguage || DEFAULT_TARGET_LANG;
  const systemPrompt =
    "Translate to " + lang + ". Reply with JSON only: {\"translation\": \"<translation>\", \"synonyms\": [\"...\"], \"word_class\": \"<Noun|Verb|Adjective|Adverb|Pronoun|Preposition|Conjunction|Interjection|phrase>\"}. IMPORTANT: synonyms must be English words/phrases with similar meaning to the original input — never translate synonyms. word_class is part of speech or \"phrase\" for multi-word input.";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    max_tokens: 256,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  var timeoutMs = 30000;
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, timeoutMs);

  return fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body,
    signal: controller.signal,
  })
    .then(function (res) {
      clearTimeout(timeoutId);
      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid DeepSeek API key. Check extension Options.");
        if (res.status === 429) throw new Error("Rate limit exceeded. Try again in a moment.");
        return res.text().then(function (t) { throw new Error(t || "DeepSeek request failed"); });
      }
      return res.json();
    })
    .then(function (data) {
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return parseTranslationResponse(content);
    })
    .catch(function (err) {
      clearTimeout(timeoutId);
      if (err && err.name === "AbortError") throw new Error("Translation timed out. In Options, check your DeepSeek API key and internet connection.");
      throw err;
    });
}

var WORD_CLASS_OPTIONS = ["Noun", "Pronoun", "Verb", "Adjective", "Adverb", "Preposition", "Conjunction", "Interjection", "phrase"];
var WORD_CLASS_ALIASES = {
  noun: "Noun", pronoun: "Pronoun", verb: "Verb", adjective: "Adjective", adverb: "Adverb",
  preposition: "Preposition", conjunction: "Conjunction", interjection: "Interjection", phrase: "phrase",
  n: "Noun", v: "Verb", adj: "Adjective", adv: "Adverb", pron: "Pronoun",
  prep: "Preposition", conj: "Conjunction", interj: "Interjection",
};

function normalizeWordClass(raw) {
  if (!raw || typeof raw !== "string") return null;
  var key = raw.trim().toLowerCase();
  if (WORD_CLASS_ALIASES[key]) return WORD_CLASS_ALIASES[key];
  if (WORD_CLASS_OPTIONS.indexOf(raw.trim()) !== -1) return raw.trim();
  for (var i = 0; i < WORD_CLASS_OPTIONS.length; i++) {
    if (WORD_CLASS_OPTIONS[i].toLowerCase() === key) return WORD_CLASS_OPTIONS[i];
  }
  return null;
}

function normalizeDatabaseId(id) {
  if (!id || typeof id !== "string") return "";
  return id.trim().replace(/-/g, "");
}

function saveToNotionApi(payload, notionToken, databaseId) {
  const synonymsStr = Array.isArray(payload.synonyms) ? payload.synonyms.join(", ") : "";
  const wordClassSelect = normalizeWordClass(payload.word_class);
  const props = {
    Word: {
      title: [{ type: "text", text: { content: (payload.original || "").slice(0, 2000) } }],
    },
    Translation: {
      rich_text: [{ type: "text", text: { content: (payload.translation || "").slice(0, 2000) } }],
    },
    Synonyms: {
      rich_text: [{ type: "text", text: { content: synonymsStr.slice(0, 2000) } }],
    },
  };
  props["Word Class"] = { select: { name: wordClassSelect || "phrase" } };

  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId) throw new Error("Notion: Database ID is empty. Check Options.");

  const body = JSON.stringify({
    parent: { type: "database_id", database_id: normalizedDbId },
    properties: props,
  });

  return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
    type: "apiRequest",
    url: NOTION_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + notionToken,
      "Notion-Version": "2022-06-28",
    },
    body: body,
  }).then(function (res) {
    if (!res) throw new Error("Notion: No response from native handler.");
    if (res.error) throw new Error(res.error);
    var status = res.status;
    var text = res.body || "";
    if (status < 200 || status >= 300) {
      var detail = "";
      try {
        var j = JSON.parse(text);
        detail = (j && j.message) || "";
      } catch (_) {}
      if (status === 401) throw new Error("Notion (" + status + "): Invalid API secret. Check extension Options." + (detail ? " — " + detail : ""));
      if (status === 403) throw new Error("Notion (" + status + "): No access. Open your database in Notion → ⋯ → Add connections → select your integration." + (detail ? " — " + detail : ""));
      if (status === 404) throw new Error("Notion (" + status + "): Database not found. Check Database ID and connect the database to your integration." + (detail ? " — " + detail : ""));
      throw new Error("Notion (" + status + "): " + (detail || "Request failed"));
    }
    return text ? JSON.parse(text) : {};
  });
}

browser.runtime.onMessage.addListener(function (message, sender) {
  if (message.type === "translate") {
    return getStoredOptions()
      .then(function (opts) {
        if (!opts.deepseekApiKey || !opts.deepseekApiKey.trim()) {
          throw new Error("Set your DeepSeek API key in extension options.");
        }
        return translateWithDeepSeek(message.text, opts.deepseekApiKey.trim(), opts.targetLanguage || DEFAULT_TARGET_LANG);
      })
      .then(function (result) {
        if (!result || typeof result.translation !== "string" || !result.translation.trim()) {
          throw new Error("DeepSeek returned an empty translation. Try again.");
        }
        return result;
      })
      .catch(function (err) {
        return { error: err && err.message ? err.message : "Translation failed" };
      });
  }

  if (message.type === "getConfig") {
    return getStoredOptions()
      .then(function (opts) {
        var max = parseInt(opts.maxSelectionLength, 10);
        return { maxSelectionLength: (isNaN(max) || max < 20 || max > 500) ? 120 : max };
      })
      .catch(function () {
        return { maxSelectionLength: 120 };
      });
  }

  if (message.type === "saveToNotion") {
    var payload = message.payload;
    if (!payload) {
      return Promise.resolve({ error: "Missing payload" });
    }
    return getStoredOptions()
      .then(function (opts) {
        if (!opts.notionToken || !opts.notionToken.trim()) {
          throw new Error("Set your Notion integration token in extension options.");
        }
        if (!opts.notionDatabaseId || !opts.notionDatabaseId.trim()) {
          throw new Error("Set your Notion Database ID in extension options.");
        }
        return saveToNotionApi(payload, opts.notionToken.trim(), opts.notionDatabaseId.trim());
      })
      .then(function () {
        return { ok: true };
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : "Save failed";
        if (/load failed|failed to fetch|networkerror|network error/i.test(msg)) {
          msg = "Notion network error: " + msg + ". Check that api.notion.com is reachable from your network, and verify API secret + Database ID in Options.";
        }
        return { error: msg };
      });
  }

  return Promise.resolve({ error: "Unknown message type" });
});
