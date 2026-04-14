/**
 * Options page: load/save settings using extension storage (local only).
 */

(function () {
  "use strict";

  const DEFAULTS = {
    deepseekApiKey: "",
    notionToken: "",
    notionDatabaseId: "",
    targetLanguage: "Simplified Chinese",
    maxSelectionLength: 120,
    obsidianVocabFolder: "Vocab_ao3",
    ao3ExportRelPath: "vocab_dump/ao3",
  };

  function showStatus(text, isError) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (isError ? " error" : " success");
    setTimeout(function () {
      el.textContent = "";
      el.className = "status";
    }, 4000);
  }

  function load() {
    function applyItems(items) {
      document.getElementById("deepseekApiKey").value = items.deepseekApiKey || "";
      document.getElementById("notionToken").value = items.notionToken || "";
      document.getElementById("notionDatabaseId").value = items.notionDatabaseId || "";
      document.getElementById("targetLanguage").value = items.targetLanguage || DEFAULTS.targetLanguage;
      var max = parseInt(items.maxSelectionLength, 10);
      document.getElementById("maxSelectionLength").value = (isNaN(max) || max < 20 || max > 500) ? 120 : max;
      document.getElementById("obsidianVocabFolder").value = items.obsidianVocabFolder || DEFAULTS.obsidianVocabFolder;
      document.getElementById("ao3ExportRelPath").value = items.ao3ExportRelPath || DEFAULTS.ao3ExportRelPath;
    }
    browser.storage.local.get(DEFAULTS).then(function (items) {
      applyItems(items);
      browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", { type: "getPersistedOptions" })
        .then(function (keychain) {
          if (keychain && typeof keychain === "object" && !keychain.error) {
            var merged = Object.assign({}, items, keychain);
            if (keychain.deepseekApiKey !== undefined) merged.deepseekApiKey = keychain.deepseekApiKey;
            if (keychain.notionToken !== undefined) merged.notionToken = keychain.notionToken;
            if (keychain.notionDatabaseId !== undefined) merged.notionDatabaseId = keychain.notionDatabaseId;
            applyItems(merged);
            return browser.storage.local.set(merged);
          }
        })
        .catch(function () {});
    }).catch(function () {});
  }

  function save(e) {
    e.preventDefault();
    const deepseekApiKey = (document.getElementById("deepseekApiKey").value || "").trim();
    const notionToken = (document.getElementById("notionToken").value || "").trim();
    const notionDatabaseId = (document.getElementById("notionDatabaseId").value || "").trim();
    const targetLanguage = (document.getElementById("targetLanguage").value || "").trim() || DEFAULTS.targetLanguage;
    var maxRaw = parseInt(document.getElementById("maxSelectionLength").value, 10);
    const maxSelectionLength = (isNaN(maxRaw) || maxRaw < 20 || maxRaw > 500) ? 120 : maxRaw;

    const obsidianVocabFolder = (document.getElementById("obsidianVocabFolder").value || "").trim() || DEFAULTS.obsidianVocabFolder;
    const ao3ExportRelPath = (document.getElementById("ao3ExportRelPath").value || "").trim() || DEFAULTS.ao3ExportRelPath;

    var toStore = {
      deepseekApiKey,
      notionToken,
      notionDatabaseId,
      targetLanguage,
      maxSelectionLength,
      obsidianVocabFolder,
      ao3ExportRelPath,
    };
    browser.storage.local.set(toStore).then(function () {
      browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
        type: "persistOptions",
        options: { deepseekApiKey, notionToken, notionDatabaseId },
      }).catch(function () {});
      showStatus("Settings saved.", false);
    }).catch(function () {
      showStatus("Failed to save settings.", true);
    });
  }

  document.addEventListener("DOMContentLoaded", load);
  document.getElementById("options-form").addEventListener("submit", save);

  // ── Obsidian Sync UI ────────────────────────────────────────────────────

  var pickVaultBtn = document.getElementById("pickVaultBtn");
  var syncNowBtn = document.getElementById("syncNowBtn");
  var linkWordsBtn = document.getElementById("linkWordsBtn");
  var vaultFolderNameEl = document.getElementById("vaultFolderName");
  var syncLogEl = document.getElementById("syncLog");
  var linkWordsLogEl = document.getElementById("linkWordsLog");

  function appendLinkWordsLog(line) {
    if (!linkWordsLogEl) return;
    linkWordsLogEl.textContent = line;
  }

  function setVaultName(name) {
    if (!vaultFolderNameEl) return;
    if (name) {
      vaultFolderNameEl.textContent = name;
      vaultFolderNameEl.classList.add("is-set");
    } else {
      vaultFolderNameEl.textContent = "No folder selected";
      vaultFolderNameEl.classList.remove("is-set");
    }
  }

  function appendLog(line) {
    if (!syncLogEl) return;
    syncLogEl.textContent = line;
  }

  // Restore persisted handle on load
  document.addEventListener("DOMContentLoaded", function () {
    if (!window.ObsidianSync) return;
    ObsidianSync.loadVaultHandle().then(function (handle) {
      if (handle) {
        setVaultName(handle.name);
        if (syncNowBtn) syncNowBtn.disabled = false;
        if (linkWordsBtn) linkWordsBtn.disabled = false;
      } else {
        setVaultName(null);
      }
    }).catch(function () {
      setVaultName(null);
    });
  });

  if (pickVaultBtn) {
    pickVaultBtn.addEventListener("click", async function () {
      if (!window.showDirectoryPicker) {
        alert("File System Access API is not supported in this browser.");
        return;
      }
      try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        await ObsidianSync.saveVaultHandle(handle);
        setVaultName(handle.name);
        if (syncNowBtn) syncNowBtn.disabled = false;
        if (linkWordsBtn) linkWordsBtn.disabled = false;
      } catch (err) {
        if (err && err.name !== "AbortError") {
          alert("Could not pick folder: " + (err.message || err));
        }
      }
    });
  }

  if (syncNowBtn) {
    syncNowBtn.addEventListener("click", async function () {
      if (!window.ObsidianSync) return;

      var items = await browser.storage.local.get(DEFAULTS);
      var token = (items.notionToken || "").trim();
      var databaseId = (items.notionDatabaseId || "").trim();
      var vocabFolder = (document.getElementById("obsidianVocabFolder").value || "").trim() || DEFAULTS.obsidianVocabFolder;

      if (!token || !databaseId) {
        appendLog("ERROR: Notion token and database ID must be set in settings above.");
        return;
      }

      var rootDirHandle = await ObsidianSync.loadVaultHandle();
      if (!rootDirHandle) {
        appendLog("ERROR: No vault folder selected. Click 'Pick vault folder' first.");
        return;
      }

      // Re-request permission in case it lapsed
      try {
        var perm = await rootDirHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
          perm = await rootDirHandle.requestPermission({ mode: "readwrite" });
        }
        if (perm !== "granted") {
          appendLog("ERROR: Read/write permission to vault folder was denied.");
          return;
        }
      } catch (err) {
        appendLog("ERROR: " + (err && err.message ? err.message : String(err)));
        return;
      }

      syncNowBtn.disabled = true;
      appendLog("Syncing…");

      try {
        await ObsidianSync.runObsidianSync({
          token,
          databaseId,
          rootDirHandle,
          vocabFolder,
          onLog: appendLog,
        });
      } catch (err) {
        appendLog("ERROR: " + (err && err.message ? err.message : String(err)));
      } finally {
        syncNowBtn.disabled = false;
      }
    });
  }
  if (linkWordsBtn) {
    linkWordsBtn.addEventListener("click", async function () {
      if (!window.LinkWords) return;

      var rootDirHandle = await ObsidianSync.loadVaultHandle();
      if (!rootDirHandle) {
        appendLinkWordsLog("ERROR: No vault folder selected. Click 'Change' to pick one.");
        return;
      }

      try {
        var perm = await rootDirHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") perm = await rootDirHandle.requestPermission({ mode: "readwrite" });
        if (perm !== "granted") { appendLinkWordsLog("ERROR: Permission denied."); return; }
      } catch (err) {
        appendLinkWordsLog("ERROR: " + (err && err.message ? err.message : String(err)));
        return;
      }

      linkWordsBtn.disabled = true;
      appendLinkWordsLog("Running…");

      try {
        await LinkWords.runLinkWords({ rootDirHandle: rootDirHandle, onLog: appendLinkWordsLog });
      } catch (err) {
        appendLinkWordsLog("ERROR: " + (err && err.message ? err.message : String(err)));
      } finally {
        linkWordsBtn.disabled = false;
      }
    });
  }
})();
