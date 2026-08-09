**中文 | [English](README_EN.md)**

<p align="center">
  <img src="src/renderer/public/img/icons/icon.svg" alt="Stapxs QQ Lite" width="144" height="144">
</p>

<h1 align="center">Stapxs QQ Lite</h1>

<p align="center">
  一个兼容 OneBot 11 协议的非官方 QQ 全平台客户端实现
</p>

<p align="center">
  <a href="https://bibistellar.github.io/Stapxs-QQ-Lite-2.0/">在线使用</a> ·
  <a href="https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/releases">下载客户端</a> ·
  <a href="https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/issues">问题反馈</a>
</p>

![应用界面](README/view.png)

> [!IMPORTANT]
> 本项目不是腾讯 QQ 官方客户端，需要连接由用户自行部署的 OneBot 11 服务。使用非官方 QQ Bot 可能带来账号安全、数据与稳定性风险，请在使用前阅读 [免责声明](DISCLAIMER.md)。

## 项目简介

Stapxs QQ Lite 将 OneBot 11 服务提供的消息与账号能力呈现为图形化聊天客户端。核心界面使用 Vue 3 和 TypeScript 开发，同一套前端可运行于浏览器，并封装为多个平台的客户端。

当前源码包含以下运行形态：

- Web 单页应用与 PWA
- Electron 桌面客户端（Windows、macOS、Linux）
- Tauri 2 桌面客户端
- Capacitor 8 移动客户端（Android、iOS）
- NapCat 插件构建

主要功能包括消息收发、回复、转发与撤回，图片、表情和文件发送，以及群文件、群公告、精华消息和部分群管理能力。具体功能是否可用还取决于所连接的 OneBot 实现及其扩展接口。

## 使用

### 1. 准备 OneBot 服务

先部署一个提供 OneBot 11 正向 WebSocket 接口的 QQ Bot。项目内置了针对以下实现的消息结构适配：

- NapCat.Onebot（LLOneBot 使用同一映射）
- Lagrange.OneBot
- SnowLuma

其他兼容 OneBot 11 的实现也可以尝试连接，但扩展接口或消息字段的差异可能导致部分功能不可用。

### 2. 打开客户端并连接

