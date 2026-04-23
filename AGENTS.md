# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求。后续协作默认以本文件为准。

## 0. 文案约束

- 禁用词：`收口`。新增或修改文案、注释、提示词、日志、界面文案时都不得使用该表述，统一改为含义更准确的描述。

## 1. 项目概览

### 1.1 产品定位

- Agent Team 是面向 OpenCode 的单工作区 Task Code Agent 编排桌面工具。
- 当前系统围绕当前 `cwd` 下的团队拓扑、Task 会话、群聊记录与 Agent 运行态工作，数据模型使用工作区与 Task。
- GUI 主布局为：上方当前 Task 拓扑图，下方左侧当前 Task 群聊，右侧当前 Task Agent 列表；前端只负责展示与聊天发消息，不负责任何配置写入。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode 与文件存储逻辑。
- 同一 Task 内若某条 `action_required` 回流链路达到自己的最大反驳次数，系统会先隔离这条超限 reviewer 链路并继续推进同源的其他待处理 reviewer；只有当前 Task 已不存在其他可继续推进的待处理链路时，才会以该超限原因结束任务。gating-router[continueAfterReviewerLoopLimit, enforceActionRequiredLoopLimit]

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
- 拓扑里单个 Agent 的 prompt 只能描述它自己的职责、输入与输出约束，不能提及其他 Agent、上下游、回流、裁决、交给谁处理、回应某个特定角色等协作关系；运行时每个 Agent 都应被视为不知道其他 Agent 的存在。team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 漏洞挖掘团队里会给出倾向性判断、通过/不通过结论或最终裁决的 Agent，prompt 必须显式要求“先阅读当前项目代码，再用文件、函数、调用链或约束作为支撑后才能下结论”；不能只根据上游口头材料直接裁定漏洞成立、误报或通过。config/team-topologies/vulnerability-team.topology.json、team-dsl[compileTeamDsl]
- `Build` 使用 OpenCode 内置 prompt，但不再具备默认可写权限；拓扑 JSON 必须显式写出 `prompt: ""` 与 `writable: true/false`。types[usesOpenCodeBuiltinPrompt]、team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON 的 `agents` 数组统一使用对象格式；不再支持直接写成 `"Build"` 这类字符串简写。每个 Agent 的 `writable` 都必须显式声明，不存在默认可写 Agent。team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON 中每个 Agent 都可以通过 `writable` 字段显式声明是否具备写能力；系统允许多个可写 Agent 同时存在。project-agent-source[extractDslAgentsFromTopology, validateProjectAgents, buildInjectedConfigFromAgents]、orchestrator[submitTask, initializeTask]
- 新的团队拓扑 JSON 可以覆盖当前工作区拓扑，后续读取工作区或 Task 快照时会使用最新持久化结果。cli[ensureJsonTopologyApplied]、store[upsertTopology]、orchestrator[hydrateWorkspace, hydrateTask]

### 2.2 工作区状态与 Task 定位

- 当前工作区的拓扑、Task、消息与运行态由当前 CLI 进程内存维护；不会再物化旧的 `<cwd>/.agent-team/state.json`。store[getState, hasWorkspaceState]、orchestrator[hydrateWorkspace, hydrateTask]
- 新建 Task 需要显式传入团队拓扑 JSON 文件，CLI 会先校验参数再加载并应用定义。cli[validateTaskHeadlessCommand, validateTaskUiCommand, loadTeamDslDefinition, ensureJsonTopologyApplied]
- 团队拓扑 JSON 只支持递归式 `entry + nodes + links` DSL。team-dsl[compileTeamDsl]
- 递归式 DSL 中，节点 `type` 只允许 `agent` 或 `spawn`；`spawn` 自身不带 `prompt`，并固定从上游结果里的 `items` 数组展开子图，不支持通过拓扑配置改字段名。team-dsl[compileTeamDsl]、spawn-items[extractSpawnItemsFromContent]
- Task 快照读取当前工作区拓扑与 Agent 定义，`TaskRecord` 本身只保存任务状态与定位信息。store[getTopology]、orchestrator[hydrateTask]、project-agent-source[extractDslAgentsFromTopology]
- Task 定位索引同样只保存在当前进程内存；删除 Task 时会同步移除对应 locator。store[getTaskLocatorCwd, removeTaskLocator, deleteTask]、orchestrator[resolveTaskCwd]
- LangGraph 运行时同样只在当前进程内存里维护每个 Task 的 checkpoint；删除 Task 时会同步清掉对应 thread。orchestrator[getLangGraphRuntime]、langgraph-runtime[deleteTask]

