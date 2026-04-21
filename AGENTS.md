# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求。后续协作默认以本文件为准。

## 1. 项目概览

### 1.1 产品定位

- Agent Team 是面向 OpenCode 的单工作区 Task Code Agent 编排桌面工具。
- 当前系统围绕当前 `cwd` 下的团队拓扑、Task 会话、群聊记录与 Agent 运行态工作，数据模型使用工作区与 Task。
- GUI 主布局为：上方当前 Task 拓扑图，下方左侧当前 Task 群聊，右侧当前 Task Agent 列表；前端只负责展示与聊天发消息，不负责任何配置写入。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode 与文件存储逻辑。

### 1.2 技术栈

- Node.js CLI + 浏览器 Web Host
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- OpenCode Server (`opencode serve`)
- 文件存储：当前工作区 `.agent-team/` + 用户数据目录日志

## 2. 功能地图（格式为文件名[方法列表]）

### 2.1 Agent 配置与拓扑应用

- 团队拓扑 JSON 会先编译为 Agent 与拓扑记录，再应用到当前工作区，Task 启动时读取这份编译结果。team-dsl[compileTeamDsl]、cli[ensureJsonTopologyApplied]、orchestrator[applyTeamDsl]
- Agent 的 prompt 与可写权限从当前拓扑的 `nodeRecords` 中提取，并在读取工作区 Agent 列表时即时恢复。project-agent-source[extractDslAgentsFromTopology]、orchestrator[listWorkspaceAgents]
- `Build` 使用 OpenCode 内置 prompt，拓扑归一化时会被识别为默认可写 Agent。types[usesOpenCodeBuiltinPrompt]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON 的 `agents` 数组统一使用对象格式；不再支持直接写成 `"Build"` 这类字符串简写。`Build` 即使未显式配置 `writable`，运行时也会默认视为可写。team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON 中每个 Agent 都可以通过 `writable` 字段显式声明是否具备写能力；系统允许多个可写 Agent 同时存在。project-agent-source[extractDslAgentsFromTopology, validateProjectAgents, buildInjectedConfigFromAgents]、orchestrator[submitTask, initializeTask]
- 新的团队拓扑 JSON 可以覆盖当前工作区拓扑，后续读取工作区或 Task 快照时会使用最新持久化结果。cli[ensureJsonTopologyApplied]、store[upsertTopology]、orchestrator[hydrateWorkspace, hydrateTask]

### 2.2 工作区状态与 Task 定位

- 当前工作区的拓扑、Task、消息与运行态统一存放在 `<cwd>/.agent-team/state.json`。store[getWorkspaceStatePath, readWorkspaceState, writeWorkspaceState]
- 新建 Task 需要显式传入团队拓扑 JSON 文件，CLI 会先校验参数再加载并应用定义。cli[validateTaskHeadlessCommand, validateTaskUiCommand, loadTeamDslDefinition, ensureJsonTopologyApplied]
- Task 快照读取当前工作区拓扑与 Agent 定义，`TaskRecord` 本身只保存任务状态与定位信息。store[getTopology]、orchestrator[hydrateTask]、project-agent-source[extractDslAgentsFromTopology]
- 用户数据目录维护 `task-locator.json` 作为 `taskId -> cwd` 的定位索引，恢复 Task 时会先按这份索引解析工作区。store[readTaskLocatorIndex]、task-index[findTaskLocatorCwd]、orchestrator[resolveTaskCwd]
- LangGraph 运行时把每个 Task 的 checkpoint 写入 `<cwd>/.agent-team/langgraph/`，并以 `taskId` 作为任务级调度标识。orchestrator[getLangGraphRuntime]、langgraph-runtime[deleteTask]

### 2.3 用户数据目录与日志

