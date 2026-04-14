const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownView } = require("obsidian");

const DEFAULT_SETTINGS = {
  deepseekApiKey: "",
  targetLanguage: "Simplified Chinese",
  vocabFolder: "Vocab_ao3",
  maxSelectionLength: 120,
};

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
    if (!keyMatch) {
      i++;
      continue;
    }
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
    "tags", "created",
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

function parseTranslationResponse(text) {
  const out = { translation: "", synonyms: [], word_class: "", base_form: "", meanings: null };
  if (!text || typeof text !== "string") return out;
  const trimmed = text.trim();
  function extract(parsed) {
    if (parsed && Array.isArray(parsed.meanings)) {
      out.meanings = parsed.meanings
        .map((m) => {
          if (!m || typeof m !== "object") return null;
          return {
            sense: (typeof m.sense === "string") ? m.sense.trim() : "",
            translation: (typeof m.translation === "string") ? m.translation.trim() : "",
            synonyms: Array.isArray(m.synonyms) ? m.synonyms.filter((s) => typeof s === "string") : [],
            word_class: (typeof m.word_class === "string") ? m.word_class.trim() : "",
          };
        })
        .filter((m) => m && m.translation);
      if (out.meanings.length > 0) {
        out.translation = out.meanings.map((m) => m.translation).join(" / ");
      }
    }
    if (parsed && typeof parsed.translation === "string") out.translation = parsed.translation;
    if (parsed && Array.isArray(parsed.synonyms)) out.synonyms = parsed.synonyms.filter((s) => typeof s === "string");
    if (parsed && typeof parsed.word_class === "string") out.word_class = parsed.word_class.trim();
    if (parsed && typeof parsed.base_form === "string") out.base_form = parsed.base_form.trim();
  }
  try { extract(JSON.parse(trimmed)); return out; } catch (_) {}
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return out;
  try { extract(JSON.parse(jsonMatch[0])); } catch (_) {}
  return out;
}

