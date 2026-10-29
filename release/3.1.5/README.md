# ChatGPT API 3.1.5

| 平台 | 文件 |
| --- | --- |
| Windows x64 | [独立安装 ZIP](ChatGPT-API-Launcher-3.1.5-win-x64.zip) |
| Linux x64 | [provider tar.gz](ChatGPT-API-Provider-3.1.5-linux-x64.tar.gz) |
| Linux ARM64 | [provider tar.gz](ChatGPT-API-Provider-3.1.5-linux-arm64.tar.gz) |
| macOS Apple Silicon | [单文件 DMG](ChatGPT-API-Provider-3.1.5-macos-arm64.dmg) |

## 功能

- 本地控制台：管理多个 API URL / Key、启用来源、图片模型和上下文，使用包内运行时，无新增依赖。
- 启动时合并全部启用来源的模型，独立标识、认证、路由与缓存；没有定时模型轮询。
- 保留旧配置和模型 ID，保存后的菜单及上下文在客户端退出重开后生效。
- 三平台包含控制台入口；macOS DMG 为三个聊天 App 加 `chatgpt-console.app`。

Windows 控制台在安装目录 `控制台.vbs`；Linux 为 `控制台.desktop` 或应用菜单；macOS 使用控制台 App。先安装官方客户端，更新前完全退出，保留原安装目录的 `data/`。

## 边界

混合模式官方额度用尽时，即时选 API 模型仍可能被原生输入框拦截，当前未修复。官方 / API 切换后的压缩 provider 需要退出重开同步。API Key 不替代原生工具需要的官方身份，不补齐模型或原生客户端本身缺少的能力。

macOS 为 Apple Silicon，ad-hoc 签名，无 Apple 公证；按系统正常流程允许。真实 Mac 权限与 GUI 仍需实机确认。Linux ARM64 为归档验证，不代表本机执行验证。

不附带独立下载校验文件，不包含个人 Key、登录或聊天。使用、架构、对比和限制见项目 [README](../../README.md)。

## 验证范围

16 组协议测试覆盖消息、工具、历史、结构化输出、图片、流式响应、中断、目录及上下文。多来源另验证同名模型独立认证、同一 WebSocket 跨来源续聊、设置冲突与缓存隔离；原生 CLI 接受带来源标识的菜单。

使用未修改的本机原生 CLI 与受控上游，验证四条协议路线的工具执行、历史续聊、取消、压缩、会话管理和官方/API 切换，以及两条路线的无官方登录模式。它们验证客户端与适配器，不代表逐个真实远程模型能力验证，也没有将混合额度拦截计为已修复。

Windows 独立安装、更新与凭据保留，Linux x64 安装、双架构归档，以及 macOS 四个 App 的包体和签名资源分别检查。macOS 权限与图形交互未在真实硬件上验证。