- CLI 启动时会解析用户数据目录并初始化 `logs/agent-team.log`。user-data-path[resolveCliUserDataPath]、app-log[initAppFileLogger]、cli[createCliContext]
- Windows 上的默认用户数据目录按 `%APPDATA%\\agent-team` 解析，因此日志路径对应为 `%APPDATA%\\agent-team\\logs\\agent-team.log`。user-data-path[resolveDefaultUserDataPath]、app-log[initAppFileLogger]
- 全局用户数据目录使用 `task-locator.json` 保存 Task 定位信息，默认目录不可写时需要显式设置 `AGENT_TEAM_USER_DATA_DIR`。store[getTaskLocatorIndexPath, readTaskLocatorIndex]、user-data-path[resolveCliUserDataPath]
- 诊断日志会以 JSON Lines 形式追加写入 `logs/agent-team.log`。app-log[appendAppLog]

## 3. 运行时与编排功能地图

### 3.1 OpenCode 注入与运行时

- 每个工作区都会启动各自独立的 `opencode serve`。opencode-client[ensureServer, startServer]
- 启动 OpenCode runtime 时直接执行 `opencode serve`，运行时会从启动输出中解析实际监听地址，并让当前工作区的 attach / 健康检查始终跟随该实际地址。opencode-client[startServer, getAttachBaseUrl, request]、opencode-serve-launch[extractOpenCodeServeBaseUrl]
- 启动 `opencode serve` 前，只会一次性注入当前工作区里真正需要自定义 prompt / permission 的 Agent 配置；单个 serve 运行中不会做 reload / 二次注入 / 配置变更触发的自动重启。orchestrator[setInjectedConfigForTask]、opencode-client[setInjectedConfigContent, startServer]
- 注入内容取当前拓扑 `nodeRecords` 里的 Agent prompt / writable。project-agent-source[extractDslAgentsFromTopology, buildInjectedConfigFromAgents]、orchestrator[setInjectedConfigForTask]
- 只有当前工作区中真正需要自定义 prompt / permission 的 Agent 才会写入 `OPENCODE_CONFIG_CONTENT`。project-agent-source[buildInjectedConfigFromAgents]、opencode-client[startServer]
- 使用 OpenCode 内置 prompt 的 Agent 不会出现在 `OPENCODE_CONFIG_CONTENT` 中；若当前工作区只有这类 Agent，则不会额外生成注入内容。types[usesOpenCodeBuiltinPrompt]、project-agent-source[buildInjectedConfigFromAgents]
- 请求会携带 `x-opencode-directory` 请求头，保持会话与工作区目录一致。opencode-client[request]
- Session 创建对齐官方 `POST /session`；消息发送对齐官方 `POST /session/:id/message`，请求体使用 `parts` 数组。opencode-client[createSession, submitMessage]
- 若本机未安装或无法连接 `opencode serve`，系统会直接报错并写入日志。opencode-client[startServer]、app-log[appendAppLog]

### 3.2 Task 初始化与状态流转

- CLI 通过 `task headless`、`task ui` 管理当前工作区 Task 会话；GUI 负责展示当前 Task，Task 初始化与配置变更由 CLI 和编排层处理。cli[validateTaskHeadlessCommand, validateTaskUiCommand, ensureJsonTopologyApplied]、orchestrator[initializeTask, submitTask]、App[App]
- 若当前节点执行完成后，拓扑里不存在可自动继续推进的下游节点，Task 会进入 `waiting` 状态；左侧 Task 列表与群聊系统消息必须同步反映该状态。gating-router[applyAgentResultToGraphState]、langgraph-runtime[resumeTask, runTaskLoop]、orchestrator[moveTaskToWaiting]
- 当 Task 进入 `finished` 状态时，右侧拓扑面板中的每个 Agent 节点都统一显示为 `已完成`；聊天区会追加一条“任务已经结束”的系统消息。orchestrator[completeTask]、task-completion-message[buildTaskCompletionMessageContent]、task-lifecycle-rules[reconcileTaskSnapshotFromMessages]、topology-graph-helpers[getTopologyAgentStatusBadgePresentation]
- Agent 运行态成功码统一使用 `completed`。gating-rules[resolveAgentStatusFromReview]、task-lifecycle-rules[reconcileTaskSnapshotFromMessages, resolveStandaloneTaskStatusAfterAgentRun]
- 审查 Agent 若显式返回标签段，系统只识别以 `<needs_revision>` 或 `<approved>` 开头的尾段，右侧结束标签可选；其中 `<needs_revision>` 表示需要继续回应，若当前拓扑存在可用的 `needs_revision` 下游，系统会继续按失败链路把意见回流给对应下游；只有不存在可继续派发的失败链路时，才会把当前 Task 结束并标记为“不通过”。若审查 Agent 没有返回正确的 `<needs_revision>` 或 `<approved>` 标签，系统默认按通过处理。review-parser[parseReview, stripStructuredSignals]、review-response[extractTrailingReviewSignalBlock]、gating-rules[resolveAgentStatusFromReview]、gating-router[applyAgentResultToGraphState, handleNeedsRevision]、orchestrator[createLangGraphBatchRunners, completeTask]
- 同一个上游 Agent 在收到回流意见后再次成功交付时，会重新派发当前拓扑里满足条件的全部下游 Agent；不会因为某个下游在上一轮已成功执行过，就被静默跳过。gating-scheduler[planAssociationDispatch, recordAssociationBatchResponse]、gating-router[continueAfterAssociationBatchResponse, triggerAssociationDownstream]

