# Build and run in Safari

The extension is a **Safari Web Extension** (Manifest V3). You need to produce an Xcode project and then build and run it on macOS.

## Option A: Safari Web Extension converter (recommended)

Apple provides a command-line tool that turns a Web Extension folder into an Xcode project.

1. Open **Terminal** and go to the folder that **contains** the extension folder (e.g. the `SafariTranslateNotion` folder):

   ```bash
   cd /path/to/SafariTranslateNotion
   ```

2. Run the converter and pass the **extension folder** name:

   ```bash
   xcrun safari-web-extension-converter SafariTranslateNotionExtension
   ```

3. Follow the prompts. The tool will create an Xcode project (e.g. `SafariTranslateNotionExtension.xcodeproj`) and a host app. When asked for the **Safari Extension name**, you can use e.g. **Translate & Save to Notion**.

4. Open the generated project in Xcode. The converter creates a folder named after the app (e.g. **Translate & Save to Notion**); the `.xcodeproj` is inside it:

   ```bash
   open "Translate & Save to Notion/Translate & Save to Notion.xcodeproj"
   ```

5. In Xcode:
   - Select the **host app** scheme (e.g. SafariTranslateNotionExtension (macOS)).
   - Choose **My Mac** as the run destination.
   - Press **Run** (⌘R). The host app will launch and install the extension into Safari.

6. **Enable the extension in Safari:**
   - Safari → **Settings** (or **Preferences**) → **Extensions**.
   - Enable **Translate & Save to Notion** (or the name you gave).
   - If prompted, approve access to browse the web (or the sites you want).

7. **Open extension options:**
   - Right‑click the extension in the Extensions list → **Manage Extension** → **Options**,  
   - or use the extension’s **Options** entry in the Extensions pane.  
   Then add your [DeepSeek API key](SETUP-DEEPSEEK.md) and [Notion token and database ID](SETUP-NOTION.md).

## Option B: Create the project manually in Xcode

If the converter is not available or you prefer to set things up by hand:

1. In Xcode: **File → New → Project**. Choose **macOS → App**. Name the app (e.g. **SafariTranslateNotion**), set Team and organization, then create the project.

2. **File → New → Target**. Choose **Safari Extension → Safari Web Extension**. Name the extension (e.g. **Translate & Save to Notion**). Xcode will create an extension target and a default extension folder with a sample `manifest.json` and scripts.

3. **Replace the contents** of the generated extension folder with the contents of **SafariTranslateNotionExtension** (all files: `manifest.json`, `content.js`, `content.css`, `background.js`, `options.html`, `options.js`, `options.css`). Keep the folder structure so that paths in `manifest.json` still match (e.g. `options.html`, `background.js` at the root of that folder).

4. Ensure the extension target’s **Copy Bundle Resources** build phase includes every file the extension needs (manifest, JS, CSS, HTML). If you replaced the folder contents, the same file names should already be referenced.

5. Build and run the **host app** (⌘R), then enable the extension in **Safari → Settings → Extensions** and configure options as in Option A, step 7.

## Signing

- **Development:** Use your **Apple ID** (no paid program required). In Xcode, select **both** the **app** target and the **Safari extension** target → **Signing & Capabilities**, and set **Team** to the same Apple ID for both. The extension must be signed with the same certificate as the app or Safari will not show it.
- **Distribution:** For App Store or notarized distribution you need an **Apple Developer Program** membership and the appropriate signing identity. Sign both the host app and the Safari extension target.

## Permissions

When you first enable the extension, Safari may ask for permission to read and change content on websites. Grant access for the sites where you want to use “select text → translate → save to Notion.” The extension only runs on pages you visit and only when you select text; it does not inject scripts on every page in a way that would require broad “Access all websites” unless you choose that.

## Troubleshooting

- **Extension doesn’t appear in Safari:** (1) Run the host app at least once (⌘R in Xcode, or double‑click the built app). (2) Open **Safari → Settings → Extensions** and look for **Translate & Save to Notion** or **Translate & Save to Notion Extension**; turn it on. (3) On macOS Ventura+, check **System Settings → Privacy & Security → Extensions → Safari** and allow the extension. (4) If still missing, quit Safari, run the host app from Finder, then open Safari again.
- **“Embedded binary is not signed with the same certificate”:** Set the **same Team** for both the app and the Safari extension target in Signing & Capabilities.
- **“Invalid API key” / “Database not found”:** Configure **Options** with the correct [DeepSeek key](SETUP-DEEPSEEK.md) and [Notion token and database ID](SETUP-NOTION.md).
- **Tooltip doesn’t show:** Confirm the page isn’t a special Safari view (e.g. some internal pages). Try a normal website. Ensure the extension is enabled for that site in Extensions settings.
- **Build errors about missing files:** Verify all extension files are in the extension folder and listed in the extension target’s **Copy Bundle Resources**.
