# Translate & Save to Notion

A macOS Safari Web Extension that translates selected text using the DeepSeek API, shows the translation in a tooltip, and lets you save vocabulary (including synonyms) to a Notion database.

## Features

- **Instant translation** — Select any word or phrase on a webpage to see the translation in a lightweight tooltip.
- **One-click save** — Save the word, translation, and synonyms to a Notion database. Synonyms are stored but not shown in the tooltip.
- **Context & source** — Optionally captures surrounding sentence context and always stores the source URL and page title.
- **No backend** — All requests go directly from the extension to DeepSeek and Notion; no external server required.
- **Manifest V3** — Built for Safari (and compatible with the standard Web Extension model).

## Requirements

- macOS with latest stable Safari
- [DeepSeek API key](https://platform.deepseek.com)
- [Notion](https://notion.so) workspace and a database with the required properties (see [Notion setup](#notion-setup))
- Xcode (for building the Safari extension)

## Quick start

1. **Build the extension** — See [BUILD.md](BUILD.md) for opening the project in Xcode, signing, and enabling the extension in Safari.
2. **Configure APIs** — Open the extension’s **Options** (right‑click the extension in Safari > Manage Extension > Options, or from Safari Settings > Extensions). Enter your DeepSeek API key, Notion integration token, and Notion database ID. See [SETUP-DEEPSEEK.md](SETUP-DEEPSEEK.md) and [SETUP-NOTION.md](SETUP-NOTION.md).
3. **Use it** — Select text on any webpage. The tooltip appears with the translation. Click **Save** to add an entry to your Notion database (or press **⌘↵** when the tooltip is open). Press **Esc** or click outside to close the tooltip.

## Notion setup

Your Notion database must have these properties:

| Property name | Type      | Required |
|---------------|-----------|----------|
| Word          | Title     | Yes      |
| Translation   | Rich text | Yes      |
| Synonyms      | Rich text | Yes      |
| Word Class    | Select    | Yes      |

**Word Class** is a Select with options: Noun, Pronoun, Verb, Adjective, Adverb, Preposition, Conjunction, Interjection, phrase. The extension fills it automatically (part of speech for a single word, or **phrase** for multiple words).

Create an [internal integration](https://www.notion.so/profile/integrations), copy its **API secret** (Configuration tab), then connect the database to the integration via **Add connections** on the database page. Use that secret and the database **ID** (from its URL) in the extension options. Full steps: [SETUP-NOTION.md](SETUP-NOTION.md). See also Notion’s [Create a Notion integration](https://developers.notion.com/guides/get-started/create-a-notion-integration) guide.

## DeepSeek setup

Get an API key from the [DeepSeek Platform](https://platform.deepseek.com) and paste it into the extension options. Details: [SETUP-DEEPSEEK.md](SETUP-DEEPSEEK.md).

## Project layout

- **SafariTranslateNotionExtension/** — The Web Extension (manifest, content script, background script, options page). This folder is what you open with the Safari Web Extension converter or add to your Xcode Safari extension target.
- **BUILD.md** — Build and run instructions (Xcode, signing, enabling in Safari).
- **SETUP-NOTION.md** — Notion database and integration setup.
- **SETUP-DEEPSEEK.md** — DeepSeek API key and usage notes.

## Acceptance checklist

- [x] Selecting text triggers the translation tooltip  
- [x] Tooltip shows the correct translation (synonyms not shown in UI)  
- [x] **Save** creates a new entry in Notion (Word, Translation, Synonyms, Word Class)  
- [x] Settings persist across browser restarts  
- [x] Extension builds and runs in Safari (after following BUILD.md)