### 3.3 拓扑与调度

- LangGraph 是唯一调度运行时核心；`TopologyRecord` 是产品真源，运行时会在主进程内把它编译为图状态与调度索引。langgraph-runtime[resumeTask]、gating-router[createGraphTaskState, applyAgentResultToGraphState]、topology-compiler[compileTopology]
- 拓扑边持久化 `source / target / triggerOn`；`triggerOn` 只允许 `association`、`approved`、`needs_revision`。store[readWorkspaceState, writeWorkspaceState]、orchestrator[normalizeTopology]、topology-compiler[compileTopology]
- 当某个 Agent 存在“直接下游通过 `association` 触发、且该下游会用 `needs_revision` 直接回流给自己、同时该下游没有 `approved` 下游”的审查回路时，系统会先只放行这类直接审查回路；只有这些回路全部通过后，才会继续放行该 Agent 其余直接 `association` 下游，避免 Build 与单个审查 Agent 多轮对话时反复提前触发无关下游。gating-scheduler[planAssociationDispatch, recordAssociationBatchResponse]、gating-router[handleNeedsRevision, continueAfterAssociationBatchResponse]
- 同一轮里若某个 Agent 需要同时触发多个直接 `association` 下游 reviewer，这批 reviewer 会并发启动；只有当前整批 reviewer 都返回后，系统才会决定是否回流给上游修复，或继续补跑这一轮尚未确认通过的 reviewer，避免把并发批次错误串成“一次只放行一个”。gating-scheduler[planAssociationDispatch, recordAssociationBatchResponse]、orchestrator[createLangGraphBatchRunners]
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列。types[resolveTopologyAgentOrder]、orchestrator[saveTopology, normalizeTopology]、frontend-agent-order[orderAgentsForFrontend]
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时，默认优先取 `Build` 作为最左侧起点；当前拓扑未声明 `Build` 时，节点顺序按已声明的 Agent 顺序解析。types[resolveBuildAgentName, resolveTopologyAgentOrder, createDefaultTopology]
- 拓扑配置中的 `nodes` 统一保存为有序的 Agent 名称字符串数组；该数组既是节点集合真源，也是节点顺序真源，其他派生标识在运行时推导。store[readWorkspaceState, writeWorkspaceState]、orchestrator[normalizeTopology]
- 默认入口语义统一按当前 `nodes` 与 `Build` 是否存在在运行时推导，配置文件使用这套推导结果表达入口。types[resolvePrimaryTopologyStartTarget, resolveBuildAgentName, createDefaultTopology]
- 编译后的最终拓扑会额外持久化 `topology.langgraph` 边界信息：`start.id` 固定为 LangGraph 的 `__start__`，并显式保存它连接到哪些业务节点；`end` 只有在团队拓扑明确声明“存在语义上的结束节点”时才会写入 `__end__`，像当前开发团队这类依靠调度状态自然收束的拓扑会把 `end` 保存为 `null`，而不是伪造一个业务 EndNode。types[createTopologyLangGraphRecord]、team-dsl[createTopology, compileTeamDsl]、store[readWorkspaceState, writeWorkspaceState]
- 拓扑配置中的 `edges` 持久化 `source / target / triggerOn`；当 `triggerOn = needs_revision` 时，还会额外持久化该边自己的 `maxRevisionRounds`，用于限制这条审视回流链路可连续反驳的最大轮数，默认值为 `4`。边的唯一标识在运行时按三元组即时推导。types[normalizeNeedsRevisionMaxRounds, getNeedsRevisionEdgeLoopLimit, getTopologyEdgeId]、store[readWorkspaceState]、orchestrator[normalizeTopology]
- 拓扑节点顶部直接展示 Agent 当前状态徽标，包括 `未启动 / 运行中 / 已完成 / 执行失败`；审查类 Agent 则显示 `审查通过 / 审查不通过`。topology-graph-helpers[getTopologyAgentStatusBadgePresentation]、TopologyGraph[TopologyGraph]
- 拓扑图中每个 Agent 节点头部都会在状态 icon 左侧提供 `attach` 按钮；点击后直接打开该 Agent 对应的 OpenCode attach 终端。topology-graph-helpers[getTopologyNodeHeaderActionOrder]、TopologyGraph[TopologyGraph]、App[App]、orchestrator[openAgentTerminal]
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态；内置与本地类型信息仅在编辑面板等辅助信息中展示。topology-graph-helpers[getTopologyAgentStatusBadgePresentation]、agent-colors[getAgentColorToken]、TopologyGraph[TopologyGraph]
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中。topology-canvas[buildTopologyCanvasLayout]、TopologyGraph[TopologyGraph]
- 前端拓扑编辑面板支持为每一条 `needs_revision` 关系单独配置“最大反驳次数”；默认显示 `4`，不同审视关系可以分别保存不同数值。types[normalizeNeedsRevisionMaxRounds, getNeedsRevisionEdgeLoopLimit]、orchestrator[normalizeTopology]、store[readWorkspaceState, writeWorkspaceState]

