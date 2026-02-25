# DeepSeek API setup

The extension uses the **DeepSeek API** to translate selected text and to generate synonyms. All requests go from the extension to `https://api.deepseek.com`; no intermediate server is used.

## 1. Get an API key

1. Go to the [DeepSeek Platform](https://platform.deepseek.com) (or the current DeepSeek API sign-up page).
2. Sign up or log in.
3. Open the API keys or billing section and create an **API key** (often shown as a key starting with `sk-`).
4. Copy the key and store it somewhere safe. You’ll paste it into the extension **Options** as **DeepSeek API Key**.

## 2. Put the key in the extension

1. In Safari, open the extension **Options** (right‑click the extension → **Manage Extension** → **Options**, or from Safari Settings → Extensions).
2. Paste your API key into **DeepSeek API Key**.
3. Set **Target language** if you want something other than **Simplified Chinese** (e.g. “English”, “Japanese”).
4. Save.

The key is stored only in the extension’s local storage on your Mac and is sent only to `https://api.deepseek.com` when you select text and the extension requests a translation.

## 3. Usage and limits

- Each time you select text, the extension sends one request to the DeepSeek API. The response is used to show the translation and (on Save) to store synonyms in Notion.
- Billing and rate limits follow your DeepSeek account. If you see **“Rate limit exceeded”**, wait a moment and try again.
- **“Invalid DeepSeek API key”** usually means the key is wrong, expired, or not pasted completely (no extra spaces).

## Security

- The extension uses **HTTPS** for all requests.
- The API key is kept in **Safari extension storage** (local to your Mac) and is not sent to any server other than DeepSeek’s API.
