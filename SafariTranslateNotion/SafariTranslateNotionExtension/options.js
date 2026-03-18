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

    var toStore = {
      deepseekApiKey,
      notionToken,
      notionDatabaseId,
      targetLanguage,
      maxSelectionLength,
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
})();
