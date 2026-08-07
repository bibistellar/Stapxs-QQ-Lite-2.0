# Tauri 自动更新发布说明

客户端使用 Tauri Updater 检查、验证、下载并安装 Windows、Linux 和 macOS 更新。更新包必须经过独立的 updater 签名；平台代码签名不能替代此签名。

## 首次配置

在仓库之外的安全目录生成一次密钥：

```bash
yarn tauri signer generate -w /安全目录/stapxs-updater.key
```

将生成结果配置到 GitHub 仓库：

- Actions Secret `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容。
- Actions Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成私钥时设置的密码；无密码时可不配置。
- Actions Variable `TAURI_UPDATER_PUBLIC_KEY`：命令输出的公钥。

私钥和密码不得提交到仓库。应离线备份私钥；私钥丢失后，已安装的客户端无法验证由新密钥签出的后续更新。

## 发布版本

1. 修改 `package.json` 中的语义化版本号，并执行 `yarn update:version` 同步 Rust 包版本。
2. 提交版本修改。
3. 创建并推送完全一致的标签，例如版本 `3.4.7` 对应 `v3.4.7`。

```bash
git tag v3.4.7
git push origin v3.4.7
```

正式发布工作流会构建三个系统的安装包及 updater 签名，生成 `latest.json`，然后将它们放入同一个 GitHub Release。标签与 `package.json` 不一致或缺少签名配置时，工作流会直接失败，避免发布客户端无法安装的半成品。

手动触发工作流主要用于重新构建当前版本。常规发布必须提升版本号，因为 Tauri Updater 不把相同版本视为更新。
