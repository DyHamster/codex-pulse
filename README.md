# Codex Pulse

在 macOS 菜单栏显示 Codex 剩余额度与代理状态：`87% · 代理✓`。项目同时包含可选的 Codex 插件工具和本地详细面板。

## 快速安装

要求：macOS 13+、Node.js 22+、已登录的 Codex CLI，以及 Xcode Command Line Tools。

```sh
git clone https://github.com/DyHamster/codex-pulse.git
cd codex-pulse
npm run install:menubar
```

无需执行 `npm install`。安装命令会在本机编译应用、复制到 `~/Applications/Codex Pulse.app` 并启动。顶部菜单栏随后显示类似 `87% · 代理✓` 的文字。

如果还要在 Codex 对话中使用“查询额度”和“打开详细面板”工具：

```sh
python3 scripts/install-local.py
```

也可以一次安装两部分：

```sh
npm run install:all
```

安装插件后请新建聊天，使 Codex 重新加载工具。

## 使用

需要 macOS、Node.js 22+、curl，以及已登录的 Codex CLI。使用本机 App Server 认证；无需 OpenAI API key，不读取或复制登录凭据，不启动模型推理。

```sh
npm start       # 启动独立后台监控服务，打印面板链接
npm run status  # 查询当前快照
npm stop        # 停止后台监控（关闭面板不会停止）
npm test        # 单元、HTTP/SSE 与 MCP 集成测试
```

无需 npm install，无第三方运行依赖。首版使用原生 JavaScript ES Modules、Node.js 和 HTML/CSS，减少安装步骤与构建依赖。

在当前 Codex 开发环境中安装到个人插件市场：

```sh
python3 scripts/install-local.py
```

安装脚本使用 Codex 自带的 plugin-creator 脚手架，将源码复制到 `~/plugins/codex-pulse`、登记个人市场并调用 `codex plugin add`。不覆盖已有同名插件。MCP 配置中的 Node 和源码路径会在安装副本中自动适配本机。

安装后新建聊天，使用“查看 Codex 额度和网络状态”或“打开 Codex Pulse 实时监控面板”。面板链接含仅在本机有效的访问密钥，不要分享。首次打开后密钥存入该标签页 sessionStorage，地址栏移除密钥。

## 指标口径

- **剩余额度**：`100 - usedPercent`，账号共享，按服务端返回的各个额度分组展示。不换算成剩余 Token，不写死窗口时长。
- **Token 用量**：账号接口返回的累计值与最近统计日（服务端日期）；非当前聊天用量。缺失值显示未知。
- **额度接口**：实际额度请求最近一次成功与耗时。
- **连接质量**：curl 轻量 HTTPS 请求，区分 DNS、连接、TLS、超时、401、403、429、5xx。HTTP 拒绝不等于断网，耗时不等于模型生成速度。
- curl 继承 `HTTPS_PROXY` / `ALL_PROXY` 等环境代理及 NO_PROXY 行为，不自动读取 macOS 系统代理或 Codex 内部代理；界面明确说明路径未经一致性验证。探测可能失败而额度接口仍可用。
- App Server 账号可能与桌面账号不同，界面显示套餐和脱敏邮箱供核对。
- **额度余额、信用额度、API 金额余额是不同概念**。首版界面只显示额度百分比和已用 Token。API key 模式不提供 ChatGPT 额度。

## 刷新与提醒

额度每 60 秒补查，连接内可用额度事件即时合并。独立 App Server 未假定能收到桌面所有会话事件，因此轮询始终保留。Token 统计每 5 分钟请求。网络每 15 秒探测（故障后 30 秒），额度失败逐步退避至 5 分钟。系统休眠期间自然暂停，唤醒后到期定时器恢复采集。

页面使用 SSE 接收快照，断开时自动重连并将旧数据标记过期。手动刷新最短间隔 10 秒；多次并发刷新合并处理。多聊天共享固定本机端口上的一个服务。

“开启提醒”只在用户点击并授权后启用浏览器通知。低于 20% / 10% 时提醒，持续三次网络失败后通知，恢复后通知。需要面板保持打开；去重范围是当前页面生命周期。另有下述原生菜单栏应用；不默认设置开机启动。

## 配置

在启动进程环境中设置：

