(function () {
  "use strict";

  var panelWriting = document.getElementById("panelWriting");
  var panelTranslate = document.getElementById("panelTranslate");
  var btnModeWriting = document.getElementById("btnModeWriting");
  var btnModeTranslate = document.getElementById("btnModeTranslate");
  var textEl = document.getElementById("writingText");
  var actionEl = document.getElementById("writingAction");
  var submitBtn = document.getElementById("writingSubmit");
  var resultEl = document.getElementById("writingResult");
  var translateTextEl = document.getElementById("translateText");
  var translateSubmitBtn = document.getElementById("translateSubmit");
  var translateResultEl = document.getElementById("translateResult");

  function setMode(mode) {
    var isWriting = mode === "writing";
    if (panelWriting) panelWriting.style.display = isWriting ? "block" : "none";
    if (panelTranslate) panelTranslate.style.display = isWriting ? "none" : "block";
    if (btnModeWriting) btnModeWriting.classList.toggle("active", isWriting);
    if (btnModeTranslate) btnModeTranslate.classList.toggle("active", !isWriting);
  }

  if (btnModeWriting) btnModeWriting.addEventListener("click", function () { setMode("writing"); });
  if (btnModeTranslate) btnModeTranslate.addEventListener("click", function () { setMode("translate"); });

  function showResult(el, content, isError) {
    if (!el) return;
    el.textContent = content || "";
    el.className = "writing-support-result visible" + (isError ? " error" : "");
  }

  function showLoading(el) {
    if (!el) return;
    el.textContent = "Loading…";
    el.className = "writing-support-result visible loading";
  }

  if (submitBtn) {
    submitBtn.addEventListener("click", function () {
      var text = (textEl && textEl.value) ? textEl.value.trim() : "";
      if (!text) {
        showResult(resultEl, "Enter or paste some text first.", true);
        return;
      }
      var action = (actionEl && actionEl.value) ? actionEl.value : "writing_comment";
      submitBtn.disabled = true;
      showLoading(resultEl);

      browser.runtime.sendMessage({ type: "writingSupport", text: text, action: action })
        .then(function (r) {
          submitBtn.disabled = false;
          if (r && r.error) {
            showResult(resultEl, r.error, true);
          } else if (action === "lookup_chinese" && (r && (r.fromNotion != null || r.fromDeepSeek != null))) {
            resultEl.className = "writing-support-result visible";
            resultEl.innerHTML = "";
            if (r.fromNotion) {
              var fromDb = document.createElement("div");
              fromDb.className = "writing-support-lookup-from-notion";
              fromDb.textContent = r.fromNotion;
              resultEl.appendChild(fromDb);
            }
            if (r.fromDeepSeek) {
              var fromAi = document.createElement("div");
              fromAi.className = "writing-support-lookup-from-deepseek";
              fromAi.textContent = "Suggested (not in your database):\n" + r.fromDeepSeek;
              resultEl.appendChild(fromAi);
            }
          } else {
            showResult(resultEl, (r && r.result) ? r.result : "No response.", false);
          }
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          showResult(resultEl, (err && err.message) ? err.message : "Request failed.", true);
        });
    });
  }

  if (translateSubmitBtn && translateResultEl) {
    translateSubmitBtn.addEventListener("click", function () {
      var text = (translateTextEl && translateTextEl.value) ? translateTextEl.value.trim() : "";
      if (!text) {
        showResult(translateResultEl, "Enter or paste some text first.", true);
        return;
      }
      translateSubmitBtn.disabled = true;
      showLoading(translateResultEl);

      browser.runtime.sendMessage({ type: "translate", text: text })
        .then(function (r) {
          translateSubmitBtn.disabled = false;
          if (r && r.error) {
            showResult(translateResultEl, r.error, true);
          } else if (r && r.meanings && r.meanings.length > 0) {
            var lines = r.meanings.map(function (m, i) {
              var t = (m.translation || "").trim();
              var s = (m.sense || "").trim();
              return (i + 1) + ". " + t + (s ? " (" + s + ")" : "");
            });
            showResult(translateResultEl, lines.join("\n"), false);
          } else {
            showResult(translateResultEl, (r && r.translation) ? r.translation : "No translation.", false);
          }
        })
        .catch(function (err) {
          translateSubmitBtn.disabled = false;
          showResult(translateResultEl, (err && err.message) ? err.message : "Translation failed.", true);
        });
    });
  }
})();
