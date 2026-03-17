/**
 * DeepSeek translate + Notion save (Node/Electron; uses fetch).
 * Ported from Safari extension background.js — no shared code; standalone.
 * Notion requests use direct HTTPS (no proxy) to avoid ECONNREFUSED when a proxy is set.
 */

const https = require("https");
const dns = require("dns").promises;
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const NOTION_URL = "https://api.notion.com/v1/pages";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_HOST = "api.notion.com";
const DEFAULT_TARGET_LANG = "Simplified Chinese";

/** Notion primary hosts (AS33191) — try these when .1 refuses. */
const NOTION_IP_FALLBACKS = ["208.103.161.32", "208.103.161.33", "208.103.161.34"];

/** Resolve api.notion.com; use known-good IPs first, then DNS. */
let cachedNotionIPs = null;
async function resolveNotionIPs() {
  if (cachedNotionIPs && cachedNotionIPs.length) return cachedNotionIPs;
  const fallbacks = NOTION_IP_FALLBACKS.slice();
  const orig = require("dns").getServers();
  try {
    require("dns").setServers(["8.8.8.8", "1.1.1.1"]);
    const addrs = await dns.resolve4(NOTION_HOST);
    const fromDns = Array.isArray(addrs) ? addrs.filter((a) => !fallbacks.includes(a)) : [];
    cachedNotionIPs = fallbacks.concat(fromDns);
    return cachedNotionIPs;
  } catch (_) {
    cachedNotionIPs = fallbacks;
    return cachedNotionIPs;
  } finally {
    require("dns").setServers(orig);
  }
}

/** HTTPS request for Notion; tries multiple IPs if one refuses. */
async function fetchNoProxy(url, options = {}) {
  const u = new URL(url);
  const body = options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined;
  const headers = Object.assign({}, options.headers);
  if (body) headers["Content-Length"] = Buffer.byteLength(body, "utf8");

  const ips = u.hostname === NOTION_HOST ? await resolveNotionIPs() : null;
  let lastErr = null;

  const tryRequest = (ip) =>
    new Promise((resolve, reject) => {
      const lookup = ip ? (hostname, opts, cb) => cb(null, ip, 4) : undefined;
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: options.method || "GET",
          headers,
          lookup,
          agent: new https.Agent(),
          rejectUnauthorized: true,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              text: () => Promise.resolve(text),
              json: () => Promise.resolve(JSON.parse(text || "{}")),
            });
          });
        }
      );
      req.on("error", reject);
      if (body) req.write(body, "utf8");
      req.end();
    });

  const toTry = ips && ips.length ? ips : [null];
  for (const ip of toTry) {
    try {
      return await tryRequest(ip);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const TAXONOMY_SYSTEM_PROMPT =
  "You are an expert psychology professor categorizing academic research vocabulary.\n\n" +
  "Your task is to classify the given term or phrase into a structured taxonomy.\n\n" +
  "STRICT RULES:\n" +
  "1. Choose exactly ONE Main Category.\n" +
  "2. Choose 1–3 Subcategories from the allowed list.\n" +
  "3. Choose exactly ONE Strength Level.\n" +
  "4. Do NOT invent new categories.\n" +
  "5. If the term is a domain concept, classify it under \"Field Concept\" and choose ONLY from:\n" +
  "   - Stereotype Threat\n" +
  "   - Self-Efficacy\n" +
  "   - Gratitude\n" +
  "   - Gratitude Journaling\n" +
  "   - Psychotherapy\n\n" +
  "Return output in STRICT JSON format:\n\n" +
  "{\n" +
  "  \"Main Category\": \"\",\n" +
  "  \"Subcategory\": [],\n" +
  "  \"Strength Level\": \"\"\n" +
  "}\n\n" +
  "TAXONOMY OPTIONS:\n\n" +
  "Main Category:\n" +
  "- Theory\n- Methodology\n- Statistics\n- Argumentation\n- Evaluation\n- Field Concept\n\n" +
  "Subcategories:\n\n" +
  "Theory: Causality, Mechanism, Construct Definition, Boundary Condition, Theoretical Integration, Conceptual Clarification\n\n" +
  "Methodology: Research Design, Measurement, Manipulation, Sampling, Validity, Reliability, Data Collection\n\n" +
  "Statistics: Effect Reporting, Interaction, Model Specification, Robustness, Uncertainty, Assumption Testing\n\n" +
  "Argumentation: Gap Statement, Contrast, Extension, Justification, Emphasis, Transition, Synthesis\n\n" +
  "Evaluation: Limitation, Strength, Generalizability, Bias, Rigor, Replicability\n\n" +
  "Field Concept: Stereotype Threat, Self-Efficacy, Gratitude, Gratitude Journaling, Psychotherapy\n\n" +
  "Strength Level:\n" +
  "- Very Cautious\n- Cautious\n- Neutral\n- Moderate Claim\n- Strong Claim";

function parseTaxonomyResponse(text) {
  const out = { mainCategory: "", subcategory: [], strengthLevel: "" };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    if (parsed["Main Category"] && typeof parsed["Main Category"] === "string") out.mainCategory = parsed["Main Category"].trim();
    if (Array.isArray(parsed["Subcategory"])) out.subcategory = parsed["Subcategory"].filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    if (parsed["Strength Level"] && typeof parsed["Strength Level"] === "string") out.strengthLevel = parsed["Strength Level"].trim();
  } catch (_) {}
  return out;
}

async function callTaxonomy(term, apiKey) {
  if (!term || typeof term !== "string" || !term.trim() || !apiKey) return parseTaxonomyResponse("");
  const userContent = "Now classify this term:\n\nTERM: \"" + term.trim().slice(0, 500) + "\"";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: TAXONOMY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: 256,
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body,
  });
  const responseText = await res.text();
  if (res.status < 200 || res.status >= 300) return parseTaxonomyResponse("");
  try {
    const data = JSON.parse(responseText);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseTaxonomyResponse(content || "");
  } catch (_) {
    return parseTaxonomyResponse("");
  }
}

