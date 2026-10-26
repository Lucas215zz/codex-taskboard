[English](README.md) | [简体中文](README.zh-CN.md)

# codex_taskboard

一个本地优先的议题看板，面向用 Codex 规划和交付工作的人。它既可以在浏览器中运行，也可以通过 CDP 启动器或注入脚本嵌入 Codex 桌面端，并让 React UI 与随附的 `taskctl` CLI 共用同一套 HTTP API。

![codex_taskboard 议题看板](docs/assets/codex-taskboard.png)

![codex_taskboard Agent 总览](docs/assets/codex-taskboard-agent-overview.png)

## 功能概览

- **每个项目一块看板。** 项目各自拥有工作目录、标签、项目文档和议题。
- **七种议题状态。** `backlog`、`todo`、`in_progress`、`in_review`、`blocked`、`done`、`canceled`。
- **完整的关系结构。** 父子议题、阻塞依赖、关联关系、标签、优先级、截止日期和重复规则。
- **丰富的议题文档。** Markdown 表格、任务列表、内嵌图片、附件，以及只读 Mermaid 图表。
- **实时协作。** 通过服务器发送事件同步所有已打开客户端；重连后执行完整刷新。
- **面向 Codex。** 从议题直接打开原生 Codex 会话，把会话绑定到议题，并让 Codex 通过内置 Skill 认领工作。
- **自动化。** 为每个项目创建 Codex 定时任务，自动认领可执行的 `todo` 议题并推进到验证完成。
- **可选集成。** Jira 双向同步、Token 使用排行榜、Cloudflare 协作和本地 Codex 对话面板。

## 视图

每个项目会记住自己上次选择的视图。

| 视图 | 用途 |
| --- | --- |
| `codex_taskboard` | 首个视图页签：完成度、进度预测、贡献热力图、优先级/标签分布、需要关注的议题和运行中的会话。 |
| Agent 总览 | 按部门分组的项目、最近动静、完成度、活跃议题和自动化状态。 |
| 议题看板 | 按状态分列，支持拖拽、筛选、子议题和会话操作。 |
| 列表 | 紧凑可排序的列表，适合快速浏览议题。 |
| 甘特图 | 时间线视图，支持日/周/月缩放、回到今天和隐藏已完成。 |
| 项目文档 | 项目唯一的 Markdown 文档，可直接在原地编辑。 |

同一项目同一时间只允许一个议题处于 `in_progress`，因为这些议题通常共用同一个工作目录。再次认领会返回 `409 PROJECT_BUSY`，并带上当前活跃议题的标识符。

## 系统要求

- Node.js 22.5 或更高版本。
- 构建 macOS App 和 DMG：Xcode Command Line Tools、Rust 1.88 或更高版本，以及 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target。`npm install` 会安装本项目的 Tauri CLI。
- 构建 Windows NSIS：Microsoft Store 版 Codex App、Rust 1.88 或更高版本，以及带 C++ 工作负载和 Windows SDK 的 Visual Studio Build Tools。
- 构建 Linux 软件包：Ubuntu 24.04 x64 及 Tauri 所需的 Linux 依赖。

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库位于 `.data/taskboard.sqlite`。

开发模式会在 <http://127.0.0.1:5173> 提供 Vite UI，并把 API 请求代理到本地服务：

```bash
npm run dev
```

## CLI

`taskctl` 是脚本和 Agent 使用的稳定接口。

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

运行 `npm link` 可以把 `taskctl` 放到 shell 路径中。用 `CODEX_TASKBOARD_URL` 指向另一个本地或局域网服务，或让 CLI 通过 `CODEX_TASKBOARD_RUNTIME_FILE` 读取当前启动器的运行时描述文件。

常用命令：

```bash
taskctl issue list --project my-project --status todo --sort priority --json
taskctl issue get MY-1 --json
taskctl issue move MY-1 --status in_progress --if-version 3 --json
taskctl comment add MY-1 --body "Implementation notes" --json
taskctl project readme get my-project --json
```