### 3.4 聊天与消息传递

- Task 群聊支持 `@AgentName` 提交任务；输入 `@` 会弹出候选 Agent 列表，支持方向键、鼠标和 `Tab` 自动补全。chat-mentions[getMentionContext, getMentionOptionItems]、ChatWindow[ChatWindow]
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示保留原始 `@Agent` 文本；底层发送给目标 Agent 前，会去掉仅用于寻址的开头或结尾 `@Agent`，并按 raw 模式封装为单行 `[User] <正文>`，不会拼成下游结构化段落。task-submission[resolveTaskSubmissionTarget]、message-forwarding[stripTargetMention]、orchestrator[submitTask, createLangGraphBatchRunners]
- 群聊中同时展示 `user -> agent`、`agent -> agent` 协作消息，以及 Agent 最终回复。chat-messages[mergeTaskChatMessages]、ChatWindow[ChatWindow]、orchestrator[createLangGraphBatchRunners]
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息。orchestrator[createLangGraphBatchRunners, shouldSuppressDuplicateDispatchMessage]、chat-messages[mergeTaskChatMessages]
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看，不会作为“尚未收到的群聊历史”再次转发给下游 Agent。orchestrator[createLangGraphBatchRunners]、message-forwarding[buildDownstreamForwardedContextFromMessages]
- Agent 自动触发下游 Agent 时，只有首次自动流转会封装 `[Initial Task]` 与 `[From <AgentName> Agent]` 结构化段落；后续 Agent 间继续流转时只保留 `[From <AgentName> Agent]`，其中 `[Initial Task]` 固定承载当前 Task 的首条用户任务。orchestrator[consumeInitialTaskForwardingAllowanceFromGraphState, buildAgentExecutionPrompt]、message-forwarding[buildDownstreamForwardedContextFromMessages, getInitialUserMessageContent]
- 对非 `Build` 且非审查类的下游，系统会在 `[Project Git Diff Summary]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动；发给 `Build` 或审查类 Agent 时不附带该段，避免把辅助上下文误判为待审正文。orchestrator[buildProjectGitDiffSummary, createLangGraphBatchRunners]、types[usesOpenCodeBuiltinPrompt, isReviewAgentInTopology]
- Agent 自动派发下游时，不会额外补充整段群聊历史，但会携带本轮需要的首条用户任务与当前上游结果；若上游结果已完整包含用户消息，会自动去重。message-forwarding[buildDownstreamForwardedContextFromMessages, contentContainsNormalized]、orchestrator[createLangGraphBatchRunners]
- 群聊落库与 Agent 间转发只使用 OpenCode 返回消息里的公开 `text` part；`reasoning`、步骤和工具调用不会混入群聊正文或下游 prompt。opencode-client[extractVisibleMessageText, getSessionRuntime]、orchestrator[stripStructuredSignals]
- 同一个 Agent 的最终回复后若紧接着自动向下游传递，群聊会把“最终回复 + 下游派发提示”合并成同一条消息；合并后只追加 `@目标Agent` 标记，避免连续出现两条重复的同名 Agent 卡片。chat-messages[mergeTaskChatMessages]、chat-message-format[buildMentionSuffix, formatAgentDispatchContent]
- 审查 Agent 给出以 `<needs_revision>` 开头的尾段后，群聊会把该 Agent 的结果正文与回应请求合并展示成同一条消息，并在消息末尾统一追加 `@目标Agent` 标记；右侧结束标签可选。chat-messages[mergeTaskChatMessages]、chat-message-format[formatRevisionRequestContent]、review-response[stripReviewResponseMarkup, stripLeadingReviewResponseLabel]
- Agent 最终回复写入群聊时，只会在命中“正式结果 / 最终回复 / 最终交付 / 结论”等明确交付标题时提取对应尾部章节展示；若只是普通结构化文档而不存在这类标题，则保留完整正文，避免误截断到附录内容。chat-messages[extractAgentFinalDisplayContent, extractTrailingTopLevelSection]

### 3.5 GUI 交互

- 右下角团队成员面板展示当前 Task 的 Agent 运行态与 prompt 摘要。App[App]、agent-prompt-preview[buildAgentPromptPreviewText]
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系可通过点击节点编辑。TopologyGraph[TopologyGraph]、topology-canvas[buildTopologyCanvasLayout]
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态。agent-history[buildAgentHistoryItems]、TopologyGraph[TopologyGraph]、opencode-client[getSessionRuntime]
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent。agent-colors[getAgentColorToken]、ChatWindow[MessageBubble]、App[App]
- 右下角展示当前工作区拓扑中的全部 Agent，以及它们在当前 Task 语境下的状态。frontend-agent-order[orderAgentsForFrontend]、App[App]
- 前端聚焦当前 Task 的展示与消息发送；Agent、Prompt、拓扑、Project、Task 的创建、删除、编辑与保存通过 JSON、CLI 与运行时处理。App[App]、ChatWindow[ChatWindow]、cli[ensureJsonTopologyApplied]、orchestrator[applyTeamDsl, saveTopology]
- GUI 展示当前 Task 的聊天流、拓扑和 Agent 状态，并允许继续发消息；终端 attach 通过 OpenCode 外部终端打开。App[App]、ChatWindow[ChatWindow]、TopologyGraph[TopologyGraph]、web-api[openAgentTerminal]

### 3.6 终端行为

- GUI 和 CLI 都通过 OpenCode session attach 到单个 Agent，会话调试入口统一围绕 OpenCode。terminal-commands[buildCliOpencodeAttachCommand]、orchestrator[openAgentTerminal, launchAgentTerminal]、task-attach-display[renderTaskAttachCommands]
- OpenCode attach 入口统一位于拓扑图节点头部。topology-graph-helpers[getTopologyNodeHeaderActionOrder]、TopologyGraph[TopologyGraph]
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内。web-api[getTaskRuntime]、App[App]、orchestrator[getTaskRuntime]、opencode-client[getSessionRuntime]
- 应用退出时，会统一关闭当前工作区相关的 `opencode serve` 与其派生会话。orchestrator[dispose]、opencode-client[shutdown]、cli[disposeCliContext]

## 4. CLI 约定

- CLI 默认使用当前目录作为工作目录。
- CLI 提供 `task headless`、`task ui`。
- `task headless --file <topology.json> --message <message>` 会新建当前 Task，打印本轮群聊，任务结束后退出到 shell。
- `task ui --file <topology.json> --message <message> [--cwd <path>]` 会新建当前 Task，启动本地 Web Host，并在浏览器中打开当前 Task 页面；CLI 进程会继续驻留，直到收到 `Ctrl+C` / `SIGTERM` 才清理当前命令持有的 OpenCode 实例并退出。
- CLI / 终端里所有用户可见 attach 文案都直接显示底层 `opencode attach ...`，不再展示 `task attach` 包装命令。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` / `task ui` 请显式传入 `--cwd`。

