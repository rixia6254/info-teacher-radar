/**
 * Info Teacher Radar - fetch script
 * - Collects: ict-enews RSS, ITmedia RSS, MEXT (HTML pages), Google News RSS queries (JP)
 * - Normalizes URLs, de-dupes, tags, scoring
 * - Writes: data/items.json (last 7 days items)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT_PATH = path.join(process.cwd(), "data", "items.json");

const JST_NOW = () => {
  // Use Asia/Tokyo time in ISO-like; we store as +09:00
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  // convert to "YYYY-MM-DDTHH:mm:ss+09:00"
  const iso = jst.toISOString().replace("Z", "+09:00");
  return iso;
};

const DAYS_KEEP = 7;
const UA =
  "Mozilla/5.0 (compatible; InfoTeacherRadar/2.0; +https://github.com/rixia6254/info-teacher-radar)";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} ${url}`);
  }
  return await res.text();
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function stripTracking(url) {
  try {
    const u = new URL(url);
    const params = u.searchParams;
    // common trackers
    const drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "yclid",
      "igshid",
    ];
    drop.forEach((k) => params.delete(k));
    // normalize
    u.search = params.toString() ? "?" + params.toString() : "";
    // remove trailing slash (except root)
    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/") {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return url;
  }
}

// ✅ 追加：Google News ラッパーURL（news.google.com）→ 実URLへ展開
async function unwrapGoogleNewsUrl(url) {
  try {
    if (!url) return url;
    if (!url.includes("news.google.com")) return url;

    const html = await fetchText(url);

    // canonical を優先
    const m = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
    );
    if (m && m[1]) return stripTracking(m[1]);

    // fallback：og:url
    const og = html.match(
      /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i
    );
    if (og && og[1]) return stripTracking(og[1]);

    return url;
  } catch {
    return url;
  }
}

// very light RSS parsing (good enough for many feeds)
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of itemBlocks) {
    const chunk = "<item " + block;
    const title = pickTag(chunk, "title");
    const link = pickTag(chunk, "link");
    const pubDate = pickTag(chunk, "pubDate");
    const guid = pickTag(chunk, "guid");
    const desc = pickTag(chunk, "description");
    items.push({
      title: decodeHtml(title || "").trim(),
      url: (link || guid || "").trim(),
      publishedRaw: pubDate || "",
      description: decodeHtml(desc || "").trim(),
    });
  }
  return items.filter((x) => x.title && x.url);
}

function pickTag(s, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = s.match(re);
  if (!m) return "";
  // handle CDATA
  return m[1].replace(/^<!\[CDATA\[(.*)\]\]>$/s, "$1").trim();
}

function decodeHtml(str) {
  return str
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function parsePubDate(pub) {
  // RSS pubDate to ISO; fallback to now
  try {
    const d = new Date(pub);
    if (Number.isNaN(d.getTime())) return null;
    // store in JST offset string (best effort)
    const iso = new Date(d.getTime() + 9 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+09:00");
    return iso;
  } catch {
    return null;
  }
}

function daysDiffFromNow(iso) {
  const now = new Date();
  const d = new Date(iso);
  return (now - d) / (1000 * 60 * 60 * 24);
}

/** Tag & tab mapping */
const TAB = {
  ICT: "ICT",
  INFO1: "INFO1",
  EXAM: "EXAM",
  AI_EDU: "AI_EDU",
  AI_LATEST: "AI_LATEST",
  MEXT: "MEXT",
};

