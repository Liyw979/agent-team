# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求。后续协作默认以本文件为准。

## 1. 项目概览

### 1.1 产品定位

- Agent Flow 是面向 OpenCode 的 Project / Task 两层 Code Agent 编排桌面工具。
- Project 是任务协作容器，Task 是最小执行单元。
- GUI 主布局为：左侧 `Project + Task` 列表，右侧上方大拓扑图，右侧下方左聊天、右 Agent 列表。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode、Zellij 与文件存储逻辑。

### 1.2 技术栈

- Electron
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- OpenCode Server (`opencode serve`)
- Zellij
- 文件存储：全局用户数据目录 + Project 内 `.agentflow/`

## 2. 真源与配置边界

### 2.1 Agent 配置

- 当前项目不再内置本地 Agent 模板文件，也不再依赖 `.opencode/agents/**/*.md` 作为运行真源。
- Agent 统一由用户目录中的自定义配置提供；运行时读取 `$AGENTFLOW_USER_DATA_DIR/custom-agents.json`。未显式设置 `AGENTFLOW_USER_DATA_DIR` 时，使用默认用户数据目录。
- 同一份配置里既保存已写入当前 Project 的 Agent，也保存当前 Project 的内置模板 prompt 覆盖。
- 只允许用户自定义 prompt；当前 Project 可以不设置可写 Agent，也可以从已写入当前 Project 的 Agent 中指定 1 个作为可写 Agent。
- 同一 Project 中最多只能有 1 个可写 Agent；只要当前 Project 已写入 `Build`，`Build` 就会固定为唯一可写 Agent。
- `Build` 作为默认内置模板提供，但继续使用 OpenCode 自带 prompt，不支持在 AgentFlow 中修改 prompt、覆盖模板或改名；只能按需写入当前 Project 或从当前 Project 删除。
- `UnitTest` 默认内置模板使用“单元测试审查”文案：先检查当前改动是否提供了测试；若没有测试，要明确指出缺失测试。若存在测试，再检查是否遵循“一个功能点一个测试、分支覆盖完全、每个测试有注释、执行极快、尽量使用纯函数而不是 Mock”四条标准，并给出修改建议。
- 一旦当前 Project 出现 Task 启动记录，Agent 与内置模板配置都会被锁定，不允许继续修改。

### 2.2 Project / Topology / Task 真源

- Project 只保留全局注册信息；拓扑、Task、消息、panel 绑定等运行数据保存在各自 Project 目录下的 `.agentflow/`。
- 默认拓扑只在 Project 首次初始化且当前还没有拓扑数据时，按当前 Agent 列表自动推断。
- Project 一旦已有拓扑，后续运行时只认当前拓扑，不会再根据固定名字做调度判断。
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取当前 Project 当前生效的自定义 Agent 配置，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段。
- 当前处于项目开发初期，不要求兼容历史数据；若现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支。

### 2.3 用户数据目录与日志

- 全局 Project 注册信息位于用户数据目录下的 `projects.json`。
- 命令执行失败等诊断日志统一写入用户数据目录下的 `logs/agentflow.log`。
- Windows 默认日志路径为 `%APPDATA%\agentflow\logs\agentflow.log`。
- CLI 不再在 `<project>/.agentflow/projects.json` 静默回退创建本地 Project registry；若默认全局目录不可写，必须显式设置 `AGENTFLOW_USER_DATA_DIR`。

## 3. 运行时与编排约定

### 3.1 OpenCode 注入与运行时

- 每个 Project 都会启动各自独立的 `opencode serve`。
- 实例会优先监听 `127.0.0.1:4096`；若端口被占用，则自动切换到本机空闲端口，并让该 Project 的 pane attach / 健康检查跟随实际端口。
- 启动 `opencode serve` 前，只会一次性注入当前 Project 中真正需要自定义 prompt / permission 的 Agent 配置；单个 serve 运行中不会做 reload / 二次注入。
- 只有当前 Project 中真正需要自定义 prompt / permission 的 Agent 才会写入 `OPENCODE_CONFIG_CONTENT`。
- `Build` 这类继续复用 OpenCode 内置 prompt 的 Agent 不会出现在 `OPENCODE_CONFIG_CONTENT` 中；若当前 Project 只有这类 Agent，则不会额外生成注入内容。
- 不同 Project 的请求会继续携带 `x-opencode-directory` 请求头，保持会话与工作区目录一致。
- Session 创建对齐官方 `POST /session`；消息发送对齐官方 `POST /session/:id/message`，请求体使用 `parts` 数组。
- 若本机未安装或无法连接 `opencode serve`，系统会直接报错并写入日志，不再退化为 mock 响应。

