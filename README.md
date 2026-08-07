# Stapxs QQ Lite 2.0

一个基于 Tauri、兼容 OneBot 11 协议的非官方 QQ 桌面客户端。

本分支仅支持以下桌面平台：

- Windows
- macOS（Apple Silicon 与 Intel）
- Linux（x86_64 与 ARM64）

Electron、独立 Web/PWA、Docker、Android、iOS、Capacitor 和 NapCat WebUI 插件构建均不再包含在本分支中。

> 本软件为第三方开源项目，仅供学习和交流。使用前请阅读 [免责声明](./DISCLAIMER.md)。

## 使用

从 [GitHub Releases](https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/releases) 下载对应系统的 Tauri 安装包。客户端需要连接到兼容 OneBot 11 的 QQ Bot 后端。

## 开发

需要 Node.js 22、Yarn 4、稳定版 Rust，以及当前操作系统所需的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
corepack enable
yarn install
yarn dev:tauri
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `yarn dev:tauri` | 启动 Tauri 开发环境 |
| `yarn build:tauri` | 构建当前平台安装包 |
| `yarn typecheck` | 检查 Vue/TypeScript |
| `yarn lint:tauri` | 检查 Rust/Tauri 代码 |
| `yarn test:connection` | 运行连接相关测试 |
| `yarn test:outgoing` | 运行消息发送相关测试 |

Tauri 不支持跨操作系统构建，请在对应的 Windows、macOS 或 Linux 环境中构建。

## 本地数据

本地消息历史使用 Tauri 后端中的 SQLCipher/SQLite 存储。数据库密钥优先保存到系统密码管理器；不可用时使用设备本地回退密钥。

## 许可证

项目主体采用 [AGPL-3.0-only](./LICENSE)。Tauri 版本的系统通知功能包含来自 [DeltaChat](https://github.com/deltachat/deltachat-desktop) 的 `user-notify` 代码，位于 `src/tauri/crates/user-notify`。
