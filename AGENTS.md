# AGENTS

本文件汇总当前项目的产品定位、运行约定、开发命令与文档同步要求

## 1. 代码要求
- 追求代码熵减，追求代码量变少
- 涉及的方法入参、返回值是否最小化，一个方法只应该传入它需要的参数，比如能传入string，就不要传入一个包装类
- 避免null、undefined、xxx?: T等可空变量，可空入参，可空返回值
- 避免兼容代码, 兜底代码，转换代码，额外状态，normalize方法等代码
- 新增的测试代码，能否直接合入已有的测试中，不要改一行代码，新增几百行测试

- 交付前必须先明确输出：原始任务、是否已经完成、任务完成的代码证据；证据不能只依赖单元测试。
- 每次交付前必须在仓库根目录运行 `bun tsc --noEmit` 与 `bun test --only-failures; bun run knip --fix`；类型检查通过是前置条件，同时要确认没有遗留失败用例与可自动修复的未使用项。
- bug优先，优先使用 `src/runtime/scheduler-script-emulator-migration.test.ts` 这类 script 测试直接验证真实对话流转，并优先复用现有 `config/team-topologies/*.yaml` 或其编译结果。

## 2. 约束

- 禁用词：`收口`。新增或修改文案、注释、提示词、日志、界面文案时都不得使用该表述，统一改为含义更准确的描述。
- 禁止未经同意加入“兜底”， “兼容”代码，当前属于项目初期，尽可能暴露问题，不需要考虑兼容，禁止加入兼容代码

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
- OpenCode Server (`opencode serve`)
- 文件存储：当前工作区 `.agent-team/` + 用户数据目录日志

