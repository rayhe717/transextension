/**
 * Options page: load/save settings using extension storage (local only).
 */

(function () {
  "use strict";

  const DEFAULTS = {
    deepseekApiKey: "",
    notionToken: "",
    notionDatabaseId: "",
    obsidianVaultPath: "",
    obsidianVocabFolder: "vocab",
    targetLanguage: "Simplified Chinese",
    maxSelectionLength: 120,
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
      var vaultEl = document.getElementById("obsidianVaultPath");
      if (vaultEl) vaultEl.value = items.obsidianVaultPath || "";
      var folderEl = document.getElementById("obsidianVocabFolder");
      if (folderEl) folderEl.value = (items.obsidianVocabFolder || "vocab").trim() || "vocab";
      document.getElementById("targetLanguage").value = items.targetLanguage || DEFAULTS.targetLanguage;
      var max = parseInt(items.maxSelectionLength, 10);
      document.getElementById("maxSelectionLength").value = (isNaN(max) || max < 20 || max > 500) ? 120 : max;
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
            if (keychain.obsidianVaultPath !== undefined) merged.obsidianVaultPath = keychain.obsidianVaultPath;
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
    const obsidianVocabFolder = (document.getElementById("obsidianVocabFolder") && document.getElementById("obsidianVocabFolder").value) ? document.getElementById("obsidianVocabFolder").value.trim() : "vocab";
    const obsidianVaultPath = (document.getElementById("obsidianVaultPath") && document.getElementById("obsidianVaultPath").value) ? document.getElementById("obsidianVaultPath").value.trim() : "";
    const targetLanguage = (document.getElementById("targetLanguage").value || "").trim() || DEFAULTS.targetLanguage;
    var maxRaw = parseInt(document.getElementById("maxSelectionLength").value, 10);
    const maxSelectionLength = (isNaN(maxRaw) || maxRaw < 20 || maxRaw > 500) ? 120 : maxRaw;

    var toStore = {
      deepseekApiKey,
      notionToken,
      notionDatabaseId,
      obsidianVaultPath,
      obsidianVocabFolder: obsidianVocabFolder || "vocab",
      targetLanguage,
      maxSelectionLength,
    };
    browser.storage.local.set(toStore).then(function () {
      browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
        type: "persistOptions",
        options: { deepseekApiKey, notionToken, notionDatabaseId, obsidianVaultPath },
      }).catch(function () {});
      showStatus("Settings saved.", false);
    }).catch(function () {
      showStatus("Failed to save settings.", true);
    });
  }

  function pickVault() {
    var btn = document.getElementById("pickVaultBtn");
    if (btn) btn.disabled = true;
    browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", { type: "pickVaultFolder" })
      .then(function (res) {
        if (!res) throw new Error("No response. Try again.");
        if (res.error) throw new Error(res.error);
        var vaultPath = (res.vaultPath || "").trim();
        if (!vaultPath) throw new Error("No vault folder returned.");
        var vaultEl = document.getElementById("obsidianVaultPath");
        if (vaultEl) vaultEl.value = vaultPath;
        return browser.storage.local.get(DEFAULTS).then(function (items) {
          items.obsidianVaultPath = vaultPath;
          return browser.storage.local.set(items);
        }).then(function () {
          return browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", {
            type: "persistOptions",
            options: { obsidianVaultPath: vaultPath },
          });
        }).catch(function () {});
      })
      .then(function () { showStatus("Vault folder saved.", false); })
      .catch(function (e) {
        showStatus((e && e.message) ? e.message : "Failed to choose vault folder.", true);
        // If the native host opened the container app to pick the vault, poll keychain-backed options for a bit.
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          browser.runtime.sendNativeMessage("com.yourCompany.Translate---Save-to-Notion", { type: "getPersistedOptions" })
            .then(function (o) {
              var p = o && o.obsidianVaultPath ? String(o.obsidianVaultPath).trim() : "";
              if (p) {
                var vaultEl = document.getElementById("obsidianVaultPath");
                if (vaultEl) vaultEl.value = p;
                browser.storage.local.get(DEFAULTS).then(function (items) {
                  items.obsidianVaultPath = p;
                  return browser.storage.local.set(items);
                }).catch(function () {});
                showStatus("Vault folder saved.", false);
                clearInterval(timer);
              }
            })
            .catch(function () {});
          if (tries >= 20) clearInterval(timer);
        }, 500);
      })
      .then(function () { if (btn) btn.disabled = false; }, function () { if (btn) btn.disabled = false; });
  }

  document.addEventListener("DOMContentLoaded", load);
  document.getElementById("options-form").addEventListener("submit", save);
  var pickBtn = document.getElementById("pickVaultBtn");
  if (pickBtn) pickBtn.addEventListener("click", pickVault);
})();
