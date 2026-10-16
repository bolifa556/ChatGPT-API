# 本地发布包

当前版本：**3.0.9**。发布包与源码集中保存在本仓库，不包含本机密钥、聊天记录或诊断数据。

| 平台 | 发布包 |
| --- | --- |
| Windows x64 | [ChatGPT-API-Launcher-3.0.9-win-x64.zip](ChatGPT-API-Launcher-3.0.9-win-x64.zip) |
| Linux x64 | [ChatGPT-API-Provider-3.0.9-linux-x64.tar.gz](ChatGPT-API-Provider-3.0.9-linux-x64.tar.gz) |
| Linux ARM64 | [ChatGPT-API-Provider-3.0.9-linux-arm64.tar.gz](ChatGPT-API-Provider-3.0.9-linux-arm64.tar.gz) |
| macOS Apple Silicon（推荐） | [ChatGPT-API-Provider-3.0.9-macos-arm64.dmg](ChatGPT-API-Provider-3.0.9-macos-arm64.dmg) |
| macOS 原脚本包（保留） | [ChatGPT-API-Provider-3.0.9-macos-arm64.tar.gz](ChatGPT-API-Provider-3.0.9-macos-arm64.tar.gz) |

Windows 完整解压后运行包内 `安装.cmd`，安装后有三个桌面入口：官方模型的 `ChatGPT`、依据登录状态使用模型的 `chatgpt-api`、始终使用网关模型的 `chatgpt-apionly`。切换前从托盘完全退出客户端；三个入口不删除原生登录或改写聊天正文。

Linux 保持单一 provider 入口；按 [Linux 使用说明](../docs/linux-readme.md) 安装。ARM64 归档通过静态包检查，不代表在 ARM64 桌面上完成实际运行验证。

macOS 推荐只下载 DMG，把 `chatgpt-apionly.app` 拖到“应用程序”，首次通过图形窗口填写 URL 和 Key。由于没有 Developer ID 和 Apple 公证，开发者提醒仍需在“隐私与安全性 → 仍要打开”中手动允许；DMG 不会自动免除该提醒。详见 [DMG 使用说明](../docs/macos-dmg-readme.md)。包结构、代码/资源哈希及隔离逻辑已验证；未在真实 Mac 上执行 Gatekeeper 首次放行和客户端 GUI 验证。原 tar.gz 的内容与校验值保留不变。

每个归档均有同名 `.sha256` 文件。历史 **3.0.5—3.0.8** 的 Windows、Linux x64 与 ARM64 包也保存在本目录，迁移时已校验 SHA-256，未重新打包历史版本。

默认构建命令：

```powershell
npm run build:release
python scripts/build-linux-release.py --arch all
python scripts/build-macos-release.py
# 下面一项在 macOS 上运行；WSL 构建需显式传入交叉工具路径
python3 scripts/build-macos-dmg.py
```

构建拒绝覆盖同名包。归档保留在本地而不提交 Git；本说明和校验文件提交 Git，源码与依赖锁定文件可用于重新构建。
