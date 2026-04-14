/**
 * link-words.js — Browser port of link_words.py
 *
 * Runs three steps against the Obsidian vault:
 *   1. linkVocabEntries  — cross-link Vocab_ao3 notes via related_forms
 *   2. linkVocabToAo3    — inline-link vocab terms in ao3/ notes
 *   3. generateLinksNotes — create/update links/ cluster notes
 *
 * Depends on ObsidianSync.parseFrontmatter / buildFrontmatter (obsidian-sync.js).
 * Exposed as: global.LinkWords = { runLinkWords }
 */

(function (global) {
  "use strict";

  // Ambiguous terms that must not be used as links note titles.
  const LINK_WORDS_BLOCKLIST = new Set(["crush"]);

  function normalizeTerm(s) {
    return String(s || "").trim().toLowerCase();
  }

  function isBlockedTerm(s) {
    return LINK_WORDS_BLOCKLIST.has(normalizeTerm(s));
  }

  // ── Regex helpers ─────────────────────────────────────────────────────────

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function makeWordRe(term) {
    return new RegExp("(?<!\\w)" + escapeRegex(term) + "(?!\\w)", "i");
  }

  // ── File System helpers ───────────────────────────────────────────────────

  async function readFile(handle) {
    const file = await handle.getFile();
    return file.text();
  }

  async function writeFileContent(dirHandle, filename, content) {
    const fh = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  /** Shallow: yields { name, handle } for .md files directly inside dirHandle. */
  async function listMdFiles(dirHandle) {
    const out = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file" && name.endsWith(".md")) {
        out.push({ name, handle });
      }
    }
    return out;
  }

  /** Recursive: yields { name, handle, parentDirHandle } for all .md files. */
  async function* walkMdFiles(dirHandle) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file" && name.endsWith(".md") && name !== "CLAUDE.md") {
        yield { name, handle, parentDirHandle: dirHandle };
      } else if (handle.kind === "directory") {
        yield* walkMdFiles(handle);
      }
    }
  }

  // ── Frontmatter helpers ───────────────────────────────────────────────────

  /** Collect all synonym values across synonyms, synonyms_1, synonyms_2, … */
  function collectAllSynonyms(fm) {
    const out = [];
    const single = fm.synonyms;
    if (Array.isArray(single)) out.push(...single);
    else if (single && typeof single === "string") out.push(single);

    const numKeys = Object.keys(fm)
      .filter((k) => /^synonyms_\d+$/.test(k))
      .sort((a, b) => parseInt(a.split("_")[1], 10) - parseInt(b.split("_")[1], 10));
    for (const k of numKeys) {
      const v = fm[k];
      if (Array.isArray(v)) out.push(...v);
      else if (v && typeof v === "string") out.push(v);
    }
    return out.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  }

  function addLink(map, a, b) {
    if (a === b) return;
    if (!map.has(a) || !map.has(b)) return;
    map.get(a).related.add(b);
    map.get(b).related.add(a);
  }

  function todayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Remove existing ## Related Forms section from body. */
  function stripRelatedFormsSection(body) {
    return body.replace(/\n## Related Forms\n[\s\S]*?(?=\n## |\n# |\s*$)/, "");
  }

  // ── Step 1: Cross-link vocab entries ─────────────────────────────────────

  async function linkVocabEntries(rootDirHandle, onLog) {
    let vocabDirHandle;
    try {
      vocabDirHandle = await rootDirHandle.getDirectoryHandle("Vocab_ao3");
    } catch (_) {
      onLog("Vocab_ao3/ not found — skipping step 1.");
      return;
    }

    // Load all entries
    const entries = new Map(); // stem → info
    for (const { name, handle } of await listMdFiles(vocabDirHandle)) {
      const stem = name.slice(0, -3);
      let content;
      try { content = await readFile(handle); } catch (_) { continue; }
      const { fm, body } = ObsidianSync.parseFrontmatter(content);
      const word = String(fm.word || stem);
      const key = word.toLowerCase();
      entries.set(stem, {
        name, handle, fm, body, stem,
        key,
        word,
        baseForm: String(fm.base_form || stem).toLowerCase().trim(),
        synonyms: new Set(collectAllSynonyms(fm).map((s) => s.toLowerCase())),
        related: new Set(),
      });
    }

    const stemSet = new Set(entries.keys());
    const keyToStem = new Map();
    for (const [stem, info] of entries) keyToStem.set(info.key, stem);

    function linkByKey(ka, kb) {
      const sa = keyToStem.get(ka);
      const sb = keyToStem.get(kb);
      if (sa && sb) addLink(entries, sa, sb);
    }

    // 1. Synonym ↔ word cross-reference
    for (const [stem, info] of entries) {
      for (const syn of info.synonyms) {
        if (keyToStem.has(syn)) linkByKey(info.key, syn);
      }
    }

    // 2. Shared synonym grouping
    const synToStems = new Map();
    for (const [stem, info] of entries) {
      for (const syn of info.synonyms) {
        if (!synToStems.has(syn)) synToStems.set(syn, new Set());
        synToStems.get(syn).add(stem);
      }
    }
    for (const stems of synToStems.values()) {
      const arr = [...stems];
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++)
          addLink(entries, arr[i], arr[j]);
    }

    // 3. Shared base_form grouping
    const bfToStems = new Map();
    for (const [stem, info] of entries) {
      if (info.baseForm) {
        if (!bfToStems.has(info.baseForm)) bfToStems.set(info.baseForm, new Set());
        bfToStems.get(info.baseForm).add(stem);
      }
    }
    for (const stems of bfToStems.values()) {
      const arr = [...stems];
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++)
          addLink(entries, arr[i], arr[j]);
    }

    // 4. Substring matching (longer contains shorter, both ≥ 4 chars)
    const sortedStems = [...stemSet].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sortedStems.length; i++) {
      const longer = sortedStems[i];
      if (longer.length < 4) continue;
      for (let j = i + 1; j < sortedStems.length; j++) {
        const shorter = sortedStems[j];
        if (shorter.length < 4) continue;
        if (new RegExp("(?<!\\w)" + escapeRegex(shorter) + "(?!\\w)").test(longer)) {
          addLink(entries, longer, shorter);
        }
      }
    }

    // 5. Inflected form candidates
    for (const [stem] of entries) {
      const candidates = [];
      if (stem.endsWith("s")) candidates.push(stem.slice(0, -1));
      if (stem.endsWith("ing")) { candidates.push(stem.slice(0, -3)); candidates.push(stem.slice(0, -3) + "e"); }
      if (stem.endsWith("ed")) { candidates.push(stem.slice(0, -2)); candidates.push(stem.slice(0, -1)); }
      if (stem.endsWith("er")) candidates.push(stem.slice(0, -2));
      for (const c of candidates) {
        if (stemSet.has(c)) addLink(entries, stem, c);
      }
    }

    // Count pairs
    const pairsSeen = new Set();
    for (const [stem, info] of entries) {
      for (const rel of info.related) {
        pairsSeen.add([stem, rel].sort().join("↔"));
      }
    }
    onLog(`Found ${pairsSeen.size} link pair(s).`);

    // Write updated files
    let updated = 0;
    for (const [stem, info] of entries) {
      if (info.related.size === 0) continue;
      const related = [...info.related].sort();
      const wikilinks = related.map((r) => `[[${r}]]`);
      const fm = { ...info.fm, related_forms: wikilinks };

      let body = stripRelatedFormsSection(info.body).trimEnd();
      body += "\n\n## Related Forms\n" + wikilinks.map((l) => `- ${l}`).join("\n") + "\n";

      const newContent = ObsidianSync.buildFrontmatter(fm) + body;
      try {
        await writeFileContent(vocabDirHandle, info.name, newContent);
        updated++;
      } catch (err) {
        onLog(`  WARN: could not write ${info.name}: ${err && err.message || err}`);
      }
    }
    onLog(`Step 1 done: updated ${updated} vocab file(s).`);
  }

  // ── Step 2: Inline-link vocab terms in AO3 notes ─────────────────────────

  /**
   * Replace the first bare occurrence of `termRe` in `body` with `[[stem]]`,
   * skipping any text already inside a wikilink.
   */
  function inlineLinkTerm(body, termRe, stem) {
    // Tokenise existing wikilinks so we never alter them
    const tokens = [];
    const tokenized = body.replace(/!?\[\[[^\]]+\]\]/g, (m) => {
      tokens.push(m);
      return `\x00T${tokens.length - 1}\x00`;
    });

    let replaced = false;
    const linked = tokenized.replace(termRe, (m) => {
      if (replaced) return m;
      replaced = true;
      return `[[${stem}]]`;
    });

    // Restore tokens
    const restored = linked.replace(/\x00T(\d+)\x00/g, (_, i) => tokens[parseInt(i, 10)]);
    return { body: restored, replaced };
  }

  async function linkVocabToAo3(rootDirHandle, onLog) {
    let vocabDirHandle, ao3DirHandle;
    try {
      vocabDirHandle = await rootDirHandle.getDirectoryHandle("Vocab_ao3");
    } catch (_) {
      onLog("Vocab_ao3/ not found — skipping step 2.");
      return;
    }
    try {
      ao3DirHandle = await rootDirHandle.getDirectoryHandle("ao3");
    } catch (_) {
      onLog("ao3/ not found — skipping step 2.");
      return;
    }

    // Collect vocab terms (longest first)
    const vocabFiles = await listMdFiles(vocabDirHandle);
    const terms = vocabFiles
      .map(({ name }) => name.slice(0, -3))
      .sort((a, b) => b.length - a.length);
    const termPatterns = terms.map((stem) => ({ stem, re: makeWordRe(stem) }));

    const legacyVocabRe = /\n\n## Vocab\n(?:- \[\[[^\]]+\]\]\n)*/g;
    let updatedCount = 0;

    for await (const { name, handle, parentDirHandle } of walkMdFiles(ao3DirHandle)) {
      let raw;
      try { raw = await readFile(handle); } catch (_) { continue; }

      // Separate frontmatter from body
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
      const frontmatter = fmMatch ? raw.slice(0, fmMatch[0].length) : "";
      let body = fmMatch ? raw.slice(fmMatch[0].length) : raw;

      // Remove legacy ## Vocab section
      body = body.replace(legacyVocabRe, "");

      const linked = [];
      for (const { stem, re } of termPatterns) {
        const result = inlineLinkTerm(body, re, stem);
        body = result.body;
        if (result.replaced) linked.push(stem);
      }

      if (linked.length === 0) continue;

      try {
        const fh = await parentDirHandle.getFileHandle(name, { create: false });
        const writable = await fh.createWritable();
        await writable.write(frontmatter + body);
        await writable.close();
        updatedCount++;
        onLog(`  Linked in ${name}: ${linked.map((t) => `[[${t}]]`).join(", ")}`);
      } catch (err) {
        onLog(`  WARN: could not write ${name}: ${err && err.message || err}`);
      }
    }
    onLog(`Step 2 done: updated ${updatedCount} AO3 note(s).`);
  }

  // ── Step 3: Generate links/ cluster notes ─────────────────────────────────

  async function generateLinksNotes(rootDirHandle, onLog) {
    let vocabDirHandle, linksDirHandle;
    try {
      vocabDirHandle = await rootDirHandle.getDirectoryHandle("Vocab_ao3");
    } catch (_) {
      onLog("Vocab_ao3/ not found — skipping step 3.");
      return;
    }
    linksDirHandle = await rootDirHandle.getDirectoryHandle("links", { create: true });

    const translations = new Map();
    const synToTerms = new Map();
    const bfToTerms = new Map();

    // Load vocab files to build groups
    for (const { name, handle } of await listMdFiles(vocabDirHandle)) {
      let content;
      try { content = await readFile(handle); } catch (_) { continue; }
      const { fm } = ObsidianSync.parseFrontmatter(content);
      const stem = name.slice(0, -3);
      translations.set(stem, String(fm.translation || ""));

      for (const s of collectAllSynonyms(fm)) {
        const sv = s.toLowerCase().trim();
        if (!synToTerms.has(sv)) synToTerms.set(sv, new Set());
        synToTerms.get(sv).add(stem);
      }

      const bf = String(fm.base_form || "").toLowerCase().trim();
      if (bf) {
        if (!bfToTerms.has(bf)) bfToTerms.set(bf, new Set());
        bfToTerms.get(bf).add(stem);
      }
    }

    // Build raw groups
    const rawGroups = [];
    for (const [sv, terms] of synToTerms) {
      if (terms.size >= 2) rawGroups.push({ source: sv, cluster: new Set(terms) });
    }
    for (const [bf, terms] of bfToTerms) {
      if (terms.size >= 2) rawGroups.push({ source: bf, cluster: new Set(terms) });
    }

    // Also groups from existing related_forms
    for (const { name, handle } of await listMdFiles(vocabDirHandle)) {
      let content;
      try { content = await readFile(handle); } catch (_) { continue; }
      const { fm } = ObsidianSync.parseFrontmatter(content);
      if (!fm.related_forms) continue;
      const stem = name.slice(0, -3);
      const rf = Array.isArray(fm.related_forms) ? fm.related_forms : [fm.related_forms];
      for (const r of rf) {
        const neighbor = String(r).replace(/^\[\[|\]\]$/g, "");
        rawGroups.push({ source: null, cluster: new Set([stem, neighbor]) });
      }
    }

    // Deduplicate groups
    const seen = new Set();
    const clusters = [];
    for (const { source, cluster } of rawGroups) {
      const key = (source || "") + "|" + [...cluster].sort().join(",");
      if (!seen.has(key)) { seen.add(key); clusters.push({ source, cluster }); }
    }

    // Load the set of stems the script created on previous runs.
    // Any stem recorded there that no longer has a file was intentionally deleted by the user.
    const STATE_FILE = ".link-words-created";
    const prevCreated = new Set();
    try {
      const stateHandle = await linksDirHandle.getFileHandle(STATE_FILE);
      const stateText = await readFile(stateHandle);
      for (const line of stateText.split("\n")) {
        const s = line.trim();
        if (s) prevCreated.add(s);
      }
    } catch (_) { /* first run — no state yet */ }

    // Stems that were previously created but are now missing = user deleted them → skip
    const ignoreStems = new Set();
    for (const stem of prevCreated) {
      try {
        await linksDirHandle.getFileHandle(stem + ".md");
      } catch (_) {
        ignoreStems.add(stem);
      }
    }

    // Load existing links/ notes
    const embedRe = /!\[\[(?:Vocab_ao3\/)?([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
    const stemToHandle = new Map();
    const existingMemberSets = [];

    for (const { name, handle } of await listMdFiles(linksDirHandle)) {
      const stem = name.slice(0, -3);
      stemToHandle.set(stem, handle);
      let content;
      try { content = await readFile(handle); } catch (_) { continue; }
      const members = new Set();
      embedRe.lastIndex = 0;
      let m;
      while ((m = embedRe.exec(content)) !== null) members.add(m[1].trim());
      if (members.size > 0) existingMemberSets.push(members);
    }

    let created = 0, updated = 0;

    for (const { source, cluster } of clusters) {
      // Verify files actually exist
      const verifiedMembers = [];
      for (const t of [...cluster].sort()) {
        try {
          await vocabDirHandle.getFileHandle(t + ".md");
          verifiedMembers.push(t);
        } catch (_) {}
      }
      if (verifiedMembers.length === 0) continue;

      let noteStem = source || verifiedMembers[0];
      if (isBlockedTerm(noteStem)) {
        const alt = verifiedMembers.find((t) => !isBlockedTerm(t));
        if (!alt) continue; // all candidates blocked as titles
        noteStem = alt;
      }

      // Skip notes the user has added to the ignore list
      if (ignoreStems.has(noteStem)) continue;

      const heading = source
        ? `### ${source}`
        : `### ${translations.get(verifiedMembers.reduce((a, b) =>
            (translations.get(a) || "").length >= (translations.get(b) || "").length ? a : b
          )) || verifiedMembers[0]}`;

      if (stemToHandle.has(noteStem)) {
        // Update existing note — only add members that are new to the cluster
        const handle = stemToHandle.get(noteStem);
        let content;
        try { content = await readFile(handle); } catch (_) { continue; }

        const { fm: existingFm, body: existingBody } = ObsidianSync.parseFrontmatter(content);

        // Members currently embedded in the file body
        const alreadyEmbedded = new Set();
        embedRe.lastIndex = 0;
        let m;
        while ((m = embedRe.exec(existingBody)) !== null) alreadyEmbedded.add(m[1].trim());

        // Add only missing embeds, based on body content.
        const toAdd = verifiedMembers.filter((t) => !alreadyEmbedded.has(t));
        if (toAdd.length === 0) continue;

        const additions = toAdd.map((t) => `![[Vocab_ao3/${t}]]`).join("\n");
        // Keep only simple timestamps in frontmatter for links notes.
        const cleanFm = { ...existingFm };
        delete cleanFm.link_words_managed;
        if (!cleanFm.created) cleanFm.created = todayDate();
        cleanFm.updated = todayDate();
        const newContent = ObsidianSync.buildFrontmatter(cleanFm) + existingBody.trimEnd() + "\n" + additions + "\n";

        try {
          const writable = await handle.createWritable();
          await writable.write(newContent);
          await writable.close();
          updated++;
          onLog(`  Updated links/${noteStem}.md: +${toAdd.join(", ")}`);
        } catch (err) {
          onLog(`  WARN: could not update ${noteStem}.md: ${err && err.message || err}`);
        }
      } else {
        // Skip if already covered by another existing note
        const memberSet = new Set(verifiedMembers);
        if (existingMemberSets.some((ex) => [...memberSet].every((t) => ex.has(t)))) continue;

        const lines = [heading, ""];
        for (const t of verifiedMembers) { lines.push(`![[Vocab_ao3/${t}]]`); lines.push(""); }
        const body = lines.join("\n") + "\n";
        const content = ObsidianSync.buildFrontmatter({
          created: todayDate(),
          updated: todayDate(),
        }) + body;

        try {
          await writeFileContent(linksDirHandle, noteStem + ".md", content);
          const newHandle = await linksDirHandle.getFileHandle(noteStem + ".md");
          stemToHandle.set(noteStem, newHandle);
          existingMemberSets.push(memberSet);
          created++;
          onLog(`  Created links/${noteStem}.md`);
        } catch (err) {
          onLog(`  WARN: could not create ${noteStem}.md: ${err && err.message || err}`);
        }
      }
    }
    // Persist the updated set of script-created stems
    const newCreated = new Set([...prevCreated, ...stemToHandle.keys()].filter((s) => !ignoreStems.has(s)));
    try {
      await writeFileContent(linksDirHandle, STATE_FILE, [...newCreated].sort().join("\n") + "\n");
    } catch (_) { /* best-effort */ }

    onLog(`Step 3 done: created ${created}, updated ${updated} links note(s).`);
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  async function runLinkWords({ rootDirHandle, onLog }) {
    const log = (typeof onLog === "function") ? onLog : () => {};

    log("Step 1/3: Cross-linking vocab entries…");
    await linkVocabEntries(rootDirHandle, log);

    log("Step 2/3: Linking vocab terms into AO3 notes…");
    await linkVocabToAo3(rootDirHandle, log);

    log("Step 3/3: Generating links/ notes…");
    await generateLinksNotes(rootDirHandle, log);

    log("All done.");
  }

  global.LinkWords = { runLinkWords, linkVocabEntries };

})(window);