### 2.3 用户数据目录与日志

- CLI 启动时会解析用户数据目录并初始化 Task 级日志目录；`task headless` 与 `task ui` 会为每个 Task 预分配独立日志文件。user-data-path[resolveCliUserDataPath]、app-log[initAppFileLogger]、cli[createCliContext]
- Windows 上的默认用户数据目录按 `%APPDATA%\\agent-team` 解析，因此某个 Task 的日志路径对应为 `%APPDATA%\\agent-team\\logs\\tasks\\<taskId>.log`。user-data-path[resolveDefaultUserDataPath]、app-log[initAppFileLogger]
- 全局用户数据目录主要承载日志与编译态运行时释放出的 Web 资源；默认目录不可写时需要显式设置 `AGENT_TEAM_USER_DATA_DIR`。user-data-path[resolveCliUserDataPath]、runtime-assets[ensureRuntimeAssets]
- 诊断日志会以 JSON Lines 形式按 Task 追加写入 `logs/tasks/<taskId>.log`。app-log[appendAppLog]

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
- 审查 Agent 若显式返回标签段，系统只识别以 `<continue>` 或 `<approved>` 开头的尾段，右侧结束标签可选；其中 `<continue>` 表示需要继续回应，若当前拓扑存在可用的 `action_required` 下游，系统会继续按失败链路把意见回流给对应下游；只有不存在可继续派发的失败链路时，才会把当前 Task 结束并标记为“不通过”。若审查 Agent 没有返回正确的 `<continue>` 或 `<approved>` 标签，系统默认按通过处理。review-parser[parseReview, stripStructuredSignals]、review-response[extractTrailingReviewSignalBlock]、gating-rules[resolveAgentStatusFromReview]、gating-router[applyAgentResultToGraphState, handleActionRequired]、orchestrator[createLangGraphBatchRunners, completeTask]
- 同一个上游 Agent 在收到回流意见后再次成功交付时，会重新派发当前拓扑里满足条件的全部下游 Agent；不会因为某个下游在上一轮已成功执行过，就被静默跳过。gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse]、gating-router[continueAfterHandoffBatchResponse, triggerHandoffDownstream]

### 3.3 拓扑与调度