function assignTabAndTags(title, url, source) {
  const t = (title + " " + url + " " + source).toLowerCase();

  // MEXT detection
  const isMext =
    url.includes("mext.go.jp") || source.toLowerCase().includes("文部科学省");
  if (isMext) {
    const tags = [];
    if (t.includes("通知") || t.includes("事務連絡")) tags.push("通知/事務連絡");
    if (t.includes("審議会")) tags.push("審議会");
    if (t.includes("会議") || t.includes("資料")) tags.push("会議資料");
    if (tags.length === 0) tags.push("文科省");
    return { tab: TAB.MEXT, tags };
  }

  // ✅ 追加：ITmedia（URL or source）を明示判定してタブ・タグを安定化
  const isItmedia =
    url.includes("itmedia.co.jp") || source.toLowerCase().includes("itmedia");
  if (isItmedia) {
    // ITmedia AI+
    if (url.includes("/aiplus/") || source.includes("AI+")) {
      const t2 = (title + " " + url + " " + source + " 生成ai chatgpt llm").toLowerCase();
      const eduSignals = [
        "授業",
        "教育",
        "学校",
        "校務",
        "ガイドライン",
        "研修",
        "著作権",
        "個人情報",
      ];
      const isEdu = eduSignals.some((k) => t2.includes(k));

      if (isEdu) {
        const tags = ["ITmedia", "AI+"];
        if (t2.includes("事例") || t2.includes("活用")) tags.push("活用事例");
        if (t2.includes("校務")) tags.push("校務");
        if (t2.includes("ガイドライン") || t2.includes("指針"))
          tags.push("ガイドライン");
        if (t2.includes("研修")) tags.push("研修");
        if (t2.includes("著作権")) tags.push("著作権");
        if (t2.includes("個人情報")) tags.push("個人情報");
        if (tags.length === 2) tags.push("生成AI(教育)");
        return { tab: TAB.AI_EDU, tags };
      } else {
        const tags = ["ITmedia", "AI+"];
        if (t2.includes("新機能") || t2.includes("アップデート"))
          tags.push("新機能");
        if (t2.includes("新モデル") || t2.includes("モデル") || t2.includes("llm"))
          tags.push("新モデル");
        if (t2.includes("ツール") || t2.includes("サービス") || t2.includes("アプリ"))
          tags.push("AIツール");
        if (tags.length === 2) tags.push("生成AI(最新)");
        return { tab: TAB.AI_LATEST, tags };
      }
    }

    // ITmedia Enterprise
    if (url.includes("/enterprise/") || source.includes("エンタープライズ")) {
      const tags = ["ITmedia", "エンタープライズ"];
      if (
        t.includes("セキュリティ") ||
        t.includes("脆弱性") ||
        t.includes("不正アクセス") ||
        t.includes("情報漏えい") ||
        t.includes("ランサム") ||
        t.includes("フィッシング")
      )
        tags.push("セキュリティ");
      if (t.includes("dx") || t.includes("業務") || t.includes("効率") || t.includes("ガバナンス"))
        tags.push("DX");
      if (t.includes("学校") || t.includes("教育") || t.includes("校務"))
        tags.push("校務DX");
      return { tab: TAB.ICT, tags: Array.from(new Set(tags)) };
    }

    // ITmedia NEWS
    if (url.includes("/news/") || source.includes("NEWS")) {
      const tags = ["ITmedia", "NEWS"];
      if (
        t.includes("sns") ||
        t.includes("誹謗中傷") ||
        t.includes("炎上") ||
        t.includes("プライバシー") ||
        t.includes("著作権") ||
        t.includes("個人情報")
      )
        tags.push("情報モラル");
      if (t.includes("法") || t.includes("規制") || t.includes("ガイドライン"))
        tags.push("法制度");
      return { tab: TAB.ICT, tags: Array.from(new Set(tags)) };
    }

    // その他ITmediaは一旦ICTへ
    return { tab: TAB.ICT, tags: ["ITmedia"] };
  }

  // Exam
  if (
    t.includes("共通テスト") ||
    t.includes("大学入学共通テスト") ||
    (t.includes("情報ⅰ") && t.includes("共通"))
  ) {
    return { tab: TAB.EXAM, tags: ["共通テスト"] };
  }

  // ICT education
  if (
    t.includes("ict") ||
    t.includes("giga") ||
    t.includes("校務dx") ||
    t.includes("教育ict") ||
    source.includes("ICT教育ニュース")
  ) {
    const tags = [];
    if (t.includes("giga") || t.includes("一人一台") || t.includes("端末"))
      tags.push("GIGA");
    if (t.includes("校務dx") || t.includes("校務") || t.includes("統合型校務"))
      tags.push("校務DX");
    if (
      t.includes("lms") ||
      t.includes("classroom") ||
      t.includes("teams") ||
      t.includes("moodle")
    )
      tags.push("LMS・学習基盤");
    if (t.includes("byod")) tags.push("端末・BYOD");
    if (t.includes("ネットワーク") || t.includes("wifi") || t.includes("回線"))
      tags.push("ネットワーク整備");
    if (t.includes("教育委員会") || t.includes("自治体"))
      tags.push("教育委員会・自治体");
    if (tags.length === 0) tags.push("ICT教育");
    return { tab: TAB.ICT, tags };
  }

  // Info I
  if (
    t.includes("情報i") ||
    t.includes("情報ⅰ") ||
    t.includes("情報 Ⅰ") ||
    t.includes("情報科") ||
    t.includes("高校 情報")
  ) {
    const tags = [];
    if (
      t.includes("プログラミング") ||
      t.includes("python") ||
      t.includes("scratch") ||
      t.includes("アルゴリズム")
    )
      tags.push("プログラミング");
    if (
      t.includes("データ活用") ||
      t.includes("統計") ||
      t.includes("分析") ||
      t.includes("可視化")
    )
      tags.push("データ活用");
    if (t.includes("情報デザイン") || t.includes("プレゼン") || t.includes("メディア"))
      tags.push("情報デザイン");
    if (t.includes("ネットワーク")) tags.push("ネットワーク");
    if (t.includes("セキュリティ")) tags.push("セキュリティ(授業)");
    if (t.includes("探究") || t.includes("pbl")) tags.push("探究・PBL");
    if (t.includes("評価") || t.includes("ルーブリック")) tags.push("評価");
    if (tags.length === 0) tags.push("情報Ⅰ");
    return { tab: TAB.INFO1, tags };
  }

  // AI education vs latest
  if (
    t.includes("生成ai") ||
    t.includes("chatgpt") ||
    t.includes("llm") ||
    t.includes("aiツール") ||
    t.includes("エージェント")
  ) {
    const tags = [];
    const eduSignals = [
      "授業",
      "教育",
      "学校",
      "校務",
      "ガイドライン",
      "研修",
      "著作権",
      "個人情報",
    ];
    const isEdu = eduSignals.some((k) => t.includes(k));
    if (isEdu) {
      if (t.includes("事例") || t.includes("活用")) tags.push("活用事例");
      if (t.includes("校務")) tags.push("校務");
      if (t.includes("ガイドライン") || t.includes("指針"))
        tags.push("ガイドライン");
      if (t.includes("研修")) tags.push("研修");
      if (t.includes("著作権")) tags.push("著作権");
      if (t.includes("個人情報")) tags.push("個人情報");
      if (tags.length === 0) tags.push("生成AI(教育)");
      return { tab: TAB.AI_EDU, tags };
    } else {
      if (t.includes("新機能") || t.includes("アップデート")) tags.push("新機能");
      if (t.includes("新モデル") || t.includes("llm") || t.includes("モデル"))
        tags.push("新モデル");
      if (t.includes("ツール") || t.includes("サービス") || t.includes("アプリ"))
        tags.push("AIツール");
      if (t.includes("仕事術") || t.includes("ワークフロー"))
        tags.push("ワークフロー");
      if (tags.length === 0) tags.push("生成AI(最新)");
      return { tab: TAB.AI_LATEST, tags };
    }
  }

  // fallback
  return { tab: TAB.ICT, tags: ["教育ニュース"] };
}

