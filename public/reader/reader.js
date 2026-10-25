/* 浮读 · 本地阅读器（无框架，全部离线；只在需要时联网：批注模型 + 你电脑上的 GPT-SoVITS） */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  // ────────────────────────────── 存储 ──────────────────────────────
  const DB_NAME = "float-reader";
  const DB_VER = 1;
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "id" });
        if (!d.objectStoreNames.contains("notes")) {
          const s = d.createObjectStore("notes", { keyPath: "id" });
          s.createIndex("bookId", "bookId");
        }
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv", { keyPath: "k" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const tx = (store, mode, fn) =>
    db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction(store, mode);
          const s = t.objectStore(store);
          const out = fn(s);
          t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
          t.onerror = () => reject(t.error);
        }),
    );

  const store = {
    allBooks: () => tx("books", "readonly", (s) => s.getAll()).then((r) => r || []),
    getBook: (id) => tx("books", "readonly", (s) => s.get(id)),
    putBook: (b) => tx("books", "readwrite", (s) => s.put(b)),
    delBook: (id) => tx("books", "readwrite", (s) => s.delete(id)),
    notesOf: (bookId) =>
      tx("notes", "readonly", (s) => s.index("bookId").getAll(bookId)).then((r) => r || []),
    putNote: (n) => tx("notes", "readwrite", (s) => s.put(n)),
    delNote: (id) => tx("notes", "readwrite", (s) => s.delete(id)),
    kvGet: (k) => tx("kv", "readonly", (s) => s.get(k)).then((r) => (r ? r.v : null)),
    kvSet: (k, v) => tx("kv", "readwrite", (s) => s.put({ k, v })),
  };

  // ────────────────────────────── 设置 ──────────────────────────────
  const DEFAULT_SETTINGS = {
    theme: "jinjiang",
    fontSize: 17,
    lineHeight: 1.95,
    characters: [],
    activeCharacterId: "",
    llm: { base: "", key: "", model: "" },
    tts: {
      base: "http://127.0.0.1:9880",
      speed: 1,
      voices: [],
      activeVoiceId: "",
    },
  };
  let S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

  async function loadSettings() {
    try {
      const v = await store.kvGet("settings");
      if (v && typeof v === "object") S = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), v);
    } catch (e) {
      /* 首次运行 */
    }
    applyLook();
  }
  function saveSettings() {
    store.kvSet("settings", S).catch(() => {});
  }
  function applyLook() {
    document.documentElement.setAttribute("data-theme", S.theme || "jinjiang");
    document.documentElement.style.setProperty("--fs", `${S.fontSize}px`);
    document.documentElement.style.setProperty("--lh", String(S.lineHeight));
    $("valFs").textContent = S.fontSize;
    $("valLh").textContent = S.lineHeight.toFixed(2).replace(/0$/, "");
    $("valSpeed").textContent = (S.tts.speed || 1).toFixed(1);
    [...$("segTheme").children].forEach((b) => b.classList.toggle("active", b.dataset.theme === (S.theme || "jinjiang")));
  }
  const activeCharacter = () =>
    S.characters.find((c) => c.id === S.activeCharacterId) || S.characters[0] || null;
  const activeVoice = () =>
    S.tts.voices.find((v) => v.id === S.tts.activeVoiceId) || S.tts.voices[0] || null;

  // ────────────────────────────── 文件解析 ──────────────────────────────
  const CH_RE = /^\s*(?:第[零一二三四五六七八九十百千万两0-9０-９]+[章回节卷篇](?:[^\n]{0,40})?|Chapter\s+[0-9]+[^\n]{0,40}|序章[^\n]{0,40}|楔子[^\n]{0,20})\s*$/i;

  function decodeBuffer(buf) {
    // 先当 UTF-8 严格解码；失败再退回 GBK（国标 txt 很常见）
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      try {
        return new TextDecoder("gbk").decode(buf);
      } catch (e2) {
        return new TextDecoder("utf-8").decode(buf);
      }
    }
  }

  function splitChapters(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const chapters = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (CH_RE.test(line) && line.length <= 60) {
        if (cur) chapters.push(cur);
        cur = { title: line, lines: [] };
      } else if (cur) {
        cur.lines.push(raw);
      }
    }
    if (cur) chapters.push(cur);
    if (!chapters.length) return [{ title: "", lines }];
    // 开头若有正文没有归入章节，塞进第一章
    return chapters;
  }

  function linesToParagraphs(lines) {
    const out = [];
    let buf = [];
    const flush = () => {
      const t = buf.join("").trim();
      if (t) out.push(t.replace(/[ \t\u3000]+$/g, ""));
      buf = [];
    };
    for (const l of lines) {
      const t = l.trim();
      if (!t) flush();
      else buf.push(t);
    }
    flush();
    return out;
  }

  function parseTxt(text, fallbackTitle) {
    const chapters = splitChapters(text).map((c, i) => {
      const paragraphs = linesToParagraphs(c.lines);
      return {
        title: c.title || (i === 0 ? "正文" : `第 ${i + 1} 节`),
        paragraphs: paragraphs.length ? paragraphs : ["（这一节是空的）"],
      };
    });
    const firstLine = text.trim().split("\n")[0].slice(0, 40);
    return {
      format: "txt",
      title: fallbackTitle,
      author: "",
      hintTitle: firstLine,
      chapters,
    };
  }

  async function parseEpub(file, fallbackTitle) {
    if (typeof JSZip === "undefined") throw new Error("解压组件没装好");
    const zip = await JSZip.loadAsync(file);
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) throw new Error("不是有效的 epub（缺 container.xml）");
    const container = new DOMParser().parseFromString(await containerFile.async("text"), "application/xml");
    const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
    if (!opfPath) throw new Error("epub 里找不到 opf");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const opfXml = await zip.file(opfPath).async("text");
    const opf = new DOMParser().parseFromString(opfXml, "application/xml");
    const metaTitleNode = opf.getElementsByTagName("dc:title")[0] || opf.getElementsByTagName("title")[0];
    const metaTitle = metaTitleNode ? (metaTitleNode.textContent || "").trim() : "";
    const manifest = {};
    opf.querySelectorAll("manifest > item").forEach((it) => {
      manifest[it.getAttribute("id")] = {
        href: it.getAttribute("href"),
        type: it.getAttribute("media-type") || "",
      };
    });
    const spine = [...opf.querySelectorAll("spine > itemref")]
      .map((r) => r.getAttribute("idref"))
      .map((id) => manifest[id])
      .filter(Boolean);

    const chapters = [];
    for (const item of spine) {
      if (!/html|xml/.test(item.type)) continue;
      const p = opfDir + item.href.replace(/^\.\//, "");
      const f = zip.file(p) || zip.file(decodeURIComponent(p));
      if (!f) continue;
      const html = await f.async("text");
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script,style").forEach((n) => n.remove());
      const heading = doc.querySelector("h1,h2,h3") || doc.querySelector("title");
      let title = heading ? heading.textContent.trim().replace(/\s+/g, " ") : "";
      if (title.length > 60) title = title.slice(0, 60);
      const paras = [];
      doc.querySelectorAll("p,div,li,blockquote,br").forEach((n) => {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length > 1 && !paras.includes(t)) paras.push(t);
      });
      if (!paras.length) continue;
      if (!title) title = `第 ${chapters.length + 1} 节`;
      chapters.push({ title, paragraphs: paras });
    }
    if (!chapters.length) throw new Error("epub 里没抽出正文");
    return { format: "epub", title: metaTitle || fallbackTitle, author: "", chapters };
  }

  function parseHtmlText(text, fallbackTitle) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script,style").forEach((n) => n.remove());
    const t = doc.body ? doc.body.innerText || doc.body.textContent || "" : text;
    return parseTxt(t, fallbackTitle);
  }

  async function importFile(file) {
    const name = file.name.replace(/\.[^.]+$/, "") || "未命名";
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let parsed;
    if (ext === "epub") {
      parsed = await parseEpub(file, name);
    } else {
      const buf = await file.arrayBuffer();
      const text = decodeBuffer(buf);
      if (ext === "html" || ext === "htm") parsed = parseHtmlText(text, name);
      else if (ext === "md" || ext === "markdown") parsed = parseTxt(text, name);
      else parsed = parseTxt(text, name);
    }
    const book = {
      id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: parsed.title || name,
      author: parsed.author || "",
      format: parsed.format,
      createdAt: new Date().toISOString(),
      chapters: parsed.chapters,
    };
    await store.putBook(book);
    return book;
  }

  // 调试/自动化钩子（壳内测试用；将来「分享到浮读」也可以走这里）
  // 调试钩子：自动化测试时临时注入模型配置
  window.__readerSetLLM = function (cfg) {
    S.llm = Object.assign({}, S.llm, cfg || {});
    saveSettings();
    return S.llm;
  };

  window.__readerImport = async function (file) {
    const b = await importFile(file);
    await refreshShelf();
    return b;
  };

  // ────────────────────────────── 书架 ──────────────────────────────
  let books = [];
  let progressAll = {};
  let shelfFilter = "all";
  const expandedGroups = Object.create(null);

  const COVER_COLORS = [
    ["#5c8f7d", "#33584c"], ["#5b7fb8", "#31517e"], ["#c08350", "#81512a"],
    ["#8a6bb0", "#59407a"], ["#c25b6a", "#86323f"], ["#4f8fa8", "#2d5f74"],
    ["#7d9150", "#4d5c2b"], ["#a8668f", "#6f3d5b"],
  ];
  function coverColor(id) {
    // FNV-1a：短 id 也散得开，相邻 id 不会撞成同一个封面色
    let h = 2166136261;
    const s = String(id || "");
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return COVER_COLORS[(h >>> 0) % COVER_COLORS.length];
  }

  function bookState(b) {
    const p = progressAll[b.id] || {};
    const total = Math.max(1, (b.chapters || []).length);
    if (p.chIdx == null) return { pct: 0, done: false };
    // 末章且确实往下翻过（scrollTop 有记录）才算读完，避免一打开就「已读完」
    const atEnd = p.chIdx >= total - 1 && (p.scrollTop || 0) > 200;
    if (atEnd) return { pct: 100, done: true };
    const pct = Math.min(99, Math.max(1, Math.round(((p.chIdx + 0.6) / total) * 100)));
    return { pct, done: false };
  }
  const bookPercent = (b) => bookState(b).pct;

  async function delBook(b) {
    if (!confirm(`删掉《${b.title || "无题"}》？（批注也一起删）`)) return;
    await store.delBook(b.id);
    const notes = await store.notesOf(b.id);
    await Promise.all(notes.map((n) => store.delNote(n.id)));
    delete progressAll[b.id];
    await store.kvSet("progress", progressAll).catch(() => {});
    toast("已删除");
    refreshShelf();
  }

  function coverCard(b) {
    const p = progressAll[b.id] || {};
    const st = bookState(b);
    const pct = st.pct;
    const [c1, c2] = coverColor(b.id);
    const card = el("div", "cover-card");
    const badge = st.done
      ? '<span class="cbadge done">已读完</span>'
      : p.chIdx != null
        ? '<span class="cbadge read">读中</span>'
        : "";
    card.innerHTML = `
      <div class="cover" style="--c1:${c1};--c2:${c2}"><span class="ct">${esc(b.title || "无题")}</span></div>
      ${badge}
      ${pct > 0 && pct < 99 ? `<span class="progress-dot">${pct}%</span>` : ""}`;
    card.addEventListener("click", () => openBook(b.id));
    let hold = 0;
    card.addEventListener("pointerdown", () => {
      hold = setTimeout(() => {
        hold = 0;
        delBook(b);
      }, 650);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) =>
      card.addEventListener(t, () => {
        if (hold) {
          clearTimeout(hold);
          hold = 0;
        }
      }),
    );
    return card;
  }

  function groupBlock(key, title, list, limit) {
    const wrap = el("div", "group");
    const head = el("div", "group-head");
    head.innerHTML = `<h2>${esc(title)}</h2><span class="cnt">共 ${list.length} 本</span>`;
    const open = expandedGroups[key] || !limit || list.length <= limit;
    if (limit && list.length > limit) {
      const more = el("button", "more", open ? "收起" : "more");
      more.addEventListener("click", () => {
        expandedGroups[key] = !open;
        renderShelf();
      });
      head.appendChild(more);
    }
    wrap.appendChild(head);
    const grid = el("div", "cover-grid");
    (open ? list : list.slice(0, limit)).forEach((b) => grid.appendChild(coverCard(b)));
    wrap.appendChild(grid);
    return wrap;
  }

  function renderShelf() {
    const box = $("shelfGroups");
    box.innerHTML = "";
    $("shelfEmpty").classList.toggle("hidden", books.length > 0);
    document.querySelectorAll("#heroTabs .htab").forEach((t) => t.classList.toggle("active", t.dataset.filter === shelfFilter));

    const recent = books
      .filter((b) => (progressAll[b.id] || {}).chIdx != null)
      .sort((a, b) => String(b.lastReadAt || "").localeCompare(String(a.lastReadAt || "")));
    const done = books.filter((b) => bookState(b).done);
    const rest = books.filter((b) => done.indexOf(b) < 0);

    const groups = [];
    if (shelfFilter === "recent") groups.push(["recent", "最近阅读", recent, 12]);
    else if (shelfFilter === "done") groups.push(["done", "已读完", done, 12]);
    else {
      if (recent.length) groups.push(["recent", "最近阅读", recent, 4]);
      groups.push(["all", "全部收藏", rest, 12]);
      if (done.length) groups.push(["done", "已读完", done, 8]);
    }
    groups.forEach(([k, t, list, lim]) => {
      if (list.length) box.appendChild(groupBlock(k, t, list, lim));
    });
  }

  async function refreshShelf() {
    books = await store.allBooks();
    books.sort((a, b) => String(b.lastReadAt || b.createdAt || "").localeCompare(String(a.lastReadAt || a.createdAt || "")));
    progressAll = (await store.kvGet("progress")) || {};
    renderShelf();
  }

  function renderSearch() {
    const q = ($("searchBox").value || "").trim().toLowerCase();
    const box = $("searchResults");
    const list = !q
      ? books.slice(0, 6)
      : books.filter((b) => String(b.title || "").toLowerCase().includes(q) || String(b.author || "").toLowerCase().includes(q));
    box.innerHTML = list.length ? "" : '<div class="hint">没找到。换个词试试，或者回书架点「＋」导入。</div>';
    list.forEach((b) => {
      const [c1, c2] = coverColor(b.id);
      const row = el("div", "sr-item");
      row.innerHTML = `<span class="sr-cover" style="background:linear-gradient(150deg,${c1},${c2})"></span>
        <div class="sr-body"><div class="sr-title">${esc(b.title || "无题")}</div>
        <div class="sr-meta">${esc((b.format || "txt").toUpperCase())} · ${b.chapters.length} 章 · 读到 ${bookPercent(b)}%</div></div>`;
      row.addEventListener("click", () => openBook(b.id));
      box.appendChild(row);
    });
  }

  function renderMe() {
    const c = activeCharacter();
    const llmOk = !!(S.llm && S.llm.base && S.llm.key && S.llm.model);
    $("llmState").textContent = llmOk ? "已配置" : "未配置";
    const ttsBase = String((S.tts && S.tts.base) || "");
    const ttsReady = !!ttsBase && !/127\.0\.0\.1|localhost/i.test(ttsBase);
    $("ttsState").textContent = ttsReady ? "已配置" : "未配置";
    $("charState").textContent = c ? c.name : "还没有";
    const v = (S.tts.voices || []).find((x) => x.id === S.tts.activeVoiceId) || (S.tts.voices || [])[0];
    $("meStatus").innerHTML = `<div class="me-status">
      <b>${books.length}</b> 本书 · <b>${Object.keys(progressAll).length}</b> 本读过<br />
      当前角色：<b>${esc(c ? c.name : "还没选")}</b><br />
      听书音色：<b>${esc(v ? v.name : "未设置")}</b>
    </div>`;
    document.querySelectorAll("#meView .row-theme button").forEach((b) => b.classList.toggle("active", b.dataset.theme === (S.theme || "jinjiang")));
  }

  function switchTab(tab) {
    document.body.classList.toggle("reading", tab === "read");
    ["shelf", "discover", "me"].forEach((t) => $(`${t}View`).classList.toggle("hidden", t !== tab));
    $("readView").classList.toggle("hidden", tab !== "read");
    $("tabbar").classList.toggle("hidden", tab === "read");
    document.querySelectorAll("#tabbar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "shelf") refreshShelf();
    if (tab === "discover") renderSearch();
    if (tab === "me") renderMe();
    // 嵌在小手机 App 里时，告诉外壳当前在哪一页（外壳据此决定要不要显示「回到桌面」按钮）
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "float-reader-view", view: tab === "read" ? "read" : "shelf" }, "*");
      }
    } catch (error) {
      /* 单独打开时没有父窗口，忽略 */
    }
  }
  // ────────────────────────────── 阅读 ──────────────────────────────
  let book = null;
  let chIdx = 0;
  let notes = [];
  let selected = null; // {paraIdx}
  let lastParagraphIdx = 0;

  async function openBook(id) {
    book = await store.getBook(id);
    if (!book) return toast("这本书不见了");
    notes = await store.notesOf(id);
    const p = progressAll[id] || {};
    chIdx = Math.min(Math.max(p.chIdx || 0, 0), book.chapters.length - 1);
    switchTab("read");
    $("bookTitle").textContent = book.title;
    renderChapter();
    if (p.scrollTop && p.chIdx === chIdx) {
      requestAnimationFrame(() => {
        $("readerScroll").scrollTop = p.scrollTop;
      });
    }
  }

  function backToShelf() {
    saveProgress();
    stopAudio();
    switchTab("shelf");
  }

  const chapterTitle = (i) => (book && book.chapters[i] ? book.chapters[i].title : "");

  function renderChapter() {
    const ch = book.chapters[chIdx];
    const box = $("readerScroll");
    box.innerHTML = "";
    const head = el("div", "chapter-head");
    head.innerHTML = `<h2 class="ch-title">${esc(ch.title || `第 ${chIdx + 1} 节`)}</h2>
      <div class="ch-sub">${esc(book.title)} · ${ch.paragraphs.length} 段</div><div class="ch-rule"></div>`;
    box.appendChild(head);

    ch.paragraphs.forEach((text, i) => {
      const p = el("p", "para", esc(text));
      p.dataset.i = String(i);
      const mine = notes.filter((n) => n.chIdx === chIdx && n.paraIdx === i);
      if (mine.length) p.classList.add("has-note", "marked");
      p.addEventListener("click", () => selectParagraph(i));
      box.appendChild(p);
      mine.forEach((n) => box.appendChild(noteCard(n, true)));
    });

    box.appendChild(el("div", "ch-end", "— 本章完 —"));
    const tip = el("div", "reader-tip", "点段落可以批注 / 朗读 · 右下角「听书」从这里开始");
    box.appendChild(tip);

    box.onscroll = () => {
      const paras = box.querySelectorAll(".para");
      let cur = 0;
      for (const p of paras) {
        if (p.offsetTop - box.scrollTop < box.clientHeight * 0.45) cur = Number(p.dataset.i);
      }
      lastParagraphIdx = cur;
      saveProgressDebounced();
    };
    selected = null;
    hideSelbar();
    updateBuddy();
    $("tocList").querySelectorAll(".toc-item").forEach((n) => n.classList.toggle("active", Number(n.dataset.i) === chIdx));
  }

  function noteCard(n, removable) {
    const card = el("div", "note");
    card.innerHTML = `
      <div class="note-head">
        <span class="note-ava">${esc((n.characterName || "读").slice(0, 1))}</span>
        <span class="note-name">${esc(n.characterName || "批注")}</span>
        ${removable ? `<button class="note-x" data-note="${esc(n.id)}">✕</button>` : ""}
      </div>
      <div class="note-body">${esc(n.content)}</div>`;
    const x = card.querySelector("[data-note]");
    if (x)
      x.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await store.delNote(n.id);
        notes = await store.notesOf(book.id);
        renderChapter();
      });
    return card;
  }

  function saveProgress() {
    if (!book) return;
    progressAll[book.id] = {
      chIdx,
      scrollTop: $("readerScroll").scrollTop,
      at: new Date().toISOString(),
    };
    book.lastReadAt = new Date().toISOString();
    store.kvSet("progress", progressAll).catch(() => {});
    store.putBook(book).catch(() => {});
  }
  let saveTimer = 0;
  function saveProgressDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 900);
  }

  // ────────────────────────────── 选中段落 ──────────────────────────────
  function selectParagraph(i) {
    selected = { paraIdx: i };
    document.querySelectorAll(".para.active").forEach((p) => p.classList.remove("active"));
    const node = document.querySelector(`.para[data-i="${i}"]`);
    if (node) node.classList.add("active");
    const text = book.chapters[chIdx].paragraphs[i] || "";
    $("selQuote").textContent = text.slice(0, 120);
    $("selbar").classList.add("show");
  }
  function hideSelbar() {
    $("selbar").classList.remove("show");
    document.querySelectorAll(".para.active").forEach((p) => p.classList.remove("active"));
  }

  // ────────────────────────────── 目录 ──────────────────────────────
  function openToc() {
    const list = $("tocList");
    list.innerHTML = "";
    book.chapters.forEach((c, i) => {
      const item = el("div", "toc-item" + (i === chIdx ? " active" : ""));
      item.dataset.i = String(i);
      item.innerHTML = `<span class="toc-num">${i + 1}</span><span class="toc-name">${esc(c.title || `第 ${i + 1} 节`)}</span>`;
      item.addEventListener("click", () => {
        chIdx = i;
        closeToc();
        renderChapter();
        $("readerScroll").scrollTop = 0;
        saveProgress();
      });
      list.appendChild(item);
    });
    $("tocTitle").textContent = `${book.title} · 目录`;
    $("toc").classList.add("show");
    $("mask").classList.add("show");
  }
  function closeToc() {
    $("toc").classList.remove("show");
    $("mask").classList.remove("show");
  }

  // ────────────────────────────── 模型调用 ──────────────────────────────
  async function callLLM(messages, { json = false, maxTokens = 600 } = {}) {
    const { base, key, model } = S.llm;
    if (!base || !key || !model) throw new Error("还没配置批注模型（设置 → 批注模型）");
    const root = base.replace(/\/+$/, "");
    const isMinimax = /minimax/i.test(root);
    const url = isMinimax ? `${root}/text/chatcompletion_v2` : `${root}/chat/completions`;
    const body = isMinimax
      ? { model, messages, temperature: 0.9, max_tokens: maxTokens }
      : { model, messages, temperature: 0.9, max_tokens: maxTokens };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`模型接口 ${res.status}：${txt.slice(0, 120)}`);
    let data;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      throw new Error("模型返回的不是 JSON");
    }
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.reply ??
      data?.data?.reply ??
      "";
    if (!content) throw new Error("模型没返回内容");
    return String(content);
  }

  function personaBase() {
    const c = activeCharacter();
    const name = c ? c.name : "一个读者朋友";
    const persona = c ? c.persona : "你是一个爱看小说、说话直接的人。";
    return `你是「${name}」。${persona}`;
  }

  function annotationSystem() {
    return `${personaBase()}

你正在陪用户读小说，你的批注会以小卡片形式贴在相应段落下面。

写批注的规矩（很重要）：
1. 每条 1~2 句，像随口说出来的，越短越好，一般不超过 40 字。
2. 用第一人称口语。不要写"这段描写了…""作者想表达…"这种分析腔，也不要总结剧情。
3. 要有活人感：可以吐槽、心累、激动、想起自己的事、替角色着急、跟用户搭话；偶尔跑题一句也行。
4. 不要剧透你还没读到的内容。
5. 不要每条都批注，只挑真正让你有反应的那 1~2 段。
6. 只输出 JSON，格式：{"notes":[{"para":段号,"text":"批注"}]}`;
  }

  function chatSystem() {
    return `${personaBase()}
你正在陪用户读同一本小说，边看边聊。
说话的规矩：
1. 直接说话，1~3 句，口语，别端着。
2. 可以吐槽、想起自己的事、反问用户；不要总结剧情、不要分析写作手法。
3. 用第一人称，不要说"作为AI"。
4. 不要在聊天里输出 JSON、markdown 或批注格式。`;
  }

  function chapterContext(centerIdx, radius = 5) {
    const ch = book.chapters[chIdx];
    const from = Math.max(0, centerIdx - radius);
    const to = Math.min(ch.paragraphs.length, centerIdx + radius + 1);
    const rows = [];
    for (let i = from; i < to; i += 1) rows.push(`[${i}] ${ch.paragraphs[i]}`);
    return { from, to, text: rows.join("\n") };
  }

  async function annotateParagraph(paraIdx) {
    const c = activeCharacter();
    if (!c) return toast("先加一个角色吧（设置 → 角色）");
    if (!S.llm.base || !S.llm.key || !S.llm.model) return toast("先配置批注模型");
    const ctx = chapterContext(paraIdx);
    toast("它在读这一段…", 1200);
    const raw = await callLLM([
      { role: "system", content: annotationSystem() },
      {
        role: "user",
        content: `书名：《${book.title}》\n章节：${chapterTitle(chIdx)}\n\n${ctx.text}\n\n我现在在读第 ${paraIdx} 段。就着这一小段，写 1 条批注给我。只输出 JSON。`,
      },
    ]);
    const notesOut = extractNotesJson(raw);
    if (!notesOut.length) {
      toast("它这次没吭声");
      return;
    }
    const now = new Date().toISOString();
    for (const n of notesOut) {
      const idx = Number.isFinite(n.para) ? Math.max(ctx.from, Math.min(ctx.to - 1, n.para)) : paraIdx;
      const text = String(n.text || "").trim();
      if (!text) continue;
      await store.putNote({
        id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        bookId: book.id,
        chIdx,
        paraIdx: idx,
        characterId: c.id,
        characterName: c.name,
        quote: book.chapters[chIdx].paragraphs[idx]?.slice(0, 80) || "",
        content: text,
        createdAt: now,
      });
    }
    notes = await store.notesOf(book.id);
    renderChapter();
    toast("批注好了");
  }

  function extractNotesJson(raw) {
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        const obj = JSON.parse(s.slice(a, b + 1));
        if (Array.isArray(obj.notes)) return obj.notes;
      } catch (e) {
        /* 继续尝试数组 */
      }
    }
    const c = s.indexOf("[");
    const d = s.lastIndexOf("]");
    if (c >= 0 && d > c) {
      try {
        const arr = JSON.parse(s.slice(c, d + 1));
        if (Array.isArray(arr)) return arr;
      } catch (e) {
        /* 放弃 */
      }
    }
    return [];
  }

  // ────────────────────────────── 听书（GPT-SoVITS）──────────────────────────────
  const audio = new Audio();
  audio.preload = "auto";
  let playing = false;
  let playIdx = 0;
  let ttsToken = 0;

  function ttsUrl(text) {
    const v = activeVoice();
    const base = (S.tts.base || "").replace(/\/+$/, "");
    if (!base) throw new Error("还没填语音服务地址");
    const q = new URLSearchParams({
      text,
      text_lang: v?.lang || "zh",
      ref_audio_path: v?.ref || "",
      prompt_text: v?.prompt || "",
      prompt_lang: v?.lang || "zh",
      text_split_method: "cut5",
      batch_size: "1",
      speed_factor: String(S.tts.speed || 1),
      media_type: "wav",
      streaming_mode: "false",
    });
    return `${base}/tts?${q.toString()}`;
  }

  async function playAt(idx) {
    if (!book) return;
    const ch = book.chapters[chIdx];
    if (idx >= ch.paragraphs.length) {
      stopAudio();
      toast("这一章读完了");
      return;
    }
    playIdx = idx;
    const text = ch.paragraphs[idx].slice(0, 600);
    const token = ++ttsToken;
    document.querySelectorAll(".para.playing").forEach((p) => p.classList.remove("playing"));
    const node = document.querySelector(`.para[data-i="${idx}"]`);
    if (node) {
      node.classList.add("playing");
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    $("abText").textContent = `第 ${idx + 1} 段 · 合成中…`;
    try {
      const url = ttsUrl(text);
      audio.src = url;
      audio.playbackRate = 1;
      await audio.play();
      playing = true;
      $("abPlay").textContent = "⏸";
      $("abText").textContent = `第 ${idx + 1} 段 · 正在读`;
    } catch (e) {
      if (token !== ttsToken) return;
      // 自动播放被系统拦下时，不要报「失败」——等用户点一下播放键就行
      if (e && (e.name === "NotAllowedError" || /not allowed|user gesture/i.test(String(e.message || "")))) {
        playing = false;
        $("abPlay").textContent = "▶";
        $("abText").textContent = `第 ${idx + 1} 段 · 点 ▶ 开始`;
        toast("点一下播放键就能听", 2200);
        return;
      }
      $("abText").textContent = `第 ${idx + 1} 段 · 失败`;
      toast(`朗读失败：${e.message || e}`, 3200);
    }
  }

  audio.addEventListener("ended", () => {
    if (!playing) return;
    playAt(playIdx + 1);
  });
  audio.addEventListener("error", () => {
    if (!playing) return;
    playing = false;
    $("abPlay").textContent = "▶";
    toast("语音服务没响应：检查电脑上的 GPT-SoVITS 和局域网地址", 3200);
  });

  function startAudio(fromIdx) {
    if (!S.tts.base) return toast("先填语音服务地址");
    playing = true;
    $("audioBar").classList.remove("hidden");
    playAt(fromIdx == null ? lastParagraphIdx : fromIdx);
  }
  function stopAudio() {
    playing = false;
    ttsToken += 1;
    try {
      audio.pause();
    } catch (e) {}
    audio.removeAttribute("src");
    $("abPlay").textContent = "▶";
    document.querySelectorAll(".para.playing").forEach((p) => p.classList.remove("playing"));
  }
  function toggleAudio() {
    if (!playing) return startAudio();
    stopAudio();
  }

  // ────────────────────────────── 和角色聊书 ──────────────────────────────
  const chatLog = [];
  async function sendChat() {
    const input = $("chatText");
    const text = input.value.trim();
    if (!text) return;
    const c = activeCharacter();
    if (!c) return toast("先加一个角色");
    if (!S.llm.base) return toast("先配置批注模型");
    input.value = "";
    chatLog.push({ role: "user", content: text });
    renderChat();
    const ctx = book ? chapterContext(lastParagraphIdx, 3).text : "";
    try {
      const reply = await callLLM([
        {
          role: "system",
          content: chatSystem(),
        },
        { role: "user", content: `我们正在看《${book ? book.title : "一本书"}》${book ? `· ${chapterTitle(chIdx)}` : ""}。\n刚读到的内容：\n${ctx}\n\n我说：${text}` },
      ]);
      chatLog.push({ role: "assistant", content: reply.trim() });
    } catch (e) {
      chatLog.push({ role: "assistant", content: `（没连上模型：${e.message}）` });
    }
    renderChat();
  }
  function renderChat() {
    const list = $("chatList");
    list.innerHTML = "";
    if (!chatLog.length) {
      list.innerHTML = `<div class="bubble ta">${esc(activeCharacter() ? `${activeCharacter().name}：读到哪了？哪句让你停了一下？` : "先去设置里加个角色")}</div>`;
    }
    chatLog.forEach((m) => list.appendChild(el("div", `bubble ${m.role === "user" ? "me" : "ta"}`, esc(m.content))));
    list.scrollTop = list.scrollHeight;
  }

  // ────────────────────────────── 弹层 ──────────────────────────────
  function openSheet(id) {
    $("mask").classList.add("show");
    $(id).classList.add("show");
  }
  function closeSheet(id) {
    $(id).classList.remove("show");
    if (!document.querySelector(".sheet.show") && !$("toc").classList.contains("show")) $("mask").classList.remove("show");
  }
  function closeAll() {
    document.querySelectorAll(".sheet.show").forEach((s) => s.classList.remove("show"));
    $("toc").classList.remove("show");
    $("mask").classList.remove("show");
    hideSelbar();
  }

  // ────────────────────────────── 设置 UI ──────────────────────────────
  function renderCharacters() {
    const sel = $("selCharacter");
    sel.innerHTML = S.characters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("") || `<option value="">（还没有角色）</option>`;
    sel.value = S.activeCharacterId || (S.characters[0] && S.characters[0].id) || "";
    $("llmBase").value = S.llm.base || "";
    $("llmKey").value = S.llm.key || "";
    $("llmModel").value = S.llm.model || "";
    $("ttsBase").value = S.tts.base || "";
    updateBuddy();
  }
  function updateBuddy() {
    const c = activeCharacter();
    $("buddyAva").textContent = c ? c.name.slice(0, 1) : "浮";
    $("buddyName").textContent = c ? c.name : "还没有角色";
    $("buddyStatus").textContent = c ? "正在陪你读" : "去设置里加一个，让它陪你读";
    $("btnBuddyAnnotate").style.display = c ? "" : "none";
  }
  function renderVoices() {
    const seg = $("segVoice");
    seg.innerHTML = "";
    if (!S.tts.voices.length) {
      seg.innerHTML = `<span style="font-size:12.5px;color:var(--muted)">还没有音色，下面填一个再保存</span>`;
      return;
    }
    S.tts.voices.forEach((v) => {
      const b = el("button", v.id === (S.tts.activeVoiceId || S.tts.voices[0].id) ? "active" : "", esc(v.name));
      b.addEventListener("click", () => {
        S.tts.activeVoiceId = v.id;
        saveSettings();
        renderVoices();
      });
      seg.appendChild(b);
    });
  }

  // ────────────────────────────── 事件绑定 ──────────────────────────────
  function bind() {
    $("btnImport").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", async (ev) => {
      const files = [...(ev.target.files || [])];
      ev.target.value = "";
      for (const f of files) {
        try {
          toast(`正在导入 ${f.name}…`, 1500);
          const b = await importFile(f);
          toast(`《${b.title}》进来了，${b.chapters.length} 章`, 2400);
        } catch (e) {
          toast(`导入失败：${e.message || e}`, 3600);
        }
      }
      refreshShelf();
    });

    $("btnBackShelf").addEventListener("click", backToShelf);
    $("btnToc").addEventListener("click", openToc);
    $("chipToc").addEventListener("click", openToc);
    $("tocClose").addEventListener("click", closeToc);
    $("mask").addEventListener("click", closeAll);

    $("btnReaderSettings").addEventListener("click", () => {
      renderCharacters();
      openSheet("settingsSheet");
    });
    $("btnImport2").addEventListener("click", () => $("fileInput").click());
    $("btnOpenSettings").addEventListener("click", () => {
      renderCharacters();
      openSheet("settingsSheet");
    });
    $("btnOpenLlm").addEventListener("click", () => {
      renderCharacters();
      openSheet("settingsSheet");
    });
    $("btnOpenVoices").addEventListener("click", () => {
      renderVoices();
      openSheet("audioSheet");
    });
    $("btnOpenTts").addEventListener("click", () => {
      renderVoices();
      openSheet("audioSheet");
    });
    $("btnOpenCharacters").addEventListener("click", () => {
      renderCharacters();
      openSheet("characterForm");
    });
    $("searchBox").addEventListener("input", renderSearch);
    document.querySelectorAll("#heroTabs .htab").forEach((b) =>
      b.addEventListener("click", () => {
        shelfFilter = b.dataset.filter;
        renderShelf();
      }),
    );
    document.querySelectorAll("#tabbar .tab").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab)),
    );
    document.querySelectorAll("#meView .row-theme button").forEach((b) =>
      b.addEventListener("click", () => {
        S.theme = b.dataset.theme;
        saveSettings();
        applyLook();
        renderMe();
        document.querySelectorAll("#segTheme button").forEach((x) => x.classList.toggle("active", x.dataset.theme === S.theme));
      }),
    );
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => closeSheet(b.dataset.close)),
    );

    $("segTheme").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-theme]");
      if (!b) return;
      S.theme = b.dataset.theme;
      saveSettings();
      applyLook();
    });
    document.querySelectorAll("[data-fs]").forEach((b) =>
      b.addEventListener("click", () => {
        S.fontSize = Math.min(26, Math.max(13, S.fontSize + Number(b.dataset.fs)));
        saveSettings();
        applyLook();
      }),
    );
    document.querySelectorAll("[data-lh]").forEach((b) =>
      b.addEventListener("click", () => {
        S.lineHeight = Math.min(2.6, Math.max(1.4, Math.round((S.lineHeight + Number(b.dataset.lh)) * 100) / 100));
        saveSettings();
        applyLook();
      }),
    );
    document.querySelectorAll("[data-speed]").forEach((b) =>
      b.addEventListener("click", () => {
        S.tts.speed = Math.min(2, Math.max(0.5, Math.round((S.tts.speed + Number(b.dataset.speed)) * 10) / 10));
        saveSettings();
        applyLook();
      }),
    );

    $("selCharacter").addEventListener("change", (ev) => {
      S.activeCharacterId = ev.target.value;
      saveSettings();
      updateBuddy();
    });
    $("btnAddCharacter").addEventListener("click", () => {
      $("characterForm").classList.toggle("hidden");
      $("cfName").value = "";
      $("cfPersona").value = "";
    });
    $("btnSaveCharacter").addEventListener("click", () => {
      const name = $("cfName").value.trim();
      const persona = $("cfPersona").value.trim();
      if (!name) return toast("给它起个名字");
      const id = `c${Date.now().toString(36)}`;
      S.characters.push({ id, name, persona });
      S.activeCharacterId = id;
      saveSettings();
      renderCharacters();
      $("characterForm").classList.add("hidden");
      toast("角色加好了");
    });
    $("btnSaveLlm").addEventListener("click", () => {
      S.llm = { base: $("llmBase").value.trim(), key: $("llmKey").value.trim(), model: $("llmModel").value.trim() };
      saveSettings();
      toast("模型配置存好了");
    });
    $("ttsBase").addEventListener("change", () => {
      S.tts.base = $("ttsBase").value.trim();
      saveSettings();
      toast("语音地址存好了");
    });
    $("btnTtsSheet").addEventListener("click", () => {
      renderVoices();
      openSheet("audioSheet");
    });
    $("btnSaveVoice").addEventListener("click", () => {
      const name = $("vName").value.trim() || "音色";
      const ref = $("vRef").value.trim();
      const prompt = $("vPrompt").value.trim();
      if (!ref) return toast("要填参考音频的路径");
      const lang = $("segLang").querySelector(".active")?.dataset.lang || "zh";
      const id = `v${Date.now().toString(36)}`;
      S.tts.voices.push({ id, name, ref, prompt, lang });
      S.tts.activeVoiceId = id;
      saveSettings();
      renderVoices();
      toast("音色保存了");
    });
    $("segLang").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-lang]");
      if (!b) return;
      [...$("segLang").children].forEach((x) => x.classList.toggle("active", x === b));
    });

    $("chipPrev").addEventListener("click", () => {
      if (chIdx > 0) {
        chIdx -= 1;
        renderChapter();
        $("readerScroll").scrollTop = 0;
        saveProgress();
      }
    });
    $("chipNext").addEventListener("click", () => {
      if (chIdx < book.chapters.length - 1) {
        chIdx += 1;
        renderChapter();
        $("readerScroll").scrollTop = 0;
        saveProgress();
      }
    });
    $("chipListen").addEventListener("click", () => {
      if (!S.tts.base) {
        $("ttsBase").value = S.tts.base || "";
        renderCharacters();
        return openSheet("settingsSheet");
      }
      startAudio();
    });
    $("chipFont").addEventListener("click", () => {
      renderCharacters();
      openSheet("settingsSheet");
    });

    $("abPlay").addEventListener("click", toggleAudio);
    $("abPrev").addEventListener("click", () => {
      if (!playing) startAudio(Math.max(0, lastParagraphIdx - 1));
      else playAt(Math.max(0, playIdx - 1));
    });
    $("abNext").addEventListener("click", () => {
      if (!playing) startAudio(Math.min(book.chapters[chIdx].paragraphs.length - 1, lastParagraphIdx + 1));
      else playAt(playIdx + 1);
    });
    $("abClose").addEventListener("click", () => {
      stopAudio();
      $("audioBar").classList.add("hidden");
    });

    $("selCancel").addEventListener("click", hideSelbar);
    $("selWrite").addEventListener("click", () => {
      if (!selected) return;
      $("noteQuote").textContent = (book.chapters[chIdx].paragraphs[selected.paraIdx] || "").slice(0, 120);
      $("noteText").value = "";
      openSheet("noteSheet");
    });
    $("selAnnotate").addEventListener("click", async () => {
      if (!selected) return;
      hideSelbar();
      try {
        await annotateParagraph(selected.paraIdx);
      } catch (e) {
        toast(`没写成：${e.message || e}`, 3600);
      }
    });
    $("selRead").addEventListener("click", () => {
      if (!selected) return;
      const i = selected.paraIdx;
      hideSelbar();
      $("audioBar").classList.remove("hidden");
      playing = true;
      playAt(i);
    });
    $("selCopy").addEventListener("click", async () => {
      if (!selected) return;
      const t = book.chapters[chIdx].paragraphs[selected.paraIdx] || "";
      try {
        await navigator.clipboard.writeText(t);
        toast("复制了");
      } catch (e) {
        toast("复制不了，长按选中试试");
      }
      hideSelbar();
    });

    $("btnBuddyAnnotate").addEventListener("click", async () => {
      const idx = lastParagraphIdx;
      try {
        await annotateParagraph(idx);
      } catch (e) {
        toast(`没写成：${e.message || e}`, 3600);
      }
    });
    $("btnBuddyChat").addEventListener("click", () => {
      $("chatTitle").textContent = activeCharacter() ? `和${activeCharacter().name}聊聊` : "聊聊";
      renderChat();
      openSheet("chatSheet");
    });
    $("chatSend").addEventListener("click", sendChat);
    $("chatText").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    // 写批注弹层
    $("noteQuote").textContent = "";
    $("noteAi").addEventListener("click", async () => {
      if (!selected) return;
      $("noteText").value = "它在想…";
      try {
        const c = activeCharacter();
        const ctx = chapterContext(selected.paraIdx, 3);
        const raw = await callLLM([
          { role: "system", content: annotationSystem() },
          { role: "user", content: `《${book.title}》${chapterTitle(chIdx)}\n\n${ctx.text}\n\n针对第 ${selected.paraIdx} 段写 1 条批注。只输出 JSON。` },
        ]);
        const arr = extractNotesJson(raw);
        $("noteText").value = arr.length ? String(arr[0].text || "") : raw.slice(0, 120);
      } catch (e) {
        $("noteText").value = "";
        toast(`模型没回：${e.message || e}`, 3600);
      }
    });
    $("noteSave").addEventListener("click", async () => {
      const text = $("noteText").value.trim();
      if (!text || !selected) return;
      const c = activeCharacter() || { id: "user", name: "我" };
      await store.putNote({
        id: `n${Date.now().toString(36)}`,
        bookId: book.id,
        chIdx,
        paraIdx: selected.paraIdx,
        characterId: c.id,
        characterName: c.name,
        quote: book.chapters[chIdx].paragraphs[selected.paraIdx]?.slice(0, 80) || "",
        content: text,
        createdAt: new Date().toISOString(),
      });
      notes = await store.notesOf(book.id);
      closeSheet("noteSheet");
      renderChapter();
      toast("记下了");
    });
  }

  // ────────────────────────────── 启动 ──────────────────────────────
  async function boot() {
    await loadSettings();
    bind();
    await refreshShelf();
    window.addEventListener("beforeunload", saveProgress);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) saveProgress();
    });
    if (!S.characters.length) {
      // 给一个默认角色，避免空荡荡
      S.characters.push({
        id: "default",
        name: "阿绿",
        persona: "你是一个看书很快、嘴有点毒但心软的人。你会为角色着急，也会突然想起自己以前的事。",
      });
      S.activeCharacterId = "default";
      saveSettings();
      updateBuddy();
    }
  }

  // 安卓返回键：先关弹层，再回书架；返回 true 表示页面自己处理了
  window.__readerBack = function () {
    if ($("toc").classList.contains("show") || $("mask").classList.contains("show")) {
      closeAll();
      $("toc").classList.remove("show");
      return true;
    }
    if ($("selbar").classList.contains("show")) {
      hideSelbar();
      return true;
    }
    if (!$("readView").classList.contains("hidden")) {
      backToShelf();
      return true;
    }
    return false;
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