- LangGraph 是唯一调度运行时核心；`TopologyRecord` 是产品真源，运行时会在主进程内把它编译为图状态与调度索引。langgraph-runtime[resumeTask]、gating-router[createGraphTaskState, applyAgentResultToGraphState]、topology-compiler[compileTopology]
- 拓扑边持久化 `source / target / triggerOn`；`triggerOn` 只允许 `handoff`、`approved`、`action_required`。其中 `handoff` 表示普通协作流转，节点完成后直接触发下游；`approved` 表示审查通过后才触发下游；`action_required` 表示审查不通过后的回流或继续回应链路。store[readWorkspaceState, writeWorkspaceState]、orchestrator[normalizeTopology]、topology-compiler[compileTopology]
- 递归式 DSL 中，`spawn` 仍会被当成拓扑中的正常节点；当父图里存在唯一的 `spawn -> 某节点` 回流边时，编译阶段会把这条边的 `triggerOn` 一并记到 `spawn rule` 上，再由子图唯一终局角色按这条触发类型直接回到外层节点，同时把 `spawn` 节点自身标记为已完成，避免激活残留卡住后续流程。漏洞团队当前写的是 `["疑点辩论", "初筛", "handoff"]`，所以它的 `裁决总结` 会按 `handoff` 回到 `初筛`。team-dsl[compileTeamDsl]、runtime-topology[instantiateSpawnBundle]、gating-router[applyAgentResultToGraphState]
- 漏洞挖掘团队的默认对抗拓扑里，`初筛` 会先把 finding 交给 `反方`，而不是先交给 `正方`；这是一条刻意保留的拓扑设计技巧，用来先由反方挑战证据链、暴露缺口，再进入正反对抗，避免正方开场直接同意导致对抗性不足。config/team-topologies/vulnerability-team.topology.json、team-dsl[compileTeamDsl]、scheduler-script-harness[assertSchedulerScript]
- 静态 `spawn` 节点属于调度节点，会保留在拓扑数据中供运行时识别，但前端拓扑图不会直接展示这类工厂节点；只有 `spawn` 实际展开出来的运行时 Agent 实例会作为可见节点显示。topology-spawn-drafts[getTopologyDisplayNodeIds]、TopologyGraph[TopologyGraph]、runtime-topology-graph[buildEffectiveTopology]
- 当某个 Agent 存在“直接下游通过 `handoff` 触发、且该下游会用 `action_required` 直接回流给自己、同时该下游没有 `approved` 下游”的审查回路时，系统会先只放行这类直接审查回路；只有这些回路全部通过后，才会继续放行该 Agent 其余直接 `handoff` 下游，避免 Build 与单个审查 Agent 多轮对话时反复提前触发无关下游。gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse]、gating-router[handleActionRequired, continueAfterHandoffBatchResponse]
- 同一轮里若某个 Agent 需要同时触发多个直接 `handoff` 下游 reviewer，这批 reviewer 会并发启动；只有当前整批 reviewer 都返回后，系统才会决定是否回流给上游修复，或继续补跑这一轮尚未确认通过的 reviewer，避免把并发批次错误串成“一次只放行一个”。gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse]、orchestrator[createLangGraphBatchRunners]
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列。types[resolveTopologyAgentOrder]、orchestrator[saveTopology, normalizeTopology]、frontend-agent-order[orderAgentsForFrontend]
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时，默认优先取 `Build` 作为最左侧起点；当前拓扑未声明 `Build` 时，节点顺序按已声明的 Agent 顺序解析。types[resolveBuildAgentName, resolveTopologyAgentOrder, createDefaultTopology]
- 拓扑配置中的 `nodes` 统一保存为有序的 Agent 名称字符串数组；该数组既是节点集合真源，也是节点顺序真源，其他派生标识在运行时推导。store[readWorkspaceState, writeWorkspaceState]、orchestrator[normalizeTopology]
- 默认入口语义统一按当前 `nodes` 与 `Build` 是否存在在运行时推导，配置文件使用这套推导结果表达入口。types[resolvePrimaryTopologyStartTarget, resolveBuildAgentName, createDefaultTopology]
- 编译后的最终拓扑会额外持久化 `topology.langgraph` 边界信息：`start.id` 固定为 LangGraph 的 `__start__`，并显式保存它连接到哪些业务节点；`end` 只有在团队拓扑明确声明“存在语义上的结束节点”时才会写入 `__end__`，像当前开发团队这类依靠调度状态自然收束的拓扑会把 `end` 保存为 `null`，而不是伪造一个业务 EndNode。types[createTopologyLangGraphRecord]、team-dsl[createTopology, compileTeamDsl]、store[readWorkspaceState, writeWorkspaceState]
- 拓扑配置中的 `edges` 持久化 `source / target / triggerOn`；当 `triggerOn = action_required` 时，还会额外持久化该边自己的 `maxRevisionRounds`，用于限制这条审视回流链路可连续反驳的最大轮数，默认值为 `4`。边的唯一标识在运行时按三元组即时推导。types[normalizeActionRequiredMaxRounds, getActionRequiredEdgeLoopLimit, getTopologyEdgeId]、store[readWorkspaceState]、orchestrator[normalizeTopology]
- 拓扑节点顶部直接展示 Agent 当前状态徽标，包括 `未启动 / 运行中 / 已完成 / 执行失败`；审查类 Agent 则显示 `审查通过 / 审查不通过`。topology-graph-helpers[getTopologyAgentStatusBadgePresentation]、TopologyGraph[TopologyGraph]
- 拓扑图中每个 Agent 节点头部都会在状态 icon 左侧提供 `attach` 按钮；点击后直接打开该 Agent 对应的 OpenCode attach 终端。topology-graph-helpers[getTopologyNodeHeaderActionOrder]、TopologyGraph[TopologyGraph]、App[App]、orchestrator[openAgentTerminal]
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态；内置与本地类型信息仅在编辑面板等辅助信息中展示。topology-graph-helpers[getTopologyAgentStatusBadgePresentation]、agent-colors[getAgentColorToken]、TopologyGraph[TopologyGraph]
- 拓扑图会隐藏静态 `spawn` 工厂节点；当某个 `spawn` 子图已经实例化出 runtime agent 时，前端会用实例节点（如 `正方-1`）替换对应模板节点（如 `正方`）进行展示，避免模板卡片出现空历史区。topology-spawn-drafts[getTopologyDisplayNodeIds]、TopologyGraph[TopologyGraph]
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中。topology-canvas[buildTopologyCanvasLayout]、TopologyGraph[TopologyGraph]
- 前端拓扑编辑面板支持为每一条 `action_required` 关系单独配置“最大反驳次数”；默认显示 `4`，不同审视关系可以分别保存不同数值。types[normalizeActionRequiredMaxRounds, getActionRequiredEdgeLoopLimit]、orchestrator[normalizeTopology]、store[readWorkspaceState, writeWorkspaceState]

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
- 审查 Agent 给出以 `<continue>` 开头的尾段后，群聊会把该 Agent 的结果正文与回应请求合并展示成同一条消息，并在消息末尾统一追加 `@目标Agent` 标记；右侧结束标签可选。chat-messages[mergeTaskChatMessages]、chat-message-format[formatActionRequiredRequestContent]、review-response[stripReviewResponseMarkup, stripLeadingReviewResponseLabel]
- Agent 最终回复写入群聊时，只会在命中“正式结果 / 最终回复 / 最终交付 / 结论”等明确交付标题时提取对应尾部章节展示；若只是普通结构化文档而不存在这类标题，则保留完整正文，避免误截断到附录内容。chat-messages[extractAgentFinalDisplayContent, extractTrailingTopLevelSection]

