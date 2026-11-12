# ChatGPT API 3.2.3

本次更新修复 API 入口启动后意外退出、部分压缩历史阻止启动，以及控制台关闭后仍占用后台的问题。README 已更新安装、三种入口、生图、历史兼容和停用卸载说明。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.3-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.3-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.3-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.3-macos-arm64.dmg) |

- Windows 已验证官方客户端 `26.1106.6628.0`。启动入口从当前安装注册读取路径和启动别名，跟随客户端更新后的安装位置。
- 发送额度和 Fast 界面兼容独立加载。部分模块无法识别时提示一次，客户端继续启动。
- 修复多帧 Zstandard 历史的读取。无法解码的单个归档保留，其他对话继续加载。
- 控制台在默认浏览器打开，关闭最后一个控制台标签页后自动退出。macOS 控制台 App 打开页面后即完成交接。
- 调整退出与异常恢复顺序，等待对应客户端退出后恢复临时设置。
- 不同 API 中的同名模型分别处理思考历史，修复启动诊断中的 Windows 版本号识别。

Windows/macOS 提供三个聊天入口，Linux 提供纯 API 入口。安装更新选择原目录即可保留 API 设置；更新前请完全退出客户端。macOS 仅发布 DMG，未做 Developer ID 公证，首次打开按系统正常允许流程操作。

使用方法和功能边界见[项目说明](../../README.md)。