async function generateExampleSentence(word, apiKey) {
  if (!word || typeof word !== "string" || !word.trim() || !apiKey) return null;
  const term = word.trim().slice(0, 200);
  const userContent = "Write exactly one academic English sentence that uses the word \"" + term + "\" naturally. Length: 20–35 words. Output only the sentence, no quotes or numbering.";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "user", content: userContent },
    ],
    max_tokens: 120,
    temperature: 0.3,
  });
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) return null;
    const data = JSON.parse(text);
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const sentence = (typeof content === "string" ? content.trim() : "").replace(/^["']|["']$/g, "");
    return sentence || null;
  } catch (_) {
    return null;
  }
}

function normalizeDatabaseId(id) {
  if (!id || typeof id !== "string") return "";
  return id.trim().replace(/-/g, "");
}

function formatMeaningsAsTranslation(meanings) {
  if (!Array.isArray(meanings) || meanings.length === 0) return "";
  const parts = [];
  for (let i = 0; i < meanings.length; i++) {
    const m = meanings[i];
    const trans = (m && typeof m.translation === "string") ? m.translation.trim() : "";
    if (!trans) continue;
    const sense = (m && typeof m.sense === "string") ? m.sense.trim() : "";
    parts.push((parts.length + 1) + ". " + trans + (sense ? " (" + sense + ")" : ""));
  }
  return parts.join("\n");
}

