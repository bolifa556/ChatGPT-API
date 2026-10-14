# 本地发布包

当前版本：**3.0.9**。发布包与源码集中保存在本仓库，不包含本机密钥、聊天记录或诊断数据。

| 平台 | 发布包 |
| --- | --- |
| Windows x64 | [ChatGPT-API-Launcher-3.0.9-win-x64.zip](ChatGPT-API-Launcher-3.0.9-win-x64.zip) |
| Linux x64 | [ChatGPT-API-Provider-3.0.9-linux-x64.tar.gz](ChatGPT-API-Provider-3.0.9-linux-x64.tar.gz) |
| Linux ARM64 | [ChatGPT-API-Provider-3.0.9-linux-arm64.tar.gz](ChatGPT-API-Provider-3.0.9-linux-arm64.tar.gz) |
| macOS Apple Silicon | [ChatGPT-API-Provider-3.0.9-macos-arm64.tar.gz](ChatGPT-API-Provider-3.0.9-macos-arm64.tar.gz) |

Windows 完整解压后运行包内 `安装.cmd`，安装后有三个桌面入口：官方模型的 `ChatGPT`、依据登录状态使用模型的 `chatgpt-api`、始终使用网关模型的 `chatgpt-apionly`。切换前从托盘完全退出客户端；三个入口不删除原生登录或改写聊天正文。

Linux 保持单一 provider 入口；按 [Linux 使用说明](../docs/linux-readme.md) 安装。ARM64 归档通过静态包检查，不代表在 ARM64 桌面上完成实际运行验证。

macOS 包只提供 `chatgpt-apionly`。解压后运行 `Install.command`，安装后使用桌面的 `chatgpt-apionly.command`，详见 [macOS 使用说明](../docs/macos-readme.md)。归档与逻辑已在构建机检查；未在真实 Mac 上执行官方客户端 GUI 验证。

每个归档均有同名 `.sha256` 文件。历史 **3.0.5—3.0.8** 的 Windows、Linux x64 与 ARM64 包也保存在本目录，迁移时已校验 SHA-256，未重新打包历史版本。

默认构建命令：

```powershell
npm run build:release
python scripts/build-linux-release.py --arch all
python scripts/build-macos-release.py
```

构建拒绝覆盖同名包。归档保留在本地而不提交 Git；本说明和校验文件提交 Git，源码与依赖锁定文件可用于重新构建。