常用命令示例：

```bash
bun run cli -- help

bun run cli -- task headless --file config/team-topologies/development-team.topology.json --message "请开始一轮开发团队协作。"
bun run cli -- task ui --file config/team-topologies/development-team.topology.json --message "请开始一轮开发团队协作。" --cwd /path/to/workspace
```

CLI 能力分组：

- `task headless`：运行一轮任务，结束后退出 CLI。
- `task ui`：新建任务并在浏览器里打开当前 Task 页面；命令会保持驻留，直到收到 `Ctrl+C` / `SIGTERM`。
- CLI 主进程收到 `Ctrl+C` / `SIGTERM` 时，会先回收当前这次命令启动或连接过的全部 OpenCode serve 实例，再结束当前命令，避免遗留孤儿会话。
- `task headless` 在任务自然结束退出时会打印本次回收掉的 OpenCode 实例 PID，`task ui` 则只会在收到 `Ctrl+C` / `SIGTERM` 清理退出时打印，便于排查残留进程。

## 5. 存储布局与仓库结构

### 5.1 存储布局

- 命令执行失败等诊断日志位于用户数据目录下的 `logs/agent-team.log`。
- 当前工作区的拓扑、Task、消息与运行态数据只在当前 CLI 进程内存中维护，不再落盘旧的工作区快照文件。
- 团队拓扑 JSON 编译后的 Agent prompt / writable 元数据与 LangGraph 边界信息也只保留在当前运行时内存快照中。
- 每个 Task 的 LangGraph checkpoint 位于 `<cwd>/.agent-team/langgraph/`。
- OpenCode runtime 统一落到 `.agent-team/` 下，便于随当前工作区一起迁移；OpenCode serve 端口、Agent session id 与 Web Host 定位信息由运行时内存态管理。

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