function computeScore(item) {
  let score = 0;
  // source boosts
  if (item.source.includes("ICT教育ニュース")) score += 20;
  if (item.url.includes("mext.go.jp")) score += 10;

  // ✅ 追加：ITmediaを少し上に（見つけやすくする）
  if (item.source.toLowerCase().includes("itmedia") || item.url.includes("itmedia.co.jp"))
    score += 6;

  // tab boosts (your priority)
  if (item.tab === TAB.ICT) score += 8;
  if (item.tab === TAB.INFO1) score += 6;
  if (item.tab === TAB.AI_LATEST) score += 4;
  if (item.tab === TAB.AI_EDU) score += 3;
  if (item.tab === TAB.MEXT) score += 2;
  if (item.tab === TAB.EXAM) score += 1;

  // teaching practice keywords
  const tt = (item.title || "").toLowerCase();
  const teachKeys = ["授業", "教材", "指導案", "実践", "ワークシート", "評価", "ルーブリック"];
  if (teachKeys.some((k) => tt.includes(k))) score += 5;

  // recency
  const dd = daysDiffFromNow(item.publishedAt);
  if (dd <= 1) score += 6;
  else if (dd <= 3) score += 4;
  else if (dd <= 7) score += 2;

  return score;
}

/** Sources */
const ICT_ENEWS_RSS = [
  // ict-enews RSS is advertised; URL may change, so keep this as a single place.
  // If it fails, you can update here without touching other logic.
  "https://ict-enews.net/?feed=rss2",
];

