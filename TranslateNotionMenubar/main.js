const { app, Tray, Menu, BrowserWindow, clipboard, ipcMain, nativeImage } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const Store = require("electron-store");
const { translateWithDeepSeek, saveToNotionApi, callTaxonomy, generateExampleSentence, checkNotionExisting, getWordTitlesWhereSynonymsContain, writingSupport, writingSupportWithDeepSeek, getChineseToEnglishSuggestions } = require("./services/api");

const store = new Store();
let tray = null;
let popupWindow = null;
let settingsWindow = null;

const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 420;
const TRAY_SIZE = 22;

function sanitizeVaultRelativePath(p) {
  const raw = (p && typeof p === "string") ? p.trim() : "";
  const cleaned = raw.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\.\./g, "").replace(/\\/g, "/");
  return cleaned || "vocab";
}

function sanitizeFilename(name) {
  const raw = (name && typeof name === "string") ? name.trim() : "";
  if (!raw) return "";
  const cleaned = raw
    .replace(/[\/\\]/g, "-")
    .replace(/[:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 180);
}

function toYamlStringValue(v) {
  const s = (v == null) ? "" : String(v);
  return JSON.stringify(s);
}

function buildWordMarkdown(payload) {
  const word = (payload.original || "").trim();
  const baseForm = (payload.base_form || payload.original || "").trim();
  const example = (payload.example && typeof payload.example === "string") ? payload.example.trim() : "";
  const notes = (payload.notes && typeof payload.notes === "string") ? payload.notes.trim() : "";
  const exampleSource = (payload.example_source === "deepseek" || payload.example_source === "user") ? payload.example_source : "";
  const tax = payload && payload.taxonomy ? payload.taxonomy : null;
  const mainCategory = tax && typeof tax.mainCategory === "string" ? tax.mainCategory.trim() : "";
  const strengthLevel = tax && typeof tax.strengthLevel === "string" ? tax.strengthLevel.trim() : "";
  const subcategory = tax && Array.isArray(tax.subcategory) ? tax.subcategory.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 20) : [];
  const now = new Date().toISOString();

  const rawMeanings = Array.isArray(payload.meanings) ? payload.meanings : [];
  const meanings = rawMeanings.length > 0
    ? rawMeanings.map((m) => ({
        translation: (m.translation != null && typeof m.translation === "string") ? m.translation.trim() : "",
        sense: (m.sense != null && typeof m.sense === "string") ? m.sense.trim() : "",
        synonyms: Array.isArray(m.synonyms) ? m.synonyms.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean).slice(0, 40) : [],
      }))
    : [{
        translation: (payload.translation || "").trim(),
        sense: (payload.sense || "").trim(),
        synonyms: Array.isArray(payload.synonyms) ? payload.synonyms : [],
      }];

  const subcatYaml = subcategory.length
    ? subcategory.map((s) => `  - ${toYamlStringValue(s)}`).join("\n")
    : "  - \"\"";

  const singleSense = meanings.length <= 1;
  const first = meanings[0];

  const frontmatter = [
    "---",
    `word: ${toYamlStringValue(word)}`,
    `base_form: ${toYamlStringValue(baseForm)}`,
  ];

  if (singleSense) {
    frontmatter.push(`translation: ${toYamlStringValue((first && first.translation) ? first.translation.trim() : "")}`);
    frontmatter.push(`sense: ${toYamlStringValue((first && first.sense) ? first.sense.trim() : "")}`);
    const synList = (first && first.synonyms && first.synonyms.length)
      ? first.synonyms.map((s) => toYamlStringValue(`[[${String(s).trim()}]]`)).join("\n  - ")
      : "";
    frontmatter.push("synonyms:", synList ? "  - " + synList : "  - \"\"");
  } else {
    const translationsList = meanings.map((m) => toYamlStringValue((m.translation || "").trim())).join("\n  - ");
    const sensesList = meanings.map((m) => toYamlStringValue((m.sense || "").trim())).join("\n  - ");
    frontmatter.push("translations:", translationsList ? "  - " + translationsList : "  - \"\"");
    frontmatter.push("senses:", sensesList ? "  - " + sensesList : "  - \"\"");
    meanings.forEach((m, i) => {
      const key = "synonyms_" + (i + 1);
      const synList = (m.synonyms && m.synonyms.length)
        ? m.synonyms.map((s) => toYamlStringValue(`[[${String(s).trim()}]]`)).join("\n  - ")
        : "";
      frontmatter.push(key + ":", synList ? "  - " + synList : "  - \"\"");
    });
  }

  frontmatter.push(`main_category: ${toYamlStringValue(mainCategory)}`, "subcategory:", subcatYaml, `strength_level: ${toYamlStringValue(strengthLevel)}`, `created: ${toYamlStringValue(now)}`, "tags:", "  - vocab");
  if (example) frontmatter.push(`example: ${toYamlStringValue(example)}`);
  if (exampleSource) frontmatter.push(`example_source: ${toYamlStringValue(exampleSource)}`);
  if (notes) frontmatter.push(`notes: ${toYamlStringValue(notes)}`);
  frontmatter.push("---", "");

  const bodyParts = [`# ${word}`, ""];
  meanings.forEach((m, i) => {
    const n = i + 1;
    bodyParts.push(`## Sense ${n}`, "");
    bodyParts.push(`- **Translation**: ${m.translation || "—"}`);
    bodyParts.push(m.sense ? `- **Meaning**: ${m.sense}` : "- **Meaning**: —");
    bodyParts.push(m.synonyms.length ? `- **Synonyms**: ${m.synonyms.map((s) => `[[${String(s).trim()}]]`).join(", ")}` : "- **Synonyms**: —");
    bodyParts.push("");
  });
  if (example) bodyParts.push("## Example", "", example, "");
  if (notes) bodyParts.push("## Notes", "", notes, "");

  return frontmatter.join("\n") + bodyParts.join("\n");
}