### 3.5 GUI 交互

- 右下角团队成员面板展示当前 Task 的 Agent 运行态与 prompt 摘要。App[App]、agent-prompt-preview[buildAgentPromptPreviewText]
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系可通过点击节点编辑。TopologyGraph[TopologyGraph]、topology-canvas[buildTopologyCanvasLayout]
- 拓扑面板 Header 右侧与消息面板 Header 右侧都提供统一的“全屏”入口；点击拓扑面板会进入仅显示拓扑的单面板视图，点击消息面板会进入仅显示消息的单面板视图；对应全屏态内都可通过“退出全屏”恢复默认三栏布局。App[App]、TopologyGraph[TopologyGraph]、ChatWindow[ChatWindow]
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态。agent-history[buildAgentHistoryItems]、TopologyGraph[TopologyGraph]、opencode-client[getSessionRuntime]
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent。agent-colors[getAgentColorToken]、ChatWindow[MessageBubble]、App[App]
- 右下角展示当前工作区拓扑中的全部 Agent，以及它们在当前 Task 语境下的状态。frontend-agent-order[orderAgentsForFrontend]、App[App]
- 前端聚焦当前 Task 的展示与消息发送；Agent、Prompt、拓扑、Project、Task 的创建、删除、编辑与保存通过 JSON、CLI 与运行时处理。App[App]、ChatWindow[ChatWindow]、cli[ensureJsonTopologyApplied]、orchestrator[applyTeamDsl, saveTopology]
- GUI 展示当前 Task 的聊天流、拓扑和 Agent 状态，并允许继续发消息；终端 attach 通过 OpenCode 外部终端打开。App[App]、ChatWindow[ChatWindow]、TopologyGraph[TopologyGraph]、web-api[openAgentTerminal]

### 3.6 终端行为

