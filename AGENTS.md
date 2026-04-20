# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求。后续协作默认以本文件为准。

## 1. 项目概览

### 1.1 产品定位

- Agent Team 是面向 OpenCode 的单工作区 Task Code Agent 编排桌面工具。
- 当前系统只关注当前 `cwd` 下的团队拓扑、Task 会话、群聊记录与 Agent 运行态，不再维护 Project 概念。
- GUI 主布局为：上方当前 Task 拓扑图，下方左侧当前 Task 群聊，右侧当前 Task Agent 列表；前端只负责展示与聊天发消息，不负责任何配置写入。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode 与文件存储逻辑。

### 1.2 技术栈

- Node.js CLI + 浏览器 Web Host
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- OpenCode Server (`opencode serve`)
- 文件存储：当前工作区 `.agent-team/` + 用户数据目录日志

## 2. 真源与配置边界

### 2.1 Agent 配置

- Agent prompt、可写权限与拓扑的唯一真源是团队拓扑 JSON 文件；运行时按该文件编译结果启动当前 Task。
- 前端不提供 Agent prompt、拓扑、模板或团队成员配置入口；这类修改只能通过 JSON 拓扑文件完成。
- 运行时不再保留 `DEFAULT_BUILTIN_AGENT_TEMPLATES`、用户目录 prompt 覆盖或其他前端回填链路。
- `Build` 继续复用 OpenCode 自带 prompt；其他 Agent 的 prompt 必须在团队拓扑 JSON 中显式提供。
- 同一工作区中最多只能有 1 个可写 Agent；只要当前拓扑包含 `Build`，`Build` 就会固定为唯一可写 Agent。
- 已有 Task 后，后续仍允许通过新的 JSON 拓扑重新覆盖当前工作区配置；运行时始终以最新应用的 JSON 编译结果为准。

### 2.2 工作区 / Topology / Task 真源

- 当前 CLI / GUI 只关注当前 `cwd` 的单 Task 会话；`.agent-team/` 保存当前工作区的拓扑、Task、消息与运行态数据。
- 拓扑不再自动推断，也不再由前端保存；新建 Task 时必须显式提供团队拓扑 JSON 文件。
- Task 不再快照 Agent 的 prompt / permission 定义；运行时只认当前拓扑 `nodeRecords` 中的 `prompt / writable` 元数据与 `Build` 的 OpenCode 内置 prompt。
- 当前处于开发初期，不要求兼容历史 Project 数据；旧的 Project registry / projectId 模型均已移除。
- LangGraph 是唯一调度运行时；每个 Task 都以 `taskId` 作为 graph `thread_id` 持久化 checkpoint，并在恢复时以该 checkpoint 作为调度真源。

### 2.3 用户数据目录与日志

- 命令执行失败等诊断日志统一写入用户数据目录下的 `logs/agent-team.log`。
- Windows 默认日志路径为 `%APPDATA%\agent-team\logs\agent-team.log`。
- 当前不再维护全局 `projects.json` registry；若默认用户数据目录不可写，必须显式设置 `AGENT_TEAM_USER_DATA_DIR`。

## 3. 运行时与编排约定

### 3.1 OpenCode 注入与运行时

- 每个工作区都会启动各自独立的 `opencode serve`。
- 实例会优先监听 `127.0.0.1:4096`；若端口被占用，则自动切换到本机空闲端口，并让当前工作区的 attach / 健康检查跟随实际端口。
- 启动 `opencode serve` 前，只会一次性注入当前工作区里真正需要自定义 prompt / permission 的 Agent 配置；单个 serve 运行中不会做 reload / 二次注入。
- 注入内容优先取当前拓扑 `nodeRecords` 里的 Agent prompt / writable；不会再被用户目录或前端配置覆盖。
- 只有当前工作区中真正需要自定义 prompt / permission 的 Agent 才会写入 `OPENCODE_CONFIG_CONTENT`。
- `Build` 这类继续复用 OpenCode 内置 prompt 的 Agent 不会出现在 `OPENCODE_CONFIG_CONTENT` 中；若当前工作区只有这类 Agent，则不会额外生成注入内容。
- 请求会继续携带 `x-opencode-directory` 请求头，保持会话与工作区目录一致。
- Session 创建对齐官方 `POST /session`；消息发送对齐官方 `POST /session/:id/message`，请求体使用 `parts` 数组。
- 若本机未安装或无法连接 `opencode serve`，系统会直接报错并写入日志，不再退化为 mock 响应。

