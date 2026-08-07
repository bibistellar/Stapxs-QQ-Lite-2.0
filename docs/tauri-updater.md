# Tauri 自动更新发布说明

客户端使用 Tauri Updater 检查、验证、下载并安装 Windows、Linux 和 macOS 更新。更新包必须经过独立的 updater 签名；平台代码签名不能替代此签名。

## 首次配置

当前客户端验签公钥已经固化在 `src/tauri/tauri.conf.json`。对应的无密码私钥只保存在 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY` 中；GitHub UI 和 API 无法读回原值，发布工作流只在打包进程环境中使用它。应通过分支保护限制对发布工作流的修改权限。

私钥不得提交到仓库。GitHub Secret 写入后无法读取，只能覆盖或删除；仓库或 Secret 丢失后，已安装客户端将无法验证使用新密钥签出的更新。如需容灾，应将私钥额外保存到受控的云端加密保险库。

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