function parseTranslationResponse(text) {
  const out = { translation: "", synonyms: [], base_form: "", meanings: null };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  function extract(parsed) {
    if (Array.isArray(parsed.meanings) && parsed.meanings.length > 0) {
      out.translation = formatMeaningsAsTranslation(parsed.meanings);
      out.meanings = parsed.meanings.map((m) => ({
        sense: (m && typeof m.sense === "string") ? m.sense.trim() : "",
        translation: (m && typeof m.translation === "string") ? m.translation.trim() : "",
        synonyms: Array.isArray(m.synonyms) ? m.synonyms.filter((s) => typeof s === "string") : [],
      })).filter((m) => m.translation);
      if (out.meanings.length === 0) out.meanings = null;
    } else if (parsed && typeof parsed.translation === "string") {
      out.translation = parsed.translation;
      if (Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter((s) => typeof s === "string");
      out.meanings = [{ translation: out.translation, sense: "", synonyms: out.synonyms }];
    }
    if (parsed && typeof parsed.base_form === "string") out.base_form = parsed.base_form.trim();
  }
  try {
    extract(JSON.parse(trimmed));
    return out;
  } catch (_) {}
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return out;
  try {
    extract(JSON.parse(jsonMatch[0]));
  } catch (_) {}
  return out;
}

async function translateWithDeepSeek(text, apiKey, targetLanguage) {
  const lang = targetLanguage || DEFAULT_TARGET_LANG;
  const systemPrompt =
    "Translate to " + lang + ". Reply with JSON only. For words with multiple distinct meanings (e.g. twitchy = twitching a lot, or nervous/anxious), use a \"meanings\" array: {\"meanings\": [{\"sense\": \"<short English gloss>\", \"translation\": \"<target translation>\", \"synonyms\": [\"...\"]}, ...], \"base_form\": \"<lemma>\"}. For a single meaning you may use either \"meanings\": [{\"sense\": \"\", \"translation\": \"...\", \"synonyms\": [...]}] or the shorthand {\"translation\": \"...\", \"synonyms\": [...], \"base_form\": \"...\"}. IMPORTANT: synonyms must be English words/phrases with similar meaning — never translate synonyms. sense is a brief English gloss. base_form is the dictionary/root form. If input is already base form or a phrase, set base_form to the input itself.";
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

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body,
  });
  const responseText = await res.text();
  if (res.status === 401) throw new Error("Invalid DeepSeek API key. Check Settings.");
  if (res.status === 429) throw new Error("Rate limit exceeded. Try again in a moment.");
  if (res.status < 200 || res.status >= 300) throw new Error(responseText || "DeepSeek request failed (" + res.status + ")");
  const data = JSON.parse(responseText);
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseTranslationResponse(content);
}

async function queryNotionPagesByWords(notionToken, databaseId, words) {
  if (!words || words.length === 0) return {};
  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId) return {};
  const list = words.filter((w) => typeof w === "string" && w.trim()).slice(0, 10);
  if (list.length === 0) return {};
  const filter = list.length === 1
    ? { property: "Word", title: { equals: list[0] } }
    : { or: list.map((w) => ({ property: "Word", title: { equals: w } })) };
  const url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  let res;
  try {
    res = await fetchNoProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + notionToken,
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ filter, sorts: [{ timestamp: "created_time", direction: "descending" }] }),
    });
  } catch (fetchErr) {
    const cause = fetchErr && fetchErr.cause;
    const detail = cause ? (cause.message || cause.code || String(cause)) : (fetchErr && fetchErr.message);
    throw new Error("Notion request failed (network): " + (detail || "fetch failed"));
  }
  if (!res.ok) return {};
  const data = await res.json();
  const results = data.results || [];
  const map = {};
  for (let i = 0; i < results.length; i++) {
    const page = results[i];
    const titleProp = page.properties && page.properties.Word;
    if (titleProp && titleProp.title && titleProp.title[0]) {
      const plain = titleProp.title[0].plain_text;
      if (plain && !map[plain]) map[plain] = page.id;
    }
  }
  return map;
}

/** Check if word or base form already exists in Notion. Returns { found, value } or { found: false }. */
async function checkNotionExisting(notionToken, databaseId, word, baseForm) {
  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId || !notionToken) return { found: false };
  const wordTrim = (word && typeof word === "string") ? word.trim() : "";
  const baseTrim = (baseForm && typeof baseForm === "string") ? baseForm.trim() : "";
  if (!wordTrim && !baseTrim) return { found: false };
  const clauses = [];
  if (wordTrim) clauses.push({ property: "Word", title: { equals: wordTrim } });
  if (baseTrim && baseTrim !== wordTrim) clauses.push({ property: "Base Form", rich_text: { equals: baseTrim } });
  if (clauses.length === 0) return { found: false };
  const filter = clauses.length === 1 ? clauses[0] : { or: clauses };
  const url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  let res;
  try {
    res = await fetchNoProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + notionToken,
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ filter, page_size: 1, sorts: [{ timestamp: "created_time", direction: "descending" }] }),
    });
  } catch (_) {
    return { found: false };
  }
  if (!res.ok) return { found: false };
  const data = await res.json();
  const results = data.results || [];
  if (results.length === 0) return { found: false };
  const page = results[0];
  const wordVal = page.properties && page.properties.Word && page.properties.Word.title && page.properties.Word.title[0] ? page.properties.Word.title[0].plain_text : "";
  const baseVal = page.properties && page.properties["Base Form"] && page.properties["Base Form"].rich_text && page.properties["Base Form"].rich_text[0] ? page.properties["Base Form"].rich_text[0].plain_text : "";
  const matchType = (wordTrim && wordVal === wordTrim) ? "word" : "base_form";
  const value = matchType === "word" ? wordVal : (baseVal || baseTrim);
  return { found: true, matchType, value: value || wordVal || baseVal };
}

