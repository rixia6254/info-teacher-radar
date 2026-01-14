/* Info Teacher Radar - front-end (static) */
console.log("app.js loaded: v20260114-2");

const TABS = [
  { key: "TODAY", label: "今日のピックアップ" },
  { key: "ICT", label: "ICT教育" },
  { key: "INFO1", label: "高校情報Ⅰ（授業実践）" },
  { key: "EXAM", label: "共通テスト（情報Ⅰ）" },
  { key: "AI_EDU", label: "生成AI（教育・校務）" },
  { key: "AI_LATEST", label: "生成AI（最新事情・AIツール）" },
  { key: "MEXT", label: "文科省（MEXT）" },
  { key: "X", label: "Xまとめ" },
  { key: "BOOKMARKS", label: "★ ブックマーク" }
];

const LS_KEY = "itr.bookmarks.v1"; // stores { map: {id: itemMeta}, order: [id...] }
const LS_X = "itr.xclips.v1";      // stores [{url,memo,ts}]
const BOOKMARK_CAP = 500;          // soft cap (you wanted >=100; 500 is safe)

let allItems = [];
let filtered = [];
let activeTab = "TODAY";
let activeTag = null;

// Xモーダルを閉じたときに戻る先
let lastNonXTab = "TODAY";

const $ = (id) => document.getElementById(id);

function isoToDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return "";
  }
}

/* -------------------------
   Bookmarks
------------------------- */
function loadBookmarks() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { map: {}, order: [] };
    const obj = JSON.parse(raw);
    if (!obj.map) obj.map = {};
    if (!obj.order) obj.order = [];
    return obj;
  } catch {
    return { map: {}, order: [] };
  }
}

function saveBookmarks(bm) {
  localStorage.setItem(LS_KEY, JSON.stringify(bm));
}

function isBookmarked(id) {
  const bm = loadBookmarks();
  return !!bm.map[id];
}

function toggleBookmark(item) {
  const bm = loadBookmarks();

  if (bm.map[item.id]) {
    delete bm.map[item.id];
    bm.order = bm.order.filter((x) => x !== item.id);
  } else {
    // store meta so it survives beyond 7 days
    bm.map[item.id] = {
      id: item.id,
      title: item.title,
      url: item.url,
      source: item.source,
      publishedAt: item.publishedAt,
      tab: item.tab,
      tags: item.tags || [],
      score: item.score || 0
    };
    bm.order.unshift(item.id);

    // soft cap
    if (bm.order.length > BOOKMARK_CAP) {
      const removed = bm.order.slice(BOOKMARK_CAP);
      removed.forEach((id) => delete bm.map[id]);
      bm.order = bm.order.slice(0, BOOKMARK_CAP);
    }
  }

  saveBookmarks(bm);
}

