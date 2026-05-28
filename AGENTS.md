# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求

## 1. 要求
每次交付前必须在仓库根目录运行 `bun tsc --noEmit` 与 `bun test --only-failures; bun run knip --fix`；
先运行`bun install`安装依赖

## 2. 约束
禁用词：`收口`。新增或修改文案、注释、提示词、日志、界面文案时都不得使用该表述，统一改为含义更准确的描述。

## 3. 项目概览

### 3.1 产品定位

- Agent Team 是面向 OpenCode 的单工作区 Task Code Agent 编排桌面工具。
- 当前系统围绕当前 `cwd` 下的团队拓扑、Task 会话、群聊记录与 Agent 运行态工作，数据模型使用工作区与 Task。
- GUI 主布局为：上方当前 Task 拓扑图，下方左侧当前 Task 群聊，右侧当前 Task Agent 列表；前端只负责展示与聊天发消息，不负责任何配置写入。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode 与文件存储逻辑。
- 核心目标是不让 Agent 停下来

### 3.2 技术栈

- Node.js CLI + 浏览器 Web Host
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- 默认 OpenCode Server 为 `opencode serve`，CLI 支持通过 `--cmd` 切换到底层命令名，例如 `nga serve`
- 文件存储：当前工作区 `.agent-team/` + 用户数据目录日志

## 4. CLI 约定

- CLI 默认使用当前目录作为工作目录，`task headless`、`task ui` 在解析 `--cwd` 时要求目标路径真实存在且为目录；创建 CLI 上下文前都会先执行一次 `<cmd> --help` 预检查，默认 `cmd=opencode`，失败即直接报错。
- CLI 提供 `task headless`、`task ui`：前者会新建当前 Task、打印本轮群聊并在任务结束后退出；后者会新建当前 Task、启动本地 Web Host、打开浏览器页面并持续驻留到 `Ctrl+C` / `SIGTERM`。
- `task ui` 只会使用已构建好的静态资源；启动前会检查 `index.html` 是否存在，浏览器地址与本地 Web Host 监听地址统一使用 `localhost`，缺少入口文件时直接报错。
- CLI / 终端里的 attach 文案都直接显示底层 `<cmd> attach ...`；当 `group` 新增 runtime agent 且获得新 session 时，会增量打印新的 attach 命令，默认 `cmd=opencode`。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` / `task ui` 必须显式传入 `--cwd`。收到 `Ctrl+C` / `SIGTERM` 时，CLI 会先回收当前命令启动或连接过的全部 OpenCode 实例，再结束进程。

## 5. 开发与打包

开发环境：

```bash
bun install
bun run cli -- help
```
opencode源代码的本地路径：~/code/opencode-origin

- 前端开发或修改 UI 相关文件后，必须执行 `bun run build`，生成最新的 `dist/web/`，避免浏览器继续读取旧 UI 产物。
- `task ui` 只会读取已构建好的 `dist/web/` 或编译产物内嵌的网页资源；源码运行时若缺少最新 `dist/web/`，或最终静态目录中缺少 `index.html`，会直接报错，不会再自动起 Vite 开发服务器兜底。

常用构建命令：

```bash
bun run build
bun run dist:win
bun run dist:mac-arm64
bun run dist:mac-x64
```
