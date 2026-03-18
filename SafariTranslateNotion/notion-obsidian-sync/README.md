# Notion → Obsidian sync (Writer Vault B)

Append-only importer that:

- reads **Notion inbox** rows where `Imported` is unchecked
- groups rows by `Base form`
- writes/updates one note per base form in an Obsidian **Vault B** `vocab/` folder
- **appends new senses only** (does not delete/overwrite existing senses)
- marks Notion rows as Imported after success

## Notion requirements

Your database must have these properties (names must match exactly):

- `Word` (Title)
- `Base form` (Text or Rich text)
- `Translation` (Rich text)
- `Sense` (Rich text)
- `Synonyms` (Rich text; comma/semicolon separated is OK)
- `Word Class` (Select)
- `Notes` (Rich text; optional)
- `Writer Taxonomy` (Text/Rich text containing JSON from the Safari extension writer taxonomy)
- `Imported` (Checkbox)

## Obsidian requirements

- Vault B exists
- inside it, a folder `vocab/` exists (or set a different folder via env var)

## Setup

From this folder:

```bash
cd /Users/asteray/Downloads/cursor-ts/SafariTranslateNotion/notion-obsidian-sync
```

Set environment variables:

- `NOTION_TOKEN` (your Notion integration token, `ntn_...`)
- `NOTION_DATABASE_ID` (database id)
- `OBSIDIAN_VAULT_PATH` (absolute path to Vault B)
- `OBSIDIAN_VOCAB_FOLDER` (optional; default `vocab`)

Run:

```bash
npm run sync
```

## What it writes

Each word becomes: `OBSIDIAN_VAULT_PATH/OBSIDIAN_VOCAB_FOLDER/<base_form>.md`

Frontmatter stores either:

- single-sense: `translation`, `sense`, `synonyms`
- multi-sense: `translations`, `senses`, `synonyms_1`, `synonyms_2`, ...

Writer taxonomy is stored under `writer_*` keys:

- `writer_narrative_function`
- `writer_sensory_channel`
- `writer_psychological_domain`
- `writer_action_type`
- `writer_social_function`
- `writer_atmosphere_tone`
- `writer_register`
- `writer_show_tell`

For idempotency, the note also stores `notion_sense_ids` (list of Notion page IDs already imported).

