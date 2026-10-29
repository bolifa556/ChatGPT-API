# ChatGPT API 3.1.3

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [ZIP](ChatGPT-API-Launcher-3.1.3-win-x64.zip) |
| Linux x64 | [tar.gz](ChatGPT-API-Provider-3.1.3-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](ChatGPT-API-Provider-3.1.3-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](ChatGPT-API-Provider-3.1.3-macos-arm64.dmg) |

Windows 和 macOS 提供官方、混合和 API-only 三个入口；Linux 提供 API provider 入口。使用前需安装对应平台的官方客户端。

适配器提供以下行为：

- 完整保留原生指令模板，由客户端组装工具、权限及协作指令；纯 API 使用经过原生内核验证的内置模板快照，不追加自写行为提示。
- 官方 HTTP 请求缺少压缩时补充无损 zstd；已有压缩正文和网关现有协议保持兼容。
- 生成、上下文压缩和生图请求不设置本地响应等待上限；暂停、断开、完成及异常退出回收连接，客户端与上游自身限制不变。
- 区分本地协议错误，保留上游原始状态及错误字段，不增加网络重试。

安装更新保留原有 URL、Key、登录和聊天。更新前请完全退出客户端，Windows 也需退出托盘。已有对话保存的基础指令保持原文；若需应用新模板，可切换到另一模型正常续聊一轮，之后再切回。

macOS 只发布一个 DMG，内含三个入口 App，采用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开按系统隐私与安全性页面正常允许。发布目录不附带独立 SHA256 文件。

适配验证包含 14 组协议测试、13 个网关模型在混合和纯 API 模式下的原生客户端隔离测试、Fast、128 秒响应等待及取消回收。真实上游模型能力与网络不属于这些隔离验证；macOS GUI、TCC 和 Gatekeeper 仍需在真机确认。

3.1.3 安装包已通过 Windows 独立安装／更新、Linux x64 安装／更新、Linux ARM64 包结构与架构检查，以及 macOS DMG 三入口资源和签名结构检查。macOS ARM64 与 Linux ARM64 未在对应硬件上运行。

[完整使用说明](../../README.md) · [适配优化与验证](../../docs/adapter-optimization-2026-10-19.md)
