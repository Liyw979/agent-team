# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求

## 0. 约束

- 禁用词：`收口`。新增或修改文案、注释、提示词、日志、界面文案时都不得使用该表述，统一改为含义更准确的描述。
- 禁止未经同意加入“兜底”， “兼容”代码，当前属于项目初期，尽可能暴露问题，不需要考虑兼容

## 1. 项目概览

### 1.1 产品定位

- Agent Team 是面向 OpenCode 的单工作区 Task Code Agent 编排桌面工具。
- 当前系统围绕当前 `cwd` 下的团队拓扑、Task 会话、群聊记录与 Agent 运行态工作，数据模型使用工作区与 Task。
- GUI 主布局为：上方当前 Task 拓扑图，下方左侧当前 Task 群聊，右侧当前 Task Agent 列表；前端只负责展示与聊天发消息，不负责任何配置写入。
- CLI 与 GUI 复用同一套 `Orchestrator`、OpenCode 与文件存储逻辑。
- 同一 Task 内若某条 `action_required` 回流链路达到自己的最大反驳次数，系统会先隔离这条超限 decisionAgent 链路并继续推进同源的其他待处理 decisionAgent；只有当前 Task 已不存在其他可继续推进的待处理链路时，才会以该超限原因结束任务。gating-router[continueAfterDecisionLoopLimit, enforceActionRequiredLoopLimit]

### 1.2 技术栈

- Node.js CLI + 浏览器 Web Host
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- OpenCode Server (`opencode serve`)
- 文件存储：当前工作区 `.agent-team/` + 用户数据目录日志

## 2. 功能地图（格式为文件名[方法列表]）

### 2.1 Agent 配置与拓扑应用

- 团队拓扑 JSON5 会先编译为 Agent 与拓扑记录，再应用到当前工作区，Task 启动时读取这份编译结果。team-dsl[compileTeamDsl]、cli[ensureJson5TopologyApplied]、orchestrator[applyTeamDsl]
- Agent 的 prompt 与可写权限从当前拓扑的 `nodeRecords` 中提取，并在读取工作区 Agent 列表时即时恢复。project-agent-source[extractDslAgentsFromTopology]、orchestrator[listWorkspaceAgents]
- 拓扑里单个 Agent 的 prompt 只能描述它自己的职责、输入与输出约束，不能提及其他 Agent、上下游、回流、裁决、交给谁处理、回应某个特定角色等协作关系；运行时每个 Agent 都应被视为不知道其他 Agent 的存在。team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON5 的 `agents` 数组统一使用对象格式；不再支持直接写成 `"Build"` 这类字符串简写。每个 Agent 的 `writable` 都必须显式声明，不存在默认可写 Agent。team-dsl[compileTeamDsl]、project-agent-source[extractDslAgentsFromTopology]
- 团队拓扑 JSON5 中每个 Agent 都可以通过 `writable` 字段显式声明是否具备写能力；系统允许多个可写 Agent 同时存在。project-agent-source[extractDslAgentsFromTopology, validateProjectAgents, buildInjectedConfigFromAgents]、orchestrator[submitTask, initializeTask]
- 新的团队拓扑 JSON5 可以覆盖当前工作区拓扑，后续读取工作区或 Task 快照时会使用最新持久化结果。cli[ensureJson5TopologyApplied]、store[upsertTopology]、orchestrator[hydrateWorkspace, hydrateTask]

### 2.2 工作区状态与 Task 定位

- 当前工作区的拓扑、Task、消息与运行态由当前 CLI 进程内存维护；不会再物化旧的 `<cwd>/.agent-team/state.json`。store[getState, hasWorkspaceState]、orchestrator[hydrateWorkspace, hydrateTask]
- 新建 Task 需要显式传入团队拓扑 JSON5 文件，CLI 会先校验参数再加载并应用定义。cli[validateTaskHeadlessCommand, validateTaskUiCommand, ensureJson5TopologyApplied]、cli-topology-file[loadTeamDslDefinitionFile]
- 团队拓扑 JSON5 只支持递归式 `entry + nodes + links` DSL；根图若需要显式结束来源，直接通过 `{ "from": "...", "to": "__end__", "trigger_type": "...", "message_type": "none" }` 这类终止边表达。team-dsl[compileTeamDsl]
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

