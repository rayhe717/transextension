/**
 * Content script: selection detection and tooltip UI.
 * Ignores input, textarea, password, contentEditable.
 */

(function () {
  "use strict";

  if (window.__stnContentScriptInitialized) return;
  window.__stnContentScriptInitialized = true;

  const DEFAULT_MAX_SELECTION_LENGTH = 120;
  const BACKDROP_ID = "stn-tooltip-backdrop";
  const TOOLTIP_ID = "stn-tooltip-root";

  let maxSelectionLength = DEFAULT_MAX_SELECTION_LENGTH;
  browser.runtime.sendMessage({ type: "getConfig" }).then(function (r) {
    if (r && typeof r.maxSelectionLength === "number" && r.maxSelectionLength >= 20 && r.maxSelectionLength <= 500) {
      maxSelectionLength = r.maxSelectionLength;
    }
  }).catch(function () {});

  let tooltipEl = null;
  let backdropEl = null;
  let currentPayload = null;
  let lastTooltipShowTime = 0;
  var TOOLTIP_DEBOUNCE_MS = 400;
  let suppressMouseUpUntil = 0;

  function isIgnoredElement(node) {
    if (!node || !node.getAttribute) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !el.closest) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return true;
    if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password") return true;
    if (el.closest("[contenteditable='true'], [contenteditable='']")) return true;
    return false;
  }

  function getSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const text = (range.toString() || "").trim();
    if (!text || text.length > maxSelectionLength) return null;
    const container = range.commonAncestorContainer;
    if (isIgnoredElement(container)) return null;
    return text;
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  }

  function removeTooltip() {
    var tooltips = document.querySelectorAll("#" + TOOLTIP_ID);
    for (var i = 0; i < tooltips.length; i++) {
      if (tooltips[i] && tooltips[i].parentNode) tooltips[i].parentNode.removeChild(tooltips[i]);
    }
    var backdrops = document.querySelectorAll("#" + BACKDROP_ID);
    for (var j = 0; j < backdrops.length; j++) {
      if (backdrops[j] && backdrops[j].parentNode) backdrops[j].parentNode.removeChild(backdrops[j]);
    }

    if (backdropEl && backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl);
    if (tooltipEl && tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
    backdropEl = null;
    tooltipEl = null;
    currentPayload = null;
    lastTooltipShowTime = 0;
  }

  function buildSavePayload() {
    if (!currentPayload) return null;
    if (currentPayload.meanings && currentPayload.meanings.length > 0) {
      var root = document.getElementById(TOOLTIP_ID);
      if (!root) return null;
      var checked = root.querySelectorAll(".stn-tooltip-meanings input[type=checkbox]:checked");
      if (!checked || checked.length === 0) return null;
      var selected = [];
      for (var i = 0; i < checked.length; i++) {
        var idx = parseInt(checked[i].getAttribute("data-meaning-index"), 10);
        if (!isNaN(idx) && currentPayload.meanings[idx]) selected.push(currentPayload.meanings[idx]);
      }
      if (selected.length === 0) return null;
      return { original: currentPayload.original, base_form: currentPayload.base_form, context: currentPayload.context, meanings: selected };
    }
    if (currentPayload.translation) return currentPayload;
    return null;
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      removeTooltip();
      document.removeEventListener("keydown", onKeyDown);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && tooltipEl) {
      var payload = buildSavePayload();
      if (payload) { e.preventDefault(); saveToNotion(payload); }
    }
  }

  function positionTooltip(rect) {
    if (!tooltipEl) return;
    const padding = 8;
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    const tipRect = tooltipEl.getBoundingClientRect();
    let top = rect.bottom + padding;
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    if (top + tipRect.height > viewH - padding) {
      top = rect.top - tipRect.height - padding;
    }
    if (top < padding) top = padding;
    if (left < padding) left = padding;
    if (left + tipRect.width > viewW - padding) left = viewW - tipRect.width - padding;
    tooltipEl.style.top = top + window.scrollY + "px";
    tooltipEl.style.left = left + window.scrollX + "px";
  }

  function updateSaveButtonState() {
    var root = document.getElementById(TOOLTIP_ID);
    if (!root) return;
    var saveBtn = root.querySelector(".stn-tooltip-btn-save");
    if (!saveBtn) return;
    var meaningsDiv = root.querySelector(".stn-tooltip-meanings");
    if (meaningsDiv && meaningsDiv.children.length > 0) {
      var anyChecked = root.querySelector(".stn-tooltip-meanings input[type=checkbox]:checked");
      saveBtn.disabled = !anyChecked;
    }
  }

  function renderTooltip(state) {
    const { original, translation, loading, error, saving, saveSuccess, saveError, meanings, alreadyInNotion } = state;
    const root = document.getElementById(TOOLTIP_ID);
    if (!root) return;

    root.setAttribute("data-save-success", saveSuccess ? "true" : "false");

    const headerOriginal = root.querySelector(".stn-tooltip-original");
    const bodyTranslation = root.querySelector(".stn-tooltip-translation");
    const meaningsDiv = root.querySelector(".stn-tooltip-meanings");
    const statusEl = root.querySelector(".stn-tooltip-status");
    const saveBtn = root.querySelector(".stn-tooltip-btn-save");

    if (headerOriginal) headerOriginal.textContent = original || "";
    if (bodyTranslation) {
      if (meanings && meanings.length > 0) {
        bodyTranslation.style.display = "none";
        bodyTranslation.textContent = "";
      } else {
        bodyTranslation.style.display = "";
        if (loading) {
          bodyTranslation.textContent = "Translating…";
          bodyTranslation.classList.add("stn-tooltip-loading");
        } else {
          bodyTranslation.classList.remove("stn-tooltip-loading");
          bodyTranslation.textContent = translation || (error ? "Translation unavailable." : "—");
        }
      }
    }
    if (meaningsDiv) {
      if (meanings && meanings.length > 0) {
        meaningsDiv.style.display = "block";
        if (!saving && !saveSuccess) {
          meaningsDiv.innerHTML = "";
          for (var i = 0; i < meanings.length; i++) {
            var m = meanings[i];
            var trans = (m.translation || "").trim();
            var sense = (m.sense || "").trim();
            var labelText = (i + 1) + ". " + trans + (sense ? " (" + sense + ")" : "");
            var label = document.createElement("label");
            label.className = "stn-tooltip-meaning-row";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = true;
            cb.setAttribute("data-meaning-index", String(i));
            cb.addEventListener("change", updateSaveButtonState);
            label.appendChild(cb);
            label.appendChild(document.createTextNode(" " + labelText));
            meaningsDiv.appendChild(label);
          }
        }
      } else {
        meaningsDiv.innerHTML = "";
        meaningsDiv.style.display = "none";
      }
    }
    var alreadyEl = root.querySelector(".stn-tooltip-already");
    if (alreadyEl) {
      if (alreadyInNotion) {
        alreadyEl.textContent = "Already in Notion: " + alreadyInNotion;
        alreadyEl.style.display = "block";
      } else {
        alreadyEl.textContent = "";
        alreadyEl.style.display = "none";
      }
    }
    if (statusEl) {
      statusEl.textContent = saveSuccess ? "Saved." : saveError || (error || "");
      statusEl.className = "stn-tooltip-status" + (saveError || error ? " error" : "") + (saveSuccess ? " success" : "");
    }
    if (saveBtn) {
      saveBtn.textContent = saving ? "Saving…" : "Save";
      if (loading || saving) {
        saveBtn.disabled = true;
      } else if (meanings && meanings.length > 0) {
        saveBtn.disabled = false;
        updateSaveButtonState();
      } else {
        saveBtn.disabled = !translation;
      }
    }
    root.offsetHeight;
  }

  function flushTooltipPaint() {
    if (!tooltipEl || !tooltipEl.parentNode) return;
    var el = tooltipEl;
    setTimeout(function () {
      if (!el || !el.parentNode) return;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!el || !el.parentNode) return;
          void el.offsetHeight;
        });
      });
    }, 0);
  }

  function showTooltip(rect, original, context) {
    var now = Date.now();
    if (now - lastTooltipShowTime < TOOLTIP_DEBOUNCE_MS) return;
    lastTooltipShowTime = now;
    removeTooltip();

    backdropEl = document.createElement("div");
    backdropEl.id = BACKDROP_ID;
    backdropEl.className = "stn-tooltip-backdrop";
    backdropEl.addEventListener("mouseup", function (ev) { ev.stopPropagation(); }, true);
    backdropEl.addEventListener("mousedown", function () { suppressMouseUpUntil = Date.now() + 500; }, true);
    backdropEl.addEventListener("click", function () {
      suppressMouseUpUntil = Date.now() + 500;
      removeTooltip();
      document.removeEventListener("keydown", onKeyDown);
    });

    tooltipEl = document.createElement("div");
    tooltipEl.id = TOOLTIP_ID;
    tooltipEl.className = "stn-tooltip-root";
    var escapedOriginal = (original || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    tooltipEl.innerHTML =
      '<div class="stn-tooltip-header">' +
      '<span class="stn-tooltip-original">' + escapedOriginal + '</span>' +
      '<button type="button" class="stn-tooltip-close" aria-label="Close">×</button>' +
      "</div>" +
      '<div class="stn-tooltip-body">' +
      '<div class="stn-tooltip-translation stn-tooltip-loading">Translating…</div>' +
      '<div class="stn-tooltip-meanings"></div>' +
      '<div class="stn-tooltip-already"></div>' +
      '<div class="stn-tooltip-actions">' +
      '<button type="button" class="stn-tooltip-btn-save" disabled>Save</button>' +
      '<span class="stn-tooltip-status"></span>' +
      "</div>" +
      "</div>";

    const closeBtn = tooltipEl.querySelector(".stn-tooltip-close");
    const saveBtn = tooltipEl.querySelector(".stn-tooltip-btn-save");

    tooltipEl.addEventListener("mouseup", function (ev) { ev.stopPropagation(); }, true);
    tooltipEl.addEventListener("mousedown", function () { suppressMouseUpUntil = Date.now() + 500; }, true);

    closeBtn.addEventListener("click", function () {
      suppressMouseUpUntil = Date.now() + 500;
      removeTooltip();
      document.removeEventListener("keydown", onKeyDown);
    });

    saveBtn.addEventListener("click", function () {
      var payload = buildSavePayload();
      if (!payload) return;
      saveToNotion(payload);
    });

    document.body.appendChild(backdropEl);
    document.body.appendChild(tooltipEl);
    document.addEventListener("keydown", onKeyDown);

    tooltipEl.style.position = "absolute";
    tooltipEl.style.top = rect.bottom + 8 + window.scrollY + "px";
    tooltipEl.style.left = rect.left + window.scrollX + "px";

    positionTooltip(rect);
    void tooltipEl.offsetHeight;

    renderTooltip({
      original,
      translation: null,
      loading: true,
      error: null,
      saving: false,
      saveSuccess: false,
      saveError: null,
    });
    requestAnimationFrame(function () {
      positionTooltip(rect);
      void tooltipEl.offsetHeight;
    });

    currentPayload = { original, translation: null, synonyms: [], context: context || null, sourceUrl: window.location.href, pageTitle: document.title || "" };

    var responseReceived = false;
    var thisOriginal = original;
    var timeoutId = setTimeout(function () {
      if (responseReceived) return;
      if (!tooltipEl || !tooltipEl.parentNode || !currentPayload || currentPayload.original !== thisOriginal) return;
      responseReceived = true;
      renderTooltip({
        original: thisOriginal,
        translation: null,
        loading: false,
        error: "Translation timed out. In Options, check your DeepSeek API key and internet connection.",
        saving: false,
        saveSuccess: false,
        saveError: null,
      });
      if (currentPayload && currentPayload.original === thisOriginal) currentPayload.translation = null;
    }, 35000);

    function handleTranslateResponse(response) {
      if (responseReceived) return;
      if (!tooltipEl || !tooltipEl.parentNode || !currentPayload || currentPayload.original !== thisOriginal) return;
      responseReceived = true;
      clearTimeout(timeoutId);

      if (!response) {
        renderTooltip({
          original: thisOriginal, translation: null, loading: false,
          error: "No response from background. Try reloading the page.",
          saving: false, saveSuccess: false, saveError: null,
        });
        flushTooltipPaint();
        if (currentPayload) currentPayload.translation = null;
        return;
      }
      if (response.error) {
        renderTooltip({
          original: thisOriginal, translation: null, loading: false,
          error: response.error,
          saving: false, saveSuccess: false, saveError: null,
        });
        flushTooltipPaint();
        if (currentPayload && currentPayload.original === thisOriginal) currentPayload.translation = null;
        return;
      }
      const translation = response.translation || "";
      const synonyms = Array.isArray(response.synonyms) ? response.synonyms : [];
      const isPhrase = (thisOriginal || "").trim().split(/\s+/).length > 1;
      const wordClass = isPhrase ? "phrase" : (response.word_class || "");
      const baseForm = response.base_form || "";
      const meanings = (response.meanings && response.meanings.length) ? response.meanings : null;
      if (currentPayload && currentPayload.original === thisOriginal) {
        currentPayload.translation = translation;
        currentPayload.base_form = baseForm;
        if (meanings) {
          currentPayload.meanings = meanings;
        } else {
          currentPayload.synonyms = synonyms;
          currentPayload.word_class = wordClass;
          currentPayload.meanings = null;
        }
      }
      renderTooltip({
        original: thisOriginal,
        translation,
        loading: false,
        error: null,
        saving: false,
        saveSuccess: false,
        saveError: null,
        meanings: meanings || undefined,
      });
      flushTooltipPaint();
      browser.runtime.sendMessage({ type: "checkNotionExisting", word: thisOriginal, baseForm: baseForm }).then(function (r) {
        if (!tooltipEl || !tooltipEl.parentNode || !currentPayload || currentPayload.original !== thisOriginal) return;
        if (r && r.found && r.value) {
          renderTooltip({
            original: thisOriginal,
            translation,
            loading: false,
            error: null,
            saving: false,
            saveSuccess: false,
            saveError: null,
            meanings: meanings || undefined,
            alreadyInNotion: r.value,
          });
        }
      }).catch(function () {});
    }

    function handleTranslateError(err) {
      if (responseReceived) return;
      if (!tooltipEl || !tooltipEl.parentNode || !currentPayload || currentPayload.original !== thisOriginal) return;
      responseReceived = true;
      clearTimeout(timeoutId);
      renderTooltip({
        original: thisOriginal, translation: null, loading: false,
        error: (err && err.message) || "Translation failed",
        saving: false, saveSuccess: false, saveError: null,
      });
      flushTooltipPaint();
      if (currentPayload) currentPayload.translation = null;
    }

    browser.runtime.sendMessage({ type: "translate", text: original })
      .then(handleTranslateResponse)
      .catch(handleTranslateError);
  }

  function saveToNotion(payload) {
    var disp = { original: payload.original, translation: payload.translation || (currentPayload && currentPayload.translation), loading: false, error: null, saving: true, saveSuccess: false, saveError: null };
    if (currentPayload && currentPayload.meanings) disp.meanings = currentPayload.meanings;
    renderTooltip(disp);

    browser.runtime.sendMessage({ type: "saveToNotion", payload: payload })
      .then(function (response) {
        if (response && response.error) {
          renderTooltip({
            original: payload.original, translation: payload.translation || (currentPayload && currentPayload.translation),
            loading: false, error: null, saving: false, saveSuccess: false, saveError: response.error,
            meanings: currentPayload && currentPayload.meanings || undefined,
          });
          flushTooltipPaint();
          return;
        }
        renderTooltip({
          original: payload.original, translation: payload.translation || (currentPayload && currentPayload.translation),
          loading: false, error: null, saving: false, saveSuccess: true, saveError: null,
          meanings: currentPayload && currentPayload.meanings || undefined,
        });
        flushTooltipPaint();
        setTimeout(removeTooltip, 1500);
      })
      .catch(function (err) {
        renderTooltip({
          original: payload.original, translation: payload.translation || (currentPayload && currentPayload.translation),
          loading: false, error: null, saving: false, saveSuccess: false, saveError: (err && err.message) || "Failed to save",
          meanings: currentPayload && currentPayload.meanings || undefined,
        });
        flushTooltipPaint();
      });
  }

  function tryCaptureContext(sel) {
    try {
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      let node = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      if (!node) return null;
      while (node && (!node.innerText || node.innerText.length > 500)) {
        node = node.parentElement;
      }
      const text = node ? (node.innerText || "").trim() : "";
      return text.length <= 500 ? text : text.slice(0, 500);
    } catch (_) {
      return null;
    }
  }

  function onMouseUp(e) {
    if (Date.now() < suppressMouseUpUntil) return;
    if (e && e.target && typeof e.target.closest === "function") {
      if (e.target.closest("#" + TOOLTIP_ID) || e.target.closest("#" + BACKDROP_ID)) return;
    }
    var text = getSelectionText();
    if (!text) return;
    var rect = getSelectionRect();
    if (!rect) return;
    var sel = window.getSelection();
    var context = sel && sel.rangeCount ? tryCaptureContext(sel) : null;
    requestAnimationFrame(function () {
      showTooltip(rect, text, context);
    });
  }

  document.addEventListener("mouseup", onMouseUp, false);
})();