function escapeHtml(raw) {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class TranslationTooltipPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TranslationSettingTab(this.app, this));
    this.registerDomEvent(document, "mouseup", this.handleMouseUp.bind(this), { capture: false });
  }

  onunload() {
    this.removeTooltip();
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isMarkdownViewActive() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return !!view;
  }

  isIgnoredElement(node) {
    if (!node || !node.getAttribute) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !el.closest) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.closest(".modal-container, .suggestion-container, .menu")) return true;
    if (el.closest("[contenteditable='true'], [contenteditable='']")) return true;
    return false;
  }

  getSelectionData() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const text = (range.toString() || "").trim();
    if (!text) return null;
    if (text.length > this.settings.maxSelectionLength) return null;
    const container = range.commonAncestorContainer;
    if (this.isIgnoredElement(container)) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, rect };
  }

  handleMouseUp(evt) {
    if (!this.isMarkdownViewActive()) return;
    const target = evt && evt.target ? evt.target : null;
    if (target && typeof target.closest === "function") {
      if (target.closest(".ot-tooltip") || target.closest(".ot-tooltip-backdrop")) {
        return;
      }
    }
    if (this._suppressMouseUpUntil && Date.now() < this._suppressMouseUpUntil) return;
    const data = this.getSelectionData();
    if (!data) return;
    this.showTooltip(data.rect, data.text);
  }

  removeTooltip() {
    if (this._tooltipEl && this._tooltipEl.parentNode) this._tooltipEl.parentNode.removeChild(this._tooltipEl);
    if (this._backdropEl && this._backdropEl.parentNode) this._backdropEl.parentNode.removeChild(this._backdropEl);
    this._tooltipEl = null;
    this._backdropEl = null;
    this._currentPayload = null;
  }

  showTooltip(rect, text) {
    this.removeTooltip();
    const backdrop = document.createElement("div");
    backdrop.className = "ot-tooltip-backdrop";
    backdrop.addEventListener("click", () => {
      this._suppressMouseUpUntil = Date.now() + 300;
      this.removeTooltip();
    });

    const tooltip = document.createElement("div");
    tooltip.className = "ot-tooltip";
    tooltip.innerHTML = [
      `<div class="ot-header"><span class="ot-original">${escapeHtml(text)}</span><button class="ot-close" type="button">×</button></div>`,
      `<div class="ot-translation ot-loading">Translating…</div>`,
      `<div class="ot-meanings" style="display:none"></div>`,
      `<textarea class="ot-notes" rows="2" placeholder="Optional notes…"></textarea>`,
      `<div class="ot-actions"><button class="ot-save" type="button" disabled>Save</button><span class="ot-status"></span></div>`,
    ].join("");

    const closeBtn = tooltip.querySelector(".ot-close");
    const saveBtn = tooltip.querySelector(".ot-save");
    closeBtn.addEventListener("click", () => {
      this._suppressMouseUpUntil = Date.now() + 300;
      this.removeTooltip();
    });

    saveBtn.addEventListener("click", async () => {
      await this.saveCurrentPayload();
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(tooltip);
    this._tooltipEl = tooltip;
    this._backdropEl = backdrop;

    const padding = 8;
    const tipRect = tooltip.getBoundingClientRect();
    let top = rect.bottom + padding;
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    if (top + tipRect.height > window.innerHeight - padding) top = rect.top - tipRect.height - padding;
    if (top < padding) top = padding;
    if (left < padding) left = padding;
    if (left + tipRect.width > window.innerWidth - padding) left = window.innerWidth - tipRect.width - padding;
    tooltip.style.top = `${top + window.scrollY}px`;
    tooltip.style.left = `${left + window.scrollX}px`;

    this._currentPayload = { original: text, translation: "", base_form: "", meanings: null, synonyms: [], word_class: "" };
    this.translateAndRender(text).catch((err) => {
      this.renderError(err && err.message ? err.message : "Translation failed.");
    });
  }

  async translateAndRender(text) {
    if (!this.settings.deepseekApiKey || !this.settings.deepseekApiKey.trim()) {
      throw new Error("Set DeepSeek API key in plugin settings.");
    }
    const lang = this.settings.targetLanguage || "Simplified Chinese";
    const systemPrompt =
      "Translate to " + lang + ". Reply with JSON only. For words with multiple distinct meanings, use a meanings array: " +
      "{\"meanings\":[{\"sense\":\"<short English gloss>\",\"translation\":\"<target translation>\",\"synonyms\":[\"...\"],\"word_class\":\"<Noun|Verb|Adjective|Adverb|Pronoun|Preposition|Conjunction|Interjection|phrase>\"}],\"base_form\":\"<lemma>\"}. " +
      "For single meaning, shorthand is allowed: {\"translation\":\"...\",\"synonyms\":[...],\"word_class\":\"...\",\"base_form\":\"...\"}. " +
      "IMPORTANT: synonyms must stay in English.";
    const body = {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 512,
      temperature: 0.2,
      response_format: { type: "json_object" },
    };

    const res = await requestUrl({
      url: "https://api.deepseek.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + this.settings.deepseekApiKey.trim(),
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) throw new Error("Invalid DeepSeek API key.");
    if (res.status === 429) throw new Error("DeepSeek rate limit exceeded. Try again shortly.");
    if (res.status < 200 || res.status >= 300) throw new Error(`DeepSeek error (${res.status}).`);

    const data = res.json;
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    const parsed = parseTranslationResponse(content || "");
    const hasMeanings = parsed.meanings && parsed.meanings.length > 0;
    const hasTranslation = typeof parsed.translation === "string" && parsed.translation.trim();
    if (!hasMeanings && !hasTranslation) throw new Error("DeepSeek returned an empty translation.");

    this._currentPayload.translation = parsed.translation || "";
    this._currentPayload.base_form = parsed.base_form || text;
    this._currentPayload.meanings = hasMeanings ? parsed.meanings : null;
    this._currentPayload.synonyms = Array.isArray(parsed.synonyms) ? parsed.synonyms : [];
    this._currentPayload.word_class = parsed.word_class || "";

    this.renderSuccess();
  }

  renderError(message) {
    if (!this._tooltipEl) return;
    const transEl = this._tooltipEl.querySelector(".ot-translation");
    const statusEl = this._tooltipEl.querySelector(".ot-status");
    const saveBtn = this._tooltipEl.querySelector(".ot-save");
    transEl.classList.remove("ot-loading");
    transEl.textContent = "Translation unavailable.";
    statusEl.textContent = message || "Failed.";
    statusEl.className = "ot-status ot-error";
    saveBtn.disabled = true;
  }

  renderSuccess() {
    if (!this._tooltipEl || !this._currentPayload) return;
    const transEl = this._tooltipEl.querySelector(".ot-translation");
    const meaningsEl = this._tooltipEl.querySelector(".ot-meanings");
    const statusEl = this._tooltipEl.querySelector(".ot-status");
    const saveBtn = this._tooltipEl.querySelector(".ot-save");
    statusEl.textContent = "";
    statusEl.className = "ot-status";

    if (this._currentPayload.meanings && this._currentPayload.meanings.length) {
      transEl.style.display = "none";
      meaningsEl.style.display = "block";
      meaningsEl.innerHTML = "";
      this._currentPayload.meanings.forEach((m, i) => {
        const row = document.createElement("label");
        row.className = "ot-meaning-row";
        const trans = (m.translation || "").trim();
        const sense = (m.sense || "").trim();
        const labelText = `${i + 1}. ${trans}${sense ? ` (${sense})` : ""}`;
        row.innerHTML = `<input type="checkbox" data-idx="${i}" checked /> <span class="ot-meaning-label">${escapeHtml(labelText)}</span>`;
        meaningsEl.appendChild(row);
      });
    } else {
      transEl.style.display = "";
      meaningsEl.style.display = "none";
      transEl.classList.remove("ot-loading");
      transEl.textContent = this._currentPayload.translation || "—";
    }
    saveBtn.disabled = false;
  }

  async ensureFolder(folderPath) {
    const clean = (folderPath || "").split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (!clean) return "";
    const parts = clean.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
    return clean;
  }

  async upsertSenseNote(folderPath, sense) {
    const key = normalizeKey(sense.baseForm) || normalizeKey(sense.word);
    const filename = sanitizeFilename(key || sense.baseForm || sense.word);
    if (!filename) throw new Error("Empty base form/word.");
    const fullPath = folderPath ? `${folderPath}/${filename}.md` : `${filename}.md`;
    const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
    const existing = existingFile ? await this.app.vault.read(existingFile) : "";
    const { fm: oldFm, body: oldBody } = parseFrontmatter(existing);

    let fm = { ...oldFm };
    if (!("word" in fm)) fm.word = sense.baseForm || sense.word || filename;
    if (!("base_form" in fm)) fm.base_form = sense.baseForm || sense.word || filename;
    if (sense.wordClass && !("word_class" in fm)) fm.word_class = sense.wordClass;
    if (sense.notes && typeof sense.notes === "string" && sense.notes.trim() && !fm.notes) fm.notes = sense.notes.trim();

    const beforeCount = getSenseCountFromFrontmatter(fm);
    fm = appendSenseToFrontmatter(fm, sense);
    const afterCount = getSenseCountFromFrontmatter(fm);
    const senseNumber = Math.max(afterCount, beforeCount + 1);
    const newFrontmatter = buildFrontmatter(fm);
    const wordForTitle = fm.word || sense.baseForm || sense.word || filename;
    const newBody = appendSenseToBody(oldBody, wordForTitle, senseNumber, sense);
    const next = newFrontmatter + newBody;

    if (existingFile) await this.app.vault.modify(existingFile, next);
    else await this.app.vault.create(fullPath, next);
  }

  getSelectedSensesFromUI() {
    if (!this._currentPayload) return null;
    const notesEl = this._tooltipEl ? this._tooltipEl.querySelector(".ot-notes") : null;
    const notes = notesEl && typeof notesEl.value === "string" ? notesEl.value.trim() : "";
    const word = this._currentPayload.original || "";
    const baseForm = this._currentPayload.base_form || word;

    if (this._currentPayload.meanings && this._currentPayload.meanings.length) {
      const checked = this._tooltipEl.querySelectorAll(".ot-meanings input[type=checkbox]:checked");
      if (!checked || checked.length === 0) return [];
      const out = [];
      checked.forEach((el) => {
        const idx = parseInt(el.getAttribute("data-idx"), 10);
        if (isNaN(idx)) return;
        const m = this._currentPayload.meanings[idx];
        if (!m) return;
        out.push({
          word,
          baseForm,
          translation: m.translation || "",
          sense: m.sense || "",
          synonyms: Array.isArray(m.synonyms) ? m.synonyms : [],
          wordClass: m.word_class || "",
          notes,
        });
      });
      return out;
    }
    return [{
      word,
      baseForm,
      translation: this._currentPayload.translation || "",
      sense: "",
      synonyms: Array.isArray(this._currentPayload.synonyms) ? this._currentPayload.synonyms : [],
      wordClass: this._currentPayload.word_class || "",
      notes,
    }];
  }

  async saveCurrentPayload() {
    if (!this._currentPayload || !this._tooltipEl) return;
    const saveBtn = this._tooltipEl.querySelector(".ot-save");
    const statusEl = this._tooltipEl.querySelector(".ot-status");
    const senses = this.getSelectedSensesFromUI();
    if (!senses || senses.length === 0) {
      statusEl.textContent = "Select at least one sense.";
      statusEl.className = "ot-status ot-error";
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    statusEl.textContent = "";
    try {
      const folderPath = await this.ensureFolder(this.settings.vocabFolder || "Vocab_ao3");
      for (const sense of senses) {
        await this.upsertSenseNote(folderPath, sense);
      }
      statusEl.textContent = `Saved ${senses.length} entr${senses.length === 1 ? "y" : "ies"} to Obsidian.`;
      statusEl.className = "ot-status ot-success";
      new Notice("Translation saved to Obsidian.");
      setTimeout(() => this.removeTooltip(), 900);
    } catch (err) {
      statusEl.textContent = (err && err.message) ? err.message : "Save failed.";
      statusEl.className = "ot-status ot-error";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }
}

class TranslationSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("DeepSeek API key")
      .setDesc("Used for translation requests.")
      .addText((text) => text
        .setPlaceholder("sk-...")
        .setValue(this.plugin.settings.deepseekApiKey || "")
        .onChange(async (value) => {
          this.plugin.settings.deepseekApiKey = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Target language")
      .setDesc("Translation target language sent to DeepSeek.")
      .addText((text) => text
        .setPlaceholder("Simplified Chinese")
        .setValue(this.plugin.settings.targetLanguage || "Simplified Chinese")
        .onChange(async (value) => {
          this.plugin.settings.targetLanguage = value.trim() || "Simplified Chinese";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Vocab folder")
      .setDesc("Folder in your vault where vocab notes are saved.")
      .addText((text) => text
        .setPlaceholder("Vocab_ao3")
        .setValue(this.plugin.settings.vocabFolder || "Vocab_ao3")
        .onChange(async (value) => {
          this.plugin.settings.vocabFolder = (value || "").trim() || "Vocab_ao3";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Max selection length")
      .setDesc("Selections longer than this are ignored.")
      .addSlider((slider) => slider
        .setLimits(20, 500, 5)
        .setValue(this.plugin.settings.maxSelectionLength || 120)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxSelectionLength = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = TranslationTooltipPlugin;