- 每个工作区独占一个 `opencode serve`；启动时直接执行该命令、解析实际监听地址，并让 attach / 健康检查 / 请求都跟随这个地址与工作区目录。opencode-client[ensureServer, startServer, getAttachBaseUrl, request]、opencode-serve-launch[extractOpenCodeServeBaseUrl]
- `opencode serve` 只在启动前一次性注入当前拓扑里真正需要自定义 prompt / writable 的 Agent 配置；注入内容来自 `nodeRecords`，使用内置 prompt 的 Agent 不写入 `OPENCODE_CONFIG_CONTENT`，单个 serve 运行中也不会 reload 或因配置变化自动重启。对 `writable: false` 的 Agent，运行时会显式拒绝 `write`、`edit`、`bash`、`task`、`patch`、`webfetch`、`websearch` 权限。orchestrator[setInjectedConfigForTask]、project-agent-source[extractDslAgentsFromTopology, buildInjectedConfigFromAgents]、types[usesOpenCodeBuiltinPrompt]、opencode-client[setInjectedConfigContent, startServer]
- Session 与消息接口分别对齐官方 `POST /session`、`POST /session/:id/message`，请求体使用 `parts`；本机未安装或无法连接 `opencode serve` 时直接报错并写日志。opencode-client[createSession, submitMessage, startServer]、app-log[appendAppLog]

### 3.2 Task 初始化与状态流转

- CLI 通过 `task headless`、`task ui` 创建和驱动当前工作区 Task，GUI 只负责展示与继续发消息；Task 初始化、提交与配置应用由 CLI 和编排层完成。cli[validateTaskHeadlessCommand, validateTaskUiCommand, ensureJson5TopologyApplied]、orchestrator[initializeTask, submitTask]、App[App]
- 当前节点完成后若不存在可自动推进的下游，Task 会进入 `finished`，聊天区追加“本轮已完成，可继续 @Agent 发起下一轮。”与“任务已经结束”系统消息，拓扑节点统一显示为 `已完成`；后续再次 `@Agent` 会把 Task 从 `finished` 恢复为 `running`。gating-router[applyAgentResultToGraphState]、langgraph-runtime[resumeTask, runTaskLoop]、orchestrator[completeTask]、task-completion-message[buildTaskCompletionMessageContent]、task-lifecycle-rules[reconcileTaskSnapshotFromMessages]、topology-graph-helpers[getTopologyAgentStatusBadgePresentation]
- Agent 成功态统一使用 `completed`；判定 Agent 只识别尾段 `<continue>` / `<complete>`，缺失或不合法时默认按 `continue` 处理，并按当前拓扑决定回流、继续派发或结束为“不通过”。同一上游在收到回流后重新交付时，会重新派发本轮满足条件的全部下游，不会跳过上轮已成功节点。gating-rules[resolveAgentStatusFromDecision]、decision-parser[parseDecision, stripStructuredSignals]、decision-response[extractTrailingDecisionSignalBlock]、gating-router[handleActionRequired, continueAfterHandoffBatchResponse, triggerHandoffDownstream]、gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse]、orchestrator[createLangGraphBatchRunners, completeTask]

### 3.3 拓扑与调度

