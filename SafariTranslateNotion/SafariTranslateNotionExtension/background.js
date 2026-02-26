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
  const out = { translation: "", synonyms: [], word_class: "", base_form: "" };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  function extract(parsed) {
    if (parsed && typeof parsed.translation === "string") out.translation = parsed.translation;
    if (Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter(function (s) { return typeof s === "string"; });
    if (parsed && typeof parsed.word_class === "string") out.word_class = parsed.word_class.trim();
    if (parsed && typeof parsed.base_form === "string") out.base_form = parsed.base_form.trim();
  }
  try { extract(JSON.parse(trimmed)); return out; } catch (_) {}
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return out;
  try { extract(JSON.parse(jsonMatch[0])); } catch (_) {}
  return out;
}

function translateWithDeepSeek(text, apiKey, targetLanguage) {
  const lang = targetLanguage || DEFAULT_TARGET_LANG;
  const systemPrompt =
    "Translate to " + lang + ". Reply with JSON only: {\"translation\": \"<translation>\", \"synonyms\": [\"...\"], \"word_class\": \"<Noun|Verb|Adjective|Adverb|Pronoun|Preposition|Conjunction|Interjection|phrase>\", \"base_form\": \"<lemma>\"}. IMPORTANT: synonyms must be English words/phrases with similar meaning to the original input — never translate synonyms. word_class is part of speech or \"phrase\" for multi-word input. base_form is the dictionary/root form of the word (e.g. skiving→skive, croons→croon, happier→happy). If the input is already a base form or a phrase, set base_form to the input itself.";
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

  return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
    type: "apiRequest",
    url: DEEPSEEK_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: body,
  }).then(function (res) {
    if (!res) throw new Error("No response from native handler.");
    if (res.error) throw new Error(res.error);
    var status = res.status;
    var text = res.body || "";
    if (status < 200 || status >= 300) {
      if (status === 401) throw new Error("Invalid DeepSeek API key. Check extension Options.");
      if (status === 429) throw new Error("Rate limit exceeded. Try again in a moment.");
      throw new Error(text || "DeepSeek request failed (" + status + ")");
    }
    var data = JSON.parse(text);
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseTranslationResponse(content);
  });
}

var TAXONOMY_SYSTEM_PROMPT =
  "You are a linguistic annotator building a fiction writer's vocabulary database.\n" +
  "Your task is to classify a word or phrase according to the predefined fiction-writing taxonomy below.\n\n" +
  "STRICT RULES:\n" +
  "- Use ONLY the categories listed in the taxonomy.\n" +
  "- Do NOT invent new labels.\n" +
  "- Choose exactly ONE Narrative Function.\n" +
  "- Other fields may contain multiple values if applicable.\n" +
  "- If none apply, return an empty array [].\n" +
  "- Base your decision on the meaning in context if a sentence is provided.\n" +
  "- Prefer tags that are useful for creative writing (not academic linguistics).\n\n" +
  "OUTPUT:\n" +
  "Return ONLY valid JSON with this exact structure:\n" +
  '{"narrative_function":"","sensory_channel":[],"psychological_domain":[],"action_type":[],"social_function":[],"atmosphere_tone":[],"register":"","show_tell":""}\n\n' +
  "TAXONOMY:\n\n" +
  "Narrative Function (choose ONE): description_physical, description_sensory, description_environment, action, dialogue_speech, thought_cognition, emotion_expression, internal_state, social_interaction, worldbuilding_technical\n\n" +
  "Sensory Channel (multi-select): visual, auditory, tactile, smell, taste, kinesthetic, temperature, pain\n\n" +
  "Psychological Domain (multi-select): emotion, cognition, personality_trait, motivation_desire, moral_stance, mental_state\n\n" +
  "Action Type (multi-select): motion, communication, violence_combat, manipulation, creation_destruction, social_action, deception, survival_bodily\n\n" +
  "Social Function (multi-select): dominance, submission, affection, conflict, authority, politeness, status_signal\n\n" +
  "Atmosphere / Tone (multi-select): tense, dark, peaceful, romantic, melancholic, sacred, whimsical, clinical, ominous, eerie\n\n" +
  "Register (choose ONE): formal, neutral, informal, literary, poetic, slang, archaic, technical\n\n" +
  "Show vs Tell Utility (choose ONE): strong_showing, neutral, abstract_telling, intensifier, vague, cliché_risk\n\n" +
  "Return empty arrays [] for multi-select and empty string for single-select if no category applies.";

