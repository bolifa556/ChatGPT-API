# ChatGPT API 3.2.3

本版改进启动失败时的提示，减少后台记录占用，并补充客户端版本建议。聊天、工具、Fast 和生图仍按原有方式使用。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.3-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.3-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.3-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.3-macos-arm64.dmg) |

- Windows 推荐官方客户端 `26.1103.7773.0` 或更新稳定版。这是项目已验证版本，并非官方最低版本要求；macOS 和 Linux 建议使用对应平台最新稳定版。
- 启动出错时说明具体环节，减少只显示“等待超时”的情况。
- 修正部分启动状态判断，避免客户端已就绪又被后续窗口的加载状态影响。
- 日常保持静默，减少无用记录和磁盘占用。

Windows/macOS 提供三个聊天入口，Linux 提供纯 API 入口。安装更新选择原目录即可保留 API 设置；更新前请完全退出客户端。macOS 仅发布 DMG，未做 Developer ID 公证，首次打开按系统正常允许流程操作。

使用方法和功能边界见[项目说明](../../README.md)。