- LangGraph 是唯一调度核心，`TopologyRecord` 是真源；运行时会把它编译为图状态、调度索引和 `topology.langgraph` 边界信息。拓扑边只持久化 `source / target / triggerOn`，其中 `triggerOn` 仅允许 `transfer`、`complete`、`continue`；`continue` 边额外带 `maxContinueRounds`，默认 `4`。store[readWorkspaceState, writeWorkspaceState]、langgraph-runtime[resumeTask]、topology-compiler[compileTopology]、gating-router[createGraphTaskState, applyAgentResultToGraphState]、types[createTopologyLangGraphRecord, normalizeActionRequiredMaxRounds, getActionRequiredEdgeLoopLimit, getTopologyEdgeId]
- `spawn` 仍是拓扑节点：静态工厂节点保留在运行时数据中供调度识别，但前端隐藏，只展示实际展开出来的 runtime agent；父图存在唯一 `spawn` 回流边时，编译阶段会把其 `triggerOn` 记入 `spawn rule`，并由子图唯一终局角色按该触发类型回到外层节点，同时把 `spawn` 标记为已完成。team-dsl[compileTeamDsl]、runtime-topology[instantiateSpawnBundle]、runtime-topology-graph[buildEffectiveTopology]、topology-spawn-drafts[getTopologyDisplayNodeIds]、TopologyGraph[TopologyGraph]
- 调度上，系统会先放行“直接 `transfer` 到判定节点、且该节点通过 `continue` 直接回流自身、并且没有 `complete` 下游”的直接判定回路；这类回路全部通过后，才继续放行其余直接 `transfer` 下游。若同一轮要触发多个直接 `transfer` 下游 decisionAgent，则整批并发执行，并在整批返回后统一决定回流、补跑或继续。gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse]、gating-router[handleActionRequired, continueAfterHandoffBatchResponse]、orchestrator[createLangGraphBatchRunners]
- 拓扑顺序与入口规则保持稳定：`nodes` 的有序字符串数组同时是真源节点集合和展示顺序；未显式保存顺序时优先把 `Build` 放最左，否则按声明顺序解析。团队成员列表可直接调整顺序并持久化。漏洞挖掘默认对抗拓扑保持“`线索发现` 先交给 `漏洞挑战` 再进入 `漏洞论证`”这一设计，让漏洞挑战暴露证据链缺口，再进入论证与挑战对抗；当 `线索发现` 认为已经没有新的可疑点时，不会直接结束任务，而是先把完整群聊语义交给 `线索完备性评估` 判断是否还有遗漏，只有它给出 `complete` 才允许结束，若它给出 `continue` 则会把具体补查方向回给 `线索发现` 继续挖掘；当 `spawnRule.exitWhen = "all_completed"` 且同一目标存在多条 `complete` 入边时，运行时只会在这些来源角色都已经给出本轮回应后，才允许继续派发该目标，因此漏洞挑战不能在漏洞论证尚未回应时直接把流程推进到 `讨论总结`。types[resolveBuildAgentId, resolveTopologyAgentOrder, resolvePrimaryTopologyStartTarget, createDefaultTopology]、orchestrator[saveTopology, normalizeTopology]、frontend-agent-order[orderAgentsForFrontend]、config/team-topologies/vulnerability-team.topology.json5、scheduler-script-emulator-migration.test.ts、gating-scheduler[planApprovedDispatch]
- 前端拓扑图只展示可见 Agent 实例，并在节点头部直接展示状态徽标、颜色和 `attach` 入口；判定类节点显示 `判定通过 / 判定不通过`。布局始终保持“Agent 在上、历史区在下、首尾贴边但留白、顶部预留连线通道”，编辑面板可逐条配置 `action_required` 的最大反驳次数。topology-graph-helpers[getTopologyAgentStatusBadgePresentation, getTopologyNodeHeaderActionOrder]、agent-colors[getAgentColorToken]、topology-canvas[buildTopologyCanvasLayout]、TopologyGraph[TopologyGraph]、App[App]、orchestrator[openAgentTerminal, normalizeTopology]

### 3.4 聊天与消息传递