- `CODEX_PULSE_PORT`：默认 `43127`。
- `CODEX_PULSE_CODEX_BIN`：可选 Codex CLI 绝对路径。默认优先发现 macOS 应用内置 CLI，否则使用 PATH。
- 标准 curl 代理环境变量：按你实际网络环境设置。修改后需 `npm stop` 再启动。

服务仅绑定 `127.0.0.1`，API 需要随机访问密钥，并校验 Host/Origin。状态和历史在内存中；临时运行目录仅当前用户可访问，保存访问密钥、PID 和服务日志。服务停止后删除连接描述文件。浏览器标签页保留最近 40 次探测图，不上传遥测。

## 发布到 GitHub

仓库已经忽略了 `build/`、日志、`.DS_Store` 和本机生成文件，不要把 `~/Applications` 下的应用或临时目录加入 Git。发布前执行：

```sh
npm test
npm run build:menubar
git init
git add .
git commit -m "Initial release of Codex Pulse"
git branch -M main
```

然后在 GitHub 创建一个名为 `codex-pulse` 的空仓库，不要勾选自动生成 README、`.gitignore` 或 License。把 GitHub 页面给出的地址代入：

```sh
git remote add origin https://github.com/YOUR_NAME/codex-pulse.git
git push -u origin main
```

最后把本页“快速安装”中的 `YOUR_NAME` 换成你的 GitHub 用户名，再提交并推送一次。GitHub Actions 会自动运行 Node 测试并在 macOS 环境验证菜单栏构建。

当前分发方式是源码构建，因此不会遇到未公证二进制应用的签名问题。若以后提供可下载的 `.app` 或 `.dmg`，建议申请 Apple Developer ID、完成签名和 notarization，再放入 GitHub Releases。

代码使用 MIT License。公开前请确认 `plugin.json` 中的作者名称符合你的预期。

## 更新与卸载

工作区源码在 `codex-pulse` 目录。安装副本在 `~/plugins/codex-pulse`，修改工作区不会自动更新已安装副本。更新时先停止服务，将改动同步到安装源码（保留安装生成的 `.mcp.json`），再使用 Codex `plugin-creator` 的 `update_plugin_cachebuster.py`，并重新 `codex plugin add codex-pulse@个人市场名称`。重新打开聊天以加载工具。

停止服务：在安装源码目录执行 `npm stop`。卸载插件：在 Codex 插件管理中移除 Codex Pulse，或使用 `codex plugin remove`。移除插件前先停止独立监控服务。

## 验证范围

测试涵盖额度多分组与缺失值、故障保留旧值、并发去重、网络错误分类、MCP 握手与工具发现、HTTP 访问密钥和跨站限制、刷新限流及 SSE 首次快照。真实账号和面板需要在当前机器执行联调。HTTP 测试需要允许本机端口监听。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。


## macOS 极简菜单栏

`npm run build:menubar` 使用系统 Swift 编译 `build/Codex Pulse.app`，无第三方依赖。将应用放入个人 Applications 后双击启动。应用不显示 Dock 图标，顶部仅显示例如 `42% · 代理✓`，点击可见其他额度窗口、刷新和退出入口。

- 百分比使用 codex 分组的 primary 窗口（通常为 5 小时）；过期数据附加 `*`，未知显示 `—%`。
- `代理✓`：系统 URLSession 的本次请求指标确认使用代理，并收到目标 HTTP 响应。
- `直连`：请求成功且指标未报告显式代理；不排除 VPN/TUN 或网络层转发。
- `代理!`：检测到系统代理配置，但请求失败，不能确认连接成功。
- `代理?`：尚未确认代理通路。

原生代理探测使用 macOS 系统网络配置，每 30 秒执行轻量 HEAD 请求。它独立于详细面板的 curl 环境代理探测，也不能保证与 Codex 内部路由一致。HTTP 403/429 能说明收到了响应，不说明模型请求一定可用。

菜单栏每 10 秒读取现有监控服务缓存，服务仍按原有频率更新账号额度。服务未启动时自动启动打包在应用内的监控代码。首次运行可能需要几秒获取数据。退出菜单栏不会停止插件共享的后台服务，停止服务请执行 `npm stop`。

每台电脑会在安装时记录自己的 Node 路径，因此需要在目标电脑本地执行安装命令。菜单栏自检随构建执行，覆盖未知/零额度、过期标识、代理确认条件和额度分组选择。
