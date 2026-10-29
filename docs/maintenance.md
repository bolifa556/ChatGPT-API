# 构建、测试与维护

## 运行与测试

包内 Node.js 与锁定依赖用于运行。源码开发可使用 Node >= 22.14，安装依赖时按 package-lock.json，不增加控制台框架。

```sh
npm test
npm run test:windows
```

协议测试覆盖工具参数与历史、思考记录、HTTP/WS、SSE、中断续聊、目录缓存、图片、上下文及多来源。Windows 测试覆盖 PowerShell 5.1、入口配置恢复、凭据保留和安装。macOS 平台与 GUI 控制器可在隔离环境测试；POSIX 进程测试在 macOS 或 WSL/Linux 执行。受控上游通过不代表真实远程模型具备相应能力。

原生 CLI 验证使用隔离 CODEX_HOME，按测试脚本设置 CODEX_CLI_PATH，不把日常账号或聊天作为测试夹具。实际硬件、在线身份、网络、模型自身能力与未执行项目需单独记录。

## 发布

```sh
npm run build:release
python3 scripts/build-linux-release.py --arch all
python3 scripts/build-macos-dmg.py
npm run test:release
```

Windows 构建在 Windows 执行；macOS DMG 在 Mac 上使用系统工具，或在 WSL/Linux 明确传入 Zig、rcodesign、HFS 与 DMG 工具路径。工具来源记录于 assets/macos-dmg-build-tools.json。

输出目录为 release/<package.json 中版本>/。Windows 一个 ZIP，Linux x64 / ARM64 各一个 tar.gz，macOS 一个 DMG；Mac provider 归档只作为临时中间文件，不对外发布。不生成独立下载校验文件，安装器内部仍核验逐文件清单，避免损坏文件覆盖已有程序。

构建采用程序文件白名单，包含控制台、来源管理、运行时和锁定依赖，排除 data、个人配置、Key、聊天、日志、Git 与测试。验证 Windows 独立安装、Linux 包及安装、Mac DMG 结构/签名资源，并核对打包源文件为当前版本。

不要覆盖旧版本发布包。更新前完全退出客户端，选择原安装目录，保留 data。当前已运行的进程不会因为磁盘文件更新自动加载新代码，不强制中断用户任务。

## 文件与 Git

源码、文档和发布说明保留在本地 Git；data、运行时、依赖及大型发布二进制不写入 Git。没有用户指令时不创建远程仓库、不推送或自动提交。

- data/cache：模型目录与容量记录。
- data/state：本地进程、入口与控制台连接状态。
- data/logs：固定文件名日志；shim.log 超过 5 MB 后滚动为一份 .1。
- data/testing、data/diagnostics：测试夹具和验证结果，不是聊天记录。

不要分享填过 Key 的安装目录。对外只分发构建生成的原始归档。PowerShell 文件保留 UTF-8 BOM，确保 Windows PowerShell 5.1 正确读取中文入口名。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 模型菜单未更新 | 完全退出后重开；目录文件变更不代表原生菜单已重载 |
| 单来源连接失败 | 控制台的地址/Key 与错误，其他来源独立加载；缓存必须匹配 URL/Key |
| 官方额度用尽，选 API 仍不能发送 | 已知原生输入框/provider 同步限制，当前消息适配层尚未解决 |
| 压缩 provider 不匹配 | 官方/API 切换后退出重开；不把官方加密块转成虚构摘要 |
| 浏览器工具不可用 | 检查原生工具身份、平台权限与工具自身网络，不仅是模型路由 |
| 控制台连接失效 | 从程序目录重新打开；随机端口与连接令牌随控制台服务变化 |

功能边界与数据位置以项目 README、configuration.md 和 console.md 为准。日期文档保留为历史调查记录。