// ✅ 追加：ITmedia RSS（直取り）
const ITMEDIA_RSS = [
  { url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", source: "ITmedia AI+" },
  { url: "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml", source: "ITmedia エンタープライズ" },
  { url: "https://rss.itmedia.co.jp/rss/2.0/news.xml", source: "ITmedia NEWS" },
];

const GOOGLE_NEWS_QUERIES = [
  // ICT
  { q: "ICT教育 学校", tabHint: TAB.ICT },
  { q: "教育ICT 最新", tabHint: TAB.ICT },
  { q: "GIGAスクール 端末 更新", tabHint: TAB.ICT },
  { q: "校務DX 学校", tabHint: TAB.ICT },
  { q: "教育委員会 校務DX", tabHint: TAB.ICT },
  { q: "LMS 学校 導入", tabHint: TAB.ICT },

  // Info I (teaching)
  { q: "高校 情報I 授業 実践", tabHint: TAB.INFO1 },
  { q: "情報I 教材", tabHint: TAB.INFO1 },
  { q: "情報I プログラミング 授業", tabHint: TAB.INFO1 },
  { q: "情報I データ活用 授業", tabHint: TAB.INFO1 },
  { q: "情報I 情報デザイン 授業", tabHint: TAB.INFO1 },
  { q: "情報I 評価 ルーブリック", tabHint: TAB.INFO1 },

  // Exam (light)
  { q: "共通テスト 情報I", tabHint: TAB.EXAM },
  { q: "情報I 共通テスト 出題", tabHint: TAB.EXAM },
  { q: "情報I 共通テスト 問題 解説", tabHint: TAB.EXAM },

  // AI education
  { q: "教育 生成AI 活用", tabHint: TAB.AI_EDU },
  { q: "学校 生成AI ガイドライン", tabHint: TAB.AI_EDU },
  { q: "校務 生成AI", tabHint: TAB.AI_EDU },
  { q: "生成AI 教員 研修", tabHint: TAB.AI_EDU },
  { q: "著作権 生成AI 教育", tabHint: TAB.AI_EDU },
  { q: "個人情報 生成AI 学校", tabHint: TAB.AI_EDU },

  // AI latest (JP only)
  { q: "生成AI 新機能", tabHint: TAB.AI_LATEST },
  { q: "AIツール 新サービス", tabHint: TAB.AI_LATEST },
  { q: "LLM 新モデル", tabHint: TAB.AI_LATEST },
  { q: "生成AI 画像 音声 ツール", tabHint: TAB.AI_LATEST },
  { q: "AI エージェント ツール", tabHint: TAB.AI_LATEST },
  { q: "生成AI 仕事術", tabHint: TAB.AI_LATEST },
];

function googleNewsRssUrl(query) {
  const q = encodeURIComponent(query);
  // JP oriented RSS parameters
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

const MEXT_PAGES = [
  // New information (last month)
  "https://www.mext.go.jp/a_menu/whatsnew/index.htm",
  // High school informatics notices (important for teachers)
  "https://www.mext.go.jp/a_menu/shotou/zyouhou/1296907.htm",
  // Informatics special page
  "https://www.mext.go.jp/a_menu/shotou/zyouhou/index.htm",
];

function parseLinksFromHtml(html, baseUrl) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = decodeHtml(
      m[2]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!href) continue;
    if (href.startsWith("javascript:")) continue;
    // resolve relative
    let abs = "";
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    // basic filter for news-ish links
    if (text.length < 8) continue;
    // include pdf pages too
    links.push({ title: text, url: abs });
  }
  return links;
}