/** Query pages where Synonyms rich_text contains the word. Returns array of pages. */
async function queryNotionPagesWhereSynonymsContain(notionToken, databaseId, word) {
  const wordTrim = (word && typeof word === "string") ? word.trim() : "";
  if (!wordTrim) return [];
  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId || !notionToken) return [];
  const url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  let res;
  try {
    res = await fetchNoProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + notionToken,
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        filter: { property: "Synonyms", rich_text: { contains: wordTrim } },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 100,
      }),
    });
  } catch (_) {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

/** Get Word titles of pages where Synonyms contains word or baseForm. */
async function getWordTitlesWhereSynonymsContain(notionToken, databaseId, word, baseForm) {
  const wordTrim = (word && typeof word === "string") ? word.trim() : "";
  const baseTrim = (baseForm && typeof baseForm === "string") ? baseForm.trim() : "";
  const titles = {};
  const collect = (pages) => {
    for (let i = 0; i < (pages || []).length; i++) {
      const p = pages[i];
      const titleProp = p && p.properties && p.properties.Word;
      const t = titleProp && titleProp.title && titleProp.title[0] ? titleProp.title[0].plain_text : "";
      if (t) titles[t] = true;
    }
  };
  const [r1, r2] = await Promise.all([
    wordTrim ? queryNotionPagesWhereSynonymsContain(notionToken, databaseId, wordTrim) : Promise.resolve([]),
    baseTrim && baseTrim !== wordTrim ? queryNotionPagesWhereSynonymsContain(notionToken, databaseId, baseTrim) : Promise.resolve([]),
  ]);
  collect(r1);
  collect(r2);
  return Object.keys(titles);
}

function buildSynonymsRichText(synonyms, synonymToPageId) {
  if (!Array.isArray(synonyms) || synonyms.length === 0) {
    return [{ type: "text", text: { content: "" } }];
  }
  const blocks = [];
  for (let i = 0; i < synonyms.length; i++) {
    if (i > 0) blocks.push({ type: "text", text: { content: ", " } });
    const s = (synonyms[i] && typeof synonyms[i] === "string") ? synonyms[i].trim() : "";
    if (!s) continue;
    const pageId = synonymToPageId && synonymToPageId[s];
    if (pageId) {
      blocks.push({ type: "mention", mention: { type: "page", page: { id: pageId } } });
    } else {
      blocks.push({ type: "text", text: { content: s.slice(0, 2000) } });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: { content: "" } }];
}

async function saveToNotionApi(payload, notionToken, databaseId) {
  const synonyms = Array.isArray(payload.synonyms) ? payload.synonyms : [];

  const synonymToPageId = await queryNotionPagesByWords(notionToken, databaseId, synonyms);
  const synonymsBlocks = buildSynonymsRichText(synonyms, synonymToPageId);
  const props = {
    Word: { title: [{ type: "text", text: { content: (payload.original || "").slice(0, 2000) } }] },
    Translation: { rich_text: [{ type: "text", text: { content: (payload.translation || "").slice(0, 2000) } }] },
    Synonyms: { rich_text: synonymsBlocks },
    "Base Form": { rich_text: [{ type: "text", text: { content: (payload.base_form || payload.original || "").slice(0, 2000) } }] },
  };
  const senseText = (payload.sense && typeof payload.sense === "string") ? payload.sense.trim() : "";
  if (senseText) props["Sense"] = { rich_text: [{ type: "text", text: { content: senseText.slice(0, 2000) } }] };

  const tax = payload.taxonomy;
  if (tax) {
    if (tax.mainCategory) props["Main Category"] = { select: { name: tax.mainCategory } };
    if (Array.isArray(tax.subcategory) && tax.subcategory.length) {
      props["Subcategory"] = { multi_select: tax.subcategory.slice(0, 10).map((n) => ({ name: n })) };
    }
    if (tax.strengthLevel) props["Strength Level"] = { select: { name: tax.strengthLevel } };
  }

  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId) throw new Error("Notion: Database ID is empty. Check Settings.");

  const body = JSON.stringify({
    parent: { type: "database_id", database_id: normalizedDbId },
    properties: props,
  });

  let res;
  try {
    res = await fetchNoProxy(NOTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + notionToken,
        "Notion-Version": "2022-06-28",
      },
      body,
    });
  } catch (fetchErr) {
    const cause = fetchErr && fetchErr.cause;
    const detail = cause ? (cause.message || cause.code || String(cause)) : (fetchErr && fetchErr.message);
    throw new Error("Notion request failed (network): " + (detail || "fetch failed"));
  }
  const text = await res.text();
  if (res.status === 401) throw new Error("Notion: Invalid API secret. Check Settings.");
  if (res.status === 403) throw new Error("Notion: No access. Add your integration to the database connections.");
  if (res.status === 404) throw new Error("Notion: Database not found. Check Database ID.");
  if (res.status < 200 || res.status >= 300) {
    let detail = "";
    try {
      const j = JSON.parse(text);
      detail = (j && j.message) || "";
    } catch (_) {}
    throw new Error("Notion: " + (detail || "Request failed"));
  }
  return text ? JSON.parse(text) : {};
}

