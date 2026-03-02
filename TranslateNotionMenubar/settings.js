(function () {
  const deepseekApiKey = document.getElementById("deepseekApiKey");
  const notionToken = document.getElementById("notionToken");
  const notionDatabaseId = document.getElementById("notionDatabaseId");
  const targetLanguage = document.getElementById("targetLanguage");
  const btnSave = document.getElementById("btnSave");
  const saveStatus = document.getElementById("saveStatus");

  async function load() {
    const s = await window.electronAPI.getSettings();
    deepseekApiKey.value = s.deepseekApiKey || "";
    notionToken.value = s.notionToken || "";
    notionDatabaseId.value = s.notionDatabaseId || "";
    targetLanguage.value = s.targetLanguage || "Simplified Chinese";
  }

  async function save() {
    await window.electronAPI.setSettings({
      deepseekApiKey: deepseekApiKey.value.trim(),
      notionToken: notionToken.value.trim(),
      notionDatabaseId: notionDatabaseId.value.trim(),
      targetLanguage: targetLanguage.value.trim() || "Simplified Chinese",
    });
    saveStatus.textContent = "Saved.";
    saveStatus.classList.remove("error");
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
  }

  btnSave.addEventListener("click", save);
  load();
})();
