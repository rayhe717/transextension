# Translate & Notion (Menubar)

A standalone macOS menubar app: copy text anywhere, open the app from the tray, translate with DeepSeek, and save vocabulary to your Notion database. Works in any app (browser, PDF, Zotero, etc.) — no browser extension required.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) (LTS)
- [DeepSeek API key](https://platform.deepseek.com)
- [Notion](https://notion.so) database with: **Word** (title), **Translation**, **Synonyms**, **Base Form**, **Sense** (optional). For taxonomy: **Main Category** (select), **Subcategory** (multi-select), **Strength Level** (select)—all optional.

## Install and run

Run from **this folder** (the one that contains `package.json`). If you’re in the repo root (e.g. `cursor-ts`), run:

```bash
cd TranslateNotionMenubar
npm install
npm start
```

Or with the full path:

```bash
cd /Users/asteray/Downloads/cursor-ts/TranslateNotionMenubar
npm install
npm start
```

The app runs in the **menubar** (top-right of the screen, near the clock) and does **not** show in the Dock. Click the translate icon in the menu bar to open the popup. On some Macs (Sonoma and later), the icon may be inside the **Control Center** (the "…" or "•••" on the right of the menu bar)—open it and look for the Translate & Notion icon there. No dependency on the Safari extension or any other project.

## Settings (API keys)

1. Click the menubar icon.
2. Choose **Settings…** from the menu (or open the popup and use the tray context menu).
3. Enter:
   - **DeepSeek API key** — from [platform.deepseek.com](https://platform.deepseek.com)
   - **Notion integration token** — Notion → Settings → Integrations → create/copy secret
   - **Notion database ID** — from your database URL in Notion
   - **Target language** — e.g. `Simplified Chinese`
4. Click **Save**.

Settings are stored locally (electron-store). Connect your Notion database to the integration via the database’s **⋯ → Add connections**.

## Usage

1. Copy text in any app (article, PDF, browser, etc.).
2. Click the menubar icon → **Translate clipboard** (or click the tray icon to open the popup).
3. Click **Paste from clipboard** to fill the box, or type/paste manually.
4. Click **Translate**. The translation appears below (with multiple meanings if applicable).
5. If there are multiple meanings, choose which one to save.
6. Click **Save to Notion** to add the entry to your vocabulary database.

You can copy this folder to another machine or repo and run it on its own with `npm install` and `npm start`.

## Tray icon

The app uses `assets/trayTemplate.png` as the menubar icon. To use a different icon (e.g. [Translate icons by photo3idea_studio - Flaticon](https://www.flaticon.com/free-icons/translate)), download the PNG (about 22×22 or 44×44 for retina), save it as `assets/trayTemplate.png`, and restart the app. On macOS, a “template” icon (light/white on transparent) will invert correctly in the dark menu bar.

## Debugging "fetch failed" when saving to Notion

If you see **"fetch failed"** or **"Notion request failed (network): …"** when saving:

1. **Run the app from the terminal** so the full error is printed:
   ```bash
   cd TranslateNotionMenubar
   npm start
   ```
   Try Save to Notion again. The **popup** will show a clearer message (e.g. the underlying cause), and the **terminal** will log the full error.

2. **Common causes:**
   - **ENOTFOUND api.notion.com** — DNS or no internet; check network and firewall.
   - **ECONNREFUSED** — Firewall or proxy blocking the app; allow the Electron app to reach `api.notion.com`.
   - **Certificate / TLS errors** — System or corporate proxy; try another network.
   - **401 from Notion** — Token invalid or wrong; re-copy the secret (e.g. `ntn_...`) from Notion and paste in Settings.
   - **403 from Notion** — Database not connected to your integration; in Notion open the database → ⋯ → Connections → add your integration.
- **ECONNREFUSED 208.103.161.1:443 (or another IP)** — Your system proxy is set (e.g. `HTTP_PROXY`/`HTTPS_PROXY`) and that proxy is refusing connections. This app now **bypasses the proxy for Notion** (direct HTTPS to api.notion.com). Restart the app and try again. If it still fails, run without proxy: `NO_PROXY='*' npm start` or unset `HTTP_PROXY` and `HTTPS_PROXY` in your shell, then `npm start`.
