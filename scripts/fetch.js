/**
 * Info Teacher Radar - fetch script (stable edition)
 * - Collects: ICT-ENews RSS, ITmedia RSS, MEXT (HTML pages), Google News RSS queries (JP)
 * - Normalizes URLs, de-dupes, tags, scoring
 * - Writes: data/items.json (last 7 days items)
 *
 * Design goals:
 * - Avoid "Unexpected token catch" by keeping blocks simple and bracket-safe
 * - Avoid hanging: fetch timeout via AbortController
 * - Ensure ITmedia items are always collected via direct RSS (no Google News unwrap required)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT_PATH = path.join(process.cwd(), "data", "items.json");

const DAYS_KEEP = 7;
const UA =
  "Mozilla/5.0 (compatible; InfoTeacherRadar/2.1; +https://github.com/rixia6254/info-teacher-radar)";
const FETCH_TIMEOUT_MS = 12000; // 12s timeout to avoid hanging

const JST_NOW = () => {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("Z", "+09:00");
};

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function stripTracking(url) {
  try {
    const u = new URL(url);
    const params = u.searchParams;
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
    u.search = params.toString() ? "?" + params.toString() : "";
    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
    return out;
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
  try {
    const d = new Date(pub);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 9 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+09:00");
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

  // ✅ ITmedia explicit handling (stable)
  const isItmedia =
    url.includes("itmedia.co.jp") || source.toLowerCase().includes("itmedia");
  if (isItmedia) {
    // AI+
    if (url.includes("/aiplus/") || source.includes("AI+")) {
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
        const tags = ["ITmedia", "AI+", "生成AI(教育)"];
        if (t.includes("事例") || t.includes("活用")) tags.push("活用事例");
        if (t.includes("校務")) tags.push("校務");
        if (t.includes("ガイドライン") || t.includes("指針"))
          tags.push("ガイドライン");
        if (t.includes("著作権")) tags.push("著作権");
        if (t.includes("個人情報")) tags.push("個人情報");
        return { tab: TAB.AI_EDU, tags: Array.from(new Set(tags)) };
      } else {
        const tags = ["ITmedia", "AI+", "生成AI(最新)"];
        if (t.includes("新機能") || t.includes("アップデート")) tags.push("新機能");
        if (t.includes("新モデル") || t.includes("モデル") || t.includes("llm"))
          tags.push("新モデル");
        if (t.includes("ツール") || t.includes("サービス") || t.includes("アプリ"))
          tags.push("AIツール");
        return { tab: TAB.AI_LATEST, tags: Array.from(new Set(tags)) };
      }
    }

    // Enterprise
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
      if (t.includes("dx") || t.includes("業務") || t.includes("効率"))
        tags.push("DX");
      if (t.includes("学校") || t.includes("教育") || t.includes("校務"))
        tags.push("校務DX");
      return { tab: TAB.ICT, tags: Array.from(new Set(tags)) };
    }

    // News
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

  // AI education vs latest (general)
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
      if (t.includes("仕事術") || t.includes("ワークフロー")) tags.push("ワークフロー");
      if (tags.length === 0) tags.push("生成AI(最新)");
      return { tab: TAB.AI_LATEST, tags };
    }
  }

  // fallback
  return { tab: TAB.ICT, tags: ["教育ニュース"] };
}

function computeScore(item) {
  let score = 0;

  if (item.source.includes("ICT教育ニュース")) score += 20;
  if (item.url.includes("mext.go.jp")) score += 10;

  // small boost for ITmedia visibility
  if (item.url.includes("itmedia.co.jp") || item.source.toLowerCase().includes("itmedia"))
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
const ICT_ENEWS_RSS = ["https://ict-enews.net/?feed=rss2"];

// ✅ ITmedia RSS direct feeds
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

  // AI latest (JP)
  { q: "生成AI 新機能", tabHint: TAB.AI_LATEST },
  { q: "AIツール 新サービス", tabHint: TAB.AI_LATEST },
  { q: "LLM 新モデル", tabHint: TAB.AI_LATEST },
  { q: "生成AI 画像 音声 ツール", tabHint: TAB.AI_LATEST },
  { q: "AI エージェント ツール", tabHint: TAB.AI_LATEST },
  { q: "生成AI 仕事術", tabHint: TAB.AI_LATEST },
];

function googleNewsRssUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

const MEXT_PAGES = [
  "https://www.mext.go.jp/a_menu/whatsnew/index.htm",
  "https://www.mext.go.jp/a_menu/shotou/zyouhou/1296907.htm",
  "https://www.mext.go.jp/a_menu/shotou/zyouhou/index.htm",
];

function parseLinksFromHtml(html, baseUrl) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = decodeHtml(
      m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    if (!href) continue;
    if (href.startsWith("javascript:")) continue;

    let abs = "";
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (text.length < 8) continue;
    links.push({ title: text, url: abs });
  }
  return links;
}

// Helper: safe RSS fetch (prevents one bad source from crashing everything)
async function collectFromRssFeed(feedUrl, sourceName) {
  try {
    const xml = await fetchText(feedUrl);
    const parsed = parseRssItems(xml);
    return parsed.map((p) => ({
      title: p.title,
      url: stripTracking(p.url),
      source: sourceName,
      publishedAt: parsePubDate(p.publishedRaw) || JST_NOW(),
    }));
  } catch (e) {
    console.warn("RSS failed:", sourceName, feedUrl, e.message);
    return [];
  }
}

async function collect() {
  const items = [];

  // 1) ICT-ENews
  for (const url of ICT_ENEWS_RSS) {
    const got = await collectFromRssFeed(url, "ICT教育ニュース");
    items.push(...got);
  }

  // 2) ITmedia direct feeds
  for (const f of ITMEDIA_RSS) {
    const got = await collectFromRssFeed(f.url, f.source);
    items.push(...got);
  }

  // 3) Google News RSS queries (no unwrap to keep stable/fast)
  for (const q of GOOGLE_NEWS_QUERIES) {
    const rss = googleNewsRssUrl(q.q);
    const got = await collectFromRssFeed(rss, `Google News: ${q.q}`);
    items.push(...got);
  }

  // 4) MEXT HTML pages
  for (const page of MEXT_PAGES) {
    try {
      const html = await fetchText(page);
      const links = parseLinksFromHtml(html, page).slice(0, 60);
      for (const l of links) {
        items.push({
          title: l.title,
          url: stripTracking(l.url),
          source: "文部科学省",
          publishedAt: JST_NOW(),
        });
      }
    } catch (e) {
      console.warn("MEXT page failed:", page, e.message);
    }
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

  // keep last 7 days
  items = items.filter((x) => daysDiffFromNow(x.publishedAt) <= DAYS_KEEP + 0.001);

  // sort by score desc then time desc
  items.sort(
    (a, b) => (b.score || 0) - (a.score || 0) || new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  // cap overall list
  items = items.slice(0, 800);

  return items;
}

async function main() {
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