- GUI 和 CLI 都通过 OpenCode session attach 到单个 Agent，会话调试入口统一围绕 OpenCode。terminal-commands[buildCliOpencodeAttachCommand]、orchestrator[openAgentTerminal, launchAgentTerminal]、task-attach-display[renderTaskAttachCommands]
- OpenCode attach 入口统一位于拓扑图节点头部。topology-graph-helpers[getTopologyNodeHeaderActionOrder]、TopologyGraph[TopologyGraph]
- Windows 上 attach 外部终端默认使用 `cmd.exe /k` 拉起可见窗口；若需备用路径，可在启动前设置 `AGENT_TEAM_WINDOWS_TERMINAL=powershell` 切换到 PowerShell 窗口启动。terminal-launcher[buildTerminalLaunchSpec]
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内。web-api[getTaskRuntime]、App[App]、orchestrator[getTaskRuntime]、opencode-client[getSessionRuntime]
- 同一工作区的 SSE 事件会按 `taskId` 区分当前页面所属 Task；当当前 Task 内部有新的 spawn runtime session 建立时，前端会立即刷新当前 Task 快照，使新实例节点尽快具备可点击的 `attach`。orchestrator[scheduleRuntimeRefresh]、runtime-event-refresh[shouldRefreshForRuntimeEvent]、App[App]
- 应用退出时，会统一关闭当前工作区相关的 `opencode serve` 与其派生会话。orchestrator[dispose]、opencode-client[shutdown]、cli[disposeCliContext]

## 4. CLI 约定

- CLI 默认使用当前目录作为工作目录。
- `task headless`、`task ui` 在解析 `--cwd`（或默认当前目录）时，要求目标路径必须真实存在且为目录；不存在或传入普通文件时会直接报错，不会静默创建内存工作区。
- CLI 提供 `task headless`、`task ui`。
- `task headless --file <topology.json> --message <message>` 会新建当前 Task，打印本轮群聊，任务结束后退出到 shell。
- `task ui --file <topology.json> --message <message> [--cwd <path>]` 会新建当前 Task，启动本地 Web Host，并在浏览器中打开当前 Task 页面；CLI 进程会继续驻留，直到收到 `Ctrl+C` / `SIGTERM` 才清理当前命令持有的 OpenCode 实例并退出。
- `task ui` 启动前会检查当前选中的 Web 静态目录中是否存在 `index.html`；缺少入口文件时会直接报错，不会继续启动 Web Host 或打开浏览器。
- `task ui` 打开的浏览器地址与本地 Web Host 监听地址统一使用 `localhost` 回环主机名，而不是 `127.0.0.1`，以兼容 Windows 上仅 `localhost` 可访问的本地浏览器环境。
- CLI / 终端里所有用户可见 attach 文案都直接显示底层 `opencode attach ...`，不再展示 `task attach` 包装命令。
- 当 Task 运行过程中因为 `spawn` 新增 runtime agent 且它获得新的 OpenCode session 时，CLI 会增量再次打印这些新实例的 `opencode attach ...` 命令，而不是只在任务启动时打印首批静态 Agent。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` / `task ui` 请显式传入 `--cwd`。

常用命令示例：

```bash
bun run cli -- help