const WRITING_SUPPORT_ACTIONS = {
  writing_comment: "Give brief writing feedback (style, clarity, tone) for this excerpt. Be concise, 2–4 sentences.",
  better_word: "Suggest a more precise or stronger word or phrase for the highlighted part. Reply with the suggested word/phrase and one short sentence explaining why it works better.",
  suggest_word: "The user may mark where they need a word with []. Suggest a word or short phrase to replace [] so it fits naturally in the context. Reply with the suggestion and a brief reason.",
  lookup_chinese: "Look up Chinese or similar senses in your Notion vocabulary and return matching English word(s).",
};

/** Query Notion for pages where Translation contains any of the terms (full text or individual chars). */
async function queryNotionPagesWhereTranslationContainsAny(notionToken, databaseId, text) {
  const textTrim = (text && typeof text === "string") ? text.trim() : "";
  if (!textTrim) return [];
  const normalizedDbId = normalizeDatabaseId(databaseId);
  if (!normalizedDbId || !notionToken) return [];
  const terms = [textTrim];
  for (let i = 0; i < textTrim.length && i < 8; i++) {
    const ch = textTrim[i];
    if (ch && !terms.includes(ch)) terms.push(ch);
  }
  if (terms.length > 10) terms.splice(10);
  const orClauses = terms.map((t) => ({ property: "Translation", rich_text: { contains: t } }));
  const filter = orClauses.length === 1 ? orClauses[0] : { or: orClauses };
  const url = NOTION_API_BASE + "/databases/" + normalizedDbId + "/query";
  let res;
  try {
    res = await fetchNoProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + notionToken,
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ filter, sorts: [{ timestamp: "created_time", direction: "descending" }], page_size: 100 }),
    });
  } catch (_) {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  const results = data.results || [];
  const seen = {};
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const p = results[i];
    const wordT = p.properties && p.properties.Word && p.properties.Word.title && p.properties.Word.title[0] ? p.properties.Word.title[0].plain_text : "";
    if (!wordT || seen[wordT]) continue;
    seen[wordT] = true;
    const transT = p.properties && p.properties.Translation && p.properties.Translation.rich_text && p.properties.Translation.rich_text[0] ? p.properties.Translation.rich_text[0].plain_text : "";
    const senseT = p.properties && p.properties.Sense && p.properties.Sense.rich_text && p.properties.Sense.rich_text[0] ? p.properties.Sense.rich_text[0].plain_text : "";
    out.push({ word: wordT, translation: transT || "", sense: senseT || "" });
  }
  return out;
}

