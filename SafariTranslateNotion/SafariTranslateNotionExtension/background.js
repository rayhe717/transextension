/**
 * Background service worker: DeepSeek translation, Notion save, storage.
 */

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const NOTION_URL = "https://api.notion.com/v1/pages";
const NOTION_API_BASE = "https://api.notion.com/v1";
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

function formatMeaningsAsTranslation(meanings) {
  if (!Array.isArray(meanings) || meanings.length === 0) return "";
  var parts = [];
  for (var i = 0; i < meanings.length; i++) {
    var m = meanings[i];
    var trans = (m && typeof m.translation === "string") ? m.translation.trim() : "";
    if (!trans) continue;
    var sense = (m && typeof m.sense === "string") ? m.sense.trim() : "";
    parts.push((parts.length + 1) + ". " + trans + (sense ? " (" + sense + ")" : ""));
  }
  return parts.join("\n");
}

function parseTranslationResponse(text) {
  const out = { translation: "", synonyms: [], word_class: "", base_form: "", meanings: null };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  function extract(parsed) {
    if (Array.isArray(parsed.meanings) && parsed.meanings.length > 0) {
      out.translation = formatMeaningsAsTranslation(parsed.meanings);
      out.meanings = parsed.meanings.map(function (m) {
        return {
          sense: (m && typeof m.sense === "string") ? m.sense.trim() : "",
          translation: (m && typeof m.translation === "string") ? m.translation.trim() : "",
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.filter(function (s) { return typeof s === "string"; }) : [],
          word_class: (m && typeof m.word_class === "string") ? m.word_class.trim() : "",
        };
      }).filter(function (m) { return m.translation; });
      if (out.meanings.length === 0) out.meanings = null;
    } else if (parsed && typeof parsed.translation === "string") {
      out.translation = parsed.translation;
      if (Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter(function (s) { return typeof s === "string"; });
      if (parsed && typeof parsed.word_class === "string") out.word_class = parsed.word_class.trim();
    }
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
    "Translate to " + lang + ". Reply with JSON only. For words with multiple distinct meanings (e.g. twitchy = twitching a lot, or nervous/anxious), use a \"meanings\" array: {\"meanings\": [{\"sense\": \"<short English gloss>\", \"translation\": \"<target translation>\", \"synonyms\": [\"...\"], \"word_class\": \"<Noun|Verb|Adjective|Adverb|Pronoun|Preposition|Conjunction|Interjection|phrase>\"}, ...], \"base_form\": \"<lemma>\"}. For a single meaning you may use either \"meanings\": [{\"sense\": \"\", \"translation\": \"...\", \"synonyms\": [...], \"word_class\": \"...\"}] or the shorthand {\"translation\": \"...\", \"synonyms\": [...], \"word_class\": \"...\", \"base_form\": \"...\"}. IMPORTANT: synonyms must be English words/phrases with similar meaning — never translate synonyms. sense is a brief English gloss (e.g. twitching a lot, anxious). base_form is the dictionary/root form (e.g. skiving→skive). If input is already base form or a phrase, set base_form to the input itself.";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
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

function buildSenseContext(senseMeaning, sentenceContext) {
  var parts = [];
  if (senseMeaning && typeof senseMeaning.sense === "string" && senseMeaning.sense.trim()) {
    parts.push("Sense: " + senseMeaning.sense.trim());
  }
  if (senseMeaning && typeof senseMeaning.translation === "string" && senseMeaning.translation.trim()) {
    parts.push("Translation: " + senseMeaning.translation.trim());
  }
  if (sentenceContext && typeof sentenceContext === "string" && sentenceContext.trim()) {
    parts.push("Context sentence: " + sentenceContext.trim().slice(0, 500));
  }
  return parts.length ? parts.join(". ") : "none";
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

function checkNotionForExistingWordOrBaseForm(notionToken, databaseId, word, baseForm) {
  var normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId || !notionToken) return Promise.resolve({ found: false });
  var wordTrim = (word && typeof word === "string") ? word.trim() : "";
  var baseTrim = (baseForm && typeof baseForm === "string") ? baseForm.trim() : "";
  if (!wordTrim && !baseTrim) return Promise.resolve({ found: false });
  var clauses = [];
  if (wordTrim) clauses.push({ property: "Word", title: { equals: wordTrim } });
  if (baseTrim && baseTrim !== wordTrim) clauses.push({ property: "Base Form", rich_text: { equals: baseTrim } });
  if (clauses.length === 0) return Promise.resolve({ found: false });
  var filter = clauses.length === 1 ? clauses[0] : { or: clauses };
  var url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  var body = JSON.stringify({ filter: filter, page_size: 1 });
  return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
    type: "apiRequest",
    url: url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + notionToken,
      "Notion-Version": "2022-06-28",
    },
    body: body,
  }).then(function (res) {
    if (!res || res.error || res.status < 200 || res.status >= 300) return { found: false };
    try {
      var data = JSON.parse(res.body || "{}");
      var results = data.results || [];
      if (results.length === 0) return { found: false };
      var page = results[0];
      var wordVal = page.properties && page.properties.Word && page.properties.Word.title && page.properties.Word.title[0] ? page.properties.Word.title[0].plain_text : "";
      var baseVal = page.properties && page.properties["Base Form"] && page.properties["Base Form"].rich_text && page.properties["Base Form"].rich_text[0] ? page.properties["Base Form"].rich_text[0].plain_text : "";
      var matchType = (wordTrim && wordVal === wordTrim) ? "word" : "base_form";
      var value = matchType === "word" ? wordVal : (baseVal || baseTrim);
      return { found: true, matchType: matchType, value: value || wordVal || baseVal };
    } catch (_) { return { found: false }; }
  }).catch(function () { return { found: false }; });
}