可以直接使用[在线版](https://bibistellar.github.io/Stapxs-QQ-Lite-2.0/)，或从 [Releases](https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/releases) 下载对应平台的客户端。

在连接页填写 OneBot 正向 WebSocket 地址和访问密钥。地址支持完整的 `ws://` / `wss://` URL；未填写协议时，客户端会根据运行环境补全协议。访问密钥会以 `access_token` 查询参数发送。

浏览器的安全策略通常不允许 HTTPS 页面连接 `ws://` 地址。如果在线版无法连接局域网中的非加密 WebSocket，请改用 `wss://`、部署在相同安全环境中的 Web 版本，或使用桌面/移动客户端。

### 3. 其他使用方式

NapCat 用户可以安装 `napcat-plugin-ssqq`，相关源码与打包说明位于 [`ssqq.napcat-plugin`](ssqq.napcat-plugin/README.md)。

发布版 Web 静态文件也可以放置在任意静态文件服务器中。仓库提供的 Docker 镜像使用 Nginx，并监听容器内的 `8080` 端口：

```bash
docker run --rm -p 8080:8080 ghcr.io/bibistellar/stapxs-qq-lite-2.0:latest
```

也可以使用 Web 快速启动包：

```bash
npx ssqq-web hostname=127.0.0.1 port=8081
```

## 本地开发

### 环境要求

- Node.js
- Yarn 4（仓库声明的版本为 `4.12.0`）
- 构建移动端时需要对应的 Android Studio / Xcode 环境
- 构建 Tauri 时需要 Rust 与对应平台的系统依赖

克隆仓库时请同时获取子模块，然后安装锁定版本的依赖：

```bash
git clone --recursive https://github.com/bibistellar/Stapxs-QQ-Lite-2.0.git
cd Stapxs-QQ-Lite-2.0
yarn install --immutable
```

### 常用命令

| 命令 | 用途 | 主要输出 |
| --- | --- | --- |
| `yarn dev` | 启动 Web 开发服务器（默认端口 `8080`） | — |
| `yarn preview` | 预览 Web 构建结果 | — |
| `yarn build` | 构建 Web 应用 | `dist/` |
| `yarn dev:electron` | 启动 Electron 开发环境 | — |
| `yarn build:electron` | 构建并打包 Electron 客户端 | `dist_electron/` |
| `yarn dev:tauri` | 启动 Tauri 开发环境 | — |
| `yarn build:tauri` | 构建 Tauri 客户端 | `src/tauri/target/release/bundle/` |
| `yarn dev:android` | 同步并运行 Android 应用 | — |
| `yarn dev:ios` | 同步并运行 iOS 应用 | — |
| `yarn open:android` | 构建前端并在 Android Studio 中打开项目 | — |
| `yarn open:ios` | 构建前端并在 Xcode 中打开项目 | — |
| `yarn build:android` | 构建 Android release APK | Android Gradle 输出目录 |
| `yarn build:ios` | 构建并导出 iOS 应用 | `dist_capacitor/` |
| `yarn build:napcat` | 生成 NapCat 专用 Web 构建 | `dist/` |
| `yarn typecheck` | 执行 Vue/TypeScript 类型检查 | — |
| `yarn test:connection` | 运行连接地址与连接健康检查测试 | — |
| `yarn test:outgoing` | 运行消息发送测试 | — |
| `yarn lint` | 执行 ESLint 并自动修复 | — |

### 构建配置

Vite 从仓库根目录读取环境变量。源码中使用的构建配置包括：

| 变量 | 作用 |
| --- | --- |
| `VITE_APP_SSE_MODE` | 设为 `true` 后使用 HTTP API / SSE 固定连接模式 |
| `VITE_APP_SSE_SUPPORT` | SSE 模式下是否启用事件推送 |
| `VITE_APP_SSE_EVENT_ADDRESS` | SSE 事件接口地址 |
| `VITE_APP_SSE_HTTP_ADDRESS` | OneBot HTTP API 基础地址 |
| `VITE_LOCAL_FACE` | 是否把本地 QQ 表情资源复制进构建结果 |
| `VITE_APP_AMAP_KEY`、`VITE_APP_AMAP_SECRET` | 位置消息使用的高德地图配置 |

SSE 模式是构建时选项，不能在运行时切换。关闭 `VITE_APP_SSE_SUPPORT` 后客户端仍可调用 HTTP API，但无法收到新消息和通知等主动事件。

不要提交包含访问密钥或第三方服务凭据的本地环境配置。

### 平台说明

- Electron 的入口位于 `src/electron`，预加载脚本位于 `src/preload`。打包目标由 `electron-builder.yml` 定义。
- Tauri 2 工程位于 `src/tauri`。Tauri 应用通常需要在目标操作系统上构建。
- Capacitor 工程位于 `src/mobile`。`capacitor.config.ts` 中的 Android 签名密码从运行环境读取；发布构建前需要自行准备有效签名配置。
- `yarn build:ios` 会调用 `scripts/build-export-ipa.sh`，需要 macOS、Xcode 和可用的开发者签名环境。

## 目录结构

```text
src/renderer/                       Vue 前端与静态资源
src/electron/                       Electron 主进程
src/preload/                        Electron preload 接口
src/tauri/                          Tauri 2 桌面工程
src/mobile/                         Capacitor Android / iOS 工程
ssqq.capacitor-onebot-connector/    移动端 OneBot 原生连接插件
ssqq.napcat-plugin/                 NapCat 插件封装
ssqq.npx-web-quick-start/           npx Web 快速启动包
tests/                              连接与消息发送测试
```

## 参与贡献

提交改动前建议至少运行与改动相关的检查：

```bash
yarn typecheck
yarn test:connection
yarn test:outgoing
```

`yarn lint` 带有自动修复参数，请在准备检查并保留其格式化结果时运行。

## 许可证

主项目采用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。子项目以各自目录中的许可证文件为准：

| 子项目 | 许可证 |
| --- | --- |
| `ssqq.capacitor-onebot-connector` | Apache-2.0 |
| `ssqq.napcat-plugin` | MIT |
| `ssqq.npx-web-quick-start` | AGPL-3.0 |

“QQ”及相关名称、图标与商标归其权利人所有。本项目与腾讯公司无关。
