# 追剧神器 wzy 🎬

> 搜剧名 · 选集数 · 即刻观看 —— 聚合多渠道影视搜索，选集后在页面内直接播放，无需跳转到任何平台。

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?logo=python&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特性

- 🔍 **聚合搜索**：一次搜索并行查询 量子 / 非凡 / 暴风 / 360 四个资源渠道，限时返回，单渠道超时或故障不影响整体结果
- ▶️ **页内播放**：基于 hls.js 的 HLS 播放器，选集后直接在当前页面观看，全程不跳转
- 🔁 **多源切换**：播放页自动聚合其他渠道的同名剧集，一键换源
- ⏭ **自动连播**：本集播完自动切下一集（可开关），支持上/下集快捷切换
- 🗂 **集数筛选**：集数较多时支持输入编号快速定位
- 🖼 **海报代理**：本地代理回源取图，绕过图床防盗链；无封面的结果自动按剧名补图
- 🌌 **星空界面**：Canvas 动态星空与流星、毛玻璃卡片、渐变光晕、骨架屏加载
- 🧹 **清空即回**：清空搜索框自动回到主页

## 🚀 快速开始

零第三方依赖，使用 Python 标准库即可运行（要求 Python ≥ 3.9）：

```bash
python server.py
```

然后浏览器打开 <http://127.0.0.1:8899> 即可使用。

## 🌐 两种运行模式（自动检测）

页面加载时会自动探测运行环境，无需任何配置：

| 模式 | 触发条件 | 能力 |
| --- | --- | --- |
| 🛰️ **静态模式** | GitHub Pages / 直接双击 `index.html` / 任何静态托管 | 浏览器端并行查询四个资源渠道，获取详情、集数并解析播放地址；直连失败时自动尝试公共 CORS 代理 |
| 🚀 **完整模式** | 本地运行 `python server.py` 后访问 8899 端口 | 四渠道聚合搜索、多源切换、海报代理（绕防盗链更稳） |

> GitHub Pages 不会运行 Python；静态模式已经把搜索、详情、集数、海报查询和播放地址解析放进 `app.js`，因此不需要启动 `server.py`。浏览器仍受数据源跨域策略和网络可达性限制；如果所有直连和公共代理都失败，需要稍后重试或使用下面的后端模式。

### 方式一：GitHub Pages（推荐，无需启动 server.py）

仓库已经包含 `.github/workflows/pages.yml`。推送到 `main` 后，在 Settings → Pages → Build and deployment 中选择 **GitHub Actions**，工作流完成后即可通过 `https://<用户名>.github.io/<仓库名>/` 访问页面。部署完成后直接打开页面即可搜索、查看集数和播放；Pages 只提供静态文件，不能运行 `server.py`。

### 方式二：本地完整体验

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>
python server.py
```

浏览器打开 <http://127.0.0.1:8899>。

### 方式三：部署到免费云平台（完整模式在线版）

`server.py` 已支持读取 `PORT` 环境变量，可直接部署到 Render / Railway / Koyeb 等支持长驻进程的平台（启动命令 `python server.py`，无构建步骤）。

> 注意：不要用 Vercel/Netlify 的 Serverless 方案托管后端，`http.server` 需要常驻进程。

## 📁 项目结构

| 文件 | 说明 |
| --- | --- |
| `server.py` | 本地服务：聚合搜索 / 详情集数 / m3u8 解析 / 海报代理 / 静态托管 |
| `index.html` | Vue 3 单页应用入口（CDN 引入，无需构建） |
| `app.js` | 应用逻辑：搜索、播放、聚合换源、星空背景 |
| `styles.css` | 全站样式 |
| `favicon.svg` | wzy 站点图标 |
| `video_vip.py` | 最早的 tkinter 桌面版原型（已被 Web 版替代，留作纪念） |

## 🛠 技术栈

- **前端**：Vue 3 + hls.js + 原生 CSS，全部 CDN 引入，无打包构建步骤
- **后端**：Python 标准库 `http.server`，无任何 pip 依赖

## ⚠️ 免责声明

本项目仅供个人学习与技术研究使用。所有影视数据来自公开采集接口，视频内容的版权归原作者及原平台所有，请支持正版。

## 📄 License

[MIT](LICENSE)