/* -------------------------
   Nav / Tabs
------------------------- */
function renderNav() {
  const nav = $("navTabs");
  nav.innerHTML = "";

  // Main nav excludes TODAY / BOOKMARKS / X (they are in Quick buttons)
  const mainTabs = TABS.filter((t) => !["TODAY", "BOOKMARKS", "X"].includes(t.key));
  for (const t of mainTabs) {
    const btn = document.createElement("button");
    btn.className = "navBtn" + (activeTab === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.onclick = () => setTab(t.key);
    nav.appendChild(btn);
  }
}

function updateTitles() {
  const titleMap = {
    TODAY: "今日のピックアップ",
    ICT: "ICT教育",
    INFO1: "高校情報Ⅰ（授業実践）",
    EXAM: "共通テスト（情報Ⅰ）",
    AI_EDU: "生成AI（教育・校務）",
    AI_LATEST: "生成AI（最新事情・AIツール）",
    MEXT: "文科省（MEXT）",
    BOOKMARKS: "★ ブックマーク（永久）",
    X: "Xまとめ（手動クリップ）"
  };

  $("viewTitle").textContent = titleMap[activeTab] || "一覧";

  $("viewSub").textContent =
    activeTab === "BOOKMARKS"
      ? "ブックマークは7日を超えても残ります（端末内に保存）。"
      : activeTab === "X"
      ? "XのURLを手動でクリップして、後から見返すためのタブです。"
      : "授業に効く情報を上に、自動で並べます。";
}

/**
 * IMPORTANT FIX:
 * - Xタブは applyFilters() 側で毎回モーダルを開くと「閉じても復活」してしまうので、
 *   setTab("X") のタイミングでだけ開く。
 */
function setTab(tabKey) {
  // record last non-X tab for returning
  if (tabKey !== "X") {
    lastNonXTab = tabKey;
  }

  activeTab = tabKey;
  activeTag = null;

  $("searchInput").value = "";
  $("sortSelect").value = "score";

  $("daysSelect").disabled = tabKey === "BOOKMARKS" || tabKey === "X";
  $("daysSelect").value = "7";

  updateTitles();
  renderNav();
  renderTags();

  // X tab: open modal and stop (do NOT call applyFilters)
  if (tabKey === "X") {
    renderXModal(true);
    return;
  }

  applyFilters();
}

/* -------------------------
   Filtering / Rendering
------------------------- */
function withinDays(item, days) {
  const now = new Date();
  const d = new Date(item.publishedAt || item.collectedAt || now.toISOString());
  const diff = (now - d) / (1000 * 60 * 60 * 24);
  return diff <= days + 0.001;
}

function pickToday(items) {
  // pick top scored from each important tab (balances)
  const buckets = ["ICT", "INFO1", "AI_LATEST", "AI_EDU", "MEXT", "EXAM"];
  const picked = [];

  for (const b of buckets) {
    const part = items
      .filter((x) => x.tab === b)
      .filter((x) => withinDays(x, 7))
      .sort((a, b2) => (b2.score || 0) - (a.score || 0))
      .slice(0, 6);
    picked.push(...part);
  }

  // de-dupe by id and sort by score
  const map = new Map();
  for (const it of picked) {
    if (!map.has(it.id)) map.set(it.id, it);
  }

  return Array.from(map.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);
}

function applyFilters() {
  const q = $("searchInput").value.trim().toLowerCase();
  const days = parseInt($("daysSelect").value, 10);
  const sort = $("sortSelect").value;

  let items = [];

  // Xタブは setTab() でモーダルを開くのでここでは扱わない
  if (activeTab === "BOOKMARKS") {
    const bm = loadBookmarks();
    items = bm.order.map((id) => bm.map[id]).filter(Boolean);
  } else if (activeTab === "TODAY") {
    items = pickToday(allItems);
  } else {
    items = allItems.filter((x) => x.tab === activeTab);
    items = items.filter((x) => withinDays(x, days));
  }

  if (activeTag) {
    items = items.filter((x) => (x.tags || []).includes(activeTag));
  }

  if (q) {
    items = items.filter((x) => {
      const text = [x.title || "", x.source || "", (x.tags || []).join(" "), x.tab || ""]
        .join(" ")
        .toLowerCase();
      return text.includes(q);
    });
  }

  if (sort === "new") {
    items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  } else {
    items.sort(
      (a, b) =>
        (b.score || 0) - (a.score || 0) ||
        new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
    );
  }

  filtered = items;
  renderCards();
}

function renderTags() {
  const row = $("tagRow");
  row.innerHTML = "";
  if (activeTab === "BOOKMARKS" || activeTab === "X") return;

  // collect top tags for current tab in last 7 days
  let base = allItems;
  if (activeTab !== "TODAY") {
    base = allItems.filter((x) => x.tab === activeTab);
  }
  base = base.filter((x) => withinDays(x, 7));

  const counts = new Map();
  for (const it of base) {
    for (const t of it.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }

  const tags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([t]) => t);

  if (tags.length === 0) return;

  const mk = (label, onClick, active = false) => {
    const b = document.createElement("button");
    b.className = "tag" + (active ? " active" : "");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };

  row.appendChild(mk("すべて", () => {
    activeTag = null;
    applyFilters();
  }, !activeTag));

  for (const t of tags) {
    row.appendChild(
      mk("#" + t, () => {
        activeTag = activeTag === t ? null : t;
        renderTags();
        applyFilters();
      }, activeTag === t)
    );
  }
}

function renderCards() {
  const wrap = $("cards");
  wrap.innerHTML = "";
  $("emptyState").hidden = filtered.length !== 0;

  for (const it of filtered) {
    const card = document.createElement("div");
    card.className = "card";

    const top = document.createElement("div");
    top.className = "cardTop";

    const left = document.createElement("div");

    const h = document.createElement("h3");
    h.className = "title";
    h.textContent = it.title || "(no title)";
    left.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.source || "—"} ・ ${isoToDate(it.publishedAt) || "—"}`;
    left.appendChild(meta);

    const pills = document.createElement("div");
    pills.className = "pills";
    (it.tags || []).slice(0, 8).forEach((t) => {
      const p = document.createElement("span");
      p.className = "pill";
      p.textContent = t;
      pills.appendChild(p);
    });
    left.appendChild(pills);

    const actions = document.createElement("div");
    actions.className = "cardActions";

    const star = document.createElement("button");
    const on = isBookmarked(it.id);
    star.className = "star" + (on ? " on" : "");
    star.textContent = on ? "★" : "☆";
    star.title = "ブックマーク";
    star.onclick = () => {
      toggleBookmark(it);
      renderTags();
      applyFilters();
    };

    const a = document.createElement("a");
    a.className = "openLink";
    a.textContent = "Open";
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    actions.appendChild(star);
    actions.appendChild(a);

    top.appendChild(left);
    top.appendChild(actions);

    card.appendChild(top);
    wrap.appendChild(card);
  }
}

/* -------------------------
   X clips (manual)
------------------------- */
function loadX() {
  try {
    const raw = localStorage.getItem(LS_X);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveX(arr) {
  localStorage.setItem(LS_X, JSON.stringify(arr));
}

function renderXList() {
  const list = $("xList");
  list.innerHTML = "";
  const arr = loadX().sort((a, b) => (b.ts || 0) - (a.ts || 0));

  for (const item of arr) {
    const box = document.createElement("div");
    box.className = "xItem";

    const top = document.createElement("div");
    top.className = "xItemTop";

    const left = document.createElement("div");
    const url = document.createElement("div");
    url.className = "xUrl";
    url.textContent = item.url;
    left.appendChild(url);

    const memo = document.createElement("div");
    memo.className = "xMemo";
    memo.textContent = item.memo ? item.memo : "（メモなし）";
    left.appendChild(memo);

    const actions = document.createElement("div");
    actions.className = "xActions";

    const open = document.createElement("a");
    open.className = "xBtn";
    open.textContent = "Open";
    open.href = item.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";

    const del = document.createElement("button");
    del.className = "xBtn";
    del.textContent = "削除";
    del.onclick = () => {
      const next = loadX().filter((x) => x.ts !== item.ts);
      saveX(next);
      renderXList();
    };

    actions.appendChild(open);
    actions.appendChild(del);

    top.appendChild(left);
    top.appendChild(actions);

    box.appendChild(top);
    list.appendChild(box);
  }
}

function closeXAndReturn() {
  renderXModal(false);
  // return to previous tab safely
  if (lastNonXTab === "X") lastNonXTab = "TODAY";
  setTab(lastNonXTab || "TODAY");
}

function renderXModal(open) {
  const modal = $("xModal");
  if (open) {
    modal.hidden = false;
    renderXList();
  } else {
    modal.hidden = true;
  }
}

/* -------------------------
   Export / Import bookmarks
------------------------- */
function exportBookmarks() {
  const bm = loadBookmarks();
  const blob = new Blob([JSON.stringify(bm, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "info-teacher-radar_bookmarks.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importBookmarks(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || typeof obj !== "object") throw new Error("Invalid JSON");
      if (!obj.map || !obj.order) throw new Error("Invalid bookmark format");

      // merge
      const bm = loadBookmarks();
      for (const id of obj.order) {
        if (obj.map[id] && !bm.map[id]) {
          bm.map[id] = obj.map[id];
          bm.order.unshift(id);
        }
      }

      // de-dupe order and soft cap
      bm.order = Array.from(new Set(bm.order));
      if (bm.order.length > BOOKMARK_CAP) {
        const removed = bm.order.slice(BOOKMARK_CAP);
        removed.forEach((id) => delete bm.map[id]);
        bm.order = bm.order.slice(0, BOOKMARK_CAP);
      }

      saveBookmarks(bm);
      alert("ブックマークを読み込みました。");
      renderTags();
      applyFilters();
    } catch (e) {
      alert("読み込みに失敗しました: " + e.message);
    }
  };
  reader.readAsText(file);
}

/* -------------------------
   Data Load
------------------------- */
async function loadItems() {
  const res = await fetch("./data/items.json?_=" + Date.now());
  if (!res.ok) throw new Error("items.json load failed");

  const data = await res.json();
  allItems = (data.items || []).map((x) => ({ ...x, tags: x.tags || [] }));

  $("metaGenerated").textContent = data.generatedAt ? `更新: ${isoToDate(data.generatedAt)}` : "—";
}

/* -------------------------
   Bindings
------------------------- */
function bind() {
  // keyboard: / to focus search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("searchInput")) {
      e.preventDefault();
      $("searchInput").focus();
    }
    if (e.key === "Escape") {
      if (!$("xModal").hidden) {
        closeXAndReturn();
      }
    }
  });

  $("searchInput").addEventListener("input", applyFilters);
  $("daysSelect").addEventListener("change", applyFilters);
  $("sortSelect").addEventListener("change", applyFilters);

  $("btnRefresh").onclick = async () => {
    await boot(true);
  };

  $("btnToday").onclick = () => setTab("TODAY");
  $("btnBookmarks").onclick = () => setTab("BOOKMARKS");
  $("btnXTab").onclick = () => setTab("X");

  $("btnExport").onclick = exportBookmarks;
  $("importFile").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importBookmarks(f);
    e.target.value = "";
  });

  $("xClose").onclick = () => closeXAndReturn();

  $("xAddBtn").onclick = () => {
    const url = $("xUrl").value.trim();
    const memo = $("xMemo").value.trim();
    if (!url) return;

    const arr = loadX();
    arr.unshift({ url, memo, ts: Date.now() });
    saveX(arr.slice(0, 500)); // soft cap

    $("xUrl").value = "";
    $("xMemo").value = "";
    renderXList();
  };

  // click outside modal to close
  $("xModal").addEventListener("click", (e) => {
    if (e.target.id === "xModal") {
      closeXAndReturn();
    }
  });
}

/* -------------------------
   Boot
------------------------- */
async function boot(force = false) {
  try {
    await loadItems();
    renderNav();
    updateTitles();
    renderTags();
    applyFilters();
  } catch (e) {
    console.error(e);
    $("viewTitle").textContent = "読み込みエラー";
    $("viewSub").textContent =
      "data/items.json が取得できません。Actionsの実行やファイル配置を確認してください。";
    $("cards").innerHTML = "";
    $("emptyState").hidden = false;
  }
}

/* -------------------------
   Main
------------------------- */
(async function main() {
  bind();
  renderXModal(false); // ← 念のため最初は必ず閉じる
  setTab("TODAY");
  await boot();
})();

