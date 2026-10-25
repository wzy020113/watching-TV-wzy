/* 追剧神器 · Vue 3 应用逻辑（支持本地后端和 GitHub Pages 静态模式） */
const { createApp, ref, computed, nextTick, watch, onMounted } = Vue;

const HOT_QUERIES = ["庆余年", "繁花", "漫长的季节", "黑暗荣耀", "请回答1988", "我的阿勒泰"];
const CHANNELS = { lzm3u8: "量子资源", ffzy: "非凡资源", bfzy: "暴风资源", zy360: "360资源" };

/* ---------- 运行模式：本地后端 / 静态直连（GitHub Pages） ---------- */
const MODE = ref("detecting"); // backend | static
const VOD_API = "https://cj.lziapi.com/api.php/provide/vod/";

/* 远程后端地址：部署 Cloudflare Worker（worker.js）后，填 Worker 地址，如
   "https://wzy-api.你的用户名.workers.dev"；留空则维持本地/静态检测逻辑 */
const REMOTE_API = ""; // 部署后填这里
const API_BASE = REMOTE_API ? REMOTE_API.replace(/\/+$/, "") : "";

async function detectMode() {
  // 优先探测远程后端，其次同源本地后端，都不可用则为静态直连
  const pingUrl = API_BASE ? `${API_BASE}/api/ping` : "/api/ping";
  try {
    const r = await fetch(pingUrl, { cache: "no-store" });
    const j = await r.json();
    MODE.value = j?.ok ? "backend" : "static";
  } catch {
    MODE.value = "static";
  }
}

/*
 * GitHub Pages 没有服务器端代理。浏览器能直连且允许 CORS 的源直接请求；
 * 直连被拦截时再使用公共只读代理。代理只是网络兜底，不改变返回数据格式。
 */
const CORS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

async function fetchText(url) {
  let lastErr;
  for (const target of [url, ...CORS_PROXIES.map((wrap) => wrap(url))]) {
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(target, { cache: "no-store", signal: controller.signal });
      if (!resp.ok) throw new Error(`接口请求失败 (${resp.status})`);
      return await resp.text();
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error(
    "浏览器无法连接影视数据源（直连与公共代理均失败）。请检查网络，或稍后重试。"
  );
}

async function fetchJSON(url) {
  const text = await fetchText(url);
  const start = text.indexOf("{");
  if (start === -1) throw new Error("接口返回内容不是 JSON");
  return JSON.parse(text.slice(start));
}

function parseSources(v, src) {
  const names = String(v.vod_play_from || "").split("$$$");
  return String(v.vod_play_url || "").split("$$$").map((group, i) => ({
    from: names[i] || `源${i + 1}`,
    srcName: src.name,
    episodes: group.split("#").filter((ep) => ep.includes("$")).map((ep) => {
      const idx = ep.indexOf("$");
      return { name: ep.slice(0, idx).trim(), url: ep.slice(idx + 1).trim() };
    }),
  })).filter((s) => s.episodes.length);
}

function normItem(v, src) {
  return {
    id: v.vod_id, name: v.vod_name, sub: v.vod_sub || "", class: v.vod_class || "",
    year: String(v.vod_year || ""), area: v.vod_area || "", remarks: v.vod_remarks || "",
    score: v.vod_score || "", pic: v.vod_pic || "",
    blurb: String(v.vod_blurb || "").replace(/\s+/g, " "),
    director: v.vod_director || "", actor: v.vod_actor || "",
    content: String(v.vod_content || v.vod_blurb || "").replace(/<[^>]+>/g, "").trim(),
    sources: parseSources(v, src),
    src: src.key, srcName: src.name,
  };
}

/* 静态模式也使用四个渠道。每个请求先直连，失败后自动走 CORS 代理。 */
const STATIC_SOURCES = [
  { key: "lzm3u8", name: "量子资源", api: "https://cj.lziapi.com/api.php/provide/vod/" },
  { key: "ffzy", name: "非凡资源", api: "https://api.ffzyapi.com/api.php/provide/vod/" },
  { key: "bfzy", name: "暴风资源", api: "https://bfzyapi.com/api.php/provide/vod/" },
  { key: "zy360", name: "360资源", api: "https://360zy.com/api.php/provide/vod/" },
];
const STATIC_SOURCE_MAP = Object.fromEntries(STATIC_SOURCES.map((s) => [s.key, s]));

async function staticJSON(params, srcKey) {
  const src = STATIC_SOURCE_MAP[srcKey];
  if (!src) throw new Error("未知影视数据源");
  return fetchJSON(src.api + "?" + new URLSearchParams(params));
}

function staticSummaryList(data, src) {
  return (data.list || []).slice(0, 16).map((v) => normItem(v, src));
}

function dedupeItems(items) {
  items.sort((a, b) => (a.pic ? 0 : 1) - (b.pic ? 0 : 1) ||
    STATIC_SOURCES.findIndex((s) => s.key === a.src) - STATIC_SOURCES.findIndex((s) => s.key === b.src));
  const seen = new Set();
  return items.filter((it) => it.name && !seen.has(it.name) && seen.add(it.name));
}

function settleWithDeadline(promises, ms = 9000) {
  return Promise.all(promises.map((promise) => Promise.race([
    promise.then((value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })),
    new Promise((resolve) => setTimeout(() => resolve({ status: "rejected" }), ms)),
  ])));
}

