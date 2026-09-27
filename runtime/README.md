# 运行环境

完整本地安装包在这里携带 `node.exe`。二进制不纳入 Git。

从源码安装且缺少 Node 时，安装器按 `assets/runtime.json` 中的固定版本和 SHA-256 下载；依赖按根目录 `package-lock.json` 的版本与 SHA-512 安装到 `node_modules/`。完整安装包已有这些文件时直接复用。

本项目面向 Windows x64；安装器不更新 ChatGPT/Codex 应用本体。
