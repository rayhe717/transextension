/**
 * AO3 → Obsidian markdown: single file, all chapters, YAML frontmatter.
 * Runs in content script context (cookies for logged-in / restricted works).
 */
(function () {
  "use strict";

  var AO3_ORIGIN = "https://archiveofourown.org";
  var CHAPTER_DELAY_MS = 400;
  /** Abort each AO3 fetch so a stuck network cannot hang the export forever. */
  var FETCH_TIMEOUT_MS = 90000;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function getWorkIdFromUrl() {
    var m = window.location.pathname.match(/\/works\/(\d+)/);
    return m ? m[1] : null;
  }

  function fetchAo3Html(path) {
    var url = path.indexOf("http") === 0 ? path : AO3_ORIGIN + path;
    if (typeof AbortController === "undefined") {
      return fetch(url, { credentials: "include", redirect: "follow" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        return res.text();
      });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      try {
        ctrl.abort();
      } catch (_) {}
    }, FETCH_TIMEOUT_MS);
    return fetch(url, { credentials: "include", redirect: "follow", signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        return res.text();
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === "AbortError") {
          return Promise.reject(new Error("Request timed out after " + Math.round(FETCH_TIMEOUT_MS / 1000) + "s: " + url));
        }
        return Promise.reject(e);
      });
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  /** Collect dd text / tag links for a dl.work.meta row. */
  function ddToValue(dd) {
    if (!dd) return "";
    var selectors = [
      "ul.commas li a.tag",
      "ul.tags li a.tag",
      "ul.tags.commas li a.tag",
      "ul.tags li a",
      "li a.tag",
      "a.tag",
    ];
    for (var s = 0; s < selectors.length; s++) {
      var seen = {};
      var collected = [];
      dd.querySelectorAll(selectors[s]).forEach(function (a) {
        var t = (a.textContent || "").trim();
        if (t && !seen[t]) {
          seen[t] = true;
          collected.push(t);
        }
      });
      if (collected.length) return collected;
    }
    var t = (dd.textContent || "").replace(/\s+/g, " ").trim();
    return t;
  }

  function parseWorkMeta(doc) {
    var dl = doc.querySelector("dl.work.meta");
    if (!dl) return {};
    var out = {};
    var dts = dl.querySelectorAll("dt");
    for (var i = 0; i < dts.length; i++) {
      var dt = dts[i];
      var label = (dt.textContent || "").replace(/\s*:\s*$/, "").trim();
      if (!label) continue;
      var n = dt.nextElementSibling;
      if (n && n.tagName === "DD") {
        out[label] = ddToValue(n);
      }
    }
    return out;
  }

  function parseStatsLine(statsText) {
    var s = {
      published: "",
      completed: "",
      words: null,
      chapters: "",
    };
    if (!statsText || typeof statsText !== "string") return s;
    var pub = statsText.match(/Published:\s*(\d{4}-\d{2}-\d{2})/i);
    if (pub) s.published = pub[1];
    var comp = statsText.match(/Completed:\s*(\d{4}-\d{2}-\d{2})/i);
    if (comp) s.completed = comp[1];
    var words = statsText.match(/Words:\s*([\d,]+)/i);
    if (words) s.words = parseInt(words[1].replace(/,/g, ""), 10) || null;
    var ch = statsText.match(/Chapters:\s*([^\n]+)/i);
    if (ch) s.chapters = ch[1].trim();
    return s;
  }

  function firstRaw(raw, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = raw[keys[i]];
      if (v == null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      return v;
    }
    return null;
  }

  /**
   * Multiple ships from AO3 are usually separate `<a>` tags → array of strings.
   * Only split on commas when there is a single blob (plain-text fallback like "A/B, C/D").
   * Splitting every entry breaks multi-ship lists: commas can appear inside one ship name.
   */
  function expandRelationshipList(arr) {
    var flat = [];
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] || "").trim();
      if (s) flat.push(s);
    }
    if (flat.length === 0) return [];
    if (flat.length > 1) {
      return dedupeRelationshipStrings(flat);
    }
    var only = flat[0];
    if (only.indexOf(",") !== -1) {
      return dedupeRelationshipStrings(
        only.split(/\s*,\s*/).map(function (p) {
          return p.trim();
        }).filter(Boolean)
      );
    }
    return dedupeRelationshipStrings([only]);
  }

  function dedupeRelationshipStrings(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i] || "").trim();
      if (!k || seen[k]) continue;
      seen[k] = true;
      out.push(k);
    }
    return out;
  }

  function relationshipFromRaw(raw) {
    var rel = firstRaw(raw, ["Relationships", "Relationship", "Ships"]);
    if (rel != null) return rel;
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var kl = k.trim();
      if (/^relationships?$/i.test(kl) && !/additional/i.test(kl)) {
        return raw[k];
      }
    }
    return null;
  }

  function normalizeMeta(raw) {
    var rating = raw["Rating"] || "";
    var warn = raw["Archive Warning"] || raw["Archive Warnings"] || "";
    var cat = firstRaw(raw, ["Category", "Categories"]) || "";
    var fandom = raw["Fandom"] || raw["Fandoms"];
    var rel = relationshipFromRaw(raw);
    var chars = raw["Characters"];
    var addTags = raw["Additional Tags"] || raw["Tags"];
    var lang = raw["Language"] || "";
    var statsText = raw["Stats"] || "";
    var fandomArr = Array.isArray(fandom) ? fandom : (fandom ? [String(fandom)] : []);
    var relArr = Array.isArray(rel) ? rel.slice() : (rel ? [String(rel)] : []);
    relArr = expandRelationshipList(relArr);
    var charArr = Array.isArray(chars) ? chars : (chars ? [String(chars)] : []);
    var addArr = Array.isArray(addTags) ? addTags : (addTags ? [String(addTags)] : []);
    return {
      rating: String(rating || ""),
      archive_warning: String(warn || ""),
      category: String(cat || ""),
      fandom: fandomArr,
      relationship: relArr,
      characters: charArr,
      additional_tags: addArr,
      language: String(lang || ""),
      stats: parseStatsLine(String(statsText || "")),
    };
  }

  function slugify(s) {
    return String(s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  /** Only `ao3/work/{id}` plus one tag per ship: `ao3/relationships/{slug}`. */
  function buildObsidianTags(meta, workId) {
    var tags = ["ao3/work/" + workId];
    for (var r = 0; r < meta.relationship.length; r++) {
      var slr = slugify(meta.relationship[r]);
      if (slr) tags.push("ao3/relationships/" + slr);
    }
    return tags;
  }

  function yamlQuote(s) {
    if (s == null || s === "") return '""';
    var str = String(s);
    if (/[\n\r":]/.test(str) || str.indexOf("'") !== -1 || str[0] === " " || str[str.length - 1] === " ") {
      return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return str;
  }

  function yamlIndentList(arr, indent) {
    if (!arr || !arr.length) return indent + "[]";
    var lines = [];
    for (var i = 0; i < arr.length; i++) {
      lines.push(indent + "- " + yamlQuote(arr[i]));
    }
    return lines.join("\n");
  }

  /**
   * Obsidian Properties UI does not render nested objects under `ao3:` — it shows one JSON-like string.
   * Use flat `ao3_*` keys so each field is a real property (searchable, typed, list-friendly).
   */
  function yamlBlockArray(key, indent, arr) {
    if (!arr || !arr.length) return [indent + key + ": []"];
    var out = [indent + key + ":"];
    out.push(yamlIndentList(arr, indent + "  "));
    return out;
  }

  function buildFrontmatter(title, workId, workUrl, authorLine, meta) {
    var tags = buildObsidianTags(meta, workId);
    var lines = [];
    lines.push("---");
    lines.push("title: " + yamlQuote(title));
    lines.push("source: ao3");
    lines.push("source_url: " + yamlQuote(workUrl));
    lines.push("ao3_work_id: " + yamlQuote(String(workId)));
    lines.push("ao3_rating: " + yamlQuote(meta.rating));
    lines.push("ao3_archive_warning: " + yamlQuote(meta.archive_warning));
    lines.push("ao3_category: " + yamlQuote(meta.category));
    lines = lines.concat(yamlBlockArray("ao3_fandom", "", meta.fandom));
    lines = lines.concat(yamlBlockArray("ao3_relationships", "", meta.relationship));
    lines = lines.concat(yamlBlockArray("ao3_characters", "", meta.characters));
    lines = lines.concat(yamlBlockArray("ao3_additional_tags", "", meta.additional_tags));
    lines.push("ao3_language: " + yamlQuote(meta.language));
    lines.push("ao3_stats_published: " + yamlQuote(meta.stats.published));
    lines.push("ao3_stats_completed: " + yamlQuote(meta.stats.completed));
    lines.push("ao3_stats_words: " + (meta.stats.words != null ? meta.stats.words : "null"));
    lines.push("ao3_stats_chapters: " + yamlQuote(meta.stats.chapters));
    lines.push("tags:");
    lines.push(yamlIndentList(tags, "  "));
    lines.push("---");
    lines.push("");
    lines.push("# " + title);
    lines.push("");
    if (authorLine) lines.push("*" + authorLine + "*");
    lines.push("");
    return lines.join("\n");
  }

  function getTitleFromWork(doc) {
    var h2 = doc.querySelector("dl.work.meta");
    var titleEl = doc.querySelector("h2.title");
    if (titleEl) return (titleEl.textContent || "").trim();
    var o = doc.querySelector("meta[property='og:title']");
    if (o && o.getAttribute("content")) return o.getAttribute("content").trim();
    return "Untitled";
  }

  function getAuthorLine(doc) {
    var rel = doc.querySelector("a[rel='author']");
    if (rel) return "by " + (rel.textContent || "").trim();
    var by = doc.querySelector("h3.byline");
    if (by) return (by.textContent || "").replace(/\s+/g, " ").trim();
    return "";
  }

  function getSummaryHtml(doc) {
    var block =
      doc.querySelector("div.preface .summary blockquote.userstuff") ||
      doc.querySelector("div.preface .summary blockquote") ||
      doc.querySelector("div.summary blockquote");
    if (!block) return "";
    return block.innerHTML;
  }

  function chapterIdsFromSelect(doc) {
    var sel = doc.querySelector("select#chapter_select[name='chapter_id']") || doc.querySelector("select[name='chapter_id']");
    if (!sel || !sel.options) return [];
    var out = [];
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      // AO3 often includes an "Entire Work" option with value "0".
      // Fetching /chapters/0 will 404 and can look like a hang, so skip it.
      var v = (o.value != null) ? String(o.value).trim() : "";
      if (!v) continue;
      if (v === "0") continue;
      if (!/^\d+$/.test(v)) continue;
      out.push({ chapterId: v, label: (o.textContent || "").trim() });
    }
    return out;
  }

  function chapterIdsFromLinks(doc, workId) {
    var set = {};
    var re = new RegExp("/works/" + workId + "/chapters/(\\d+)");
    doc.querySelectorAll("a[href*='/chapters/']").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var m = href.match(re);
      if (m) set[m[1]] = true;
    });
    return Object.keys(set).sort(function (a, b) {
      return parseInt(a, 10) - parseInt(b, 10);
    });
  }

  function htmlToMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      var t = node.textContent || "";
      return t.replace(/\r\n/g, "\n");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    var tag = (node.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style") return "";
    var inner = "";
    for (var c = node.firstChild; c; c = c.nextSibling) {
      inner += htmlToMarkdown(c);
    }
    inner = inner.trim();
    switch (tag) {
      case "p":
        return inner ? "\n\n" + inner + "\n\n" : "";
      case "br":
        return "\n";
      case "strong":
      case "b":
        return inner ? "**" + inner + "**" : "";
      case "em":
      case "i":
        return inner ? "*" + inner + "*" : "";
      case "a":
        var href = node.getAttribute("href") || "";
        if (href.indexOf("/") === 0) href = AO3_ORIGIN + href;
        if (href && inner) return "[" + inner + "](" + href + ")";
        return inner;
      case "blockquote":
        return inner ? "\n\n" + inner.split("\n").map(function (line) { return "> " + line; }).join("\n") + "\n\n" : "";
      case "div":
        return inner;
      default:
        return inner;
    }
  }

  function extractChapterBody(doc) {
    var chapter = doc.querySelector("div#chapters div.chapter") || doc.querySelector("div.chapter");
    var userstuff = chapter ? chapter.querySelector("div.userstuff") : doc.querySelector("div.userstuff");
    if (!userstuff) return { title: "", md: "" };
    var titleEl = chapter ? chapter.querySelector("h3.title") : doc.querySelector("h3.title");
    var title = titleEl ? (titleEl.textContent || "").trim() : "";
    var clone = userstuff.cloneNode(true);
    var md = htmlToMarkdown(clone).replace(/\n{3,}/g, "\n\n").trim();
    return { title: title, md: md };
  }

  function sanitizeFilename(name) {
    return String(name)
      .replace(/[\/\\\:\?\*\|\"\<\>]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "ao3-work";
  }

  function ao3ExportWork() {
    var workId = getWorkIdFromUrl();
    if (!workId) {
      return Promise.reject(new Error("Open an AO3 work page (URL contains /works/123…)."));
    }

    var workUrl = AO3_ORIGIN + "/works/" + workId;

    return fetchAo3Html("/works/" + workId).then(function (html) {
      var doc = parseHtml(html);
      var title = getTitleFromWork(doc);
      var authorLine = getAuthorLine(doc);
      var rawMeta = parseWorkMeta(doc);
      var meta = normalizeMeta(rawMeta);

      var chapters = chapterIdsFromSelect(doc);
      if (chapters.length === 0) {
        var ids = chapterIdsFromLinks(doc, workId);
        if (ids.length) {
          chapters = ids.map(function (id) {
            return { chapterId: id, label: "" };
          });
        }
      }

      var shouldFetchFullWork = chapters.length === 0;

      var summaryHtml = getSummaryHtml(doc);
      var summaryMd = "";
      if (summaryHtml) {
        var sumDoc = parseHtml("<div class=\"stn-ao3-sum\">" + summaryHtml + "</div>");
        var sumRoot = sumDoc.querySelector(".stn-ao3-sum");
        summaryMd = sumRoot ? htmlToMarkdown(sumRoot) : "";
      }

      var parts = [];
      parts.push(buildFrontmatter(title, workId, workUrl, authorLine, meta));
      if (summaryMd) {
        parts.push("## Summary");
        parts.push("");
        parts.push(summaryMd.trim());
        parts.push("");
      }

      function fetchOneChapter(ch, index) {
        if (ch && ch.chapterId && /^\d+$/.test(String(ch.chapterId)) && String(ch.chapterId) !== "0") {
          return fetchAo3Html("/works/" + workId + "/chapters/" + ch.chapterId).then(function (chHtml) {
            var chDoc = parseHtml(chHtml);
            return extractChapterBody(chDoc);
          });
        }
        if (shouldFetchFullWork) {
          // Works with view_full_work=true are a single page containing all chapters.
          return fetchAo3Html("/works/" + workId + "?view_full_work=true").then(function (fullHtml) {
            var fullDoc = parseHtml(fullHtml);
            var bodies = [];
            var chapterEls = fullDoc.querySelectorAll("div#chapters div.chapter");
            if (chapterEls && chapterEls.length) {
              for (var i = 0; i < chapterEls.length; i++) {
                var chap = chapterEls[i];
                var titleEl = chap.querySelector("h3.title");
                var title = titleEl ? (titleEl.textContent || "").trim() : ("Chapter " + (i + 1));
                var userstuff = chap.querySelector("div.userstuff");
                var md = userstuff ? htmlToMarkdown(userstuff.cloneNode(true)).replace(/\n{3,}/g, "\n\n").trim() : "";
                bodies.push({ title: title, md: md });
              }
              return { multi: true, bodies: bodies };
            }
            // Fallback: at least try the first userstuff we can find.
            return { multi: false, body: extractChapterBody(fullDoc) };
          });
        }
        if (index === 0) return Promise.resolve(extractChapterBody(doc));
        return Promise.reject(new Error("Could not determine chapter URL(s) for this work."));
      }

      var chain = Promise.resolve();
      if (shouldFetchFullWork) {
        chain = chain.then(function () {
          return fetchOneChapter(null, 0);
        }).then(function (r) {
          if (r && r.multi && Array.isArray(r.bodies)) {
            r.bodies.forEach(function (body, idx) {
              var sep = (idx === 0) ? "" : "\n\n---\n\n";
              var heading = body.title || ("Chapter " + (idx + 1));
              parts.push(sep + "## " + heading);
              parts.push("");
              parts.push(body.md || "");
            });
            return;
          }
          var single = r && r.body ? r.body : r;
          var heading = (single && single.title) ? single.title : "Chapter 1";
          parts.push("## " + heading);
          parts.push("");
          parts.push((single && single.md) ? single.md : "");
        });
      } else {
        chapters.forEach(function (ch, idx) {
          chain = chain.then(function () {
            if (idx > 0) return sleep(CHAPTER_DELAY_MS);
          }).then(function () {
            return fetchOneChapter(ch, idx);
          }).then(function (body) {
            var sep = (idx === 0) ? "" : "\n\n---\n\n";
            var heading = body.title || ch.label || ("Chapter " + (idx + 1));
            parts.push(sep + "## " + heading);
            parts.push("");
            parts.push(body.md || "");
          });
        });
      }

      return chain.then(function () {
        var markdown = parts.join("\n");
        var basename = sanitizeFilename(title) + " - " + workId;
        return { markdown: markdown, basename: basename };
      });
    });
  }

  window.__ao3ExportWork = ao3ExportWork;

  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === "ao3ExportStart") {
      ao3ExportWork()
        .then(function (result) {
          sendResponse({
            markdown: result.markdown,
            basename: result.basename,
          });
        })
        .catch(function (err) {
          sendResponse({ error: err && err.message ? err.message : String(err) });
        });
      return true;
    }
    if (message.type === "ao3AnchorDownload") {
      try {
        var md = message.markdown;
        if (!md || typeof md !== "string") {
          sendResponse({ error: "No markdown payload." });
          return false;
        }
        var fname = message.filename || "ao3-export.md";
        var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = fname;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        }, 3000);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e && e.message ? e.message : String(e) });
      }
      return true;
    }
    if (message.type === "ao3ClipboardMarkdown") {
      var fnameClip = (message.filename && String(message.filename)) || "export.md";
      var clipResponded = false;
      var clipHangGuard = setTimeout(function () {
        if (clipResponded) return;
        clipResponded = true;
        try {
          var stuck = document.getElementById("stn-ao3-clipboard-modal");
          if (stuck) stuck.remove();
        } catch (_) {}
        sendResponse({ error: "Clipboard step timed out — try Save again or use Downloads." });
      }, 600000);
      function finishClip(ok, errMsg) {
        if (clipResponded) return;
        clipResponded = true;
        try {
          clearTimeout(clipHangGuard);
        } catch (_) {}
        if (ok) sendResponse({ ok: true });
        else sendResponse({ error: errMsg || "Copy failed" });
      }
      /**
       * Safari blocks "silent" clipboard from extension messages. Always show the modal so
       * "Copy now" runs inside a real click. Do not call navigator.clipboard first — it can
       * reject or hang and prevent the modal from appearing.
       */
      function showUserGestureCopyModal(onResult) {
        var id = "stn-ao3-clipboard-modal";
        try {
          var old = document.getElementById(id);
          if (old) old.remove();
        } catch (_) {}
        var wrap = document.createElement("div");
        wrap.id = id;
        wrap.style.cssText =
          "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,sans-serif;";
        var box = document.createElement("div");
        box.style.cssText =
          "background:#fff;border-radius:10px;max-width:min(560px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.25);padding:16px;";
        var h = document.createElement("p");
        h.style.margin = "0 0 8px 0";
        h.style.fontWeight = "600";
        h.textContent = "Copy markdown for Obsidian";
        var sub = document.createElement("p");
        sub.style.margin = "0 0 12px 0";
        sub.style.fontSize = "13px";
        sub.style.color = "#444";
        sub.textContent =
          "Safari blocked automatic copy. Click “Copy now”, or focus the box and press ⌘A then ⌘C (" + fnameClip + ").";
        var ta = document.createElement("textarea");
        ta.value = mdClip;
        ta.readOnly = true;
        ta.style.cssText =
          "width:100%;min-height:140px;max-height:45vh;font-size:12px;margin-bottom:12px;border:1px solid #ccc;border-radius:6px;padding:8px;box-sizing:border-box;";
        var row = document.createElement("div");
        row.style.display = "flex";
        row.style.gap = "8px";
        row.style.justifyContent = "flex-end";
        var btnCopy = document.createElement("button");
        btnCopy.type = "button";
        btnCopy.textContent = "Copy now";
        btnCopy.style.cssText =
          "padding:8px 14px;font-weight:600;border-radius:6px;border:1px solid #16a34a;background:#22c55e;color:#fff;cursor:pointer;";
        var btnClose = document.createElement("button");
        btnClose.type = "button";
        btnClose.textContent = "Close";
        btnClose.style.cssText = "padding:8px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;";
        var btnFinished = document.createElement("button");
        btnFinished.type = "button";
        btnFinished.textContent = "I copied (⌘C) — continue";
        btnFinished.style.cssText = "padding:8px 14px;border-radius:6px;border:1px solid #86efac;background:#f0fdf4;cursor:pointer;";
        btnFinished.title = "Use after you copied from the box or with ⌘A / ⌘C";
        function cleanup() {
          try {
            wrap.remove();
          } catch (_) {}
        }
        btnCopy.addEventListener("click", function () {
          navigator.clipboard.writeText(mdClip).then(
            function () {
              cleanup();
              onResult(true);
            },
            function () {
              try {
                ta.focus();
                ta.select();
                if (document.execCommand("copy")) {
                  cleanup();
                  onResult(true);
                  return;
                }
              } catch (_) {}
              sub.textContent =
                "Automatic copy failed. Select all in the box (⌘A), copy (⌘C), then click Close when done.";
            }
          );
        });
        btnClose.addEventListener("click", function () {
          cleanup();
          onResult(false);
        });
        btnFinished.addEventListener("click", function () {
          cleanup();
          onResult(true);
        });
        row.appendChild(btnClose);
        row.appendChild(btnFinished);
        row.appendChild(btnCopy);
        box.appendChild(h);
        box.appendChild(sub);
        box.appendChild(ta);
        box.appendChild(row);
        wrap.appendChild(box);
        document.body.appendChild(wrap);
        try {
          ta.focus();
          ta.select();
        } catch (_) {}
      }
      function openClipboardUi(mdClip) {
        if (!mdClip || typeof mdClip !== "string") {
          finishClip(false, "No markdown to copy.");
          return;
        }
        showUserGestureCopyModal(function (ok) {
          if (ok) finishClip(true);
          else finishClip(false, "Dismissed — use “Copy now” or ⌘A/⌘C, then “I copied — continue”.");
        });
      }
      if (message.storageKey) {
        var sess = browser.storage && browser.storage.session;
        if (!sess || typeof sess.get !== "function") {
          sendResponse({ error: "Storage unavailable — reload the AO3 page." });
          return false;
        }
        sess
          .get(message.storageKey)
          .then(function (obj) {
            var text = obj && obj[message.storageKey];
            try {
              if (typeof sess.remove === "function") sess.remove(message.storageKey);
            } catch (_) {}
            openClipboardUi(text);
          })
          .catch(function () {
            finishClip(false, "Could not read saved export text.");
          });
        return true;
      }
      openClipboardUi(message.markdown);
      return true;
    }
    return false;
  });

  function sendAo3ExportTriggerMessage() {
    var ext = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
    if (!ext || !ext.runtime) return Promise.reject(new Error("Extension runtime unavailable."));
    if (ext.tabs && typeof ext.tabs.query === "function") {
      return ext.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
        var tid = tabs && tabs[0] && typeof tabs[0].id === "number" ? tabs[0].id : undefined;
        return ext.runtime.sendMessage({ type: "ao3ExportTrigger", tabId: tid });
      });
    }
    return ext.runtime.sendMessage({ type: "ao3ExportTrigger" });
  }

  function injectAo3FloatingButton() {
    try {
      if (!/^https?:\/\/archiveofourown\.org\/works\/\d+/i.test(window.location.href)) return;
      if (document.getElementById("stn-ao3-float-btn")) return;
      if (!document.getElementById("stn-ao3-float-style")) {
        var st = document.createElement("style");
        st.id = "stn-ao3-float-style";
        st.textContent =
          "#stn-ao3-float-btn{position:fixed;bottom:14px;right:14px;z-index:2147483647;margin:0;padding:5px 9px;font-size:11px;font-weight:600;border-radius:6px;border:1px solid rgba(0,0,0,.14);background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.12);cursor:pointer;font-family:system-ui,-apple-system,sans-serif;line-height:1.25;transition:background .2s ease,color .2s ease,border-color .2s ease,box-shadow .2s ease}" +
          "#stn-ao3-float-btn:hover:not(:disabled){border-color:#86efac;box-shadow:0 2px 6px rgba(34,197,94,.2)}" +
          "#stn-ao3-float-btn:disabled{opacity:.92;cursor:wait}" +
          "#stn-ao3-float-btn.stn-ao3-success{background:#22c55e;border-color:#16a34a;color:#fff;box-shadow:0 2px 8px rgba(22,163,74,.35);cursor:default}" +
          "#stn-ao3-float-btn.stn-ao3-error{background:#fecaca;border-color:#f87171;color:#7f1d1d}";
        document.head.appendChild(st);
      }
      var btn = document.createElement("button");
      btn.id = "stn-ao3-float-btn";
      btn.type = "button";
      btn.textContent = "Save to Obsidian";
      btn.setAttribute("aria-label", "Save AO3 work to Obsidian markdown");
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.remove("stn-ao3-success", "stn-ao3-error");
        btn.textContent = "Saving…";
        function showAo3Error(fullMsg) {
          var msg = fullMsg ? String(fullMsg) : "Export failed";
          btn.classList.add("stn-ao3-error");
          btn.title = msg;
          btn.setAttribute("aria-label", msg);
          var short = msg.length > 42 ? msg.slice(0, 40) + "…" : msg;
          btn.textContent = short;
          btn.disabled = false;
          setTimeout(function () {
            btn.classList.remove("stn-ao3-error");
            btn.textContent = "Save to Obsidian";
            btn.title = "";
            btn.setAttribute("aria-label", "Save AO3 work to Obsidian markdown");
          }, 8000);
        }
        function clearUiTimers() {
          try {
            if (slowHint) clearTimeout(slowHint);
          } catch (_) {}
          try {
            if (uiHangGuard) clearTimeout(uiHangGuard);
          } catch (_) {}
        }
        var slowHint = setTimeout(function () {
          if (btn.textContent === "Saving…") btn.textContent = "Still exporting…";
        }, 120000);
        var uiHangGuard = setTimeout(function () {
          clearUiTimers();
          if (btn.disabled && (btn.textContent === "Saving…" || btn.textContent === "Still exporting…")) {
            btn.disabled = false;
            showAo3Error("No reply from extension — reload this page, then try again.");
          }
        }, 960000);
        sendAo3ExportTriggerMessage()
          .then(function (r) {
            clearUiTimers();
            if (r && r.ok) {
              try {
                console.info("[STN AO3] Export OK", r);
              } catch (_) {}
              btn.classList.add("stn-ao3-success");
              btn.textContent = "Saved";
              btn.title = "Check Downloads → ao3 (or your browser download folder)";
              setTimeout(function () {
                btn.disabled = false;
                btn.classList.remove("stn-ao3-success");
                btn.textContent = "Save to Obsidian";
                btn.title = "";
              }, 2200);
            } else {
              var errMsg = (r && r.error) ? r.error : "Unknown error";
              try {
                console.warn("[STN AO3] Export failed:", errMsg, r);
              } catch (_) {}
              showAo3Error(errMsg);
            }
          })
          .catch(function (err) {
            clearUiTimers();
            try {
              console.warn("[STN AO3] sendMessage failed:", err);
            } catch (_) {}
            var m = err && err.message ? String(err.message) : "Message to extension failed — reload this tab and try again.";
            showAo3Error(m);
          });
      });
      document.body.appendChild(btn);
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectAo3FloatingButton);
  } else {
    injectAo3FloatingButton();
  }
})();
