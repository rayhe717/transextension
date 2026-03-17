(function () {
  const inputText = document.getElementById("inputText");
  const btnTranslate = document.getElementById("btnTranslate");
  const translationArea = document.getElementById("translationArea");
  const meaningsRow = document.getElementById("meaningsRow");
  const meaningsList = document.getElementById("meaningsList");
  const btnSave = document.getElementById("btnSave");
  const saveStatus = document.getElementById("saveStatus");
  const alreadyInNotionEl = document.getElementById("alreadyInNotionEl");
  const alsoSynonymInEl = document.getElementById("alsoSynonymInEl");
  const errorArea = document.getElementById("errorArea");
  const btnModeTranslate = document.getElementById("btnModeTranslate");
  const btnModeWriting = document.getElementById("btnModeWriting");
  const popupPanelTranslate = document.getElementById("popupPanelTranslate");
  const popupPanelWriting = document.getElementById("popupPanelWriting");
  const popupWritingText = document.getElementById("popupWritingText");
  const popupWritingResult = document.getElementById("popupWritingResult");

  let lastPayload = null;
  let popupPanelMode = "translate";

  function setPopupMode(mode) {
    popupPanelMode = mode;
    if (popupPanelTranslate) popupPanelTranslate.style.display = mode === "translate" ? "" : "none";
    if (popupPanelWriting) popupPanelWriting.style.display = mode === "writing" ? "" : "none";
    if (btnModeTranslate) btnModeTranslate.classList.toggle("active", mode === "translate");
    if (btnModeWriting) btnModeWriting.classList.toggle("active", mode === "writing");
  }

  function showError(msg) {
    errorArea.textContent = msg || "";
    errorArea.style.display = msg ? "block" : "none";
  }

  function setTranslation(result) {
    lastPayload = Object.assign({}, result, { original: inputText.value.trim() });
    translationArea.style.display = "block";
    showError("");
    if (alreadyInNotionEl) { alreadyInNotionEl.textContent = ""; alreadyInNotionEl.style.display = "none"; }
    if (alsoSynonymInEl) { alsoSynonymInEl.textContent = ""; alsoSynonymInEl.style.display = "none"; }
    const exampleSentenceEl = document.getElementById("exampleSentence");
    const notesFieldEl = document.getElementById("notesField");
    if (exampleSentenceEl) exampleSentenceEl.value = "";
    if (notesFieldEl) notesFieldEl.value = "";

    if (result.meanings && result.meanings.length > 0) {
      meaningsRow.style.display = "block";
      meaningsList.innerHTML = "";
      result.meanings.forEach((m, i) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "meaning";
        input.value = String(i);
        input.checked = true;
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + (m.translation || "") + (m.sense ? " (" + m.sense + ")" : "")));
        meaningsList.appendChild(label);
      });
    } else {
      meaningsRow.style.display = "none";
    }
    saveStatus.textContent = "";
  }

  async function pasteClipboard() {
    try {
      const text = await window.electronAPI.getClipboard();
      inputText.value = text || "";
    } catch (e) {
      showError(e && e.message ? e.message : "Failed to read clipboard");
    }
  }

  async function translate() {
    const text = (inputText.value || "").trim();
    if (!text) {
      showError("Enter or paste text to translate.");
      return;
    }
    btnTranslate.disabled = true;
    showError("");
    translationArea.style.display = "none";
    try {
      const result = await window.electronAPI.translate(text);
      setTranslation(result);
    } catch (e) {
      showError(e && e.message ? e.message : "Translation failed.");
    } finally {
      btnTranslate.disabled = false;
    }
  }

  function getSelectedMeanings() {
    if (!lastPayload) return null;
    if (lastPayload.meanings && lastPayload.meanings.length > 0) {
      const checked = Array.from(document.querySelectorAll('input[name="meaning"]:checked')).map((el) => parseInt(el.value, 10));
      const indices = checked.length > 0 ? checked : lastPayload.meanings.map((_, i) => i);
      const meanings = indices
        .map((idx) => lastPayload.meanings[idx])
        .filter(Boolean)
        .map((m) => ({
          translation: m.translation || "",
          sense: m.sense || "",
          synonyms: Array.isArray(m.synonyms) ? m.synonyms : [],
        }));
      if (meanings.length === 0) return null;
      return {
        original: lastPayload.original || inputText.value.trim(),
        base_form: lastPayload.base_form || lastPayload.original || inputText.value.trim(),
        meanings,
      };
    }
    return {
      original: lastPayload.original || inputText.value.trim(),
      base_form: lastPayload.base_form || lastPayload.original || inputText.value.trim(),
      meanings: [{
        translation: lastPayload.translation || "",
        sense: "",
        synonyms: lastPayload.synonyms || [],
      }],
    };
  }

  const exampleSentenceEl = document.getElementById("exampleSentence");
  const notesFieldEl = document.getElementById("notesField");

  async function save() {
    const payload = getSelectedMeanings();
    if (!payload) {
      saveStatus.textContent = "Translate first or select at least one meaning.";
      saveStatus.classList.add("error");
      return;
    }
    payload.example = (exampleSentenceEl && exampleSentenceEl.value) ? exampleSentenceEl.value.trim() : "";
    payload.notes = (notesFieldEl && notesFieldEl.value) ? notesFieldEl.value.trim() : "";
    btnSave.disabled = true;
    saveStatus.textContent = "Saving…";
    saveStatus.classList.remove("error");
    try {
      await window.electronAPI.saveToVault(payload);
      saveStatus.textContent = "Saved to vault.";
      saveStatus.classList.remove("error");
      showError("");
      if (alreadyInNotionEl) { alreadyInNotionEl.textContent = ""; alreadyInNotionEl.style.display = "none"; }
      if (alsoSynonymInEl) { alsoSynonymInEl.textContent = ""; alsoSynonymInEl.style.display = "none"; }
    } catch (e) {
      let msg = (e && e.message) ? e.message : "Save failed.";
      msg = msg.replace(/^Error invoking remote method 'saveToVault': Error: /, "");
      saveStatus.textContent = "Save failed.";
      saveStatus.classList.add("error");
      showError(msg);
    } finally {
      btnSave.disabled = false;
    }
  }

  btnTranslate.addEventListener("click", translate);
  btnSave.addEventListener("click", save);

  if (btnModeTranslate) btnModeTranslate.addEventListener("click", () => { setPopupMode("translate"); try { localStorage.setItem("defaultPanelMode", "translate"); } catch (_) {} });
  if (btnModeWriting) btnModeWriting.addEventListener("click", () => { setPopupMode("writing"); try { localStorage.setItem("defaultPanelMode", "writing"); } catch (_) {} });
  const savedMode = (function () { try { return localStorage.getItem("defaultPanelMode"); } catch (_) { return null; } })();
  if (savedMode === "writing") setPopupMode("writing");

  const writingBtns = document.querySelectorAll(".popup-btn-writing");
  for (let i = 0; i < writingBtns.length; i++) {
    writingBtns[i].addEventListener("click", async function () {
      const text = (popupWritingText && popupWritingText.value) ? popupWritingText.value.trim() : "";
      if (!text) {
        if (popupWritingResult) {
          popupWritingResult.textContent = "Enter or paste some text first.";
          popupWritingResult.className = "popup-writing-result error";
        }
        return;
      }
      const action = this.getAttribute("data-action") || "writing_comment";
      if (popupWritingResult) {
        popupWritingResult.textContent = "Loading…";
        popupWritingResult.className = "popup-writing-result";
      }
      try {
        const r = await window.electronAPI.writingSupport({ text, action });
        if (!popupWritingResult) return;
        if (r && r.error) {
          popupWritingResult.textContent = r.error;
          popupWritingResult.className = "popup-writing-result error";
        } else if (action === "lookup_chinese" && r && (r.fromNotion != null || r.fromDeepSeek != null)) {
          popupWritingResult.classList.remove("error");
          popupWritingResult.innerHTML = "";
          if (r.fromNotion) {
            const fromDb = document.createElement("div");
            fromDb.className = "popup-lookup-from-notion";
            fromDb.textContent = r.fromNotion;
            popupWritingResult.appendChild(fromDb);
          }
          if (r.fromDeepSeek) {
            const fromAi = document.createElement("div");
            fromAi.className = "popup-lookup-from-deepseek";
            fromAi.textContent = "Suggested (not in your database):\n" + r.fromDeepSeek;
            popupWritingResult.appendChild(fromAi);
          }
        } else {
          popupWritingResult.textContent = (r && r.result) ? r.result : "";
          popupWritingResult.classList.remove("error");
        }
      } catch (e) {
        if (popupWritingResult) {
          popupWritingResult.textContent = (e && e.message) ? e.message : "Request failed.";
          popupWritingResult.className = "popup-writing-result error";
        }
      }
    });
  }

  pasteClipboard();
})();