- Task 群聊通过 `@AgentId` 提交任务，输入 `@` 会弹出候选列表；展示层保留原始 `@Agent` 文本，但发送给目标 Agent 前会去掉仅用于寻址的头尾 `@Agent`，并按 raw 模式封装为单行 `[User] <正文>`。chat-mentions[getMentionContext, getMentionOptionItems]、task-submission[resolveTaskSubmissionTarget]、message-forwarding[stripTargetMention]、ChatWindow[ChatWindow]、orchestrator[submitTask, createLangGraphBatchRunners]
- 群聊同时展示 `user -> agent`、`agent -> agent` 与最终回复；同一 Agent 批量派发多个下游时会合并成一条消息，仅用于展示，不会再作为历史转发给下游。首次自动流转会附带 `[Initial Task]` 与 `[From <AgentId> Agent]`，后续只保留 `[From <AgentId> Agent]`；自动派发只带首条用户任务和当前上游结果，命中重复内容会去重。chat-messages[mergeTaskChatMessages]、orchestrator[consumeInitialTaskForwardingAllowanceFromGraphState, createLangGraphBatchRunners, shouldSuppressDuplicateDispatchMessage]、message-forwarding[buildDownstreamForwardedContextFromMessages, getInitialUserMessageContent, contentContainsNormalized]
- 下游转发语义以“用户实际看到的群聊卡片”为真源：`message_type = all` 时必须先做群聊合并再生成 transcript。群聊落库与 Agent 间转发只使用 OpenCode 公开 `text` part，不混入 `reasoning`、步骤或工具调用；对非 `Build` 且非判定类的下游，会额外附带 `[Project Git Diff Summary]`。message-forwarding[buildDownstreamForwardedContextFromMessages]、chat-messages[mergeTaskChatMessages]、opencode-client[extractVisibleMessageText, getSessionRuntime]、orchestrator[buildProjectGitDiffSummary, stripStructuredSignals, createLangGraphBatchRunners]、types[usesOpenCodeBuiltinPrompt, isDecisionAgentInTopology]
- 消息展示会尽量合并同一轮语义：Agent 最终回复后紧接着自动派发下游时，会并成同一条消息并追加 `@目标Agent`；判定 Agent 返回 `<continue>` 时，也会把正文与回应请求合并展示。最终回复仅在命中“正式结果 / 最终回复 / 最终交付 / 结论”等标题时提取尾部章节，否则保留完整正文。chat-messages[mergeTaskChatMessages, extractAgentFinalDisplayContent, extractTrailingTopLevelSection]、chat-message-format[buildMentionSuffix, formatAgentDispatchContent, formatActionRequiredRequestContent]、decision-response[stripDecisionResponseMarkup, stripLeadingDecisionResponseLabel]

### 3.5 GUI 交互

- GUI 聚焦当前 Task 的展示与继续发消息，不负责 Agent、Prompt、拓扑、Project、Task 的创建和保存；这些变更统一走 JSON、CLI 与运行时。App[App]、ChatWindow[ChatWindow]、cli[ensureJsonTopologyApplied]、orchestrator[applyTeamDsl, saveTopology]
- 主界面展示聊天流、拓扑图、团队成员列表和当前 Task 语境下的 Agent 状态、prompt 摘要；拓扑历史区优先显示最近运行活动，并区分思考、普通消息、步骤与 Tool Call 参数摘要。App[App]、TopologyGraph[TopologyGraph]、ChatWindow[ChatWindow]、frontend-agent-order[orderAgentsForFrontend]、agent-prompt-snippet[buildAgentPromptSnippetText]、agent-history[buildAgentHistoryItems]、opencode-client[getSessionRuntime]
- 拓扑面板和消息面板都支持全屏；拓扑放大视图会让卡片随视口铺满面板，连线固定走顶部通道，节点下游关系可点击编辑。Agent 名称配色在拓扑与聊天中保持稳定。TopologyGraph[TopologyGraph]、topology-canvas[buildTopologyCanvasLayout]、agent-colors[getAgentColorToken]、ChatWindow[MessageBubble]

### 3.6 终端行为