async function collect() {
  const items = [];

  // 1) ict-enews RSS
  for (const url of ICT_ENEWS_RSS) {
    try {
      const xml = await fetchText(url);
      const parsed = parseRssItems(xml);
      for (const p of parsed) {
        items.push({
          title: p.title,
          url: stripTracking(p.url),
          source: "ICT教育ニュース",
          publishedAt: parsePubDate(p.publishedRaw) || JST_NOW(),
        });
      }
    } catch (e) {
      console.warn("ict-enews RSS failed:", e.message);
    }
  }

  // 1.5) ✅ ITmedia RSS（直取り）
  for (const f of ITMEDIA_RSS) {
    try {
      const xml = await fetchText(f.url);
      const parsed = parseRssItems(xml);
      for (const p of parsed) {
        items.push({
          title: p.title,
          url: stripTracking(p.url),
          source: f.source,
          publishedAt: parsePubDate(p.publishedRaw) || JST_NOW(),
        });
      }
    } catch (e) {
      console.warn("ITmedia RSS failed:", f.url, e.message);
    }
  }

  // 2) Google News RSS queries
  for (const q of GOOGLE_NEWS_QUERIES) {
    const rss = googleNewsRssUrl(q.q);
    try {
      const xml = await fetchText(rss);
      const parsed = parseRssItems(xml);
      for (const p of parsed) {
        const rawUrl = stripTracking(p.url);

// news.google.com のときだけ、さらに「ITmediaっぽい」なら unwrap
let realUrl = rawUrl;
if (rawUrl.includes("news.google.com")) {
  const hint = (p.title || "").toLowerCase();
  const itmediaHint =
    hint.includes("itmedia") ||
    hint.includes("アイティメディア") ||
    hint.includes("itメディア");

  if (itmediaHint) {
    realUrl = await unwrapGoogleNewsUrl(rawUrl);
  }

        items.push({
          title: p.title,
          url: stripTracking(realUrl),
          source: `Google News: ${q.q}`,
          publishedAt: parsePubDate(p.publishedRaw) || JST_NOW(),
        });
      }
    } catch (e) {
      console.warn("Google News RSS failed:", q.q, e.message);
    }
  }

  // 3) MEXT HTML pages (link harvest)
 for (const p of parsed) {
  const rawUrl = stripTracking(p.url);

  // ✅ wrapper 展開は「ITmediaっぽい時だけ」
  let realUrl = rawUrl;
  if (rawUrl.includes("news.google.com")) {
    const hint = (p.title || "").toLowerCase();
    const itmediaHint =
      hint.includes("itmedia") ||
      hint.includes("アイティメディア") ||
      hint.includes("itメディア");

    if (itmediaHint) {
      realUrl = await unwrapGoogleNewsUrl(rawUrl);
    }
  }

  // ✅ items.push は必ず “if の外” に置く
  items.push({
    title: p.title,
    url: stripTracking(realUrl),
    source: `Google News: ${q.q}`,
    publishedAt: parsePubDate(p.publishedRaw) || JST_NOW(),
  });
}

  return items;
}

function dedupeAndEnrich(rawItems) {
  const map = new Map();

  for (const r of rawItems) {
    const url = stripTracking(r.url);
    const title = (r.title || "").trim();
    if (!url || !title) continue;

    const id = "sha1:" + sha1(url);
    const base = map.get(id);

    const { tab, tags } = assignTabAndTags(title, url, r.source || "");
    const item = {
      id,
      title,
      url,
      source: r.source || "—",
      publishedAt: r.publishedAt || JST_NOW(),
      tab,
      tags,
    };
    item.score = computeScore(item);

    if (!base) {
      map.set(id, item);
    } else {
      // merge: keep best title length and max score
      const betterTitle = item.title.length > base.title.length ? item.title : base.title;
      const betterPub =
        new Date(item.publishedAt) < new Date(base.publishedAt) ? base.publishedAt : item.publishedAt;
      const mergedTags = Array.from(new Set([...(base.tags || []), ...(item.tags || [])]));
      map.set(id, {
        ...base,
        title: betterTitle,
        publishedAt: betterPub,
        tags: mergedTags,
        score: Math.max(base.score || 0, item.score || 0),
      });
    }
  }

  let items = Array.from(map.values());

  // keep last 7 days (publishedAt based; MEXT uses "now" so it will stay—acceptable)
  items = items.filter((x) => daysDiffFromNow(x.publishedAt) <= DAYS_KEEP + 0.001);

  // sort by score desc then time desc
  items.sort(
    (a, b) => (b.score || 0) - (a.score || 0) || new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  // cap overall list to keep site fast
  items = items.slice(0, 800);

  return items;
}

async function main() {
  // ensure dirs
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const raw = await collect();
  const items = dedupeAndEnrich(raw);

  const out = {
    generatedAt: JST_NOW(),
    items,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${items.length} items -> ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
