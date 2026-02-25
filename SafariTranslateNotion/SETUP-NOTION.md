# Notion setup

To save vocabulary from the extension into Notion, you need a **Notion database** and an **internal integration**. The extension uses Notion’s public API with your integration’s **API secret** (no OAuth). For the full official guide, see [Create a Notion integration](https://developers.notion.com/guides/get-started/create-a-notion-integration).

## 1. Create a database

1. In Notion, create a new **full-page database** (Table view is fine).
2. Add or rename columns so the database has **exactly** these properties:

   | Property name | Type      | Required |
   |---------------|-----------|----------|
   | Word          | Title     | Yes      |
   | Translation   | Rich text | Yes      |
   | Synonyms      | Rich text | Yes      |
   | Word Class    | Select    | Yes      |

   - **Word** — Title (the selected word or phrase).  
   - **Translation** — Rich text (translation in your target language).  
   - **Synonyms** — Rich text (comma‑separated synonyms in the source language).  
   - **Word Class** — **Select** with exactly these options: **Noun**, **Pronoun**, **Verb**, **Adjective**, **Adverb**, **Preposition**, **Conjunction**, **Interjection**, **phrase**. The extension fills this automatically: for a single word it uses the part of speech; for multiple words it uses **phrase**.  

3. Save the page. You can add any other columns you like; the extension only writes to the four above.

## 2. Create an internal integration and get your API secret

1. Open Notion’s [integrations dashboard](https://www.notion.so/profile/integrations).
2. Click **+ New integration**.
3. Enter a name (e.g. “Translate & Save Extension”) and select the **workspace** where your vocabulary database lives, then create it.
4. On the integration page, open the **Configuration** (or **Capabilities**) tab and copy your **API secret** (also called **Internal Integration Secret**; it starts with `secret_`).  
   This is the value the extension uses to authenticate with the Notion API. Paste it into the extension **Options** as **Notion Integration Token**.

**Keep the API secret private.** Do not commit it or expose it; the extension stores it only in local Safari storage.

## 3. Give the integration access to the database

Notion requires explicit permission per page or database. Until you connect the database to your integration, the API cannot create pages in it.

1. Open the **database** page in Notion (the page that contains your vocabulary table).
2. Click the **⋯** (More) menu in the top-right.
3. Under **Connections**, click **+ Add connections** (or **Add connections**).
4. Search for your integration (e.g. “Translate & Save Extension”) and select it.
5. Confirm so the integration can access that page and its contents.

After this, the extension can create new rows in that database via the API.

## 4. Get the Database ID

1. Open the database as a **full page** (click the database title so the URL is the database page).
2. The URL looks like:
   - `https://www.notion.so/workspace/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...`  
   or  
   - `https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...`  
   The **Database ID** is the 32-character block (with or without hyphens). Notion often shows it with hyphens, e.g. `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.
3. Copy that ID. If the URL has hyphens in the ID, you can use it with or without hyphens (Notion accepts both). Paste this into the extension **Options** as **Notion Database ID**.

## 5. Enter values in the extension

1. In Safari, open the extension **Options** (right‑click the extension → **Manage Extension** → **Options**, or from Safari Settings → Extensions).
2. Set:
   - **Notion Integration Token** — the **API secret** from step 2 (the `secret_…` value from your integration’s Configuration tab).
   - **Notion Database ID** — the database ID from step 4.
3. Save. Then use **Save** in the tooltip to create a new row in that database.

## Troubleshooting

- **“Invalid API secret”** — Use the **API secret** from your integration’s **Configuration** tab (starts with `secret_`). Paste the full value with no extra spaces. If it was exposed, create a new secret in the integration settings.
- **“Database not found”** — Use the **Database ID** from the database **page** URL (open the database as a full page; the 32-character ID is in the URL). You can paste it with or without hyphens. The database must also be **connected** to your integration (step 3).
- **“No access” / 403** — The database must be **connected** to your integration. In Notion: open the database page → **⋯** (top right) → **Connections** → **+ Add connections** → select your integration.
- **Missing or wrong columns** — Property **names** must match exactly: **Word** (Title), **Translation** (Rich text), **Synonyms** (Rich text), **Word Class** (Select with options: Noun, Pronoun, Verb, Adjective, Adverb, Preposition, Conjunction, Interjection, phrase). Rename columns in Notion to match if needed.