## 4. 功能地图与运行时编排（格式为文件名[方法列表], 对于我说的要求、功能要求、避免的要求要记录到这个章节）
### 4.1 拓扑、Agent 与工作区
- 团队拓扑 YAML 会先编译再应用到工作区；`agents` 必须使用对象格式并显式声明 `writable`，单个 Agent 的 `system_prompt` 只能描述自身职责、输入与输出约束，不能写协作关系，自定义 outgoing trigger 必须在对应 `system_prompt` 中显式出现。工作区拓扑、Task、消息与 Task 运行态都只保存在当前 CLI 进程内存；新建 Task 必须显式传入递归式 YAML 拓扑，节点只允许 `agent` 或 `group`；`group` 内只允许声明 `nodes`，不再声明 `entry` 和局部 `links`，整个 YAML 文件只有最外层这一组 `links`，每条 `link` 都必须显式声明 `from / to / trigger / message_type`，其中 `message_type` 只允许 `last | none`；`from` 必须是 agent，`to` 必须是 agent 或根图 `__end__`；`agent` 节点可额外声明 `initialMessage`，表示目标 Agent 仅在首次启动时额外注入指定来源 Agent 的首条可转发消息，空数组等同于不额外注入；当 `initialMessage` 同时声明多个来源时，编译阶段会按 YAML 中 Agent 自上而下的定义顺序重排这些来源，再交给运行时使用；`group` 按上游首条非空行展开。team-dsl[compileTeamDsl]、cli[ensureYamlTopologyApplied, validateTaskHeadlessCommand, validateTaskUiCommand, loadTeamDslDefinitionFile]、project-agent-source[extractDslAgentsFromTopology, validateProjectAgents, buildInjectedConfigFromAgents]、orchestrator[applyTeamDsl, listWorkspaceAgents, submitTask, initializeTask, hydrateWorkspace, hydrateTask, getTaskRuntime]、store[getState, hasWorkspaceState, removeTaskLocator, deleteTask]、task-runtime[deleteTask]、gating-router[materializeGroupNodeTargets]
### 4.2 运行时、调度与消息
- `cwd` 是工作区唯一边界，每个 `cwd` 只会对应一个 `opencode serve`，当前拓扑需要的 prompt / writable 配置只会在 `opencode serve` 启动时通过 `OPENCODE_CONFIG_CONTENT` 注入到同一工作区目录与同一真实监听地址；serve 启动后不再热更新这份配置，也不会因为配置变化主动重启当前 serve，连接失败时直接报错并写日志。`cwd` 现在只保留为工作区事实与底层进程启动目录，不再作为运行态事件、调度回调或 attach 终端的路由键。task runtime 是唯一调度核心，边只按 `source / target / trigger` 字面值路由，`maxTriggerRounds` 是唯一回流轮次声明；节点无下游可推进时 Task 进入 `finished`，再次 `@Agent` 会恢复为 `running`。漏洞挖掘默认保持“线索发现 -> 误报论证 -> 漏洞论证 -> 线索完备性评估”的顺序；指向同一 target 的多条同 trigger 入边表示多个可触发来源，任意一条边被触发就会立即派发 target。Task 群聊通过 `@AgentId` 提交任务，自动派发默认只带当前上游结果，并且仅在目标 Agent 首次启动时按其 `initialMessage` 额外注入指定来源的首条可转发消息；若额外注入了多个来源，这些来源的段落顺序以编译后的 Agent 定义顺序为准，而不是 `initialMessage` 数组书写顺序；同源重复内容必须去重，不再额外注入项目 Git Diff 摘要。opencode-client[ensureServerStarted, startServer, getAttachBaseUrl, request, createSession, submitMessage, extractVisibleMessageText, getSessionRuntime, shutdown]、opencode-serve-launch[extractOpenCodeServeBaseUrl]、orchestrator[applyTeamDsl, initializeTask, submitTask, createRuntimeBatchRunners, completeTask, shouldSuppressDuplicateDispatchMessage, stripStructuredSignals, openAgentTerminal, getTaskRuntime, scheduleRuntimeRefresh, dispose]、gating-router[createGraphTaskState, applyAgentResultToGraphState, handleActionRequired, resumeAfterHandoffBatchResponse, triggerHandoffDownstream]、gating-scheduler[planHandoffDispatch, recordHandoffBatchResponse, planApprovedDispatch]、task-runtime[resumeTask, runTaskLoop]、topology-compiler[compileTopology]、types[usesOpenCodeBuiltinPrompt, createTopologyFlowRecord, normalizeActionRequiredMaxRounds, getActionRequiredEdgeLoopLimit, getTopologyEdgeId]、decision-parser[parseDecision, stripStructuredSignals]、decision-response[extractTrailingDecisionSignalBlock, stripDecisionResponseMarkup, stripLeadingDecisionResponseLabel]、task-completion-message[buildTaskCompletionMessageContent]、task-lifecycle-rules[reconcileTaskSnapshotFromMessages]、chat-mentions[getMentionContext, getMentionOptionItems]、task-submission[resolveTaskSubmissionTarget]、message-forwarding[stripTargetMention, buildDownstreamForwardedContextFromMessages]、chat-messages[mergeTaskChatMessages, extractAgentFinalDisplayContent, extractTrailingTopLevelSection]、chat-message-format[buildMentionSuffix, formatAgentDispatchContent, formatActionRequiredRequestContent]、chat-execution-feed[buildChatExecutionWindows, buildChatFeedItems]
### 4.3 展示、终端与日志
- GUI 只负责当前 Task 的展示与继续发消息，不负责 Agent、Prompt、拓扑、Project、Task 的创建与保存；主界面展示聊天流、拓扑图、团队成员列表、当前 Task 语境下的 Agent 状态 / prompt 摘要，拓扑与聊天中的 Agent 配色保持一致，面板支持全屏，运行中的 Agent 会通过 OpenCode HTTP session 轮询实时工具调用与摘要。单个 CLI 进程只承载一个 Task，因此浏览器入口 URL 与前端 `ui-snapshot` 请求都不再传递 `taskId` 参数，页面直接绑定当前进程内的唯一 Task。CLI 与 GUI 都围绕 OpenCode session attach 到单个 Agent，入口统一放在拓扑节点头部；Windows 默认使用 `cmd.exe /k` 拉起 attach 终端，可通过 `AGENT_TEAM_WINDOWS_TERMINAL=powershell` 切换。用户数据目录承载 Task 日志与运行时释放的 Web 资源，CLI 启动时会初始化 Task 级日志，诊断日志按 JSON Lines 追加写入 `logs/tasks/<taskId>.log`，默认目录不可写时必须显式设置 `AGENT_TEAM_USER_DATA_DIR`。App[App]、ChatWindow[ChatWindow]、TopologyGraph[TopologyGraph]、frontend-agent-order[orderAgentsForFrontend]、agent-prompt-snippet[buildAgentPromptSnippetText]、agent-history[buildAgentHistoryItems, buildAgentExecutionHistoryItems]、topology-canvas[buildTopologyCanvasLayout]、agent-colors[getAgentColorToken]、topology-graph-helpers[getTopologyAgentStatusBadgePresentation, getTopologyNodeHeaderActionOrder]、task-attach-display[renderTaskAttachCommands]、terminal-commands[buildCliOpencodeAttachCommand]、terminal-launcher[buildTerminalLaunchSpec]、web-api[getTaskRuntime]、runtime-event-refresh[shouldRefreshForRuntimeEvent]、cli[createCliContext, disposeCliContext]、user-data-path[resolveCliUserDataPath, resolveDefaultUserDataPath]、app-log[initAppFileLogger, appendAppLog]、runtime-assets[ensureRuntimeAssets]
## 5. CLI 约定

- CLI 默认使用当前目录作为工作目录，`task headless`、`task ui` 在解析 `--cwd` 时要求目标路径真实存在且为目录；创建 CLI 上下文前都会先执行一次 `opencode --help` 预检查，失败即直接报错。
- CLI 提供 `task headless`、`task ui`：前者会新建当前 Task、打印本轮群聊并在任务结束后退出；后者会新建当前 Task、启动本地 Web Host、打开浏览器页面并持续驻留到 `Ctrl+C` / `SIGTERM`。
- `task ui` 只会使用已构建好的静态资源；启动前会检查 `index.html` 是否存在，浏览器地址与本地 Web Host 监听地址统一使用 `localhost`，缺少入口文件时直接报错。
- CLI / 终端里的 attach 文案都直接显示底层 `opencode attach ...`；当 `group` 新增 runtime agent 且获得新 session 时，会增量打印新的 attach 命令。
- `bun run cli -- ...` 需要在仓库根目录执行；若从其他目录排查目标工作区，`task headless` / `task ui` 必须显式传入 `--cwd`。收到 `Ctrl+C` / `SIGTERM` 时，CLI 会先回收当前命令启动或连接过的全部 OpenCode 实例，再结束进程。

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
