(function () {
  const inputEl = document.getElementById("inputText");
  const translateBtn = document.getElementById("translateBtn");
  const saveBtn = document.getElementById("saveBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const translationEl = document.getElementById("translationText");
  const meaningsListEl = document.getElementById("meaningsList");
  const statusEl = document.getElementById("statusText");
  const alreadyInNotionEl = document.getElementById("alreadyInNotionEl");
  const alsoSynonymInEl = document.getElementById("alsoSynonymInEl");
  const exampleSentenceEl = document.getElementById("exampleSentence");
  const notesFieldEl = document.getElementById("notesField");

  let currentPayload = null;

  function showAlsoSynonymIn(wordTitles) {
    if (!alsoSynonymInEl) return;
    if (!wordTitles || wordTitles.length === 0) {
      alsoSynonymInEl.textContent = "";
      alsoSynonymInEl.style.display = "none";
      return;
    }
    alsoSynonymInEl.textContent = "Also appears in: " + wordTitles.join(", ");
    alsoSynonymInEl.style.display = "block";
  }

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
    if (exampleSentenceEl) exampleSentenceEl.value = "";
    if (notesFieldEl) notesFieldEl.value = "";
    if (alreadyInNotionEl) { alreadyInNotionEl.textContent = ""; alreadyInNotionEl.style.display = "none"; }
    if (alsoSynonymInEl) { alsoSynonymInEl.textContent = ""; alsoSynonymInEl.style.display = "none"; }
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
        const meanings = (response.meanings && response.meanings.length) ? response.meanings : null;
        if (!translation && (!meanings || meanings.length === 0)) {
          setStatus("Translation is empty. Try again.", "error");
          return;
        }
        currentPayload = {
          original: text,
          translation: translation,
          base_form: response.base_form || "",
          context: null,
          sourceUrl: "",
          pageTitle: "",
        };
        if (meanings) {
          currentPayload.meanings = meanings;
          translationEl.textContent = "";
          translationEl.style.display = "none";
          meaningsListEl.innerHTML = "";
          meaningsListEl.style.display = "block";
          meanings.forEach(function (m, i) {
            var trans = (m.translation || "").trim();
            var sense = (m.sense || "").trim();
            var labelText = (i + 1) + ". " + trans + (sense ? " (" + sense + ")" : "");
            var label = document.createElement("label");
            label.className = "popup-meaning-row";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.setAttribute("data-meaning-index", String(i));
            label.appendChild(cb);
            label.appendChild(document.createTextNode(" " + labelText));
            meaningsListEl.appendChild(label);
          });
        } else {
          currentPayload.synonyms = Array.isArray(response.synonyms) ? response.synonyms : [];
          currentPayload.word_class = response.word_class || "";
          translationEl.style.display = "";
          translationEl.textContent = translation;
          meaningsListEl.innerHTML = "";
          meaningsListEl.style.display = "none";
        }
        saveBtn.disabled = false;
        setStatus(meanings && meanings.length > 0 ? "Choose sense(s) to save, then click Save." : "Ready to save.");
        if (alreadyInNotionEl) {
          alreadyInNotionEl.textContent = "";
          alreadyInNotionEl.style.display = "none";
        }
        var existingPromise = browser.runtime.sendMessage({ type: "checkNotionExisting", word: text, baseForm: response.base_form || "" });
        var synonymInPromise = browser.runtime.sendMessage({ type: "getAlsoSynonymIn", word: text, baseForm: response.base_form || "" });
        Promise.allSettled([existingPromise, synonymInPromise]).then(function (results) {
          var r = results[0].status === "fulfilled" ? results[0].value : null;
          var r2 = results[1].status === "fulfilled" ? results[1].value : null;
          if (alreadyInNotionEl && r && r.found && r.value) {
            alreadyInNotionEl.textContent = "Already in Vault: " + r.value;
            alreadyInNotionEl.style.display = "block";
          }
          if (r2 && r2.alsoSynonymIn && Array.isArray(r2.alsoSynonymIn) && r2.alsoSynonymIn.length > 0) {
            showAlsoSynonymIn(r2.alsoSynonymIn);
          }
        });
      })
      .catch(function (err) {
        setBusy(false);
        setStatus((err && err.message) || "Translation failed.", "error");
      });
  }

  function getSelectedMeaningsPayload() {
    if (!currentPayload) return null;
    if (!currentPayload.meanings || currentPayload.meanings.length === 0) {
      return currentPayload;
    }
    var checked = meaningsListEl.querySelectorAll("input[type=checkbox]:checked");
    if (!checked || checked.length === 0) {
      setStatus("Select at least one sense to save.", "error");
      return null;
    }
    var selected = [];
    for (var i = 0; i < checked.length; i++) {
      var idx = parseInt(checked[i].getAttribute("data-meaning-index"), 10);
      if (!isNaN(idx) && currentPayload.meanings[idx]) selected.push(currentPayload.meanings[idx]);
    }
    if (selected.length === 0) return null;
    return {
      original: currentPayload.original,
      base_form: currentPayload.base_form,
      context: currentPayload.context,
      meanings: selected,
    };
  }

  function save() {
    var payload = currentPayload && currentPayload.meanings ? getSelectedMeaningsPayload() : (currentPayload || null);
    if (!payload) {
      if (!currentPayload) setStatus("Translate first before saving.", "error");
      return;
    }
    payload.example = (exampleSentenceEl && exampleSentenceEl.value) ? exampleSentenceEl.value.trim() : "";
    payload.notes = (notesFieldEl && notesFieldEl.value) ? notesFieldEl.value.trim() : "";
    translateBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus("Saving...");

    browser.runtime.sendMessage({ type: "saveToVault", payload: payload })
      .then(function (response) {
        translateBtn.disabled = false;
        saveBtn.disabled = false;
        if (response && response.error) {
          setStatus(response.error, "error");
          return;
        }
        var count = (response && response.count) ? response.count : 1;
        setStatus("Saved " + count + (count === 1 ? " entry" : " entries") + " to Vault.", "success");
        var alsoIn = response && response.alsoSynonymIn && response.alsoSynonymIn.length > 0 ? response.alsoSynonymIn : null;
        showAlsoSynonymIn(alsoIn);
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

  var popupModeSwitch = document.getElementById("popupModeSwitch");
  var popupPanelTranslate = document.getElementById("popupPanelTranslate");
  var popupPanelWriting = document.getElementById("popupPanelWriting");
  var popupWritingText = document.getElementById("popupWritingText");
  var popupWritingResult = document.getElementById("popupWritingResult");
  var popupPanelMode = "translate";

  function setPopupMode(mode) {
    popupPanelMode = mode;
    if (popupPanelTranslate) popupPanelTranslate.style.display = mode === "translate" ? "" : "none";
    if (popupPanelWriting) popupPanelWriting.style.display = mode === "writing" ? "" : "none";
    if (popupModeSwitch) popupModeSwitch.textContent = mode === "translate" ? "Writing" : "Translate";
  }

  if (popupModeSwitch) {
    popupModeSwitch.addEventListener("click", function () {
      setPopupMode(popupPanelMode === "translate" ? "writing" : "translate");
      browser.storage.local.set({ defaultPanelMode: popupPanelMode });
    });
    browser.storage.local.get("defaultPanelMode").then(function (o) {
      var mode = (o.defaultPanelMode === "writing") ? "writing" : "translate";
      setPopupMode(mode);
      if (mode === "writing" && popupWritingText) popupWritingText.focus();
      else if (inputEl) inputEl.focus();
    });
  } else if (inputEl) {
    inputEl.focus();
  }

  var writingBtns = document.querySelectorAll(".popup-btn-writing");
  for (var i = 0; i < writingBtns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var text = (popupWritingText && popupWritingText.value) ? popupWritingText.value.trim() : "";
        if (!text) {
          if (popupWritingResult) { popupWritingResult.textContent = "Enter or paste some text first."; popupWritingResult.className = "popup-writing-result error"; }
          return;
        }
        var action = btn.getAttribute("data-action") || "writing_comment";
        if (popupWritingResult) {
          popupWritingResult.textContent = "Loading…";
          popupWritingResult.className = "popup-writing-result";
        }
        browser.runtime.sendMessage({ type: "writingSupport", text: text, action: action })
          .then(function (r) {
            if (!popupWritingResult) return;
            if (r && r.error) {
              popupWritingResult.textContent = r.error;
              popupWritingResult.className = "popup-writing-result error";
            } else if (action === "lookup_chinese" && (r && (r.fromNotion != null || r.fromDeepSeek != null))) {
              popupWritingResult.classList.remove("error");
              popupWritingResult.innerHTML = "";
              if (r.fromNotion) {
                var fromDb = document.createElement("div");
                fromDb.className = "popup-lookup-from-notion";
                fromDb.textContent = r.fromNotion;
                popupWritingResult.appendChild(fromDb);
              }
              if (r.fromDeepSeek) {
                var fromAi = document.createElement("div");
                fromAi.className = "popup-lookup-from-deepseek";
                fromAi.textContent = "Suggested (not in your database):\n" + r.fromDeepSeek;
                popupWritingResult.appendChild(fromAi);
              }
            } else {
              popupWritingResult.textContent = (r && r.result) ? r.result : "";
              popupWritingResult.classList.remove("error");
            }
          })
          .catch(function (e) {
            if (popupWritingResult) {
              popupWritingResult.textContent = (e && e.message) ? e.message : "Request failed.";
              popupWritingResult.className = "popup-writing-result error";
            }
          });
      });
    })(writingBtns[i]);
  }

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (saveBtn.disabled) translate();
      else save();
    }
  });
})();