function parseTaxonomyResponse(text) {
  const out = {
    narrative_function: "",
    sensory_channel: [],
    psychological_domain: [],
    action_type: [],
    social_function: [],
    atmosphere_tone: [],
    register: "",
    show_tell: "",
  };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  function extract(parsed) {
    if (parsed && typeof parsed.narrative_function === "string") out.narrative_function = parsed.narrative_function.trim();
    if (Array.isArray(parsed.sensory_channel)) out.sensory_channel = parsed.sensory_channel.filter(function (s) { return typeof s === "string"; });
    if (Array.isArray(parsed.psychological_domain)) out.psychological_domain = parsed.psychological_domain.filter(function (s) { return typeof s === "string"; });
    if (Array.isArray(parsed.action_type)) out.action_type = parsed.action_type.filter(function (s) { return typeof s === "string"; });
    if (Array.isArray(parsed.social_function)) out.social_function = parsed.social_function.filter(function (s) { return typeof s === "string"; });
    if (Array.isArray(parsed.atmosphere_tone)) out.atmosphere_tone = parsed.atmosphere_tone.filter(function (s) { return typeof s === "string"; });
    if (parsed && typeof parsed.register === "string") out.register = parsed.register.trim();
    if (parsed && typeof parsed.show_tell === "string") out.show_tell = parsed.show_tell.trim();
  }
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) extract(JSON.parse(jsonMatch[0]));
  } catch (_) {}
  return out;
}

function callTaxonomy(word, context, apiKey) {
  if (!word || !apiKey) return Promise.resolve(parseTaxonomyResponse(""));
  const contextSentence = (context && typeof context === "string" && context.trim()) ? context.trim().slice(0, 1000) : "none";
  const userContent = "INPUT:\nWord: " + word + "\nContext sentence: " + contextSentence + "\n\nOUTPUT (JSON only):";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: TAXONOMY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 512,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
    type: "apiRequest",
    url: DEEPSEEK_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: body,
  }).then(function (res) {
    if (!res) return parseTaxonomyResponse("");
    if (res.error) return parseTaxonomyResponse("");
    var status = res.status;
    var text = res.body || "";
    if (status < 200 || status >= 300) return parseTaxonomyResponse("");
    try {
      var data = JSON.parse(text);
      var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return parseTaxonomyResponse(content || "");
    } catch (_) {
      return parseTaxonomyResponse("");
    }
  }).catch(function () {
    return parseTaxonomyResponse("");
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
  props["Base Form"] = {
    rich_text: [{ type: "text", text: { content: (payload.base_form || payload.original || "").slice(0, 2000) } }],
  };

  var tax = payload.taxonomy;
  if (tax) {
    if (tax.narrative_function) props["Narrative Function"] = { select: { name: tax.narrative_function } };
    if (Array.isArray(tax.sensory_channel) && tax.sensory_channel.length) {
      props["Sensory Channel"] = { multi_select: tax.sensory_channel.slice(0, 20).map(function (n) { return { name: n }; }) };
    }
    if (Array.isArray(tax.psychological_domain) && tax.psychological_domain.length) {
      props["Psychological Domain"] = { multi_select: tax.psychological_domain.slice(0, 20).map(function (n) { return { name: n }; }) };
    }
    if (Array.isArray(tax.action_type) && tax.action_type.length) {
      props["Action Type"] = { multi_select: tax.action_type.slice(0, 20).map(function (n) { return { name: n }; }) };
    }
    if (Array.isArray(tax.social_function) && tax.social_function.length) {
      props["Social Function"] = { multi_select: tax.social_function.slice(0, 20).map(function (n) { return { name: n }; }) };
    }
    if (Array.isArray(tax.atmosphere_tone) && tax.atmosphere_tone.length) {
      props["Atmosphere Tone"] = { multi_select: tax.atmosphere_tone.slice(0, 20).map(function (n) { return { name: n }; }) };
    }
    if (tax.register) props["Register"] = { select: { name: tax.register } };
    if (tax.show_tell) props["Show Tell"] = { select: { name: tax.show_tell } };
  }

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
        var apiKey = (opts.deepseekApiKey && opts.deepseekApiKey.trim()) ? opts.deepseekApiKey.trim() : "";
        return callTaxonomy(payload.original, payload.context, apiKey).then(function (taxonomy) {
          payload.taxonomy = taxonomy;
          return saveToNotionApi(payload, opts.notionToken.trim(), opts.notionDatabaseId.trim());
        });
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
