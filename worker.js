/**
 * 追剧神器 · Cloudflare Worker 后端
 * 复刻 server.py 的全部接口，部署后给 GitHub Pages 静态前端当后端用。
 *
 * 部署步骤见 worker.md（或 README）。前端 app.js 里把 REMOTE_API 填成
 * 本 Worker 的地址（如 "https://wzy-api.你的名字.workers.dev"）即可。
 *
 * 接口（均带 CORS 头，允许任意来源跨域调用）：
 *   GET /api/ping                 存活探测
 *   GET /api/search?wd=剧名       四渠道聚合搜索
 *   GET /api/detail?id=&src=      详情与集数列表
 *   GET /api/parse?url=share页    解析 m3u8 直链
 *   GET /api/poster?wd=剧名       按剧名取海报
 *   GET /api/img?url=             海报代理（绕防盗链）
 */

const VOD_SOURCES = {
  lzm3u8: { name: "量子资源", api: "https://cj.lziapi.com/api.php/provide/vod/" },
  ffzy: { name: "非凡资源", api: "https://api.ffzyapi.com/api.php/provide/vod/" },
  bfzy: { name: "暴风资源", api: "https://bfzyapi.com/api.php/provide/vod/" },
  zy360: { name: "360资源", api: "https://360zy.com/api.php/provide/vod/" },
};
const SRC_ORDER = Object.keys(VOD_SOURCES);
const DEFAULT_SRC = "lzm3u8";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SEARCH_DEADLINE_MS = 8000;

// 海报缓存（Worker 实例内存级，重启即失效，仅用于减少回源）
const POSTER_CACHE = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function ok(data) {
  return json({ ok: true, data });
}

function fail(msg, status = 502) {
  return json({ ok: false, msg }, status);
}

async function fetchText(url, timeoutMs = 10000) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Referer": url },
    signal: AbortSignal.timeout(timeoutMs),
    cf: { cacheTtl: 300 },
  });
  if (!resp.ok) throw new Error(`上游返回 ${resp.status}`);
  return resp.text();
}

async function fetchUpstreamJson(url, timeoutMs = 10000) {
  const text = await fetchText(url, timeoutMs);
  const start = text.indexOf("{");
  if (start === -1) throw new Error("接口返回内容不是 JSON");
  return JSON.parse(text.slice(start));
}

function summary(v, srcKey) {
  return {
    id: v.vod_id,
    name: v.vod_name,
    sub: v.vod_sub || "",
    class: v.vod_class || "",
    year: String(v.vod_year || ""),
    area: v.vod_area || "",
    remarks: v.vod_remarks || "",
    score: v.vod_score || "",
    pic: v.vod_pic || "",
    blurb: String(v.vod_blurb || "").replace(/\s+/g, " "),
    src: srcKey,
    srcName: VOD_SOURCES[srcKey].name,
  };
}

async function searchOne(srcKey, wd) {
  const qs = new URLSearchParams({ wd, pg: "1" });
  const data = await fetchUpstreamJson(VOD_SOURCES[srcKey].api + "?" + qs);
  return (data.list || []).slice(0, 16).map((v) => summary(v, srcKey));
}

// 聚合搜索：全渠道并行，限时返回已完成的部分
async function aggregateSearch(wd, srcKeys) {
  const tasks = srcKeys.map(async (key) => {
    try {
      return { key, items: await searchOne(key, wd), error: null };
    } catch (err) {
      return { key, items: [], error: String(err && err.message || err) };
    }
  });
  const settled = await Promise.all(tasks.map((p) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r(null), SEARCH_DEADLINE_MS))])
  ));
  const merged = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (!r) { failed.push(srcKeys[i]); return; }
    if (r.error) { failed.push(r.key); return; }
    merged.push(...r.items);
  });
  // 同名去重：有海报的优先，其次按渠道顺序
  merged.sort((a, b) =>
    (a.pic ? 0 : 1) - (b.pic ? 0 : 1) || SRC_ORDER.indexOf(a.src) - SRC_ORDER.indexOf(b.src)
  );
  const seen = new Set();
  const items = [];
  for (const it of merged) {
    if (!it.name || seen.has(it.name)) continue;
    seen.add(it.name);
    items.push(it);
  }
  return { items, failed: failed.map((k) => VOD_SOURCES[k].name) };
}