- 前端开发或修改 UI 相关文件后，必须执行 `bun run build`，生成最新的 `dist/web/`，避免浏览器继续读取旧 UI 产物。
- `task ui` 只会读取已构建好的 `dist/web/` 或编译产物内嵌的网页资源；源码运行时若缺少最新 `dist/web/`，会直接报错，不会再自动起 Vite 开发服务器兜底。

常用构建命令：

```bash
bun run build
bun run dist:win
bun run dist:mac-arm64
bun run dist:mac-x64
```

交付前检查：

- 每次交付前必须在仓库根目录运行 `bun test`，并以测试通过作为交付前置条件。

打包注意事项：

- 推荐直接使用 `bun run dist:win`；该命令会先执行 `bun run build` 生成最新 `dist/web/`，再生成单文件 `dist/agent-team.exe`。
- macOS Apple Silicon 打包命令为 `bun run dist:mac-arm64`，产物位于 `dist/agent-team-macos-arm64`。
- macOS Intel 打包命令为 `bun run dist:mac-x64`，产物位于 `dist/agent-team-macos-x64`。
- Windows 主程序位于 `dist/agent-team.exe`。
- 打包后的网页静态资源会内嵌在编译产物中，并在运行时自动释放到本地 runtime 目录。
- 如果只想单独刷新网页产物，可以执行 `bun run build`。
- 每次修改前端页面、样式或共享前端数据结构后，都必须执行 `bun run build`，把最新的 UI 产物刷新到 `dist/web/`。

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
- 补充集成测试。