function queryNotionPagesByWords(notionToken, databaseId, words) {
  if (!words || words.length === 0) return Promise.resolve({});
  var normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId) return Promise.resolve({});
  var list = words.filter(function (w) { return typeof w === "string" && w.trim(); }).slice(0, 10);
  if (list.length === 0) return Promise.resolve({});
  var filter = list.length === 1
    ? { property: "Word", title: { equals: list[0] } }
    : { or: list.map(function (w) { return { property: "Word", title: { equals: w } }; }) };
  var url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  var body = JSON.stringify({ filter: filter });
  return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
    type: "apiRequest",
    url: url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + notionToken,
      "Notion-Version": "2022-06-28",
    },
    body: body,
  }).then(function (res) {
    if (!res || res.error || res.status < 200 || res.status >= 300) return {};
    try {
      var data = JSON.parse(res.body || "{}");
      var results = data.results || [];
      var map = {};
      for (var i = 0; i < results.length; i++) {
        var page = results[i];
        var titleProp = page.properties && page.properties.Word;
        if (titleProp && titleProp.title && titleProp.title[0]) {
          var plain = titleProp.title[0].plain_text;
          if (plain && !map[plain]) map[plain] = page.id;
        }
      }
      return map;
    } catch (_) { return {}; }
  }).catch(function () { return {}; });
}

function buildSynonymsRichText(synonyms, synonymToPageId) {
  if (!Array.isArray(synonyms) || synonyms.length === 0) {
    return [{ type: "text", text: { content: "" } }];
  }
  var blocks = [];
  for (var i = 0; i < synonyms.length; i++) {
    if (i > 0) blocks.push({ type: "text", text: { content: ", " } });
    var s = (synonyms[i] && typeof synonyms[i] === "string") ? synonyms[i].trim() : "";
    if (!s) continue;
    var pageId = synonymToPageId && synonymToPageId[s];
    if (pageId) {
      blocks.push({ type: "mention", mention: { type: "page", page: { id: pageId } } });
    } else {
      blocks.push({ type: "text", text: { content: s.slice(0, 2000) } });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: { content: "" } }];
}

