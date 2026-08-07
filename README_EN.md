# Stapxs QQ Lite 2.0

An unofficial OneBot 11-compatible QQ desktop client built with Tauri.

This branch supports desktop systems only:

- Windows
- macOS (Apple Silicon and Intel)
- Linux (x86_64 and ARM64)

Electron, standalone Web/PWA, Docker, Android, iOS, Capacitor, and NapCat WebUI plugin builds are not included in this branch.

> This is an independent open-source project intended for learning and communication. Read the [disclaimer](./DISCLAIMER.md) before use.

## Usage

Download the Tauri package for your system from [GitHub Releases](https://github.com/bibistellar/Stapxs-QQ-Lite-2.0/releases). The client connects to a QQ Bot backend compatible with OneBot 11.

## Development

Install Node.js 22, Yarn 4, stable Rust, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system.

```bash
corepack enable
yarn install
yarn dev:tauri
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `yarn dev:tauri` | Start the Tauri development environment |
| `yarn build:tauri` | Build a package for the current platform |
| `yarn typecheck` | Check Vue and TypeScript code |
| `yarn lint:tauri` | Check Rust/Tauri code |
| `yarn test:connection` | Run connection tests |
| `yarn test:outgoing` | Run outgoing-message tests |

Tauri does not support cross-OS builds; build on the corresponding Windows, macOS, or Linux system.

## Local data

Local message history is stored by the Tauri backend using SQLCipher/SQLite. The database key is stored in the system credential manager when available, with a device-local fallback key.

## License

The main project is licensed under [AGPL-3.0-only](./LICENSE). The Tauri notification implementation contains `user-notify` code from [DeltaChat](https://github.com/deltachat/deltachat-desktop) under `src/tauri/crates/user-notify`.