- GUI 和 CLI 都围绕 OpenCode session attach 到单个 Agent，入口统一放在拓扑节点头部；终端文案与调试链路都直接对齐 OpenCode。terminal-commands[buildCliOpencodeAttachCommand]、topology-graph-helpers[getTopologyNodeHeaderActionOrder]、TopologyGraph[TopologyGraph]、orchestrator[openAgentTerminal, launchAgentTerminal]、task-attach-display[renderTaskAttachCommands]
- 运行中的 Agent 会通过 OpenCode HTTP session 轮询实时工具调用与摘要并显示在拓扑节点内；同一工作区的 SSE 事件按 `taskId` 隔离，当前 Task 新增 spawn runtime session 时会立即刷新快照，让新实例节点尽快具备可点击的 `attach`。web-api[getTaskRuntime]、opencode-client[getSessionRuntime]、orchestrator[getTaskRuntime, scheduleRuntimeRefresh]、runtime-event-refresh[shouldRefreshForRuntimeEvent]、App[App]
- Windows 默认用 `cmd.exe /k` 拉起 attach 终端，设置 `AGENT_TEAM_WINDOWS_TERMINAL=powershell` 可切到 PowerShell；应用退出时会统一关闭当前工作区相关的 `opencode serve` 与派生会话。terminal-launcher[buildTerminalLaunchSpec]、orchestrator[dispose]、opencode-client[shutdown]、cli[disposeCliContext]

## 4. CLI 约定

- CLI 默认使用当前目录作为工作目录。
- `task headless`、`task ui` 在解析 `--cwd`（或默认当前目录）时，要求目标路径必须真实存在且为目录；不存在或传入普通文件时会直接报错，不会静默创建内存工作区。
- `task headless`、`task ui` 在创建 CLI 上下文前都会先执行一次 `opencode --help` 预检查；只要该命令执行失败，就会直接报错并提示用户先把 `opencode` 配置好。
- CLI 提供 `task headless`、`task ui`。
- `task headless --file <topology-file> --message <message>` 会新建当前 Task，打印本轮群聊，任务结束后退出到 shell；`--file` 必须是 `.json5`，并按 JSON5 语法解析。
- `task ui --file <topology-file> --message <message> [--cwd <path>]` 会新建当前 Task，启动本地 Web Host，并在浏览器中打开当前 Task 页面；CLI 进程会继续驻留，直到收到 `Ctrl+C` / `SIGTERM` 才清理当前命令持有的 OpenCode 实例并退出；`--file` 必须是 `.json5`，并按 JSON5 语法解析。
- `task ui` 启动前会检查当前选中的 Web 静态目录中是否存在 `index.html`；缺少入口文件时会直接报错，不会继续启动 Web Host 或打开浏览器。
- `task ui` 打开的浏览器地址与本地 Web Host 监听地址统一使用 `localhost` 回环主机名，而不是 `127.0.0.1`，以兼容 Windows 上仅 `localhost` 可访问的本地浏览器环境。
- CLI / 终端里所有用户可见 attach 文案都直接显示底层 `opencode attach ...`，不再展示 `task attach` 包装命令。
- 当 Task 运行过程中因为 `spawn` 新增 runtime agent 且它获得新的 OpenCode session 时，CLI 会增量再次打印这些新实例的 `opencode attach ...` 命令，而不是只在任务启动时打印首批静态 Agent。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` / `task ui` 请显式传入 `--cwd`。

常用命令示例：

```bash
bun run cli -- help

