# -*- coding: utf-8 -*-
"""
追剧神器本地服务
- 托管前端静态页面（index.html / app.js / styles.css）
- 提供接口：
    GET /api/search?wd=剧名      搜索影视
    GET /api/detail?id=影视ID    获取详情与集数列表
    GET /api/parse?url=share页   解析出 m3u8 直链
启动：python server.py  然后浏览器打开 http://127.0.0.1:8899
"""
import json
import os
import re
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8899"))  # 云平台(Render/Railway等)会注入 PORT 环境变量
ROOT = Path(__file__).parent
TIMEOUT = 8
SEARCH_DEADLINE = 8  # 聚合搜索总时限，到点先返回已完成的渠道，慢渠道记入 failed
POSTER_DEADLINE = 12  # 海报查询时限更宽：异步装饰加载，宁可多等也要取到图

# 聚合渠道：均为苹果CMS格式接口
VOD_SOURCES = {
    "lzm3u8": {"name": "量子资源", "api": "https://cj.lziapi.com/api.php/provide/vod/"},
    "ffzy": {"name": "非凡资源", "api": "https://api.ffzyapi.com/api.php/provide/vod/"},
    "bfzy": {"name": "暴风资源", "api": "https://bfzyapi.com/api.php/provide/vod/"},
    "zy360": {"name": "360资源", "api": "https://360zy.com/api.php/provide/vod/"},
}
DEFAULT_SRC = "lzm3u8"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# 首页海报缓存：剧名 -> 图片URL（None 表示各渠道都没有）
POSTER_CACHE = {}


def http_get(url, timeout=TIMEOUT, retries=3):
    last_exc = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": url})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "ignore")
        except Exception as exc:  # noqa: BLE001 超时/SSL握手失败等，重试
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(0.5 * (attempt + 1))
    raise last_exc


def fetch_json(url, timeout=TIMEOUT):
    text = http_get(url, timeout)
    start = text.find("{")
    if start == -1:
        raise ValueError("接口返回内容不是 JSON")
    return json.loads(text[start:])


def search_one(src_key, wd):
    src = VOD_SOURCES[src_key]
    data = fetch_json(src["api"] + "?" + urllib.parse.urlencode({"wd": wd, "pg": 1}))
    items = []
    for v in data.get("list", [])[:16]:
        items.append(_summary(v, src_key))
    return items


