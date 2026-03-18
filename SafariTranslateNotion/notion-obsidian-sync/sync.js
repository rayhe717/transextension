import fs from "node:fs/promises";
import path from "node:path";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function requiredEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function optEnv(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function sanitizeFilename(name) {
  const raw = (name && typeof name === "string") ? name.trim() : "";
  if (!raw) return "";
  return raw
    .replace(/[\/\\]/g, "-")
    .replace(/[:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeKey(s) {
  return (s && typeof s === "string") ? s.trim().toLowerCase() : "";
}

function extractPlainText(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((t) => (t && t.plain_text) ? String(t.plain_text) : "").join("").trim();
}

function extractTitleText(title) {
  if (!Array.isArray(title)) return "";
  return title.map((t) => (t && t.plain_text) ? String(t.plain_text) : "").join("").trim();
}

function getProp(page, propName) {
  const props = page && page.properties ? page.properties : {};
  return props && props[propName] ? props[propName] : null;
}

function getTextProp(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "rich_text") return extractPlainText(p.rich_text);
  if (p.type === "title") return extractTitleText(p.title);
  if (p.type === "text") return extractPlainText(p.text);
  return "";
}

function getSelectProp(page, propName) {
  const p = getProp(page, propName);
  if (!p) return "";
  if (p.type === "select" && p.select && p.select.name) return String(p.select.name).trim();
  return "";
}

function getMultiSelectProp(page, propName) {
  const p = getProp(page, propName);
  if (!p) return [];
  if (p.type === "multi_select" && Array.isArray(p.multi_select)) {
    return p.multi_select
      .map((o) => (o && o.name) ? String(o.name).trim() : "")
      .filter(Boolean);
  }
  return [];
}

function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function firstNonEmptyArray(values) {
  for (const v of values) {
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function getSelectFromAny(page, names) {
  return firstNonEmptyString(names.map((n) => getSelectProp(page, n)));
}

function getMultiSelectFromAny(page, names) {
  return firstNonEmptyArray(names.map((n) => getMultiSelectProp(page, n)));
}

function parseSynonyms(str) {
  const raw = (str || "").trim();
  if (!raw) return [];
  return raw
    .split(/[;,]/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 60);
}

function safeJsonParse(str) {
  const raw = (str || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

function yamlEscapeScalar(s) {
  const v = (s == null) ? "" : String(s);
  const needsQuotes = /[:\n\r\t]|^\s|\s$|^[-?[\]{}#,>&*!|%@"'`]|^$/.test(v);
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return needsQuotes ? `"${escaped}"` : v;
}

function parseFrontmatter(md) {
  const text = md || "";
  if (!text.startsWith("---\n")) return { fm: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { fm: {}, body: text };
  const fmText = text.slice(4, end).trimEnd();
  const body = text.slice(end + 5);

  const fm = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1];
    const rest = keyMatch[2] || "";
    if (rest === "") {
      // list
      const list = [];
      i++;
      while (i < lines.length) {
        const li = lines[i];
        const m = li.match(/^\s*-\s*(.*)$/);
        if (!m) break;
        const val = m[1].trim();
        list.push(val.replace(/^"|"$/g, ""));
        i++;
      }
      fm[key] = list;
      continue;
    }
    fm[key] = rest.replace(/^"|"$/g, "");
    i++;
  }
  return { fm, body };
}

function buildFrontmatter(fm) {
  const out = ["---"];
  const pushScalar = (k, v) => { out.push(`${k}: ${yamlEscapeScalar(v)}`); };
  const pushList = (k, arr) => {
    out.push(`${k}:`);
    const a = Array.isArray(arr) ? arr : [];
    if (!a.length) out.push(`  - ""`);
    else a.forEach((x) => out.push(`  - ${yamlEscapeScalar(x)}`));
  };

  // Preserve existing keys but write in a stable order first, then extras.
  const preferred = [
    "word",
    "base_form",
    "word_class",
    "translation",
    "sense",
    "synonyms",
    "translations",
    "senses",
    // synonyms_1..n are handled later
    "notes",
    "writer_narrative_function",
    "writer_sensory_channel",
    "writer_psychological_domain",
    "writer_action_type",
    "writer_social_function",
    "writer_atmosphere_tone",
    "writer_register",
    "writer_show_tell",
    "notion_sense_ids",
    "tags",
    "created",
  ];

  const keys = Object.keys(fm || {});
  const synonymKeys = keys.filter((k) => /^synonyms_\d+$/.test(k)).sort((a, b) => {
    const na = parseInt(a.split("_")[1], 10);
    const nb = parseInt(b.split("_")[1], 10);
    return na - nb;
  });

  const done = new Set();
  for (const k of preferred) {
    if (!(k in fm)) continue;
    done.add(k);
    const v = fm[k];
    if (Array.isArray(v)) pushList(k, v);
    else pushScalar(k, v);
  }
  for (const k of synonymKeys) {
    if (!(k in fm) || done.has(k)) continue;
    done.add(k);
    pushList(k, fm[k]);
  }
  // Any remaining keys (if user adds custom fields).
  for (const k of keys.sort()) {
    if (done.has(k)) continue;
    const v = fm[k];
    if (Array.isArray(v)) pushList(k, v);
    else pushScalar(k, v);
  }
  out.push("---", "");
  return out.join("\n");
}

function getSenseCountFromFrontmatter(fm) {
  if (fm && Array.isArray(fm.translations) && fm.translations.length) return fm.translations.length;
  if (fm && typeof fm.translation === "string" && fm.translation.trim()) return 1;
  return 0;
}

function ensureMultiSense(fm) {
  const out = { ...(fm || {}) };
  if (Array.isArray(out.translations) && Array.isArray(out.senses)) return out;

  const t = (typeof out.translation === "string") ? out.translation : "";
  const s = (typeof out.sense === "string") ? out.sense : "";
  const syn = Array.isArray(out.synonyms) ? out.synonyms : [];

  if (t || s || syn.length) {
    out.translations = [t].filter((x) => x != null);
    out.senses = [s].filter((x) => x != null);
    out.synonyms_1 = syn;
  } else {
    out.translations = [];
    out.senses = [];
  }

  delete out.translation;
  delete out.sense;
  delete out.synonyms;
  return out;
}

function appendSenseToFrontmatter(fm, sense) {
  const out = { ...(fm || {}) };
  const hasMulti = Array.isArray(out.translations) || Array.isArray(out.senses) || Object.keys(out).some((k) => /^synonyms_\d+$/.test(k));
  const existingCount = getSenseCountFromFrontmatter(out);

  if (!hasMulti && existingCount <= 1 && existingCount === 0) {
    // first sense, single-sense fields
    out.translation = sense.translation || "";
    out.sense = sense.sense || "";
    out.synonyms = sense.synonyms || [];
    return out;
  }

  // Migrate to multi-sense if needed
  const multi = ensureMultiSense(out);
  const n = (Array.isArray(multi.translations) ? multi.translations.length : 0) + 1;
  multi.translations = Array.isArray(multi.translations) ? multi.translations : [];
  multi.senses = Array.isArray(multi.senses) ? multi.senses : [];
  multi.translations.push(sense.translation || "");
  multi.senses.push(sense.sense || "");
  multi[`synonyms_${n}`] = sense.synonyms || [];
  return multi;
}

function appendSenseToBody(body, word, senseNumber, sense) {
  const parts = [];
  const b = (body || "").trimEnd();
  parts.push(b);
  if (b && !b.endsWith("\n")) parts.push("\n");
  if (b) parts.push("\n");
  if (!b) parts.push(`# ${word}\n\n`);

  parts.push(`## Sense ${senseNumber}\n`);
  parts.push(`- **Translation**: ${sense.translation || "—"}\n`);
  const synLine = (sense.synonyms && sense.synonyms.length)
    ? sense.synonyms.map((s) => `[[${s}]]`).join(", ")
    : "—";
  parts.push(`- **Synonyms**: ${synLine}\n\n`);
  const notes = (sense.notes && String(sense.notes).trim()) ? String(sense.notes).trim() : "";
  if (notes) {
    parts.push(`- **Notes**: ${notes}\n\n`);
  }
  return parts.join("");
}

async function notionRequest(token, method, urlPath, body) {
  const res = await fetch(NOTION_API_BASE + urlPath, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion API ${method} ${urlPath} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function queryInboxPages(token, databaseId) {
  const out = [];
  let cursor = undefined;
  for (;;) {
    const body = {
      page_size: 100,
      filter: {
        property: "Imported",
        checkbox: { equals: false },
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest(token, "POST", `/databases/${databaseId}/query`, body);
    const results = Array.isArray(data.results) ? data.results : [];
    out.push(...results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function markImported(token, pageId) {
  await notionRequest(token, "PATCH", `/pages/${pageId}`, {
    properties: {
      Imported: { checkbox: true },
    },
  });
}

function extractSenseFromPage(page) {
  const word = getTextProp(page, "Word");
  const baseForm = getTextProp(page, "Base form") || word;
  const translation = getTextProp(page, "Translation");
  const sense = getTextProp(page, "Sense");
  const synonyms = parseSynonyms(getTextProp(page, "Synonyms"));
  const wordClass = getSelectProp(page, "Word Class");
  const notes = getTextProp(page, "Notes");
  const writerTaxonomyRaw = getTextProp(page, "Writer Taxonomy");
  let writerTaxonomy = safeJsonParse(writerTaxonomyRaw);
  if (!writerTaxonomy) {
    // Back-compat: writer taxonomy stored as separate columns (select/multi-select).
    // Support a few common naming variants.
    const narrative_function = getSelectFromAny(page, ["Narrative Function", "narrative_function", "Narrative function"]);
    const sensory_channel = getMultiSelectFromAny(page, ["Sensory Channel", "sensory_channel", "Sensory channel"]);
    const psychological_domain = getMultiSelectFromAny(page, ["Psychological Domain", "psychological_domain", "Psychological domain"]);
    const action_type = getMultiSelectFromAny(page, ["Action Type", "action_type", "Action type"]);
    const social_function = getMultiSelectFromAny(page, ["Social Function", "social_function", "Social function"]);
    const atmosphere_tone = getMultiSelectFromAny(page, ["Atmosphere / Tone", "Atmosphere/Tone", "atmosphere_tone", "Atmosphere tone"]);
    const register = getSelectFromAny(page, ["Register", "register"]);
    const show_tell = getSelectFromAny(page, ["Show vs Tell Utility", "Show/Tell", "show_tell", "Show vs Tell"]);
    const hasAny =
      narrative_function || register || show_tell ||
      sensory_channel.length || psychological_domain.length || action_type.length || social_function.length || atmosphere_tone.length;
    if (hasAny) {
      writerTaxonomy = {
        narrative_function: narrative_function || "",
        sensory_channel: sensory_channel || [],
        psychological_domain: psychological_domain || [],
        action_type: action_type || [],
        social_function: social_function || [],
        atmosphere_tone: atmosphere_tone || [],
        register: register || "",
        show_tell: show_tell || "",
      };
    }
  }

  return {
    pageId: page && page.id ? String(page.id) : "",
    word,
    baseForm,
    translation,
    sense,
    synonyms,
    wordClass,
    notes,
    writerTaxonomy,
  };
}

function applyWriterTaxonomyIfMissing(fm, tax) {
  const out = { ...(fm || {}) };
  if (!tax || typeof tax !== "object") return out;
  const mapping = {
    writer_narrative_function: "narrative_function",
    writer_sensory_channel: "sensory_channel",
    writer_psychological_domain: "psychological_domain",
    writer_action_type: "action_type",
    writer_social_function: "social_function",
    writer_atmosphere_tone: "atmosphere_tone",
    writer_register: "register",
    writer_show_tell: "show_tell",
  };
  for (const [k, src] of Object.entries(mapping)) {
    if (k in out) continue; // do not overwrite user edits
    const v = tax[src];
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
    else if (typeof v === "string") out[k] = v.trim();
  }
  return out;
}

async function upsertSenseNote({ vaultPath, vocabFolder, sense }) {
  const key = normalizeKey(sense.baseForm) || normalizeKey(sense.word);
  const filename = sanitizeFilename(key || sense.baseForm || sense.word);
  if (!filename) throw new Error("Empty base form/word.");

  const dir = path.join(vaultPath, vocabFolder);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename + ".md");

  let existing = "";
  try { existing = await fs.readFile(filePath, "utf8"); } catch (_) {}
  const { fm: oldFm, body: oldBody } = parseFrontmatter(existing);

  const notionIds = Array.isArray(oldFm.notion_sense_ids) ? oldFm.notion_sense_ids : [];
  if (sense.pageId && notionIds.includes(sense.pageId)) {
    return { filePath, changed: false };
  }

  let fm = { ...oldFm };
  if (!("word" in fm)) fm.word = sense.baseForm || sense.word || filename;
  if (!("base_form" in fm)) fm.base_form = sense.baseForm || sense.word || filename;
  if (sense.wordClass && !("word_class" in fm)) fm.word_class = sense.wordClass;

  // notes: append only if provided and not already present (simple heuristic)
  if (sense.notes && typeof sense.notes === "string" && sense.notes.trim()) {
    const existingNotes = (typeof fm.notes === "string") ? fm.notes : "";
    if (!existingNotes) fm.notes = sense.notes.trim();
  }

  fm = applyWriterTaxonomyIfMissing(fm, sense.writerTaxonomy);

  const beforeCount = getSenseCountFromFrontmatter(fm);
  fm = appendSenseToFrontmatter(fm, sense);
  const afterCount = getSenseCountFromFrontmatter(fm);
  const senseNumber = Math.max(afterCount, beforeCount + 1);

  const updatedIds = notionIds.slice();
  if (sense.pageId) updatedIds.push(sense.pageId);
  fm.notion_sense_ids = updatedIds;

  const newFrontmatter = buildFrontmatter(fm);
  const wordForTitle = fm.word || sense.baseForm || sense.word || filename;
  const newBody = appendSenseToBody(oldBody, wordForTitle, senseNumber, sense);
  const next = newFrontmatter + newBody;

  await fs.writeFile(filePath, next, "utf8");
  return { filePath, changed: true };
}

async function main() {
  const token = requiredEnv("NOTION_TOKEN");
  const databaseId = requiredEnv("NOTION_DATABASE_ID").replace(/-/g, "");
  const vaultPath = requiredEnv("OBSIDIAN_VAULT_PATH");
  const vocabFolder = optEnv("OBSIDIAN_VOCAB_FOLDER", "vocab");

  const pages = await queryInboxPages(token, databaseId);
  if (!pages.length) {
    console.log("No inbox rows to import.");
    return;
  }

  // group by base_form key, keeping deterministic order by created_time (Notion sort already).
  const groups = new Map();
  for (const p of pages) {
    const s = extractSenseFromPage(p);
    const k = normalizeKey(s.baseForm) || normalizeKey(s.word) || "";
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  let imported = 0;
  for (const [k, senses] of groups.entries()) {
    for (const s of senses) {
      const { changed, filePath } = await upsertSenseNote({ vaultPath, vocabFolder, sense: s });
      if (changed) {
        imported++;
        console.log(`Imported: ${s.word} (${s.baseForm}) -> ${filePath}`);
      } else {
        console.log(`Skipped (already imported): ${s.word} (${s.baseForm})`);
      }
      if (s.pageId) await markImported(token, s.pageId);
    }
  }

  console.log(`Done. Imported ${imported} new sense(s).`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});