function buildVocabBankDataview(vocabFolderRel) {
  const folder = vocabFolderRel.replace(/\\/g, "/");
  return [
    "# Vocab",
    "",
    "```dataview",
    "TABLE link(file.path, word) AS \"Word\", join(choice(length(translations) > 0, translations, array(translation)), \", \") AS \"Translation\", main_category AS \"Cat\", join(choice(length(subcategory) > 0, subcategory, array(\"\")), \", \") AS \"Subcat\", strength_level AS \"Level\"",
    `FROM "${folder}"`,
    "WHERE !startswith(file.name, \"_\")",
    "SORT word ASC",
    "```",
    "",
  ].join("\n");
}

async function loadVaultVocabEntries(vaultPath, vocabFolderRel, limit) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 800);
  const vocabDir = path.join(vaultPath, vocabFolderRel);
  let files = [];
  try {
    files = await fs.readdir(vocabDir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (let i = 0; i < files.length && out.length < cap; i++) {
    const f = files[i];
    if (!f.endsWith(".md")) continue;
    if (f.startsWith("_")) continue;
    const p = path.join(vocabDir, f);
    let content = "";
    try {
      content = await fs.readFile(p, "utf8");
    } catch (_) {
      continue;
    }
    const top = content.slice(0, 8000);
    const word = f.replace(/\.md$/i, "");
    let translation = "";
    let sense = "";
    const transBlock = top.match(/translations:\s*\n((?:\s+-\s+.+\n?)+)/);
    const senseBlock = top.match(/senses:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (transBlock) {
      const lines = transBlock[1].match(/\s+-\s+.+/g) || [];
      translation = lines.map((l) => l.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim()).filter(Boolean).join("; ");
    }
    if (senseBlock) {
      const lines = senseBlock[1].match(/\s+-\s+.+/g) || [];
      sense = lines.map((l) => l.replace(/^\s+-\s+/, "").replace(/^["']|["']$/g, "").trim()).filter(Boolean).join("; ");
    }
    if (!translation && !sense) {
      const meaningsBlock = top.match(/meanings:\s*\n([\s\S]*?)(?=\n\w|\n---|$)/);
      if (meaningsBlock) {
        const meaningsStr = meaningsBlock[1];
        const rawItems = meaningsStr.split(/\n\s+-\s+translation:/);
        const parts = rawItems.slice(1).map((blob) => {
          const t = blob.match(/translation:\s*(.+?)(?=\n\s|$)/s);
          const s = blob.match(/sense:\s*(.+?)(?=\n\s|$)/s);
          return {
            translation: t ? t[1].replace(/^["']|["']$/g, "").trim() : "",
            sense: s ? s[1].replace(/^["']|["']$/g, "").trim() : "",
          };
        });
        translation = parts.map((p) => p.translation).filter(Boolean).join("; ");
        sense = parts.map((p) => p.sense).filter(Boolean).join("; ");
      }
    }
    if (!translation && !sense) {
      const mTrans = top.match(/^\s*translation:\s*(.+)\s*$/m);
      const mSense = top.match(/^\s*sense:\s*(.+)\s*$/m);
      translation = mTrans ? mTrans[1].replace(/^["']|["']$/g, "").trim() : "";
      sense = mSense ? mSense[1].replace(/^["']|["']$/g, "").trim() : "";
    }
    out.push({ word, translation, sense });
  }
  return out;
}

function getTrayIcon() {
  const iconPath = path.join(__dirname, "assets", "trayTemplate.png");
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      const resized = img.resize({ width: TRAY_SIZE, height: TRAY_SIZE });
      return resized.isEmpty() ? img : resized;
    }
  } catch (_) {}
  const fallback = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhElEQVQ4T2NkYGD4z0ABYBzVMKoBBgPjqAYGBgZGBgaG/0g6GBkZ/jMwMPxHVQOugYGB4T8uN8CtgNcNcDfAdYNrYGD4j88KdDfAdYNrYGD4j88KdDfAdYNrYGD4j88KdDfAdQMAQyoS0U9VhfkAAAAASUVORK5CYII=");
  return fallback.resize({ width: TRAY_SIZE, height: TRAY_SIZE });
}

function createPopup() {
  if (popupWindow) {
    popupWindow.show();
    popupWindow.focus();
    return;
  }
  popupWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWindow.loadFile(path.join(__dirname, "popup.html"));
  popupWindow.on("closed", () => { popupWindow = null; });
  popupWindow.on("blur", () => {
    if (popupWindow && !popupWindow.isDestroyed() && settingsWindow && !settingsWindow.isDestroyed()) return;
    if (process.platform === "darwin") return;
    if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
  });
}

function showPopupBelowTray() {
  createPopup();
  const bounds = tray.getBounds();
  const { screen } = require("electron");
  const primary = screen.getPrimaryDisplay().workArea;
  let x = Math.round(bounds.x + bounds.width / 2 - POPUP_WIDTH / 2);
  let y = Math.round(bounds.y + bounds.height + 4);
  if (y + POPUP_HEIGHT > primary.y + primary.height) y = Math.round(bounds.y - POPUP_HEIGHT - 4);
  if (x < primary.x) x = primary.x;
  if (x + POPUP_WIDTH > primary.x + primary.width) x = primary.x + primary.width - POPUP_WIDTH;
  popupWindow.setPosition(x, y);
  popupWindow.show();
  popupWindow.focus();
}

function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("Translate & Save to Notion");
  tray.on("click", () => {
    if (popupWindow && popupWindow.isVisible()) {
      popupWindow.hide();
    } else {
      showPopupBelowTray();
    }
  });
  const contextMenu = Menu.buildFromTemplate([
    { label: "Settings…", click: () => openSettings() },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.on("right-click", () => {
    tray.popUpContextMenu(contextMenu);
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 440,
    height: 380,
    title: "Translate & Notion — Settings",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

ipcMain.handle("getSettings", () => {
  return {
    obsidianVaultPath: store.get("obsidianVaultPath", ""),
    obsidianVocabFolder: store.get("obsidianVocabFolder", "vocab"),
    deepseekApiKey: store.get("deepseekApiKey", ""),
    notionToken: store.get("notionToken", ""),
    notionDatabaseId: store.get("notionDatabaseId", ""),
    targetLanguage: store.get("targetLanguage", "Simplified Chinese"),
  };
});

ipcMain.handle("setSettings", (_, opts) => {
  if (opts.obsidianVaultPath !== undefined) store.set("obsidianVaultPath", opts.obsidianVaultPath);
  if (opts.obsidianVocabFolder !== undefined) store.set("obsidianVocabFolder", opts.obsidianVocabFolder);
  if (opts.deepseekApiKey !== undefined) store.set("deepseekApiKey", opts.deepseekApiKey);
  if (opts.notionToken !== undefined) store.set("notionToken", opts.notionToken);
  if (opts.notionDatabaseId !== undefined) store.set("notionDatabaseId", opts.notionDatabaseId);
  if (opts.targetLanguage !== undefined) store.set("targetLanguage", opts.targetLanguage);
});

ipcMain.handle("getClipboard", () => {
  return clipboard.readText();
});

ipcMain.handle("translate", async (_, text) => {
  const apiKey = store.get("deepseekApiKey", "").trim();
  if (!apiKey) throw new Error("Set your DeepSeek API key in Settings.");
  const targetLanguage = store.get("targetLanguage", "Simplified Chinese");
  return translateWithDeepSeek(text, apiKey, targetLanguage);
});

ipcMain.handle("writingSupport", async (_, { text, action }) => {
  const apiKey = store.get("deepseekApiKey", "").trim();
  const vaultPath = store.get("obsidianVaultPath", "").trim();
  const vocabFolderRel = sanitizeVaultRelativePath(store.get("obsidianVocabFolder", "vocab"));
  const act = (action && typeof action === "string") ? action : "";
  const queryText = (text && typeof text === "string") ? text.trim() : "";
  if (!queryText) return { error: "No text provided." };

  // Use vault vocab as the primary resource whenever a vault is configured.
  if (vaultPath) {
    if (act === "lookup_chinese") {
      const terms = [queryText];
      for (let i = 0; i < queryText.length && i < 8; i++) {
        const ch = queryText[i];
        if (ch && !terms.includes(ch)) terms.push(ch);
      }
      try {
        const entries = await loadVaultVocabEntries(vaultPath, vocabFolderRel, 800);
        const hits = [];
        for (let i = 0; i < entries.length && hits.length < 50; i++) {
          const e = entries[i];
          const hay = (e.translation || "") + " " + (e.sense || "");
          if (!terms.some((t) => hay.includes(t))) continue;
          hits.push(e);
        }
        if (hits.length > 0) {
          const lines = hits.map((e) => e.word + (e.translation ? " — " + e.translation : "") + (e.sense ? " (" + e.sense + ")" : ""));
          return { fromNotion: lines.join("\n"), fromDeepSeek: null };
        }
        if (!apiKey) return { fromNotion: null, fromDeepSeek: null, error: "No matches in your vault. Set your DeepSeek API key in Settings to get AI suggestions." };
        const suggestions = await getChineseToEnglishSuggestions(queryText, apiKey);
        return { fromNotion: null, fromDeepSeek: suggestions || null };
      } catch (err) {
        return { error: (err && err.message) ? err.message : "Lookup failed." };
      }
    }

    // Comment / Better word / Suggest word: feed vault vocab into the prompt.
    if (!apiKey) return { error: "Set your DeepSeek API key in Settings." };
    try {
      const vocabLines = await loadVaultVocabEntries(vaultPath, vocabFolderRel, 500);
      const result = await writingSupportWithDeepSeek(queryText, act || "writing_comment", vocabLines, apiKey);
      return { result };
    } catch (err) {
      return { error: (err && err.message) ? err.message : "Writing support failed." };
    }
  }

  // No vault configured: fall back to legacy Notion-backed implementation.
  const token = store.get("notionToken", "").trim();
  const databaseId = store.get("notionDatabaseId", "").trim();
  return writingSupport(queryText, act, token, databaseId, apiKey);
});

ipcMain.handle("checkNotionStatus", async (_, { word, baseForm }) => {
  const token = store.get("notionToken", "").trim();
  const databaseId = store.get("notionDatabaseId", "").trim();
  if (!token || !databaseId) return { alreadyInNotion: null, alsoSynonymIn: [] };
  try {
    const [existing, synonymIn] = await Promise.all([
      checkNotionExisting(token, databaseId, word, baseForm),
      getWordTitlesWhereSynonymsContain(token, databaseId, word, baseForm),
    ]);
    return {
      alreadyInNotion: existing.found ? existing.value : null,
      alsoSynonymIn: Array.isArray(synonymIn) ? synonymIn : [],
    };
  } catch (_) {
    return { alreadyInNotion: null, alsoSynonymIn: [] };
  }
});

ipcMain.handle("saveToVault", async (_, payload) => {
  const vaultPath = store.get("obsidianVaultPath", "").trim();
  const vocabFolderRel = sanitizeVaultRelativePath(store.get("obsidianVocabFolder", "vocab"));
  if (!vaultPath) throw new Error("Set Obsidian vault path in Settings.");
  const word = payload && typeof payload.original === "string" ? payload.original.trim() : "";
  const filename = sanitizeFilename(word);
  if (!filename) throw new Error("Word is empty. Translate first.");

  const apiKey = store.get("deepseekApiKey", "").trim();
  if (apiKey && word) {
    try {
      const taxonomy = await callTaxonomy(word, apiKey);
      payload = Object.assign({}, payload, { taxonomy });
    } catch (_) {}
  }
  if (!(payload.example && payload.example.trim()) && apiKey && word) {
    try {
      const generated = await generateExampleSentence(word, apiKey);
      if (generated) {
        payload = Object.assign({}, payload, { example: generated, example_source: "deepseek" });
      }
    } catch (_) {}
  } else if (payload.example && payload.example.trim()) {
    payload = Object.assign({}, payload, { example_source: "user" });
  }

  const vocabDir = path.join(vaultPath, vocabFolderRel);
  await fs.mkdir(vocabDir, { recursive: true });

  const filePath = path.join(vocabDir, filename + ".md");
  const md = buildWordMarkdown(payload);
  await fs.writeFile(filePath, md, "utf8");

  const bankPath = path.join(vocabDir, "_Vocab Bank.md");
  await fs.writeFile(bankPath, buildVocabBankDataview(vocabFolderRel), "utf8");

  return { ok: true, path: filePath };
});

ipcMain.handle("saveToNotion", async (_, payload) => {
  const token = store.get("notionToken", "").trim();
  const databaseId = store.get("notionDatabaseId", "").trim();
  if (!token || !databaseId) throw new Error("Set Notion API secret and Database ID in Settings.");
  const apiKey = store.get("deepseekApiKey", "").trim();
  const term = (payload.original && typeof payload.original === "string") ? payload.original.trim() : "";
  if (apiKey && term) {
    try {
      const taxonomy = await callTaxonomy(term, apiKey);
      payload = Object.assign({}, payload, { taxonomy });
    } catch (_) {}
  }
  try {
    return await saveToNotionApi(payload, token, databaseId);
  } catch (err) {
    console.error("[TranslateNotion] Save to Notion failed:", err && err.message, err && err.cause);
    throw err;
  }
});

app.whenReady().then(() => {
  createTray();
  if (process.platform === "darwin") app.dock.hide();
});

app.on("window-all-closed", (e) => {
  if (process.platform !== "darwin") app.quit();
  e.preventDefault();
});