### 3.2 Task 初始化与状态流转

- CLI 通过 `task headless`、`task ui` 管理当前工作区 Task 会话；GUI 只负责展示当前 Task，不再承担初始化或配置职责。
- 若当前节点执行完成后，拓扑里不存在可自动继续推进的下游节点，Task 会进入 `waiting` 状态；左侧 Task 列表与群聊系统消息必须同步反映该状态。
- 当 Task 进入 `finished` 状态时，右侧拓扑面板中的每个 Agent 节点都统一显示为 `已完成`，不再保留 `未启动 / 运行中` 等中间状态；聊天区会追加一条“任务已经结束”的系统消息。
- Agent 运行态成功码统一使用 `completed`。
- 审查 Agent 若显式返回标签段，系统只识别以 `<needs_revision>` 或 `<approved>` 开头的尾段，右侧结束标签可选；其中 `<needs_revision>` 表示需要继续回应，若当前拓扑存在可用的 `needs_revision` 下游，系统会继续按失败链路把意见回流给对应下游；只有不存在可继续派发的失败链路时，才会把当前 Task 结束并标记为“不通过”。若审查 Agent 没有返回正确的 `<needs_revision>` 或 `<approved>` 标签，系统默认按通过处理。
- 同一个上游 Agent 在收到回流意见后再次成功交付时，会重新派发当前拓扑里满足条件的全部下游 Agent；不会因为某个下游在上一轮已成功执行过，就被静默跳过。

### 3.3 拓扑与调度

- LangGraph 现作为唯一调度运行时核心；`TopologyRecord` 继续是产品真源，运行时会在主进程内把它编译为图状态与调度索引。
- 拓扑边持久化 `source / target / triggerOn`；`triggerOn` 只允许 `association`、`approved`、`needs_revision`。
- 当某个 Agent 存在“直接下游通过 `association` 触发、且该下游会用 `needs_revision` 直接回流给自己、同时该下游没有 `approved` 下游”的审查回路时，系统会先只放行这类直接审查回路；只有这些回路全部通过后，才会继续放行该 Agent 其余直接 `association` 下游，避免 Build 与单个审查 Agent 多轮对话时反复提前触发无关下游。
- 同一轮里若某个 Agent 需要同时触发多个直接 `association` 下游 reviewer，这批 reviewer 会并发启动；只有当前整批 reviewer 都返回后，系统才会决定是否回流给上游修复，或继续补跑这一轮尚未确认通过的 reviewer，避免把并发批次错误串成“一次只放行一个”。
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列。
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时，默认优先取 `Build` 作为最左侧起点；若当前 Project 尚未写入 `Build`，则不会偷偷回退到其他 Agent 作为默认起点。
- 拓扑配置中的 `nodes` 统一保存为有序的 Agent 名称字符串数组；该数组既是节点集合真源，也是节点顺序真源，不再额外保存 `agentOrderIds`、节点 `kind` 或节点对象里的冗余 `id/label` 字段。
- 拓扑配置不再单独持久化 `startAgentId`；默认入口语义统一按当前 `nodes` 与 `Build` 是否存在在运行时推导，避免与节点顺序真源重复。
- 编译后的最终拓扑会额外持久化 `topology.langgraph` 边界信息：`start.id` 固定为 LangGraph 的 `__start__`，并显式保存它连接到哪些业务节点；`end` 只有在团队拓扑明确声明“存在语义上的结束节点”时才会写入 `__end__`，像当前开发团队这类依靠调度状态自然收束的拓扑会把 `end` 保存为 `null`，而不是伪造一个业务 EndNode。
- 拓扑配置中的 `edges` 持久化 `source / target / triggerOn`；当 `triggerOn = needs_revision` 时，还会额外持久化该边自己的 `maxRevisionRounds`，用于限制这条审视回流链路可连续反驳的最大轮数，默认值为 `4`。边的唯一标识在运行时按三元组即时推导，不再单独持久化 `id` 字段。
- 拓扑节点顶部直接展示 Agent 当前状态徽标，包括 `未启动 / 运行中 / 已完成 / 执行失败`；审查类 Agent 则显示 `审查通过 / 审查不通过`。
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息中展示。
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中。
- 前端拓扑编辑面板支持为每一条 `needs_revision` 关系单独配置“最大反驳次数”；默认显示 `4`，不同审视关系可以分别保存不同数值。