### 3.2 Task 初始化与状态流转

- 每个 Task 对应独立 Zellij session，并为当前 Project 的全部 Agent 建立 `panel <-> agent` 运行时映射。
- CLI 与 GUI 都支持先单独执行 `task init`：先创建 Task，并把当前 Project 的全部 Agent OpenCode session / Zellij pane 初始化完成。
- 若当前节点执行完成后，拓扑里不存在可自动继续推进的下游节点，Task 会进入 `waiting` 状态；左侧 Task 列表与群聊系统消息必须同步反映该状态。
- 当 Task 进入 `finished` 状态时，右侧拓扑面板中的每个 Agent 节点都统一显示为 `已完成`，不再保留 `未启动 / 运行中` 等中间状态；聊天区会追加一条“任务已经结束”的系统消息。
- Agent 运行态成功码统一使用 `completed`。
- Agent 一旦给出需要继续响应的 `<revision_request> ...` 尾段，系统会把当前 Task 直接结束并标记为“不通过”；失败链路不再单独派发固定 Agent。
- 同一个上游 Agent 在收到回流意见后再次成功交付时，会重新派发当前拓扑里满足条件的全部下游 Agent；不会因为某个下游在上一轮已成功执行过，就被静默跳过。

### 3.3 拓扑与调度

- 拓扑边只保留一种触发语义：`success`，表示当前 Agent 审查通过或执行完成后自动触发下游。
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列。
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时，默认优先取当前列表首个 Agent 作为最左侧起点。
- 拓扑节点顶部直接展示 Agent 当前状态徽标，包括 `未启动 / 运行中 / 已完成 / 执行失败`；审查类 Agent 则显示 `审查通过 / 审查不通过`。
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息中展示。
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中。

### 3.4 聊天与消息传递

