/**
 * Notion → Obsidian sync logic (browser version).
 * Ported from notion-obsidian-sync/sync.js — replaces Node fs with
 * the File System Access API and adds IndexedDB handle persistence.
 *
 * Public API:
 *   runObsidianSync({ token, databaseId, rootDirHandle, vocabFolder, onLog })
 *   openSyncDB() / saveVaultHandle(h) / loadVaultHandle()
 */

(function (global) {
  "use strict";

  // ── String helpers ────────────────────────────────────────────────────────

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
    return raw.split(/[;,]/g).map((s) => s.trim()).filter(Boolean).slice(0, 60);
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

  // ── YAML / frontmatter helpers ────────────────────────────────────────────

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

    const preferred = [
      "word", "base_form", "word_class", "translation", "sense", "synonyms",
      "translations", "senses", "notes",
      "writer_narrative_function", "writer_sensory_channel", "writer_psychological_domain",
      "writer_action_type", "writer_social_function", "writer_atmosphere_tone",
      "writer_register", "writer_show_tell",
      "notion_sense_ids", "tags", "created",
    ];

    const keys = Object.keys(fm || {});
    const synonymKeys = keys
      .filter((k) => /^synonyms_\d+$/.test(k))
      .sort((a, b) => parseInt(a.split("_")[1], 10) - parseInt(b.split("_")[1], 10));

    const done = new Set();
    for (const k of preferred) {
      if (!(k in fm)) continue;
      done.add(k);
      Array.isArray(fm[k]) ? pushList(k, fm[k]) : pushScalar(k, fm[k]);
    }
    for (const k of synonymKeys) {
      if (!(k in fm) || done.has(k)) continue;
      done.add(k);
      pushList(k, fm[k]);
    }
    for (const k of keys.sort()) {
      if (done.has(k)) continue;
      Array.isArray(fm[k]) ? pushList(k, fm[k]) : pushScalar(k, fm[k]);
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
    const hasMulti =
      Array.isArray(out.translations) ||
      Array.isArray(out.senses) ||
      Object.keys(out).some((k) => /^synonyms_\d+$/.test(k));
    const existingCount = getSenseCountFromFrontmatter(out);

    if (!hasMulti && existingCount === 0) {
      out.translation = sense.translation || "";
      out.sense = sense.sense || "";
      out.synonyms = sense.synonyms || [];
      return out;
    }
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
    if (notes) parts.push(`- **Notes**: ${notes}\n\n`);
    return parts.join("");
  }

  // ── Notion API ────────────────────────────────────────────────────────────
  // Use XMLHttpRequest — Chrome extension pages bypass CORS for host_permissions
  // origins with XHR (unlike fetch, which still enforces CORS preflights).
  // On Safari the native messaging host handles calls in background.js instead,
  // so this code only runs in the options page context on Chrome.

  function notionXHR(token, method, urlPath, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, "https://api.notion.com/v1" + urlPath);
      xhr.setRequestHeader("Authorization", "Bearer " + token);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Notion-Version", "2022-06-28");
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { resolve({}); }
        } else {
          reject(new Error("Notion API " + method + " " + urlPath + " failed (" + xhr.status + "): " + xhr.responseText.slice(0, 300)));
        }
      };
      xhr.onerror = function () { reject(new Error("Notion network error (XHR)")); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function runtimeSyncRequest(type, payload) {
    if (typeof browser === "undefined" || !browser.runtime || typeof browser.runtime.sendMessage !== "function") {
      return Promise.reject(new Error("Extension runtime unavailable"));
    }
    return browser.runtime.sendMessage(Object.assign({ type: type }, payload || {})).then(function (res) {
      if (!res) throw new Error("No response from background");
      if (res.error) throw new Error(String(res.error));
      return res;
    });
  }

  function isChromeBrowser() {
    try {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) ? navigator.userAgent : "";
      const vendor = (typeof navigator !== "undefined" && navigator.vendor) ? navigator.vendor : "";
      return /Chrome/i.test(ua) && /Google Inc\./i.test(vendor);
    } catch (_) {
      return false;
    }
  }

  var LOCAL_IMPORTED_IDS_KEY = "syncImportedLocalIds";

  async function loadLocalImportedIdSet() {
    if (typeof browser === "undefined" || !browser.storage || !browser.storage.local) {
      return new Set();
    }
    try {
      const items = await browser.storage.local.get({ [LOCAL_IMPORTED_IDS_KEY]: [] });
      const arr = Array.isArray(items[LOCAL_IMPORTED_IDS_KEY]) ? items[LOCAL_IMPORTED_IDS_KEY] : [];
      return new Set(arr.map((x) => String(x)).filter(Boolean));
    } catch (_) {
      return new Set();
    }
  }

  async function saveLocalImportedIdSet(idSet) {
    if (typeof browser === "undefined" || !browser.storage || !browser.storage.local) return;
    try {
      // Keep storage bounded.
      const arr = Array.from(idSet).slice(-20000);
      await browser.storage.local.set({ [LOCAL_IMPORTED_IDS_KEY]: arr });
    } catch (_) {}
  }

  async function queryInboxPages(token, databaseId) {
    // Prefer background offscreen fetch path on Chrome.
    let bgErr = null;
    try {
      var r = await runtimeSyncRequest("syncQueryPages", { token: token, databaseId: databaseId });
      if (r && Array.isArray(r.pages)) return r.pages;
    } catch (e) {
      bgErr = e;
      var isChrome = (typeof chrome !== "undefined" && !!chrome.runtime);
      if (isChrome) {
        throw new Error("Background sync failed: " + (e && e.message ? e.message : String(e)));
      }
    }

    const out = [];
    let cursor;
    for (;;) {
      const body = {
        page_size: 100,
        filter: { property: "Imported", checkbox: { equals: false } },
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
      };
      if (cursor) body.start_cursor = cursor;
      const data = await notionXHR(token, "POST", "/databases/" + databaseId + "/query", body);
      const results = Array.isArray(data.results) ? data.results : [];
      out.push(...results);
      if (!data.has_more) break;
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function markImported(token, pageId) {
    // In Chrome extension context, Notion PATCH is blocked by CORS/preflight behavior.
    // Query (POST) works, but PATCH consistently fails; use local checkpoint fallback.
    if (isChromeBrowser()) {
      const err = new Error("Notion PATCH blocked in Chrome extension context");
      err.code = "PATCH_UNSUPPORTED_CHROME";
      throw err;
    }
    // Prefer background offscreen fetch path on Chrome.
    try {
      await runtimeSyncRequest("syncMarkImported", { token: token, pageId: pageId });
      return;
    } catch (e) {
      // Chrome PATCH via background/offscreen can fail preflight; fall back to
      // direct XHR from options page, which works better with extension host permissions.
      const bgMsg = (e && e.message) ? e.message : String(e);
      try {
        await notionXHR(token, "PATCH", "/pages/" + pageId, {
          properties: { Imported: { checkbox: true } },
        });
        return;
      } catch (xhrErr) {
        const xhrMsg = (xhrErr && xhrErr.message) ? xhrErr.message : String(xhrErr);
        throw new Error("Background markImported failed: " + bgMsg + " | XHR fallback failed: " + xhrMsg);
      }
    }
  }

  function extractSenseFromPage(page) {
    const word = getTextProp(page, "Word");
    const baseForm = firstNonEmptyString([getTextProp(page, "Base Form"), getTextProp(page, "Base form")]) || word;
    const translation = getTextProp(page, "Translation");
    const sense = getTextProp(page, "Sense");
    const synonyms = parseSynonyms(getTextProp(page, "Synonyms"));
    const wordClass = getSelectProp(page, "Word Class");
    const notes = getTextProp(page, "Notes");
    const writerTaxonomyRaw = getTextProp(page, "Writer Taxonomy");
    let writerTaxonomy = safeJsonParse(writerTaxonomyRaw);
    if (!writerTaxonomy) {
      const narrative_function = getSelectFromAny(page, ["Narrative Function", "narrative_function", "Narrative function"]);
      const sensory_channel = getMultiSelectFromAny(page, ["Sensory Channel", "sensory_channel", "Sensory channel"]);
      const psychological_domain = getMultiSelectFromAny(page, ["Psychological Domain", "psychological_domain", "Psychological domain"]);
      const action_type = getMultiSelectFromAny(page, ["Action Type", "action_type", "Action type"]);
      const social_function = getMultiSelectFromAny(page, ["Social Function", "social_function", "Social function"]);
      const atmosphere_tone = getMultiSelectFromAny(page, ["Atmosphere Tone", "Atmosphere / Tone", "Atmosphere/Tone", "atmosphere_tone", "Atmosphere tone"]);
      const register = getSelectFromAny(page, ["Register", "register"]);
      const show_tell = getSelectFromAny(page, ["Show Tell", "Show vs Tell Utility", "Show/Tell", "show_tell", "Show vs Tell"]);
      const hasAny =
        narrative_function || register || show_tell ||
        sensory_channel.length || psychological_domain.length ||
        action_type.length || social_function.length || atmosphere_tone.length;
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
    return { pageId: page && page.id ? String(page.id) : "", word, baseForm, translation, sense, synonyms, wordClass, notes, writerTaxonomy };
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
      if (k in out) continue;
      const v = tax[src];
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      else if (typeof v === "string") out[k] = v.trim();
    }
    return out;
  }

  function ensureTagsForNarrativeFunction(fm) {
    const out = { ...(fm || {}) };
    const func = (out.writer_narrative_function && typeof out.writer_narrative_function === "string")
      ? out.writer_narrative_function.trim() : "";
    if (!func) return out;
    const tags = Array.isArray(out.tags) ? out.tags.slice() : [];
    const want = [`func/${func}`];
    for (const t of want) {
      if (!tags.includes(t)) tags.push(t);
    }
    out.tags = tags;
    return out;
  }

  // ── File System Access API helpers ────────────────────────────────────────

  async function upsertSenseNote({ subDirHandle, sense }) {
    const key = normalizeKey(sense.baseForm) || normalizeKey(sense.word);
    const filename = sanitizeFilename(key || sense.baseForm || sense.word);
    if (!filename) throw new Error("Empty base form/word — skipping.");

    const mdFilename = filename + ".md";

    let existing = "";
    try {
      const fh = await subDirHandle.getFileHandle(mdFilename);
      const file = await fh.getFile();
      existing = await file.text();
    } catch (_) {}

    const { fm: oldFm, body: oldBody } = parseFrontmatter(existing);

    const notionIds = Array.isArray(oldFm.notion_sense_ids) ? oldFm.notion_sense_ids : [];
    if (sense.pageId && notionIds.includes(sense.pageId)) {
      return { filename: mdFilename, changed: false };
    }

    let fm = { ...oldFm };
    if (!("word" in fm)) fm.word = sense.baseForm || sense.word || filename;
    if (!("base_form" in fm)) fm.base_form = sense.baseForm || sense.word || filename;
    if (sense.wordClass && !("word_class" in fm)) fm.word_class = sense.wordClass;

    if (sense.notes && typeof sense.notes === "string" && sense.notes.trim()) {
      const existingNotes = (typeof fm.notes === "string") ? fm.notes : "";
      if (!existingNotes) fm.notes = sense.notes.trim();
    }

    fm = applyWriterTaxonomyIfMissing(fm, sense.writerTaxonomy);
    fm = ensureTagsForNarrativeFunction(fm);

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

    const writeFh = await subDirHandle.getFileHandle(mdFilename, { create: true });
    const writable = await writeFh.createWritable();
    await writable.write(next);
    await writable.close();

    return { filename: mdFilename, changed: true };
  }

  // ── IndexedDB handle persistence ─────────────────────────────────────────

  function openSyncDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("obsidian-sync-db", 1);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore("handles");
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function saveVaultHandle(handle) {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "obsidianVault");
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function loadVaultHandle() {
    const db = await openSyncDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("obsidianVault");
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string}                       opts.token          Notion API token
   * @param {string}                       opts.databaseId     Notion database ID
   * @param {FileSystemDirectoryHandle}    opts.rootDirHandle  Obsidian vault root
   * @param {string}                       opts.vocabFolder    Subfolder name (e.g. "Vocab_ao3")
   * @param {function(string): void}       opts.onLog          Progress callback
   * @returns {Promise<{imported: number}>}
   */
  async function runObsidianSync({ token, databaseId, rootDirHandle, vocabFolder, onLog }) {
    const log = (typeof onLog === "function") ? onLog : () => {};
    const databaseIdClean = databaseId.replace(/-/g, "");

    log("Querying Notion for unimported entries…");
    const pagesFromNotion = await queryInboxPages(token, databaseIdClean);
    const localImportedIds = await loadLocalImportedIdSet();
    const pages = pagesFromNotion.filter((p) => {
      const id = p && p.id ? String(p.id) : "";
      return id ? !localImportedIds.has(id) : true;
    });
    const skippedByLocal = pagesFromNotion.length - pages.length;
    if (skippedByLocal > 0) {
      log("Skipped " + skippedByLocal + " page(s) already tracked as imported locally.");
    }

    if (!pages.length) {
      log("No new entries to import.");
      return { imported: 0 };
    }

    log(`Found ${pages.length} page(s). Writing to vault…`);
    const subDirHandle = await rootDirHandle.getDirectoryHandle(vocabFolder, { create: true });

    const groups = new Map();
    for (const p of pages) {
      const s = extractSenseFromPage(p);
      const k = normalizeKey(s.baseForm) || normalizeKey(s.word) || "";
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }

    let imported = 0;
    let processed = 0;
    let total = 0;
    for (const senses of groups.values()) total += senses.length;
    let markImportedFailed = 0;
    const markImportedFailedIds = [];
    let warnedChromePatch = false;
    let localImportedChanged = false;
    for (const senses of groups.values()) {
      for (const s of senses) {
        const { changed, filename } = await upsertSenseNote({ subDirHandle, sense: s });
        if (changed) {
          imported++;
        }
        processed++;
        if (processed === 1 || processed % 5 === 0 || processed === total) {
          log(`Sync progress: ${processed}/${total} (imported ${imported}, mark-fail ${markImportedFailed})`);
        }
        if (s.pageId) {
          try {
            await markImported(token, s.pageId);
            if (localImportedIds.has(s.pageId)) {
              localImportedIds.delete(s.pageId);
              localImportedChanged = true;
            }
          } catch (err) {
            markImportedFailed++;
            markImportedFailedIds.push(s.pageId);
            localImportedIds.add(s.pageId);
            localImportedChanged = true;
            const code = err && err.code ? String(err.code) : "";
            if (code === "PATCH_UNSUPPORTED_CHROME") {
              if (!warnedChromePatch) {
                warnedChromePatch = true;
                log("INFO: Chrome blocks Notion PATCH from this extension. Using local imported-ID checkpoint mode.");
              }
            } else {
              log(
                "WARNING: Imported file but could not mark Notion page as Imported (" +
                s.pageId + "): " + ((err && err.message) ? err.message : String(err))
              );
            }
          }
        }
      }
    }

    if (localImportedChanged) {
      await saveLocalImportedIdSet(localImportedIds);
    }

    if (markImportedFailed > 0) {
      const preview = markImportedFailedIds.slice(0, 10).join(", ");
      log(
        "Done with warnings. Imported " + imported +
        " sense(s), but failed to mark " + markImportedFailed +
        " Notion page(s) as Imported. Those page IDs are now tracked locally to avoid re-import loops."
      );
      log(
        "Unmarked page IDs (first " + Math.min(markImportedFailedIds.length, 10) + "): " +
        preview + (markImportedFailedIds.length > 10 ? " ... +" + (markImportedFailedIds.length - 10) + " more" : "")
      );
    } else {
      log(`Done. Imported ${imported} new sense(s).`);
    }
    return { imported, markImportedFailed, markImportedFailedIds };
  }

  // Expose to global scope (loaded as a plain <script> tag)
  global.ObsidianSync = { runObsidianSync, upsertSenseNote, saveVaultHandle, loadVaultHandle, parseFrontmatter, buildFrontmatter };

})(window);