### 3.4 聊天与消息传递

- Task 群聊支持 `@AgentName` 提交任务；输入 `@` 会弹出候选 Agent 列表，支持方向键、鼠标和 `Tab` 自动补全。
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示保留原始 `@Agent` 文本；底层发送给目标 Agent 前，会去掉仅用于寻址的开头或结尾 `@Agent`，并按 raw 模式封装为单行 `[User] <正文>`，不会拼成下游结构化段落。
- 群聊中同时展示 `user -> agent`、`agent -> agent` 协作消息，以及 Agent 最终回复。
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息。
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看，不会作为“尚未收到的群聊历史”再次转发给下游 Agent。
- Agent 自动触发下游 Agent 时，只有首次自动流转会封装 `[Initial Task]` 与 `[From <AgentName> Agent]` 结构化段落；后续 Agent 间继续流转时只保留 `[From <AgentName> Agent]`，其中 `[Initial Task]` 固定承载当前 Task 的首条用户任务。
- 对非 `Build` 且非审查类的下游，系统会在 `[Project Git Diff Summary]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动；发给 `Build` 或审查类 Agent 时不附带该段，避免把辅助上下文误判为待审正文。
- Agent 自动派发下游时，不会额外补充整段群聊历史，但会携带本轮需要的首条用户任务与当前上游结果；若上游结果已完整包含用户消息，会自动去重。
- 群聊落库与 Agent 间转发只使用 OpenCode 返回消息里的公开 `text` part；`reasoning`、步骤和工具调用不会混入群聊正文或下游 prompt。
- 同一个 Agent 的最终回复后若紧接着自动向下游传递，群聊会把“最终回复 + 下游派发提示”合并成同一条消息；合并后只追加 `@目标Agent` 标记，避免连续出现两条重复的同名 Agent 卡片。
- 审查 Agent 给出以 `<needs_revision>` 开头的尾段后，群聊会把该 Agent 的结果正文与回应请求合并展示成同一条消息，并在消息末尾统一追加 `@目标Agent` 标记；右侧结束标签可选。
- Agent 最终回复写入群聊时，只会在命中“正式结果 / 最终回复 / 最终交付 / 结论”等明确交付标题时提取对应尾部章节展示；若只是普通结构化文档而不存在这类标题，则保留完整正文，避免误截断到附录内容。

### 3.5 GUI 交互

- 右下角团队成员面板只展示当前 Task 的 Agent 运行态与 attach 入口，不再提供任何配置按钮。
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系仍可通过点击节点编辑。
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态。
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent。
- 右下角展示当前工作区拓扑中的全部 Agent，以及它们在当前 Task 语境下的状态。
- 前端不再提供 Agent、Prompt、拓扑、Project、Task 的创建、删除、编辑与保存入口。
- 前端不嵌入终端；GUI 只展示当前 Task 的聊天流、拓扑和 Agent 状态，并允许继续发消息。

### 3.6 终端行为

- GUI 和 CLI 都通过 OpenCode session attach 到单个 Agent，会话调试入口统一围绕 OpenCode。
- 右下角团队成员面板中，每个 Agent 名称旁都会提供“attach”按钮，直接打开该 Agent 自己的 OpenCode attach 独立终端窗口。
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内。
- 应用退出时，会统一关闭当前工作区相关的 `opencode serve` 与其派生会话。

## 4. CLI 约定

- CLI 默认使用当前目录作为工作目录。
- CLI 只保留 `task headless`、`task ui`、`task attach`。
- `task headless --file <topology.json> --message <message>` 会新建当前 Task，打印本轮群聊，任务结束后退出到 shell。
- `task ui --file <topology.json> --message <message> [--cwd <path>]` 会新建当前 Task，后台启动本地 Web Host，并在浏览器中打开当前 Task 页面。
- `task ui <taskId> [--cwd <path>]` 会恢复已有 Task，并在浏览器中打开当前 Task 页面；传入 `--cwd` 时会作为任务定位的优先工作区。
- `task attach <taskId> <agentName>` 会 attach 到指定 Task 的目标 Agent OpenCode session；所有用户可见 attach 文案都统一显示这条高层命令，不展示底层 `opencode attach ...`。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` 请显式传入 `--cwd`；`task attach` 则应直接传入目标 `taskId`。

