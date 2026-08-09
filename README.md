# Stapxs QQ Lite 2.0

Stapxs QQ Lite 是一个基于 [Tauri 2](https://tauri.app/) 和 Vue 3 的非官方 QQ 桌面客户端。它通过 WebSocket 连接兼容 OneBot 11 的 QQ Bot 后端，将会话、联系人和消息能力带到原生桌面应用中。

> 本项目不是腾讯官方客户端，也不提供 QQ 登录或协议实现。使用前请阅读[免责声明](./DISCLAIMER.md)，并自行确认所使用 OneBot 后端的安全性与合规性。

## 功能概览

- 通过 `ws://` 或 `wss://` 主动连接 OneBot 11 后端，支持 Access Token
- 展示好友、群聊、会话和多种 OneBot 消息段
- 支持文本、表情、图片、文件、语音、合并转发等消息交互（实际能力取决于后端实现）
- 连接中断后自动重连，并通过 OneBot 心跳检测连接状态
- 使用本地发件箱记录待发送消息，在连接恢复后继续处理
- 使用 SQLCipher/SQLite 保存本地消息历史，离线时仍可查看已缓存会话
- 提供系统通知、托盘、窗口状态恢复、深色模式和平台原生界面适配
- 通过签名的 Tauri Updater 检查和安装更新

部分代码包含针对 SnowLuma 的兼容逻辑；其他 OneBot 11 实现可能因 API、事件或消息段差异而只支持部分功能。

## 支持平台

此仓库只维护 Tauri 桌面版本：

| 系统 | 架构 |
| --- | --- |
| Windows | x86_64 |
| macOS | Apple Silicon、Intel |
| Linux | x86_64、ARM64 |

Electron、独立 Web/PWA、Docker、Android、iOS、Capacitor 和 NapCat WebUI 插件构建不在此分支中。

## 安装

前往 [GitHub Releases](https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/releases) 下载与系统和架构匹配的安装包。

应用本身不能登录 QQ。开始前还需要单独部署或启动一个兼容 OneBot 11、能够提供正向 WebSocket 服务的 QQ Bot 后端，并取得：

- 完整 WebSocket 地址，例如 `ws://127.0.0.1:3001/`
- 后端启用鉴权时所需的 Access Token

### 连接 OneBot

1. 启动 OneBot 后端并确认其正向 WebSocket 服务正在监听。
2. 打开 Stapxs QQ Lite，在首页“连接到 OneBot”区域填写完整地址。地址必须以 `ws://` 或 `wss://` 开头。
3. 如后端配置了 Access Token，展开密钥输入项并填写相同 Token。
4. 点击连接。连接成功后，客户端会读取账号、好友和群聊信息。

如果客户端与 OneBot 运行在不同设备上，不能使用 `127.0.0.1` 作为远端地址；请使用后端设备在局域网中可访问的地址，并检查监听地址和防火墙。通过公网连接时应优先使用 `wss://`，不要在不受信任的网络中暴露未加密的 WebSocket 或 Token。

## 本地数据与隐私

消息历史和发件箱存放在应用数据目录中的 SQLCipher 数据库。数据库密钥优先保存在系统安全存储中：

- macOS：钥匙串
- Windows：凭据管理器
- Linux：Secret Service（例如 GNOME Keyring 或 KWallet）

系统安全存储不可用时，应用会生成仅限当前设备使用的本地回退密钥。删除或迁移应用数据、系统凭据或回退密钥，可能导致已有数据库无法解密。连接地址会保存在连接历史中；只有启用“保存密码”后，Token 才会随连接记录保存。

地图、头像、图片等内容可能由客户端从第三方资源地址加载。具体网络请求也取决于收到的消息内容及 OneBot 后端返回的数据。

## 从源码运行

### 环境要求

- Node.js 22
- 由 Corepack 管理的 Yarn 4（仓库固定为 `yarn@4.12.0`）
- 稳定版 Rust 工具链
- 当前系统所需的 [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

安装依赖并启动桌面开发环境：

```bash
corepack enable
yarn install --immutable
yarn dev:tauri
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `yarn dev:tauri` | 启动 Vite 和 Tauri 开发环境 |
| `yarn build:tauri` | 为当前操作系统构建安装包 |
| `yarn typecheck` | 检查 Vue 和 TypeScript 类型 |
| `yarn lint` | 使用 ESLint 检查并自动修复前端代码 |
| `yarn lint:tauri` | 使用 Cargo 检查 Rust/Tauri 代码 |
| `yarn test:connection` | 运行连接地址和连接健康检查测试 |
| `yarn test:outgoing` | 运行发件箱与消息发送测试 |
| `yarn test:updater` | 验证更新清单生成逻辑 |

Tauri 不支持跨操作系统打包。Windows、macOS 和 Linux 安装包需要分别在对应系统上构建。`yarn dev` 只启动前端页面，而当前运行时要求 Tauri 后端；日常开发请使用 `yarn dev:tauri`。

## 项目结构

```text
src/renderer/        Vue 3 界面、状态管理和 OneBot 消息逻辑
src/tauri/           Rust/Tauri 桌面后端、WebSocket、数据库和原生能力
tests/               连接、发件箱和更新清单测试
docs/                补充技术文档
build/               桌面安装包资源
```

前端通过 Tauri command 和 event 与 Rust 后端通信；WebSocket 连接、HTTP 代理、本地数据库、系统通知和窗口能力由桌面后端提供。应用标识符为 `cn.stapxs.qqweb`，并注册 `stapxs-qq-lite://` 深链接协议。

## 常见问题

### 提示地址无效

客户端只接受完整的 `ws://` 或 `wss://` URL，不会自动补全协议。请同时确认地址包含正确的主机、端口和后端要求的路径。

### 一直无法连接

确认 OneBot 使用的是正向 WebSocket 服务，而不是仅启用了反向 WebSocket；检查 Token、监听接口、防火墙和代理设置。跨设备连接时，从客户端设备测试后端主机和端口是否可达。

### 某种消息或操作不可用

OneBot 实现之间存在扩展 API 和消息段差异。请先确认后端支持对应的 OneBot 11 action；客户端中的开发者设置和日志可用于定位兼容性问题。

### Linux 无法保存安全密钥

请确认桌面会话中存在可用的 Secret Service 实现并已解锁。不可用时应用会回退到应用数据目录中的设备本地密钥，迁移数据时需连同该密钥一起保留。

## 参与开发

提交变更时请保持改动聚焦，并至少运行与改动相关的类型检查和测试。若变更 OneBot 行为，请同时考虑不同后端对 action、事件和消息结构的实现差异。

## 许可证与致谢

项目主体采用 [AGPL-3.0-only](./LICENSE) 许可证。

Tauri 系统通知功能包含来自 [DeltaChat](https://github.com/deltachat/deltachat-desktop) 的 `user-notify` 代码，位于 `src/tauri/crates/user-notify`。感谢所有依赖项目、贡献者和测试者。