- Task 群聊支持 `@AgentName` 提交任务；输入 `@` 会弹出候选 Agent 列表，支持方向键、鼠标和 `Tab` 自动补全。
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示保留原始 `@Agent` 文本；底层发送给目标 Agent 前，会去掉仅用于寻址的开头或结尾 `@Agent`，并按 raw 模式封装为单行 `[User] <正文>`，不会拼成下游结构化段落。
- 群聊中同时展示 `user -> agent`、`agent -> agent` 协作消息，以及 Agent 最终回复。
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息。
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看，不会作为“尚未收到的群聊历史”再次转发给下游 Agent。
- Agent 自动触发下游 Agent 时，会封装 `[Initial Task]` 与 `[From <AgentName> Agent]` 结构化段落；其中 `[Initial Task]` 固定承载当前 Task 的首条用户任务。
- 对非 `Build` 下游，系统会在 `[Project Git Diff Summary]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动；发给 `Build` 时不附带该段。
- Agent 自动派发下游时，不会额外补充整段群聊历史，但会携带本轮需要的首条用户任务与当前上游结果；若上游结果已完整包含用户消息，会自动去重。
- 群聊落库与 Agent 间转发只使用 OpenCode 返回消息里的公开 `text` part；`reasoning`、步骤和工具调用不会混入群聊正文或下游 prompt。
- 同一个 Agent 的最终回复后若紧接着自动向下游传递，群聊会把“最终回复 + 下游派发提示”合并成同一条消息；合并后只追加 `@目标Agent` 标记，避免连续出现两条重复的同名 Agent 卡片。
- 审查 Agent 给出 `<revision_request> ...` 尾段后，群聊会把该 Agent 的结果正文与回应请求合并展示成同一条消息，并在消息末尾统一追加 `@目标Agent` 标记。
- Agent 最终回复写入群聊时，只会在命中“正式结果 / 最终回复 / 最终交付 / 结论”等明确交付标题时提取对应尾部章节展示；若只是普通结构化文档而不存在这类标题，则保留完整正文，避免误截断到附录内容。

### 3.5 GUI 交互

- 右下角团队成员面板顶部仅展示当前 Task 的 panel 绑定摘要，不再额外显示最后一条群聊消息预览。
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系仍可通过点击节点编辑。
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态。
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent。
- 右下角展示 Project 全量 Agent，以及它们在当前 Task 语境下的状态。
- GUI 中点击 Agent 支持直接编辑并保存当前 Agent 的名称、prompt 与可写状态；内置模板仍是可选项，不会自动写入当前 Project。可先单独编辑可编辑模板的 prompt，再按需写入为 Agent，且模板修改只影响当前 Project，不影响新项目默认值。
- 内置模板阶段统一不允许选择“设为可写 Agent”；`Build` 模板使用 OpenCode 自带 prompt，这里只负责选择是否加入当前 Project 或删除已写入项。
- 一旦当前 Project 出现 Task 启动记录，Agent 与内置模板配置都会被锁定，不允许继续修改。
- 前端不嵌入终端，也不复刻 Zellij panel；GUI 只展示 Task 级聊天流、拓扑和 Agent 状态。

### 3.6 Zellij 与终端行为

- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane。
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便 debug 当前会话。
- 右下角团队成员面板中，每个 Agent 名称旁都会提供“打开终端”按钮；点击后会优先补齐当前 Task 的 pane 绑定，并直接打开该 Agent 自己的 OpenCode attach 独立终端窗口，而不是带出整个 Zellij session 网格。
- Zellij pane 顺序只跟随前端拓扑 / 团队成员区里用户拖拽后保存的 Agent 排序，不再根据运行态动态重排。
- 全新 Task 首次初始化且当前还没有托管 pane 时，Zellij 会优先按“先横向后换行”的 tiled grid 创建初始 pane 布局，并限制最多两排；内部 pane 会按当前保存的 Agent 顺序排布。
- 左侧 Task 列表会定期与 Zellij session 状态同步；如果对应 session 已被外部删除，或只剩 `EXITED - attach to resurrect` 这类非活跃残留，只有已经结束的 Task 才会自动从列表中移除；`pending / running / waiting` 等未结束 Task 会保留，避免正在运行的任务被误删。
- 左侧 Project 卡片支持右键删除 Project；删除时会同时清理该 Project 的 Task 记录、`.agentflow/` 运行态数据、用户目录里的自定义 Agent 配置，以及相关 Zellij session / `opencode serve`，但不会删除项目源码目录。
- 左侧 Task 列表支持右键删除 Task；删除时会同时清理该 Task 对应的 Zellij session。
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内。
- Zellij pane 内部启动命令会按平台生成：macOS / Linux 使用 `/bin/sh`，Windows 使用 `cmd.exe`，不再把 POSIX shell 语法直接下发到 Windows pane。
- macOS / Linux 仍要求本机可执行 `zellij`；Windows 会优先使用打包产物内的 `resources/bin/zellij.exe`，开发期回退到项目内置的 `download/zellij.exe`；只有这两个位置都缺失时才会追加系统提醒。
- macOS 下会固定新开独立 Terminal 窗口后再 attach；Windows 下会以普通窗口的最大化状态打开新拉起的终端，不再自动切到全屏。
- 如果当前环境缺少可用的 `zellij`，GUI 和 CLI 会给出显式提醒；Task 群聊也会追加系统消息说明当前不会创建真实 Zellij pane。

## 4. CLI 约定

- CLI 默认使用当前目录作为 project cwd。
- CLI 只支持当前 Agent 名称。
- `task init` 会先创建 Task，并把全部 Agent 的 OpenCode session / Zellij pane 启动完成；GUI 输入框会优先弹出候选 Agent 并默认选中当前列表第一个 Agent，CLI 仍通过 `task send <agent> <message...>` 指定目标。
- `task send <agent> <message...>` 成功后会打印可复制的 panel 打开命令。
- `task debug-info` 默认读取当前 Project 最新 Task，并只输出聊天区里实际展示的合并消息；追加 `--full` 后，才会输出 `zellijSessionId`、`opencodeSessionId`、panel 打开命令和完整运行态数据；也可以显式传入 `taskId`。
- `task show <taskId>` 与 `task init` 在交互式终端里默认直接进入对应 Zellij session。
- `npm run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标 Project，请改用外层包装脚本并显式传入 `--cwd`。
- CLI 与 GUI 复用同一套 Project / Task / Agent / 拓扑 / panel 运行时能力。

