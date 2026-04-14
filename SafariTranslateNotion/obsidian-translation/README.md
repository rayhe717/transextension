# Obsidian Translation Tooltip

Obsidian plugin variant of your extension flow:

- Select text in Obsidian markdown view.
- Tooltip translates via DeepSeek.
- Save writes directly into vault notes (no Notion).

## Included

- Tooltip translation UI (no popup).
- Multi-sense checkbox save.
- Direct note upsert with YAML frontmatter and sense sections.
- Plugin settings for API key, target language, vocab folder, max selection length.

## Install locally on Mac

1. Open your vault folder.
2. Create plugin folder:
   - `.obsidian/plugins/obsidian-translation`
3. Copy these files into that folder:
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. In Obsidian:
   - Settings -> Community plugins -> turn off Safe mode
   - Reload plugins
   - Enable `Obsidian Translation Tooltip`
5. Open plugin settings and set your DeepSeek API key.

## Usage

1. Open a markdown note.
2. Select a short word or phrase.
3. Tooltip appears with translation.
4. Click Save to write into `Vocab_ao3` (or your configured folder).
