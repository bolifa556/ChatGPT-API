# ChatGPT API 3.2.4

本次更新主要优化启动速度和运行占用，减少长对话转发时的内存复制，完善历史对话兼容与退出恢复。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.4-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.4-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.4-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.4-macos-arm64.dmg) |

- 加快启动和退出时的历史兼容处理，对话较多时减少等待。
- 减少原生界面兼容模块的常驻内存，复用已有的模型目录和客户端版本缓存。
- 减少长对话请求的重复解析、复制与缓冲区占用，大段历史使用可无损还原的内存压缩。
- 保留旧版未完成恢复记录的处理，完善配置恢复和临时文件收尾。

Windows 已验证官方客户端 `26.1106.6628.0`。Windows/macOS 提供三个聊天入口，Linux 提供纯 API 入口。安装更新选择原目录即可保留 API 设置，更新前请完全退出客户端。

使用方法和功能边界见[项目说明](../../README.md)。
