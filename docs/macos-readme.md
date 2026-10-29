# ChatGPT API 3.1.5 — macOS

macOS 只发布 Apple Silicon 单文件 DMG，包含：

- `chatgpt-official.app`：原生登录、官方模型与混合历史兼容。
- `chatgpt-api.app`：根据登录状态显示官方和自定义 API 模型。
- `chatgpt-apionly.app`：始终使用自定义 API。
- `chatgpt-console.app`：多来源、模型目录、图片模型与上下文设置。

先安装官方客户端，再将 App 拖到“应用程序”。本包附带运行时，不包含官方客户端；使用 ad-hoc 签名，首次需按系统正常流程允许。更新保留程序目录的 `data/`，配置保存后需退出重开客户端。

完整步骤、数据位置和限制见 [DMG 使用说明](macos-dmg-readme.md)，控制台见 [设置说明](console.md)，平台测试范围见 [macOS 隔离测试](macos-testing.md)。