读命令和写命令默认都输出 JSON。完整命令树见 [skills/manage-taskboard/references/cli.md](skills/manage-taskboard/references/cli.md)。

## Codex Skill

把 `skills/manage-taskboard` 复制或符号链接到 Codex 的 Skill 目录，然后新建一个 Codex 任务：

```bash
ln -s /absolute/path/to/codex_taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

桌面 App 会让已安装的 Skill 保持同步。这个 Skill 会指导 Codex 检查议题和附件、使用当前版本和完整会话绑定认领议题、验证工作，然后移到 `in_review`。只有用户明确接受后，才会移到 `done`。

## 项目自动化

codex_taskboard 可以为每个项目创建 Codex 定时自动化，让 Codex 按固定间隔检查可执行的 `todo` 议题。请从 Codex App 的内嵌面板配置；独立浏览器页面不提供项目自动化入口。

1. 打开内嵌面板并选择项目。
2. 确认项目已绑定正确的 Codex 项目和工作目录。
3. 点击项目页眉中的 **自动化**，展开 **自动认领待办**。
4. 打开自动认领开关，并选择 `5`、`10`、`15`、`30` 或 `60` 分钟。
5. 可按需启用额度限制，再选择模型和推理强度。

每轮执行：

1. 按优先级、手动排序和创建时间列出 `todo` 议题。
2. 跳过明确要求等待或仍有未完成依赖的议题。
3. 用当前版本和完整绑定把一个可执行议题认领为 `in_progress`。
4. 在绑定的项目、分支或 worktree 中实施并验证。
5. 写入结果评论，再把议题移到 `in_review`。
6. 不会自动标记 `done`；完成需要用户确认。

项目里已有活跃的 `in_progress` 议题时，本轮会跳过该项目，直到该议题离开活跃状态。没有可执行议题时，自动化保持空闲。

## 嵌入 Codex

### 一条命令启动

保持现有 Codex 窗口打开，然后运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

启动器会在需要时启动本地服务，复用已有可用 CDP 的 Codex 渲染器，在普通 Codex 窗口的原生浏览面板中打开 codex_taskboard，或在没有运行 Codex 时用独立配置文件和仅限回环的端口 `9231` 启动官方 macOS Codex App。CDP 可用时，它会在 Plugins 之后注入一个原生外观的侧边栏入口，并持续监视服务和替换后的渲染器。

启动器会把带身份信息的服务地址写入 `.data/launcher-runtime.json`。通过 `npm link` 安装的 `taskctl` 默认读取该描述文件，因此普通 shell 和从面板打开的 Codex 会话使用同一个服务。

### 手动使用 CDP

保持现有 Codex 窗口打开，用专用 CDP 端口启动第二个实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

然后运行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用面板期间请让注入器保持运行。如果端口 `9231` 被占用，请在两个命令中同时换成其他端口。

要注入一个已经以 CDP 方式运行的 Codex 实例：

```bash
npm run codex:inject -- --port 9229 --open
```

注入器会在侧边栏添加入口，并在 Codex 的整个主工作区渲染 iframe，包括上下文标题栏区域。它不会修改 `ChatGPT.app`、`app.asar` 或 Codex 数据文件。

**在对话中打开** 会在可用时选择对应的原生 Codex 项目，并打开一个未发送的 composer，包含 `e-taskboard` 指令和议题标识符。只有当会话实际处理该议题后，`taskctl` 才会读取 `CODEX_THREAD_ID` 并把会话记录到议题或评论的写入上。每个议题可以绑定一个 Git 分支或一个 worktree，选项从所选 Codex 项目的仓库中扫描。

要使用不同的 UI 来源，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。Windows 上自行启动的 Codex 窗口没有 CDP 端口时，可参考 [tools/windows](tools/windows/README.md) 中的面板诊断说明。

## 桌面 App

### macOS

```bash
npm run app:dev
```

如需构建本地 App 和 DMG，请先安装两个 Rust target：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

打开 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`。DMG 位于 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。预构建安装包发布在[发布通道](https://github.com/chuspeeism/dashi-taskboard/releases/latest)。

App 内置自己的 Node 运行时、服务、Web UI、Skill、CLI 包装器和注入脚本。它会启动服务，在 CDP 可用时注入面板，并直接打开面板而不显示终端窗口。数据位于 `~/Library/Application Support/Codex Taskboard`，启动器日志位于 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

本地构建使用 ad-hoc 签名。公开的 macOS 下载仍需要 Developer ID 签名和 Apple 公证。

### Windows

先从 Microsoft Store 安装官方 Codex App，然后构建当前用户级 NSIS 安装包：

```powershell
npm ci
npm run app:build:windows
```

安装包输出到 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。它包含托盘启动器、内置 Node、本地服务、构建后的 Web UI、Skill、`taskctl.cmd` 和注入脚本。数据位于 `%APPDATA%\Codex Taskboard`，日志位于 `%LOCALAPPDATA%\Codex Taskboard\Logs`，Skill 会复制到 `%USERPROFILE%\.agents\skills\manage-taskboard`。

Windows CI 产物目前未签名，也不支持自动更新。分发前请阅读[代码签名策略](docs/code-signing-policy.md)，保留数据的行为见 [Windows 卸载说明](docs/windows-uninstall.md)。

### Linux

Linux 桌面版第一版仅支持 Ubuntu 24.04 LTS x64。请先安装官方 ChatGPT 桌面版 `.deb`，再从发布通道安装 codex_taskboard 的 `.deb` 或运行 AppImage。

```bash
sudo apt install ./<file>.deb
# 或
chmod +x ./<file>.AppImage
./<file>.AppImage
```

在 Ubuntu 24.04 x64 上构建这两个软件包：

```bash
npm ci
npm run app:build:linux:x64
```

第一版不支持 ARM64、Fedora、RPM 和其他 Linux 发行版。

## Jira

在项目菜单中连接 Jira。Jira Cloud 使用 Atlassian 邮箱和 API token；自建 Jira 使用账号密码。选择一个或多个 Jira 项目（名称或 Key），同步为 `Jira · <账号>` 项目。

codex_taskboard 会导入议题、状态、优先级、经办人、标签和链接。状态或优先级变化会通过匹配的 Jira 工作流 transition 或优先级字段写回。如果 Jira 中没有匹配的 transition，写入会失败，而不是静默产生两边不一致。

## Token 使用排行榜

页眉提供排行榜入口。启用使用量采集并配置上传 token 后，本地服务会记录 Codex 会话的 token 使用量，并把批量事件发送到配置的接口。默认接口为 `https://ttokens.lusixian.com/api/token-usage/events`。

可通过 `CODEX_TOKEN_RANKING_UPLOAD_URL` 和 `CODEX_TOKEN_RANKING_UPLOAD_TOKEN` 配置，也可以通过本地设置 API 配置。排行榜服务源码在 `token-ranking-server/`。不希望记录使用事件时，可通过该设置 API 关闭采集。

## 本地 AI 对话

从 Codex 或其他回环浏览器打开面板时，右侧可以提供本地 Codex 对话。面板会从本地 Codex app server 读取模型和推理强度，记住来源项目和议题，支持附件，并可选择只读、workspace-write 或完全访问的沙箱设置。远程或受信任隧道请求不会获得这项设备本地能力。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 和本地运行时数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址 |
| `CODEX_TASKBOARD_RUNTIME_FILE` | 启动器描述文件 | 为 CLI 显式指定运行时描述文件 |
| `CODEX_TASKBOARD_COMPANION_URL` | 本地服务 | 云端模式使用的回环 companion |
| `CODEX_TASKBOARD_TRUSTED_ORIGINS` | 未设置 | 允许通过反向隧道访问的精确 HTTPS 源，逗号分隔 |
| `CODEX_TOKEN_RANKING_UPLOAD_URL` | `https://ttokens.lusixian.com/api/token-usage/events` | 排行榜上传接口 |
| `CODEX_TOKEN_RANKING_UPLOAD_TOKEN` | 空 | 排行榜上传使用的 Bearer token |

`npm start` 会输出本地 URL 和可用的局域网 URL。任务、评论、附件和项目文档的变化会通过服务器发送事件广播到所有已打开客户端。使用 `taskctl` 的协作者可以通过 `CODEX_TASKBOARD_URL=http://<host-ip>:47823` 指向共享服务。

局域网模式没有账号身份验证：受信任网络中任何能访问该 URL 的人都可以读写看板。公网和云端部署需要经过身份验证的边界。

使用反向隧道时，把 `CODEX_TASKBOARD_TRUSTED_ORIGINS` 设为隧道的精确 HTTPS 源。源不能包含路径、查询参数、片段、凭据或通配符；重复项会在启动时被拒绝。代理必须保留公网 `Host` 和浏览器提供的 `Origin`。即使隧道 socket 位于回环地址，通过配置的公网源访问时也不会开放设备本地能力接口。

## 数据与隐私

默认所有内容都在你的电脑上运行。SQLite 数据库和本地运行时文件位于 `CODEX_TASKBOARD_DATA_DIR`；桌面 App 使用上面列出的平台数据目录。看板内容不会发送给项目维护者。

网络活动仅限：

- 面板、启动器和 CLI 使用的回环服务；
- 你配置的可选 Jira 连接；
- 可选 Token 排行榜接口；
- 你配置的可选 Cloudflare 部署；
- 用于检查更新的 GitHub Releases；
- 官方 Codex App 和 CLI 在你自己的账号下使用的 OpenAI 服务。

完整说明见 [PRIVACY.md](PRIVACY.md)。

## 云端协作

对于两名受信任的协作者，看板可以运行在 Cloudflare 上，使用 Worker 静态资源和 API 路由、D1 作为权威数据库、私有 R2 bucket 存储附件，并用 Durable Object 做实时广播。部署使用带共享密码的 HTTPS Basic 身份验证。

每台设备保留自己的项目检出映射，并通过回环 companion 提供 Codex、Git/worktree、Skill 和 MCP 能力。云端模式绝不会回退到本地 SQLite，也不会同时写入本地数据库。

部署、密码轮换、本地路径映射和一次性迁移流程见[云端协作](docs/cloud-collaboration.md)。

## 验证

```bash
npm run check
```

该命令运行 TypeScript 检查、生产前端构建、组件测试，以及服务器/CLI/注入测试套件。也可以单独运行：

```bash
npm run typecheck
npm run build:web
npm test
```

## Markdown 支持

议题描述、评论和项目文档支持 GFM，包括表格和任务列表。`mermaid` 围栏代码块会在查看器加载后渲染为只读图表；渲染失败时仍可阅读原始源码。Markdown HTML 注释（例如 `<!-- trace-analysis:v1 ... -->`）不会显示。未启用原始 HTML。

## 文档

- [云端协作](docs/cloud-collaboration.md)
- [代码签名策略](docs/code-signing-policy.md)
- [Windows 卸载说明](docs/windows-uninstall.md)
- [Windows 面板诊断](tools/windows/README.md)
- [隐私政策](PRIVACY.md)
- [taskctl 参考](skills/manage-taskboard/references/cli.md)

## 致谢

感谢 [Lingshan21](https://github.com/Lingshan21)：

- 在 [#371](https://github.com/chuspeeism/dashi-taskboard/pull/371) 中提出并初步实现基于父议题的项目完成度方案，让顶层父议题拥有同等权重，而不受子议题数量影响。
- 在 [#372](https://github.com/chuspeeism/dashi-taskboard/pull/372) 中提出并初步实现优先级组织方案。最终的看板排序控件按维护者需求调整，没有采用提议中的优先级泳道。

## 许可证

[Apache License 2.0](LICENSE)