bun run cli -- task headless --file config/team-topologies/development-team.topology.json5 --message "请开始一轮开发团队协作。"
bun run cli -- task ui --file config/team-topologies/development-team.topology.json5 --message "使用node实现一个加法方法" --cwd "D:\empty"
```

CLI 能力分组：

- `task headless`：运行一轮任务，结束后退出 CLI。
- `task ui`：新建任务并在浏览器里打开当前 Task 页面；命令会保持驻留，直到收到 `Ctrl+C` / `SIGTERM`。
- CLI 主进程收到 `Ctrl+C` / `SIGTERM` 时，会先回收当前这次命令启动或连接过的全部 OpenCode serve 实例，再结束当前命令，避免遗留孤儿会话。
- `task headless` 在任务自然结束退出时会打印本次回收掉的 OpenCode 实例 PID，`task ui` 则只会在收到 `Ctrl+C` / `SIGTERM` 清理退出时打印，便于排查残留进程。

## 5. 开发与打包

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
- 涉及调度状态变化、回流顺序、裁决转发、spawn 对话推进等用户可见协作语义时，新增覆盖优先写进 `src/runtime/scheduler-script-emulator-migration.test.ts` 这类 script 测试，用对话脚本直接驱动 `src/runtime/scheduler-script-emulator.ts` 和真实调度核心验证流转；只有当该行为依赖内部暂存状态、且确实无法自然表达为一段用户可见对话脚本时，才保留在 `src/runtime/gating-router.test.ts` / `src/runtime/orchestrator.test.ts` 做纯状态测试。
- 只要某个问题已经可以通过 emulator / script 测试直接证明真实用户可见流转，就不要再为同一语义额外补 `orchestrator`、`gating-router` 或其他重复层级的测试；只有 emulator 确实无法自然表达该问题时，才允许补其他测试。
- 所有 Agent 对话顺序类单元测试，在排查和修复前都必须优先补成 `src/runtime/scheduler-script-emulator-migration.test.ts` 这类 script 脚本复现；先用脚本把真实对话顺序跑出失败，再继续修改实现与复验通过。
- 只要现有 `config/team-topologies/*.topology.json5` 或其编译结果足以表达目标协作路径，就必须直接使用这些 JSON5 拓扑或基于它们编译出的 topology 做测试；禁止为了省事另写一大堆自定义 DSL、手搓 topology 夹具来替代真实拓扑。只有当目标场景确实无法用现有 JSON5 拓扑自然表达，才允许补最小必要的 DSL / 手写 topology 夹具，并在测试里明确说明为什么不能直接复用 JSON5 拓扑。
- 群聊合并、`continue-request`、`message_type = all` 转发这类消息语义测试，测试夹具必须显式写出真实落库形态：例如 `agent-final` 中真实存在的正文与 `<continue>/<complete>` 尾段，以及 `continue-request` 独立落库后的正文与尾部 `@目标Agent`。禁止为了“制造重复”而在测试里手工把同一段正文复制两遍，再倒推出实现应该去重；断言目标必须直接对齐“用户实际看到的群聊语义卡片”或“基于该语义卡片生成的 transcript”。chat-messages[mergeTaskChatMessages]、message-forwarding[buildDownstreamForwardedContextFromMessages]

打包注意事项：

- 推荐直接使用 `bun run dist:win`；该命令会先执行 `bun run build` 生成最新 `dist/web/`，再生成单文件 `dist/agent-team.exe`。
- macOS Apple Silicon 打包命令为 `bun run dist:mac-arm64`，产物位于 `dist/agent-team-macos-arm64`。
- macOS Intel 打包命令为 `bun run dist:mac-x64`，产物位于 `dist/agent-team-macos-x64`。
- Windows 主程序位于 `dist/agent-team.exe`。
- 打包后的网页静态资源会连同 `index.html` 一起内嵌在编译产物中，并在运行时自动释放到本地 runtime 目录；若编译产物缺少这个入口文件，`task ui` 会直接报错，不会继续启动空壳 Web Host。
- 如果只想单独刷新网页产物，可以执行 `bun run build`。
- 每次修改前端页面、样式或共享前端数据结构后，都必须执行 `bun run build`，把最新的 UI 产物刷新到 `dist/web/`。

## 6. 文档同步要求

以下变更必须同步检查并在需要时更新本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agent-team/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化

## 7. 后续建议

- 把协作消息做得更接近 “Agent @ Agent” 的可视化协作流。
- 补充集成测试。