function detailResponse(data, srcKey) {
  const list = data.list || [];
  if (!list.length) return fail("没有找到该影视的详情", 404);
  const v = list[0];
  const names = (v.vod_play_from || "").split("$$$");
  const sources = (v.vod_play_url || "").split("$$$").map((group, i) => {
    const episodes = group.split("#").filter((ep) => ep.includes("$")).map((ep) => {
      const idx = ep.indexOf("$");
      return { name: ep.slice(0, idx).trim(), url: ep.slice(idx + 1).trim() };
    });
    return { from: names[i] || `源${i + 1}`, episodes };
  }).filter((s) => s.episodes.length);
  return ok({
    id: v.vod_id,
    name: v.vod_name,
    src: srcKey,
    srcName: VOD_SOURCES[srcKey].name,
    sub: v.vod_sub || "",
    class: v.vod_class || "",
    year: String(v.vod_year || ""),
    area: v.vod_area || "",
    remarks: v.vod_remarks || "",
    score: v.vod_score || "",
    director: v.vod_director || "",
    actor: v.vod_actor || "",
    pic: v.vod_pic || "",
    content: String(v.vod_content || v.vod_blurb || "").replace(/<[^>]+>/g, "").trim(),
    sources,
  });
}

async function handlePoster(wd) {
  if (POSTER_CACHE.has(wd)) return ok({ pic: POSTER_CACHE.get(wd) });
  const { items } = await aggregateSearch(wd, SRC_ORDER);
  const exact = items.find((it) => it.name === wd && it.pic);
  const contains = items.find((it) => it.pic && (it.name || "").includes(wd));
  const anypic = items.find((it) => it.pic);
  const pic = (exact || contains || anypic)?.pic || null;
  if (pic) POSTER_CACHE.set(wd, pic);
  return ok({ pic });
}

async function handleImg(imgUrl) {
  if (!/^https?:\/\//.test(imgUrl)) return new Response("bad url", { status: 400 });
  try {
    const resp = await fetch(imgUrl, {
      headers: { "User-Agent": UA, "Referer": imgUrl },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return new Response(null, { status: 404 });
    return new Response(resp.body, {
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
        ...CORS_HEADERS,
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    let resp;
    try {
      if (url.pathname === "/api/ping") {
        resp = ok({ pong: true });
      } else if (url.pathname === "/api/search") {
        const wd = (url.searchParams.get("wd") || "").trim();
        if (!wd) {
          resp = fail("缺少搜索关键词", 400);
        } else {
          const srcKeys = (url.searchParams.get("srcs") || SRC_ORDER.join(","))
            .split(",").filter((k) => k in VOD_SOURCES);
          const { items, failed } = await aggregateSearch(wd, srcKeys.length ? srcKeys : SRC_ORDER);
          const body = JSON.stringify({ ok: true, data: items, failed });
          resp = new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS } });
        }
      } else if (url.pathname === "/api/detail") {
        const vid = (url.searchParams.get("id") || "").trim();
        let srcKey = (url.searchParams.get("src") || DEFAULT_SRC).trim();
        if (!(srcKey in VOD_SOURCES)) srcKey = DEFAULT_SRC;
        if (!vid) {
          resp = fail("缺少影视ID", 400);
        } else {
          const qs = new URLSearchParams({ ac: "detail", ids: vid });
          const data = await fetchUpstreamJson(VOD_SOURCES[srcKey].api + "?" + qs, 15000);
          resp = detailResponse(data, srcKey);
        }
      } else if (url.pathname === "/api/parse") {
        const pageUrl = (url.searchParams.get("url") || "").trim();
        if (!/^https?:\/\//.test(pageUrl)) {
          resp = fail("链接不合法", 400);
        } else {
          const html = await fetchText(pageUrl, 15000);
          const m = html.match(/var\s+main\s*=\s*['"]([^'"]+)['"]/);
          if (!m) {
            resp = fail("未能从页面解析出播放地址", 404);
          } else {
            resp = ok({ m3u8: new URL(m[1], pageUrl).href });
          }
        }
      } else if (url.pathname === "/api/poster") {
        const wd = (url.searchParams.get("wd") || "").trim();
        resp = wd ? await handlePoster(wd) : fail("缺少剧名", 400);
      } else if (url.pathname === "/api/img") {
        resp = await handleImg((url.searchParams.get("url") || "").trim());
      } else {
        resp = new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      resp = fail(`服务器处理失败：${err && err.message || err}`);
    }

    // 统一补 CORS 头（防止个别分支遗漏）
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  },
};