bun run cli -- task headless --file config/team-topologies/development-team.topology.json --message "请开始一轮开发团队协作。"
bun run cli -- task ui --file config/team-topologies/development-team.topology.json --message "使用node实现一个加法方法" --cwd "D:\empty"
```

CLI 能力分组：

- `task headless`：运行一轮任务，结束后退出 CLI。
- `task ui`：新建任务并在浏览器里打开当前 Task 页面；命令会保持驻留，直到收到 `Ctrl+C` / `SIGTERM`。
- CLI 主进程收到 `Ctrl+C` / `SIGTERM` 时，会先回收当前这次命令启动或连接过的全部 OpenCode serve 实例，再结束当前命令，避免遗留孤儿会话。
- `task headless` 在任务自然结束退出时会打印本次回收掉的 OpenCode 实例 PID，`task ui` 则只会在收到 `Ctrl+C` / `SIGTERM` 清理退出时打印，便于排查残留进程。

## 5. 存储布局与仓库结构

### 5.1 存储布局

- 命令执行失败等诊断日志位于用户数据目录下的 `logs/tasks/<taskId>.log`。
- 当前工作区的拓扑、Task、消息与运行态数据只在当前 CLI 进程内存中维护，不再落盘旧的工作区快照文件。
- 团队拓扑 JSON 编译后的 Agent prompt / writable 元数据与 LangGraph 边界信息也只保留在当前运行时内存快照中。
- 每个 Task 的 LangGraph checkpoint 只保存在当前进程内存里，不再额外写入工作区目录。
- 编译态 CLI 首次启动时，会把内嵌的 Web 静态资源释放到用户数据目录下的 `runtime/<version>/web/`；源码运行时优先直接复用仓库里的 `dist/web/`。runtime-assets[ensureRuntimeAssets]
- OpenCode serve 端口、Agent session id 与 Web Host 定位信息由运行时内存态管理；agent-team 不再额外为 OpenCode 注入专用数据库落盘路径。opencode-client[startServer]

### 5.2 仓库结构

```txt
agent-team/
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   ├── launcher.cjs
│   │   └── web-host.ts
│   ├── components/
│   ├── lib/
│   ├── runtime/
│   │   ├── gating-state.ts
│   │   ├── gating-router.ts
│   │   ├── langgraph-host.ts
│   │   ├── langgraph-runtime.ts
│   │   ├── orchestrator.ts
│   │   ├── topology-compiler.ts
│   │   ├── store.ts
│   │   ├── opencode-client.ts
│   │   └── user-data-path.ts
│   ├── shared/
│   │   ├── ipc.ts
│   │   ├── terminal-commands.ts
│   │   └── types.ts
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
- `task ui` 只会读取已构建好的 `dist/web/` 或编译产物内嵌的网页资源；源码运行时若缺少最新 `dist/web/`，或最终静态目录中缺少 `index.html`，会直接报错，不会再自动起 Vite 开发服务器兜底。

常用构建命令：

```bash
bun run build
bun run dist:win
bun run dist:mac-arm64
bun run dist:mac-x64
```

交付前检查：

- 每次交付前必须在仓库根目录运行 `bun tsc --noEmit`，并以类型检查通过作为交付前置条件。
- 每次交付前必须在仓库根目录运行 `bun test --only-failures; bun run knip --fix`，并确认没有遗留失败用例与可自动修复的未使用项。
- 新增或修改字段、函数入参、返回值时，尽量避免引入 `prop?: T`、`T | null`、`T | undefined` 这类宽松可空类型；优先通过更稳定的模型表达状态差异。确实需要“缺失值”语义时，也要先统一该字段在当前层级到底使用“必填值”“可选字段”还是“显式 `null`”，避免同一语义同时混用 optional、`undefined`、`null` 三套表达。
- 涉及调度状态变化、回流顺序、裁决转发、spawn 对话推进等用户可见协作语义时，新增覆盖优先写进 `src/runtime/scheduler-script-harness.test.ts` 这类 script 测试，用对话脚本验证真实流转；只有当该行为依赖内部暂存状态或 synthetic dispatch、无法自然表达为一段用户可见对话脚本时，才保留在 `src/runtime/gating-router.test.ts` / `src/runtime/orchestrator.test.ts` 做纯状态测试。

打包注意事项：

- 推荐直接使用 `bun run dist:win`；该命令会先执行 `bun run build` 生成最新 `dist/web/`，再生成单文件 `dist/agent-team.exe`。
- macOS Apple Silicon 打包命令为 `bun run dist:mac-arm64`，产物位于 `dist/agent-team-macos-arm64`。
- macOS Intel 打包命令为 `bun run dist:mac-x64`，产物位于 `dist/agent-team-macos-x64`。
- Windows 主程序位于 `dist/agent-team.exe`。
- 打包后的网页静态资源会连同 `index.html` 一起内嵌在编译产物中，并在运行时自动释放到本地 runtime 目录；若编译产物缺少这个入口文件，`task ui` 会直接报错，不会继续启动空壳 Web Host。
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