/* 静态模式适配器：把 server.py 的搜索、详情、海报、解析逻辑放到浏览器端。 */
const staticAPI = {
  async search(params) {
    const requested = params.srcs
      ? params.srcs.split(",").map((key) => STATIC_SOURCE_MAP[key]).filter(Boolean)
      : [];
    const wanted = requested.length ? requested : STATIC_SOURCES;
    const jobs = wanted.map(async (src) => {
      const data = await staticJSON({ wd: params.wd, pg: 1 }, src.key);
      return staticSummaryList(data, src);
    });
    const settled = await settleWithDeadline(jobs);
    const items = settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
    if (!items.length) throw new Error("所有数据源均无法连接，请检查网络后重试");
    return dedupeItems(items);
  },
  async detail(params) {
    const src = STATIC_SOURCE_MAP[params.src] || STATIC_SOURCES[0];
    const data = await staticJSON({ ac: "detail", ids: params.id }, src.key);
    const v = (data.list || [])[0];
    if (!v) throw new Error("没有找到该影视的详情");
    return {
      ...normItem(v, src),
    };
  },
  async poster(params) {
    const settled = await settleWithDeadline(STATIC_SOURCES.map(async (src) => {
      const data = await staticJSON({ wd: params.wd, pg: 1 }, src.key);
      return staticSummaryList(data, src);
    }));
    const list = settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
    const exact = list.find((v) => v.name === params.wd && v.pic);
    const contains = list.find((v) => v.pic && v.name.includes(params.wd));
    const any = list.find((v) => v.pic);
    return { pic: (exact || contains || any)?.pic || null };
  },
  async parse(params) {
    const html = await fetchText(params.url);
    const m = html.match(/var\s+main\s*=\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error("未能解析播放地址");
    return { m3u8: new URL(m[1], params.url).href };
  },
};

async function api(path, params = {}) {
  if (MODE.value === "detecting") await detectMode();
  if (MODE.value === "backend") {
    const qs = new URLSearchParams(params).toString();
    let resp, payload;
    try {
      resp = await fetch(`${API_BASE}/api/${path}?${qs}`);
      payload = await resp.json();
    } catch {
      throw new Error("本地服务未运行：请先执行 python server.py，再访问 http://127.0.0.1:8899");
    }
    if (!payload.ok) throw new Error(payload.msg || "接口请求失败");
    return payload.data;
  }
  const fn = staticAPI[path];
  if (!fn) throw new Error("当前页面不支持该功能");
  return fn(params);
}

createApp({
  setup() {
    /* ---------- 搜索状态 ---------- */
    const query = ref("");
    const lastQuery = ref("");
    const searched = ref(false);
    const loadingSearch = ref(false);
    const results = ref([]);
    const searchMsg = ref("");
    const searchErr = ref(false);
    const hotQueries = HOT_QUERIES;

    /* ---------- 详情与播放状态 ---------- */
    const active = ref(null);          // 当前影视详情
    const sources = ref([]);           // 播放源列表 [{from, episodes:[{name,url}]}]
    const sourceIndex = ref(0);
    const currentEpisode = ref(null);
    const playState = ref("idle");     // idle | loading | error
    const playError = ref("");
    const video = ref(null);
    let hls = null;

    const episodes = computed(() => sources.value[sourceIndex.value]?.episodes || []);

    /* ---------- 播放器增强状态 ---------- */
    const episodeFilter = ref("");
    const autoNext = ref(true);

    /* ---------- 首页海报：每个剧名配真实图片 ---------- */
    const HERO_LEFT = ["庆余年", "漫长的季节", "黑暗荣耀"];
    const HERO_RIGHT = ["我的阿勒泰", "繁花", "请回答1988"];
    const heroPostersLeft = ref(HERO_LEFT.map(name => ({ name, pic: "" })));
    const heroPostersRight = ref(HERO_RIGHT.map(name => ({ name, pic: "" })));

    async function fillPoster(entry, tries = 3) {
      for (let i = 0; i < tries; i++) {
        try {
          const data = await api("poster", { wd: entry.name });
          if (data.pic) { entry.pic = data.pic; return; }
        } catch { /* 取不到图则继续重试 */ }
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
      }
    }

    /* ---------- 星空背景：闪烁星点 + 缓慢漂移 + 偶尔流星 ---------- */
    function initStars() {
      const canvas = document.getElementById("stars");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      let w, h, stars = [], meteors = [];
      function resize() {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
        const count = Math.min(240, Math.floor((w * h) / 8500));
        stars = Array.from({ length: count }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.3 + 0.3,
          base: Math.random() * 0.45 + 0.25,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.015 + 0.005,
          vy: Math.random() * 0.025 + 0.005,
        }));
      }
      function tick() {
        ctx.clearRect(0, 0, w, h);
        for (const s of stars) {
          s.phase += s.speed;
          s.y += s.vy;
          if (s.y > h) { s.y = -2; s.x = Math.random() * w; }
          ctx.globalAlpha = Math.max(0.05, s.base + Math.sin(s.phase) * 0.35);
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        // 小概率生成一颗流星
        if (Math.random() < 0.006 && meteors.length < 2) {
          meteors.push({
            x: Math.random() * w * 0.8 + w * 0.1, y: -20,
            len: Math.random() * 140 + 90,
            vy: Math.random() * 4 + 5, vx: -(Math.random() * 2 + 1.5),
            life: 1,
          });
        }
        for (let i = meteors.length - 1; i >= 0; i--) {
          const m = meteors[i];
          m.x += m.vx; m.y += m.vy; m.life -= 0.012;
          if (m.life <= 0 || m.y > h + 60) { meteors.splice(i, 1); continue; }
          const grad = ctx.createLinearGradient(m.x, m.y, m.x + m.len * 0.6, m.y - m.len);
          grad.addColorStop(0, `rgba(255,255,255,${0.8 * m.life})`);
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.globalAlpha = 1;
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(m.x + m.len * 0.6, m.y - m.len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        requestAnimationFrame(tick);
      }
      window.addEventListener("resize", resize);
      resize();
      tick();
    }

    onMounted(async () => {
      initStars();
      // 先探测运行模式：本地后端 → 完整聚合；无后端（GitHub Pages/直开）→ 静态直连量子渠道
      await detectMode();
      heroPostersLeft.value.forEach(fillPoster);
      heroPostersRight.value.forEach(fillPoster);
    });

    const filteredEpisodes = computed(() => {
      const kw = episodeFilter.value.toLowerCase().replace(/第|集/g, "");
      if (!kw) return episodes.value;
      return episodes.value.filter(ep => ep.name.toLowerCase().includes(kw));
    });
    const currentIndex = computed(() =>
      currentEpisode.value ? episodes.value.findIndex(ep => ep.url === currentEpisode.value.url) : -1
    );
    const hasPrev = computed(() => currentIndex.value > 0);
    const hasNext = computed(() => currentIndex.value >= 0 && currentIndex.value < episodes.value.length - 1);

    /* 清空搜索词时回到主界面（若在播放页也一并退出） */
    watch(query, val => {
      if (!val && (searched.value || active.value)) {
        closePlayer();
        searched.value = false;
        results.value = [];
        searchMsg.value = "";
        searchErr.value = false;
      }
    });

    function sourceLabel(s, i) {
      if (s.srcName) return s.srcName;
      const map = { lzm3u8: "量子", liangzi: "备用", kkm3u8: "快看", ffm3u8: "非凡" };
      return map[s.from] || (s.from || `源${i + 1}`).replace(/m3u8/i, "").toUpperCase();
    }

    /* ---------- 搜索 ---------- */
    async function search() {
      const kw = query.value.trim();
      if (!kw) {
        searchMsg.value = "请先输入剧名再搜索";
        searchErr.value = true;
        return;
      }
      // 若正在播放页，先退出回到结果视图
      if (active.value) closePlayer();
      loadingSearch.value = true;
      searchMsg.value = `正在搜索“${kw}”…`;
      searchErr.value = false;
      lastQuery.value = kw;
      searched.value = true;
      try {
        results.value = await api("search", { wd: kw });
        // 没有封面的结果自动按剧名补图
        results.value.filter(it => !it.pic).forEach(fillPoster);
        searchMsg.value = results.value.length ? `找到 ${results.value.length} 部相关作品，点击海报选集播放` : "";
      } catch (err) {
        results.value = [];
        searchMsg.value = `搜索失败：${err.message}`;
        searchErr.value = true;
      } finally {
        loadingSearch.value = false;
      }
    }

    function quickSearch(q) {
      query.value = q;
      search();
    }

    /* ---------- 打开详情、列出集数 ---------- */
    async function openShow(item) {
      searchMsg.value = `正在获取《${item.name}》的集数信息…`;
      try {
        // 资源搜索结果通常已经包含 vod_play_url；优先本地解析，避免再次请求被跨域拦截的 detail 接口。
        const hasInlineEpisodes = Array.isArray(item.sources) && item.sources.some((s) => s.episodes?.length);
        const detail = MODE.value === "static" && hasInlineEpisodes
          ? item
          : await api("detail", { id: item.id, src: item.src || "" });
        active.value = detail;
        // 给每个播放源打上渠道标签
        sources.value = (detail.sources || []).map(s => ({ ...s, srcName: detail.srcName }));
        sourceIndex.value = 0;
        currentEpisode.value = null;
        playState.value = "idle";
        destroyHls();
        searchMsg.value = "";
        window.scrollTo({ top: 0, behavior: "smooth" });
        // 后台聚合其他渠道的同名剧，加入换源列表
        aggregateSources(detail.name, detail.src);
      } catch (err) {
        searchMsg.value = `获取集数失败：${err.message}`;
        searchErr.value = true;
      }
    }

    /* ---------- 聚合其他渠道同名剧的播放源 ---------- */
    async function aggregateSources(name, excludeSrc) {
      const others = Object.keys(CHANNELS).filter(k => k !== excludeSrc);
      if (!others.length) return;
      try {
        const list = await api("search", { wd: name, srcs: others.join(",") });
        for (const hit of list) {
          if (hit.name !== name || sources.value.some(s => s.srcName === hit.srcName)) continue;
          try {
            const hasInlineEpisodes = Array.isArray(hit.sources) && hit.sources.some((s) => s.episodes?.length);
            const detail = MODE.value === "static" && hasInlineEpisodes
              ? hit
              : await api("detail", { id: hit.id, src: hit.src });
            for (const s of detail.sources || []) {
              if (!s.episodes.length) continue;
              if (sources.value.some(x => x.from === s.from && x.episodes.length === s.episodes.length)) continue;
              sources.value.push({ ...s, srcName: detail.srcName });
            }
          } catch { /* 单渠道聚合失败可忽略 */ }
        }
      } catch { /* 聚合失败不影响当前播放 */ }
    }

    function closePlayer() {
      destroyHls();
      active.value = null;
      currentEpisode.value = null;
      playState.value = "idle";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function switchSource(i) {
      sourceIndex.value = i;
    }

    /* ---------- 上/下集切换与自动连播 ---------- */
    function playByOffset(offset) {
      const idx = currentIndex.value + offset;
      const ep = episodes.value[idx];
      if (ep) playEpisode(ep);
    }

    /* ---------- 播放某一集 ---------- */
    async function playEpisode(ep) {
      currentEpisode.value = ep;
      playState.value = "loading";
      playError.value = "";
      await nextTick();

      let m3u8Url = ep.url;
      // 播放地址若是 share 网页，先让本地接口解析出 m3u8 直链
      if (!/\.m3u8/i.test(ep.url)) {
        try {
          const parsed = await api("parse", { url: ep.url });
          m3u8Url = parsed.m3u8;
        } catch (err) {
          playState.value = "error";
          playError.value = `解析播放地址失败：${err.message}`;
          return;
        }
      }

      const el = video.value;
      if (!el) return;
      destroyHls();
      // 本集播完自动切下一集（可开关）
      el.onended = () => {
        if (autoNext.value && hasNext.value) playByOffset(1);
      };

      if (el.canPlayType("application/vnd.apple.mpegurl") && !window.Hls) {
        el.src = m3u8Url; // Safari 原生支持
      } else if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30 });
        hls.loadSource(m3u8Url);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          playState.value = "idle";
          el.play().catch(() => { /* 自动播放被浏览器策略阻止时交给用户手动点 */ });
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            playState.value = "error";
            playError.value = "视频加载失败，该源可能已失效";
            destroyHls();
          }
        });
      } else {
        playState.value = "error";
        playError.value = "当前浏览器不支持 HLS 播放";
      }
    }

    function destroyHls() {
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (video.value) {
        video.value.removeAttribute("src");
        video.value.load();
      }
    }

    function imgSrc(pic) {
      // 后端模式走代理绕防盗链；静态模式直连，失败时由 imgFail 重试公共代理
      if (MODE.value === "backend") return `${API_BASE}/api/img?url=${encodeURIComponent(pic)}`;
      return pic;
    }

    function imgFail(event) {
      const img = event.target;
      // 静态模式先用公共只读代理重试一次，尽量兼容有防盗链的图床。
      if (MODE.value === "static" && !img.dataset.proxyTried && /^https?:/i.test(img.src)) {
        img.dataset.proxyTried = "1";
        img.src = CORS_PROXIES[0](img.src);
        return;
      }
      // 海报加载失败时显示占位
      const fallback = document.createElement("div");
      fallback.className = "poster-fallback";
      fallback.textContent = img.alt || "暂无海报";
      img.replaceWith(fallback);
    }

    return {
      query, lastQuery, searched, loadingSearch, results, searchMsg, searchErr, hotQueries,
      heroPostersLeft, heroPostersRight, MODE,
      active, sources, sourceIndex, episodes, filteredEpisodes, currentEpisode, playState, playError, video,
      episodeFilter, autoNext, hasPrev, hasNext,
      sourceLabel, search, quickSearch, openShow, closePlayer, switchSource, playEpisode, playByOffset, imgSrc, imgFail,
    };
  },
}).mount("#app");