function saveToNotionApi(payload, notionToken, databaseId) {
  var synonyms = Array.isArray(payload.synonyms) ? payload.synonyms : [];
  var wordClassSelect = normalizeWordClass(payload.word_class);

  var createPage = function (synonymToPageId) {
    var synonymsBlocks = buildSynonymsRichText(synonyms, synonymToPageId);
    const props = {
      Word: {
        title: [{ type: "text", text: { content: (payload.original || "").slice(0, 2000) } }],
      },
      Translation: {
        rich_text: [{ type: "text", text: { content: (payload.translation || "").slice(0, 2000) } }],
      },
      Synonyms: {
        rich_text: synonymsBlocks,
      },
    };
    props["Word Class"] = { select: { name: wordClassSelect || "phrase" } };
    props["Base Form"] = {
      rich_text: [{ type: "text", text: { content: (payload.base_form || payload.original || "").slice(0, 2000) } }],
    };
    var senseText = (payload.sense && typeof payload.sense === "string") ? payload.sense.trim() : "";
    if (senseText) {
      props["Sense"] = { rich_text: [{ type: "text", text: { content: senseText.slice(0, 2000) } }] };
    }

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
  };

  return queryNotionPagesByWords(notionToken, databaseId, synonyms).then(createPage);
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
        if (!result) throw new Error("DeepSeek returned nothing. Try again.");
        if (result.meanings && result.meanings.length > 0) return result;
        if (typeof result.translation === "string" && result.translation.trim()) return result;
        throw new Error("DeepSeek returned an empty translation. Try again.");
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

  if (message.type === "checkNotionExisting") {
    var word = message.word;
    var baseForm = message.baseForm;
    return getStoredOptions()
      .then(function (opts) {
        if (!opts.notionToken || !opts.notionToken.trim() || !opts.notionDatabaseId || !opts.notionDatabaseId.trim()) {
          return { found: false };
        }
        return checkNotionForExistingWordOrBaseForm(opts.notionToken.trim(), opts.notionDatabaseId.trim(), word, baseForm);
      })
      .catch(function () { return { found: false }; });
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
        var token = opts.notionToken.trim();
        var dbId = opts.notionDatabaseId.trim();

        if (payload.meanings && Array.isArray(payload.meanings) && payload.meanings.length > 0) {
          var sensePromises = payload.meanings.map(function (m) {
            var senseContext = buildSenseContext(m, payload.context);
            return callTaxonomy(payload.original, senseContext, apiKey).then(function (taxonomy) {
              var sensePayload = {
                original: payload.original,
                translation: m.translation || "",
                sense: (m.sense && typeof m.sense === "string") ? m.sense.trim() : "",
                synonyms: m.synonyms || [],
                word_class: m.word_class || "",
                base_form: payload.base_form || payload.original || "",
                taxonomy: taxonomy,
              };
              return saveToNotionApi(sensePayload, token, dbId);
            });
          });
          return Promise.all(sensePromises).then(function () {
            return { ok: true, count: payload.meanings.length };
          });
        }

        return callTaxonomy(payload.original, payload.context, apiKey).then(function (taxonomy) {
          payload.taxonomy = taxonomy;
          return saveToNotionApi(payload, token, dbId).then(function () {
            return { ok: true, count: 1 };
          });
        });
      })
      .then(function (result) {
        return result || { ok: true };
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

// On load: restore API key and Notion credentials from Keychain so they persist across restarts/reinstalls
browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", { type: "getPersistedOptions" })
  .then(function (keychain) {
    if (!keychain || typeof keychain !== "object" || keychain.error) return;
    var hasAny = (keychain.deepseekApiKey && keychain.deepseekApiKey.length) ||
      (keychain.notionToken && keychain.notionToken.length) ||
      (keychain.notionDatabaseId && keychain.notionDatabaseId.length);
    if (!hasAny) return;
    return getStoredOptions().then(function (current) {
      var merged = Object.assign({}, current);
      if (keychain.deepseekApiKey !== undefined) merged.deepseekApiKey = keychain.deepseekApiKey;
      if (keychain.notionToken !== undefined) merged.notionToken = keychain.notionToken;
      if (keychain.notionDatabaseId !== undefined) merged.notionDatabaseId = keychain.notionDatabaseId;
      return browser.storage.local.set(merged);
    });
  })
  .catch(function () {});
