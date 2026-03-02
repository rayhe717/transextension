const { app, Tray, Menu, BrowserWindow, clipboard, ipcMain, nativeImage } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { translateWithDeepSeek, saveToNotionApi, callTaxonomy, checkNotionExisting, getWordTitlesWhereSynonymsContain, writingSupport } = require("./services/api");

const store = new Store();
let tray = null;
let popupWindow = null;
let settingsWindow = null;

const POPUP_WIDTH = 380;
const POPUP_HEIGHT = 420;
const TRAY_SIZE = 22;

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
    deepseekApiKey: store.get("deepseekApiKey", ""),
    notionToken: store.get("notionToken", ""),
    notionDatabaseId: store.get("notionDatabaseId", ""),
    targetLanguage: store.get("targetLanguage", "Simplified Chinese"),
  };
});

ipcMain.handle("setSettings", (_, opts) => {
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
  const token = store.get("notionToken", "").trim();
  const databaseId = store.get("notionDatabaseId", "").trim();
  const apiKey = store.get("deepseekApiKey", "").trim();
  return writingSupport(text, action, token, databaseId, apiKey);
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