def _summary(v, src_key):
    return {
        "id": v.get("vod_id"),
        "name": v.get("vod_name"),
        "sub": v.get("vod_sub") or "",
        "class": v.get("vod_class") or "",
        "year": str(v.get("vod_year") or ""),
        "area": v.get("vod_area") or "",
        "remarks": v.get("vod_remarks") or "",
        "score": v.get("vod_score") or "",
        "pic": v.get("vod_pic") or "",
        "blurb": re.sub(r"\s+", " ", v.get("vod_blurb") or ""),
        "src": src_key,
        "srcName": VOD_SOURCES[src_key]["name"],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[access]", self.address_string(), fmt % args)

    def _send(self, code, content, ctype="application/json; charset=utf-8"):
        if isinstance(content, str):
            content = content.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content)

    def _api_result(self, data):
        self._send(200, json.dumps({"ok": True, "data": data}, ensure_ascii=False))

    def _api_error(self, message, code=502):
        self._send(code, json.dumps({"ok": False, "msg": message}, ensure_ascii=False))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/api/search":
                wd = (query.get("wd") or [""])[0].strip()
                if not wd:
                    return self._api_error("缺少搜索关键词", 400)
                # 可用 srcs=量子key,另一个key 限定只搜部分渠道
                src_keys = [k for k in (query.get("srcs") or [",".join(VOD_SOURCES)])[0].split(",") if k in VOD_SOURCES]
                if not src_keys:
                    src_keys = list(VOD_SOURCES)
                # 并行请求全部渠道，到点先返回；单渠道超时/失败不影响整体
                merged, failed = [], []
                pool = ThreadPoolExecutor(max_workers=len(src_keys))
                try:
                    futures = {pool.submit(search_one, key, wd): key for key in src_keys}
                    try:
                        for future in as_completed(futures, timeout=SEARCH_DEADLINE):
                            key = futures[future]
                            try:
                                merged.extend(future.result())
                            except Exception as exc:  # noqa: BLE001
                                print(f"[search] {key} 失败: {exc!r}")
                                failed.append(key)
                    except FutureTimeoutError:
                        for future, key in futures.items():
                            if not future.done():
                                failed.append(key)
                finally:
                    # 不等待慢渠道，直接返回已完成结果
                    pool.shutdown(wait=False, cancel_futures=True)
                # 按 name 去重：同名条目优先保留有海报的，渠道顺序其次
                merged.sort(key=lambda it: (0 if it["pic"] else 1, list(VOD_SOURCES).index(it["src"])))
                seen = set()
                items = []
                for it in merged:
                    if not it["name"] or it["name"] in seen:
                        continue
                    seen.add(it["name"])
                    items.append(it)
                return self._send(200, json.dumps(
                    {"ok": True, "data": items, "failed": [VOD_SOURCES[k]["name"] for k in failed]},
                    ensure_ascii=False))

            if parsed.path == "/api/detail":
                vid = (query.get("id") or [""])[0].strip()
                src_key = (query.get("src") or [DEFAULT_SRC])[0].strip()
                if src_key not in VOD_SOURCES:
                    src_key = DEFAULT_SRC
                if not vid:
                    return self._api_error("缺少影视ID", 400)
                api = VOD_SOURCES[src_key]["api"]
                data = fetch_json(api + "?" + urllib.parse.urlencode({"ac": "detail", "ids": vid}), timeout=15)
                lst = data.get("list") or []
                if not lst:
                    return self._api_error("没有找到该影视的详情", 404)
                v = lst[0]
                # 播放源：from = "liangzi$$$lzm3u8"，url = "第01集$地址#第02集$地址$$$..."
                sources = []
                names = (v.get("vod_play_from") or "").split("$$$")
                groups = (v.get("vod_play_url") or "").split("$$$")
                for i, group in enumerate(groups):
                    episodes = []
                    for ep in group.split("#"):
                        if "$" not in ep:
                            continue
                        ep_name, ep_url = ep.split("$", 1)
                        episodes.append({"name": ep_name.strip(), "url": ep_url.strip()})
                    if episodes:
                        sources.append({"from": names[i] if i < len(names) else f"源{i + 1}", "episodes": episodes})
                return self._api_result({
                    "id": v.get("vod_id"),
                    "name": v.get("vod_name"),
                    "src": src_key,
                    "srcName": VOD_SOURCES[src_key]["name"],
                    "sub": v.get("vod_sub") or "",
                    "class": v.get("vod_class") or "",
                    "year": str(v.get("vod_year") or ""),
                    "area": v.get("vod_area") or "",
                    "remarks": v.get("vod_remarks") or "",
                    "score": v.get("vod_score") or "",
                    "director": v.get("vod_director") or "",
                    "actor": v.get("vod_actor") or "",
                    "pic": v.get("vod_pic") or "",
                    "content": re.sub(r"<[^>]+>", "", v.get("vod_content") or v.get("vod_blurb") or "").strip(),
                    "sources": sources,
                })

            if parsed.path == "/api/parse":
                page_url = (query.get("url") or [""])[0].strip()
                if not page_url.startswith(("http://", "https://")):
                    return self._api_error("链接不合法", 400)
                html = http_get(page_url, timeout=15)
                # share 页里：var main = "/xxx/index.m3u8?sign=..."
                match = re.search(r"var\s+main\s*=\s*['\"]([^'\"]+)['\"]", html)
                if not match:
                    return self._api_error("未能从页面解析出播放地址", 404)
                m3u8 = urllib.parse.urljoin(page_url, match.group(1))
                return self._api_result({"m3u8": m3u8})

            if parsed.path == "/api/ping":
                # 前端用它检测后端是否在线（静态托管下此接口不存在）
                return self._api_result({"pong": True})

            if parsed.path == "/api/poster":
                # 按剧名取一张海报：多渠道并发搜索，精确同名优先，其余带图的兜底
                wd = (query.get("wd") or [""])[0].strip()
                if not wd:
                    return self._api_error("缺少剧名", 400)
                if wd in POSTER_CACHE:
                    pic = POSTER_CACHE[wd]
                else:
                    merged = []
                    pool = ThreadPoolExecutor(max_workers=len(VOD_SOURCES))
                    try:
                        futures = {pool.submit(search_one, key, wd): key for key in VOD_SOURCES}
                        try:
                            for future in as_completed(futures, timeout=POSTER_DEADLINE):
                                try:
                                    merged.extend(future.result())
                                except Exception:  # noqa: BLE001
                                    pass
                        except FutureTimeoutError:
                            pass
                    finally:
                        pool.shutdown(wait=False, cancel_futures=True)
                    exact = [it for it in merged if it["name"] == wd and it["pic"]]
                    contains = [it for it in merged if it["pic"] and wd in (it["name"] or "")]
                    anypic = [it for it in merged if it["pic"]]
                    pick = (exact or contains or anypic or [{}])[0]
                    pic = pick.get("pic") or None
                    # 取到图才缓存，失败下次自动重试
                    if pic:
                        POSTER_CACHE[wd] = pic
                return self._send(200, json.dumps({"ok": True, "pic": pic}, ensure_ascii=False))

            if parsed.path == "/api/img":
                # 海报代理：带 UA/Referer 回源取图，绕过图床防盗链
                img_url = (query.get("url") or [""])[0].strip()
                if not img_url.startswith(("http://", "https://")):
                    return self._send(400, "bad url", "text/plain; charset=utf-8")
                try:
                    req = urllib.request.Request(img_url, headers={"User-Agent": UA, "Referer": img_url})
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        data = resp.read()
                        ctype = resp.headers.get("Content-Type", "image/jpeg")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as exc:  # noqa: BLE001
                    print("[img]", img_url, repr(exc))
                    self.send_response(404)
                    self.end_headers()
                return

            # 静态文件
            return self._static(parsed.path)
        except Exception as exc:  # noqa: BLE001
            print("[error]", parsed.path, repr(exc))
            return self._api_error(f"服务器处理失败：{exc}")

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        file_path = (ROOT / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(ROOT.resolve())) or not file_path.is_file():
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        }.get(file_path.suffix.lower(), "application/octet-stream")
        self._send(200, file_path.read_bytes(), ctype)


if __name__ == "__main__":
    print(f"追剧神器服务已启动： http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
