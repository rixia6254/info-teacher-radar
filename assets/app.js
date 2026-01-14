/* Info Teacher Radar - front-end (static) */
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

const LS_KEY = "itr.bookmarks.v1";     // stores { map: {id: itemMeta}, order: [id...] }
const LS_X = "itr.xclips.v1";          // stores [{url,memo,ts}]

let allItems = [];
let filtered = [];
let activeTab = "TODAY";
let activeTag = null;

const $ = (id) => document.getElementById(id);

function isoToDate(iso){
  try{
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ja-JP", { year:"numeric", month:"2-digit", day:"2-digit" });
  }catch{ return ""; }
}

function loadBookmarks(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return { map:{}, order:[] };
    const obj = JSON.parse(raw);
    if(!obj.map) obj.map = {};
    if(!obj.order) obj.order = [];
    return obj;
  }catch{
    return { map:{}, order:[] };
  }
}
function saveBookmarks(bm){
  localStorage.setItem(LS_KEY, JSON.stringify(bm));
}

function isBookmarked(id){
  const bm = loadBookmarks();
  return !!bm.map[id];
}

function toggleBookmark(item){
  const bm = loadBookmarks();
  if (bm.map[item.id]){
    delete bm.map[item.id];
    bm.order = bm.order.filter(x => x !== item.id);
  }else{
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
    // Soft cap (keep at least 100, default 500 for safety)
    const CAP = 500;
    if (bm.order.length > CAP){
      const removed = bm.order.slice(CAP);
      removed.forEach(id => delete bm.map[id]);
      bm.order = bm.order.slice(0, CAP);
    }
  }
  saveBookmarks(bm);
}

function renderNav(){
  const nav = $("navTabs");
  nav.innerHTML = "";
  // skip TODAY/BOOKMARKS/X in main nav (we have quick buttons)
  const mainTabs = TABS.filter(t => !["TODAY","BOOKMARKS","X"].includes(t.key) && t.key !== "TODAY");
  for(const t of mainTabs){
    const btn = document.createElement("button");
    btn.className = "navBtn" + (activeTab === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.onclick = () => setTab(t.key);
    nav.appendChild(btn);
  }
}

function setTab(tabKey){
  activeTab = tabKey;
  activeTag = null;
  $("searchInput").value = "";
  $("sortSelect").value = "score";
  $("daysSelect").disabled = (tabKey === "BOOKMARKS" || tabKey === "X");
  $("daysSelect").value = "7";
  updateTitles();
  renderNav();
  renderTags();
  applyFilters();
}

function updateTitles(){
  const titleMap = {
    "TODAY":"今日のピックアップ",
    "ICT":"ICT教育",
    "INFO1":"高校情報Ⅰ（授業実践）",
    "EXAM":"共通テスト（情報Ⅰ）",
    "AI_EDU":"生成AI（教育・校務）",
    "AI_LATEST":"生成AI（最新事情・AIツール）",
    "MEXT":"文科省（MEXT）",
    "BOOKMARKS":"★ ブックマーク（永久）",
    "X":"Xまとめ（手動クリップ）"
  };
  $("viewTitle").textContent = titleMap[activeTab] || "一覧";
  $("viewSub").textContent =
    activeTab === "BOOKMARKS" ? "ブックマークは7日を超えても残ります（端末内に保存）。" :
    activeTab === "X" ? "XのURLを手動でクリップして、後から見返すためのタブです。" :
    "授業に効く情報を上に、自動で並べます。";
}

function withinDays(item, days){
  const now = new Date();
  const d = new Date(item.publishedAt || item.collectedAt || now.toISOString());
  const diff = (now - d) / (1000*60*60*24);
  return diff <= days + 0.001;
}

function pickToday(items){
  // pick top scored from each important tab (balances)
  const buckets = ["ICT","INFO1","AI_LATEST","AI_EDU","MEXT","EXAM"];
  const picked = [];
  for(const b of buckets){
    const part = items
      .filter(x => x.tab === b)
      .filter(x => withinDays(x, 7))
      .sort((a,b)=> (b.score||0) - (a.score||0))
      .slice(0, 6);
    picked.push(...part);
  }
  // de-dupe by id and sort by score
  const map = new Map();
  for(const it of picked){
    if(!map.has(it.id)) map.set(it.id, it);
  }
  return Array.from(map.values()).sort((a,b)=> (b.score||0) - (a.score||0)).slice(0, 20);
}

function applyFilters(){
  const q = $("searchInput").value.trim().toLowerCase();
  const days = parseInt($("daysSelect").value, 10);
  const sort = $("sortSelect").value;

  let items = [];

  if (activeTab === "X"){
    renderXModal(true); // open
    return;
  }

  if (activeTab === "BOOKMARKS"){
    const bm = loadBookmarks();
    items = bm.order
      .map(id => bm.map[id])
      .filter(Boolean);
  } else if (activeTab === "TODAY"){
    items = pickToday(allItems);
  } else {
    items = allItems.filter(x => x.tab === activeTab);
    items = items.filter(x => withinDays(x, days));
  }

  if (activeTag){
    items = items.filter(x => (x.tags||[]).includes(activeTag));
  }

  if (q){
    items = items.filter(x => {
      const text = [
        x.title || "",
        x.source || "",
        (x.tags||[]).join(" "),
        x.tab || ""
      ].join(" ").toLowerCase();
      return text.includes(q);
    });
  }

  if (sort === "new"){
    items.sort((a,b)=> new Date(b.publishedAt||0) - new Date(a.publishedAt||0));
  } else {
    items.sort((a,b)=> (b.score||0) - (a.score||0) || (new Date(b.publishedAt||0) - new Date(a.publishedAt||0)));
  }

  filtered = items;
  renderCards();
}

function renderTags(){
  const row = $("tagRow");
  row.innerHTML = "";
  if (activeTab === "BOOKMARKS" || activeTab === "X") return;

  // collect top tags for current tab in last 7 days
  let base = allItems;
  if (activeTab !== "TODAY"){
    base = allItems.filter(x => x.tab === activeTab);
  }
  base = base.filter(x => withinDays(x, 7));
  const counts = new Map();
  for(const it of base){
    for(const t of (it.tags||[])){
      counts.set(t, (counts.get(t)||0) + 1);
    }
  }
  const tags = Array.from(counts.entries())
    .sort((a,b)=> b[1]-a[1])
    .slice(0, 16)
    .map(([t])=>t);

  if (tags.length === 0) return;

  const mk = (label, onClick, active=false) => {
    const b = document.createElement("button");
    b.className = "tag" + (active ? " active" : "");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };

  row.appendChild(mk("すべて", ()=>{activeTag=null; applyFilters();}, !activeTag));
  for(const t of tags){
    row.appendChild(mk("#"+t, ()=>{
      activeTag = (activeTag === t ? null : t);
      // toggle active state by re-render
      renderTags();
      applyFilters();
    }, activeTag === t));
  }
}

function renderCards(){
  const wrap = $("cards");
  wrap.innerHTML = "";
  $("emptyState").hidden = filtered.length !== 0;

  for(const it of filtered){
    const card = document.createElement
