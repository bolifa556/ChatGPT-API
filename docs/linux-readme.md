# ChatGPT API 3.1.6 — Linux

Linux 包提供自定义 API provider 和本地控制台，模型与图片请求只使用自定义 API。消息与工具格式转换复用共用适配器，不管理官方订阅登录。

## 安装

1. 安装对应发行版与架构的官方 ChatGPT 桌面客户端。
2. 完全退出客户端，解压 `ChatGPT-API-Provider-3.1.6-linux-x64.tar.gz` 或 ARM64 包。
3. 以桌面用户运行 `./install.sh`，不要使用 sudo。默认安装到 `~/.local/share/chatgpt-api-provider`，也可传入独立的绝对路径。
4. 输入 API URL 和 Key。安装后从应用菜单打开 **ChatGPT API**。

包内包含对应架构的 Node.js 和依赖。安装完成后可删除解压目录；更新时选择原安装目录，保留 `data/`。模型目录查询仍需要连接 API。

## 控制台

在程序目录打开 `控制台.desktop`，或应用菜单的 **ChatGPT API 控制台**。也可运行：

```sh
"$INSTALL/linux/chatgpt-api" console
```

`$INSTALL` 为实际安装目录。控制台可配置多个 URL / Key、启用来源、指定图片模型、修改全局和单模型上下文。旧配置自动导入为默认来源，已有 Key 留空保留。每次入口启动获取所有启用来源的模型，运行期间不定时轮询。修改并保存后完全退出客户端，再从 API 入口重开。

模型目录默认上限 500,000 tokens，通常有效显示 475k，容量小于上限时取实际值。已确认容量缓存；控制台中可调整上限，官方客户端本身功能与模型能力不会因此扩展。

## 命令

```sh
"$INSTALL/linux/chatgpt-api"           # 启动客户端并加载目录
"$INSTALL/linux/chatgpt-api" configure # 旧版单来源 URL / Key 设置
"$INSTALL/linux/chatgpt-api" status    # 本地适配器状态
"$INSTALL/linux/chatgpt-api" stop      # 退出客户端后停止适配器
"$INSTALL/linux/chatgpt-api" restore   # 退出客户端后恢复接管前配置
```

默认从 PATH 中查找 `chatgpt`；特殊安装位置设置 `CHATGPT_API_CLIENT`。自定义 `CODEX_HOME` 应在安装与启动时保持一致。无人值守安装可设置 `CHATGPT_API_BASE_URL`、`CHATGPT_API_KEY`、`CHATGPT_API_PORT`，不要把真实 Key 写入共享命令或脚本。

## 数据与限制

- `data/providers.json` 保存多来源、Key 和上下文；`data/.env` 保留兼容启动配置。配置为明文，POSIX 权限限制为当前用户，不要分享安装目录的 `data/`。
- 原生 `CODEX_HOME/config.toml` 中的 provider 配置持久保留，普通 `chatgpt` 启动也会读到；`restore` 可恢复接管项并保留其他偏好。不会写入 `auth.json` 或聊天正文。
- 工具、权限、聊天保存和文本压缩由原生客户端提供。格式转换不补齐模型缺少的能力，不能代替浏览器或在线服务需要的官方身份。
- API-only 的模型与生图不回退官方。图片模型必须由 API 提供兼容 Images 接口，可在控制台配置；无对应模型时明确报错。
- Fast 档位原样传递，是否实际提供优先服务以上游为准。生成、压缩、生图不设置适配层响应等待上限，不添加网络重试，不改变代理或 TUN。
- 支持 `response.interrupt`，中断后仅保留已完成的原始输出，不补写工具参数或聊天内容。
- Linux 客户端本身未提供的功能不在本包支持范围。ARM64 包的结构与权限可检查，实机执行范围以发布验证说明为准。

更多说明见源码中的 `README.md`；归档内的本说明可直接阅读，源码文档见 `docs/console.md`、`docs/configuration.md` 和 `docs/message-protocol.md`。

安装时可选择“跳过，稍后配置”，保留已有 API 设置；首次空配置安装不请求模型目录。API 入口在未配置时给出明确提示，可稍后打开控制台填写。Linux 终端安装另可使用 ./install.sh --skip-api。Windows / macOS 的官方入口不要求填写 API。