常用命令示例：

```bash
bun run cli -- help

bun run cli -- task headless --file config/team-topologies/development-team.topology.json --message "请开始一轮开发团队协作。"
bun run cli -- task ui --file config/team-topologies/development-team.topology.json --message "请开始一轮开发团队协作。" --cwd /path/to/workspace
bun run cli -- task ui <taskId> --cwd /path/to/workspace
bun run cli -- task attach <taskId> <agentName>
```

CLI 能力分组：

- `task headless`：运行一轮任务，结束后退出 CLI。
- `task ui`：运行或恢复任务，并在浏览器里打开当前 Task 页面。
- `task attach`：attach 到指定 Task 的指定 Agent OpenCode 会话。

## 5. 存储布局与仓库结构

### 5.1 存储布局

- 命令执行失败等诊断日志位于用户数据目录下的 `logs/agent-team.log`。
- 当前工作区的拓扑、Task、消息与运行态数据位于 `<cwd>/.agent-team/state.json`。
- 当前工作区网页界面 Host 的运行态位于 `<cwd>/.agent-team/ui-host.json`。
- 团队拓扑 JSON 编译后的 Agent prompt / writable 元数据会跟随当前拓扑保存在 `<cwd>/.agent-team/state.json` 的 `topology.nodeRecords` 中。
- 团队拓扑 JSON 编译后的 LangGraph 边界信息会跟随当前拓扑保存在 `<cwd>/.agent-team/state.json` 的 `topology.langgraph` 中。
- 每个 Task 的 LangGraph checkpoint 位于 `<cwd>/.agent-team/langgraph/`。
- OpenCode runtime 也统一落到 `.agent-team/` 下，便于随当前工作区一起迁移。

### 5.2 仓库结构

```txt
agent-team/
├── cli/
│   ├── index.ts
│   ├── launcher.cjs
│   └── web-host.ts
├── runtime/
│   ├── gating-state.ts
│   ├── gating-router.ts
│   ├── langgraph-host.ts
│   ├── langgraph-runtime.ts
│   ├── orchestrator.ts
│   ├── topology-compiler.ts
│   ├── store.ts
│   ├── opencode-client.ts
│   └── user-data-path.ts
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
│   └── opencode.example.json
└── AGENTS.md
```

## 6. 开发与打包

开发环境：

```bash
bun install
bun run cli -- help
```

常用构建命令：

```bash
bun run build
bun run dist:win
```

交付前检查：

- 每次交付前必须在仓库根目录运行 `bun test`，并以测试通过作为交付前置条件。

打包注意事项：

- 推荐直接使用 `bun run dist:win`；该命令会先执行 `bun run build` 生成最新 `dist/web/`，再生成单文件 `dist/agent-team.exe`。
- Windows 主程序位于 `dist/agent-team.exe`。
- 打包后的网页静态资源会内嵌在 `agent-team.exe` 中，并在运行时自动释放到本地 runtime 目录。
- 如果只想单独刷新网页产物，可以执行 `bun run build`。

## 7. 文档同步要求

以下变更必须同步检查并在需要时更新本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agent-team/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化

## 8. 后续建议

- 把协作消息做得更接近 “Agent @ Agent” 的可视化协作流。
- 为 `.agent-team/state.json` 增加更明确的 schema version 与升级策略。
- 补充集成测试。