常用命令示例：

```bash
npm run cli -- help

npm run cli -- agent list
npm run cli -- agent show <agentName>
npm run cli -- agent cat <agentName>

npm run cli -- task list
npm run cli -- task init --title "初始化手动测试"
npm run cli -- task send <agentName> "请先分析需求并推进实现。"
npm run cli -- task send <agentName> "请先分析需求并推进实现。" --task <taskId>
npm run cli -- task show <taskId>
npm run cli -- task messages <taskId>
npm run cli -- task panels <taskId>
npm run cli -- task debug-info --json
npm run cli -- task debug-info --json --full

npm run cli -- topology show
npm run cli -- topology set-downstream <sourceAgent> <targetAgent1> <targetAgent2>

npm run cli -- panel focus <taskId> <agentName>
```

CLI 能力分组：

- `project`：Project 列表、当前 Project 展示、创建 Project。
- `task`：Task 列表、Task 初始化、Task 群聊查看、排障信息查看、向特定 Agent 发消息、查看当前 Task 的 panel 绑定。
- `agent`：Project 级 Agent 列表、查看 Agent 元信息、读取 Agent prompt。
- `topology`：查看当前 Project 拓扑、修改某个 Agent 的下游关系。
- `panel`：通过 `panel focus` 直接打开指定 Task / Agent 的 OpenCode 独立终端窗口。

## 5. 存储布局与仓库结构

### 5.1 存储布局

- 全局 Project 注册信息位于用户数据目录下的 `projects.json`。
- 自定义 Agent 配置位于用户数据目录下的 `custom-agents.json`。
- 命令执行失败等诊断日志位于用户数据目录下的 `logs/agentflow.log`。
- 每个 Project 自己的拓扑、Task、消息、panel 绑定等数据位于 `<project>/.agentflow/state.json`。
- OpenCode runtime 和 pane runtime 也统一落到 `.agentflow/` 下，便于随 Project 一起迁移。

### 5.2 仓库结构

```txt
agentflow/
├── electron/
│   ├── cli/
│   │   └── index.ts
│   ├── main/
│   │   ├── index.ts
│   │   ├── orchestrator.ts
│   │   ├── store.ts
│   │   ├── zellij-manager.ts
│   │   ├── opencode-client.ts
│   │   └── user-data-path.ts
│   └── preload.ts
├── shared/
│   ├── ipc.ts
│   ├── terminal-commands.ts
│   └── types.ts
├── src/
│   ├── components/
│   ├── lib/
│   ├── store/
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── config/
│   ├── agentflow.kdl
│   └── opencode.example.json
├── download/
│   └── zellij.exe
└── AGENTS.md
```

## 6. 开发与打包

开发环境：

```bash
npm install
npm run electron:dev
```

常用构建命令：

```bash
npm run build
npm run dist:win
```

打包注意事项：

- Windows 打包前必须先刷新当前源码对应的 Electron 产物，禁止直接复用旧 `out/`。
- 推荐直接使用 `npm run dist:win`；该命令会先执行 `npm run build` 生成最新 `out/main`、`out/preload`、`out/renderer`，再生成 `dist/win-unpacked/` 目录产物。
- Windows 主程序位于 `dist/win-unpacked/agentflow.exe`。
- 打包后的 `zellij.exe` 位于 `dist/win-unpacked/resources/bin/zellij.exe`。
- 如果只想单独刷新 Electron 产物，可以执行 `npm run build`。

## 7. 文档同步要求

以下变更必须同步检查并在需要时更新本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agentflow/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化

## 8. 后续建议

- 把协作消息做得更接近 “Agent @ Agent” 的可视化协作流。
- 为 `.agentflow/state.json` 增加更明确的 schema version 与升级策略。
- 补充集成测试。
