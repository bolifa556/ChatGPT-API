# ChatGPT API 3.1.2

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [ZIP](ChatGPT-API-Launcher-3.1.2-win-x64.zip) |
| Linux x64 | [tar.gz](ChatGPT-API-Provider-3.1.2-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](ChatGPT-API-Provider-3.1.2-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](ChatGPT-API-Provider-3.1.2-macos-arm64.dmg) |

Windows 和 macOS 提供官方、混合和 API-only 三个入口；Linux 提供 API provider 入口。需要先安装对应平台的官方客户端。

适配层保留官方请求压缩和上游关闭原因，按通道顺序绑定请求与历史，使用有界共享内存保存恢复所需的原始上下文。代理连接使用正确的 TLS 超时参数，客户端取消不会等待连接超时才返回。协议诊断记录大小、阶段和耗时，不记录聊天正文。网关压缩能力不明确时使用其现有未压缩 JSON 协议。

网关 GPT 在模型目录未提供速度元数据时仍可选择 Fast，混合模式与 API-only 模式均适用。选择后转发原生 `service_tier: priority`；明确的上游速度声明优先，不自动启用 Fast，不承诺固定倍速。

安装更新保留原有 URL、Key、登录和聊天。更新前请完全退出客户端，Windows 也需退出托盘；本机已运行的路由要在退出并重新进入后加载新代码。

macOS 仅发布 DMG，包含三个入口 App。使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开按系统隐私与安全性页面正常允许。发布包不附带独立 SHA256 文件。

[完整使用说明](../../README.md)
