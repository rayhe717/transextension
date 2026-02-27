(function () {
  const inputEl = document.getElementById("inputText");
  const translateBtn = document.getElementById("translateBtn");
  const saveBtn = document.getElementById("saveBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const translationEl = document.getElementById("translationText");
  const statusEl = document.getElementById("statusText");

  let currentPayload = null;

  function setStatus(message, type) {
    statusEl.textContent = message || "";
    statusEl.className = "popup-status" + (type ? " " + type : "");
  }

  function setBusy(isBusy) {
    translateBtn.disabled = isBusy;
    if (isBusy) saveBtn.disabled = true;
  }

  function getInputText() {
    return (inputEl.value || "").trim();
  }

  function translate() {
    const text = getInputText();
    if (!text) {
      setStatus("Type text first.", "error");
      return;
    }
    setBusy(true);
    setStatus("Translating...");
    translationEl.textContent = "";
    currentPayload = null;

    browser.runtime.sendMessage({ type: "translate", text: text })
      .then(function (response) {
        setBusy(false);
        if (!response) {
          setStatus("No response from background.", "error");
          return;
        }
        if (response.error) {
          setStatus(response.error, "error");
          return;
        }
        const translation = (response.translation || "").trim();
        if (!translation) {
          setStatus("Translation is empty. Try again.", "error");
          return;
        }
        translationEl.textContent = translation;
        currentPayload = {
          original: text,
          translation: translation,
          synonyms: Array.isArray(response.synonyms) ? response.synonyms : [],
          word_class: response.word_class || "",
          base_form: response.base_form || "",
          context: null,
          sourceUrl: "",
          pageTitle: "",
        };
        saveBtn.disabled = false;
        setStatus("Ready to save.");
      })
      .catch(function (err) {
        setBusy(false);
        setStatus((err && err.message) || "Translation failed.", "error");
      });
  }

  function save() {
    if (!currentPayload || !currentPayload.translation) {
      setStatus("Translate first before saving.", "error");
      return;
    }
    translateBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus("Saving...");

    browser.runtime.sendMessage({ type: "saveToNotion", payload: currentPayload })
      .then(function (response) {
        translateBtn.disabled = false;
        saveBtn.disabled = false;
        if (response && response.error) {
          setStatus(response.error, "error");
          return;
        }
        setStatus("Saved to Notion.", "success");
      })
      .catch(function (err) {
        translateBtn.disabled = false;
        saveBtn.disabled = false;
        setStatus((err && err.message) || "Save failed.", "error");
      });
  }

  translateBtn.addEventListener("click", translate);
  saveBtn.addEventListener("click", save);
  settingsBtn.addEventListener("click", function () {
    if (browser.runtime && typeof browser.runtime.openOptionsPage === "function") {
      browser.runtime.openOptionsPage();
      return;
    }
    window.open("options.html", "_blank");
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (saveBtn.disabled) translate();
      else save();
    }
  });

  inputEl.focus();
})();