/** DeepSeek: 3 English suggestions for Chinese text. */
async function getChineseToEnglishSuggestions(chineseText, apiKey) {
  const prompt = "The user has a Chinese word or phrase. Provide exactly three possible English translations or equivalents, one per line. No numbering, no explanation, just the three lines of text.";
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: prompt + "\n\nChinese: " + chineseText }],
    max_tokens: 150,
    temperature: 0.3,
  });
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body,
  });
  const responseText = await res.text();
  if (res.status === 401) throw new Error("Invalid DeepSeek API key. Check Settings.");
  if (res.status === 429) throw new Error("Rate limit exceeded. Try again in a moment.");
  if (res.status < 200 || res.status >= 300) throw new Error(responseText || "Request failed");
  const data = JSON.parse(responseText || "{}");
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = (content && typeof content === "string") ? content.trim() : "";
  if (!text) return null;
  const lines = text.split(/\n/).map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  return lines.slice(0, 3).join("\n") || null;
}

/** DeepSeek: writing support (comment, better word, suggest word). */
async function writingSupportWithDeepSeek(text, action, vocabLines, apiKey) {
  const promptSpec = WRITING_SUPPORT_ACTIONS[action] || WRITING_SUPPORT_ACTIONS.writing_comment;
  let systemContent = "You are a fiction writing assistant. " + promptSpec + " Reply in plain text, no JSON.";
  if (vocabLines && vocabLines.length > 0) {
    systemContent += "\n\nThe writer has this vocabulary (word / translation / sense). When suggesting words, prefer or draw from this list when it fits:\n" + vocabLines.slice(0, 500).map((e) => (e.word || "") + " | " + (e.translation || "") + (e.sense ? " | " + e.sense : "")).join("\n");
  }
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: text },
    ],
    max_tokens: 512,
    temperature: 0.3,
  });
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body,
  });
  const responseText = await res.text();
  if (res.status === 401) throw new Error("Invalid DeepSeek API key. Check Settings.");
  if (res.status === 429) throw new Error("Rate limit exceeded. Try again in a moment.");
  if (res.status < 200 || res.status >= 300) throw new Error(responseText || "Request failed");
  const data = JSON.parse(responseText || "{}");
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (content && typeof content === "string") ? content.trim() : "";
}

/** Main writing support handler. Returns { result }, { fromNotion, fromDeepSeek }, or { error }. */
async function writingSupport(text, action, notionToken, databaseId, apiKey) {
  const textTrim = (text && typeof text === "string") ? text.trim() : "";
  if (!textTrim) return { error: "No text provided." };
  const act = action && WRITING_SUPPORT_ACTIONS[action] ? action : "writing_comment";

  if (act === "lookup_chinese") {
    if (!notionToken || !databaseId) return { error: "Set your Notion API secret and Database ID in Settings." };
    try {
      const entries = await queryNotionPagesWhereTranslationContainsAny(notionToken, databaseId, textTrim);
      if (entries.length > 0) {
        const lines = entries.map((e) => {
          const part = e.word + (e.translation ? " — " + e.translation : "");
          return part + (e.sense ? " (" + e.sense + ")" : "");
        });
        return { fromNotion: lines.join("\n"), fromDeepSeek: null };
      }
      if (!apiKey) return { fromNotion: null, fromDeepSeek: null, error: "No matches in your Notion database. Set your DeepSeek API key in Settings to get AI suggestions." };
      try {
        const suggestions = await getChineseToEnglishSuggestions(textTrim, apiKey);
        return { fromNotion: null, fromDeepSeek: suggestions || null };
      } catch (err) {
        return { fromNotion: null, fromDeepSeek: null, error: (err && err.message) ? err.message : "No matches in Notion and suggestion request failed." };
      }
    } catch (err) {
      return { error: (err && err.message) ? err.message : "Lookup failed." };
    }
  }

  if (!apiKey) return { error: "Set your DeepSeek API key in Settings." };
  try {
    const result = await writingSupportWithDeepSeek(textTrim, act, [], apiKey);
    return { result };
  } catch (err) {
    return { error: (err && err.message) ? err.message : "Writing support failed." };
  }
}

module.exports = {
  translateWithDeepSeek,
  saveToNotionApi,
  callTaxonomy,
  generateExampleSentence,
  checkNotionExisting,
  getWordTitlesWhereSynonymsContain,
  writingSupport,
  writingSupportWithDeepSeek,
  getChineseToEnglishSuggestions,
  DEFAULT_TARGET_LANG,
};
