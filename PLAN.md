**OpenCode Code Agent 编排工具实施方案**
**（Task 级群聊 + Project 级 Agent/拓扑配置 + Orchestrator 中心调度）**

**完整实施计划（以本版为准）**
本计划以当前最新决策为准，核心约束如下：

- 左侧核心是 `Project + Task` 的垂直 `PANEL`。
- 中间主区域显示的是“当前选中 Task 的群聊界面”。
- 这个群聊是 `Task` 级别，不是 `Project` 级别。
- 用户会在 Task 群聊里通过 `@AgentName` 给某个 Agent 下发任务。
- Agent 完成阶段工作后，也可以在同一个 Task 群聊里看到“它 @ 了其他 Agent”的消息。
- 但底层真正触发下游 Agent 的不是 Agent 自己，而是 Orchestrator 按拓扑配置统一调度。
- Agent 是 `Project` 级资源，不存在 `Task` 级独立 Agent。
- 拓扑也是 `Project` 级配置，不存在 `Task` 级独立拓扑或拓扑快照。
- 中间输入框在用户输入 `@` 时，要弹出 Agent 候选框，支持自动补全。
- 右上角是真正的拓扑图，并且支持动态修改下游触发关系。
- 右下角展示的是当前 Project 的 Agent 列表，以及它们在当前 Task 里的状态。
- 点击右上角拓扑图中的 Agent，是配置“这个 Agent 会去跟哪些 Agent”。
- 点击右下角 Agent 列表中的 Agent，是编辑这个 Agent 的 OpenCode 原始配置文件。

### 1. 最终确认的产品结构
系统采用两层核心对象，加一个调度层：

第一层为 Project。
每个 Project 绑定且只绑定一个 CWD，作为该 Project 下全部 Task、Agent 配置与拓扑配置的共享工作目录。Project 承载：

- Project 基础信息
- Agent 原始配置文件
- Project 下全部 Agent
- Project 级拓扑定义
- Project 下全部 Task

第二层为 Task。
Task 是用户真正协作和观察的基本容器，也是围绕一个工作目标持续推进的执行线程与聚合视图。Task 承载：

- Task 基础信息
- Task 群聊 Talk
- 当前状态
- 独立 Zellij session
- 当前 Task 运行时的 `panel <-> agent` 对应关系
- 当前 Project 全部 Agent 在该 Task 语境下的状态变化

第三层为执行调度。
执行调度由 Orchestrator 驱动，负责：

- 读取 Agent 配置
- 读取 Project 级拓扑配置
- 启动 Task 时扫描 Project 内全部已配置 Agent
- 判断谁可以触发谁
- 创建或推进 Task
- 创建并维护 `panel <-> agent` 运行时映射
- 更新 Task 与 Project Agent 在对应 Task 下的状态
- 把结果正文写回当前 Task 群聊

### 2. 关键建模：Talk 属于 Task；Agent 与拓扑属于 Project
这是本次方案里最重要的约束。

错误方向是：

- 一个 Project 只有一个统一大群聊
- 所有 Task 的消息都混在一起
- 用户在 Project 群聊里持续 `@Agent`

这个模型的问题是：

- 多个任务会把消息流搅在一起
- 用户很难判断某条消息属于哪一个任务
- Agent 协作链路不容易和某个具体任务绑定

最新方案改为：

- Talk 存在于 Task 维度
- 一个 Task 对应一个群聊 Talk
- 用户在这个 Task 群聊里 `@Agent`
- Agent 间的协作消息也回到这个 Task 群聊
- Agent 始终是 Project 级资源，不随 Task 复制出独立集合
- 拓扑始终是 Project 级配置，所有 Task 都读取同一份当前拓扑
- Project 负责承载 Task 列表，不承载统一聊天主视图

### 3. 用户真正想看到的交互
本轮功能目标聚焦为以下几件事：

1. 左侧看到 `Project + Task` 的垂直结构。
2. 中间看到当前 Task 的群聊消息流。
3. 群聊里既能看到“人 -> Agent”的消息，也能看到“Agent -> Agent”的消息。
4. 用户要对某个 Agent 讲话时，必须在消息里 `@这个 Agent`。
5. 用户输入 `@` 时，输入框光标附近会弹出 Agent 候选列表。
6. 用户可以用方向键、鼠标或 `Tab` 选中候选 Agent。
7. 用户一回车，消息立刻进入当前 Task 群聊，同时前端立刻把被 `@` 的 Agent 状态改成工作中。
8. 如果某个 Agent 完成后需要触发其他 Agent，前端会看到一条像“这个 Agent @ 了其他 Agent”的消息。
9. 但只有当拓扑配置允许时，Orchestrator 才会真正触发下游 Agent。
10. 右上角看到真实拓扑图。
11. 右下角看到当前 Project 的 Agent 列表，以及它们在当前 Task 下的状态。
12. 点击拓扑图中的 Agent 节点后，可以配置“这个 Agent 会去跟哪些其他 Agent”。
13. 点击右下角某个 Agent 后，可以编辑这个 Agent 的 OpenCode 原始配置文件。

### 4. 界面布局
前端结构固定为三块区域：

左侧：`Project + Task` 垂直 `PANEL`

- 顶层列出全部 Project
- 展开某个 Project 后，列出该 Project 下全部 Task
- Task 在这里既是执行记录，也是对应的聊天会话
- 用户选中哪个 Task，中间就显示哪个 Task 的群聊

中间：Task 级群聊消息流

- 展示当前选中 Task 的群聊 Talk
- 用户在这里输入消息
- 用户通过 `@AgentName` 指定对哪个 Agent 讲话
- 当用户输入 `@` 时，输入框光标附近弹出 Agent 候选列表
- 候选列表来自当前 Project 的 Agent 集合
- 用户可通过方向键、鼠标或 `Tab` 选中一个 Agent
- 选中后，输入框内插入标准化的 `@AgentName`
- 用户消息、Agent 对 Agent 消息、阶段性结果、最终结果都在这里按时间顺序展示

右上：Project 当前拓扑图

- 必须是真正画出来的图
- 节点是 Agent
- 边表示“允许触发”或“完成后可触发”的关系
- 图上体现的是当前 Project 生效中的拓扑
- 用户点击某个 Agent 节点后，配置的是“这个 Agent 会去跟哪些 Agent”
- 如果新增一个下游 Agent，拓扑图里立即新增一条线
- 如果移除一个下游 Agent，拓扑图里对应的线立即消失
- 拓扑图始终根据当前拓扑配置动态刷新

右下：Project Agent 列表（当前 Task 视角）

- 展示当前 Project 的所有 Agent
- 展示名称、模型、角色摘要、当前状态
- 状态是“该 Agent 在当前选中 Task 中的状态”，而不是一个全局状态
- 状态至少包括 `idle / running / completed / failed`
- 用户点击某个 Agent 时，弹出该 Agent 的编辑窗
- 这里的点击行为只负责编辑 Agent config 文件，不负责修改拓扑关系

### 5. Task 群聊消息模型
中间区域展示的是 Task 级群聊，不是单 Agent 聊天窗口。

Task 群聊中至少要出现三类消息：

- 用户发给某个 Agent 的消息
- 展示为“Agent -> Agent”的协作消息
- Agent 或系统回写的阶段性结果 / 最终结果

典型样子应当类似：

1. 用户：
   `@Build 请实现登录流程并补测试。`
2. Build：
   `@TaskReview 请检查交付结果是否完整。`
3. Build：
   `@UnitTest 请开始单元测试。`
4. Build：
   `@IntegrationTest 请开始集成测试。`
5. TaskReview：
   `已完成文档审查，AGENTS.md 已同步核对。`

这里要注意：

- 前端看到的是一种群聊表达
- “Build @ TaskReview” 这类消息是协作可视化
- 底层真正的调度动作由 Orchestrator 统一完成
- Agent 在执行中产生的大量工具调用、搜索、grep、编辑等 low-level 过程，不默认进入 Task 群聊
- Task 群聊默认只展示对用户有意义的消息，尤其是该 Agent 本轮任务的最终回复

### 6. 输入框 `@` 自动补全
中间聊天输入框必须支持 `@` 自动补全。

目标交互如下：

1. 用户在输入框里输入 `@`。
2. 前端立即捕获这个符号。
3. 输入框光标附近弹出 Agent 候选列表。
4. 候选列表基于当前 Project 的 Agent 集合做过滤。
5. 用户可以用方向键移动选中项。
6. 用户可以鼠标点击选中候选项。
7. 用户按 `Tab` 时，视为选中当前候选 Agent。
8. 选中后，输入框补全为标准化的 `@AgentName`。
9. 用户发送消息时，前端只做轻量解析，用于输入体验和 optimistic UI。
10. 发送时，由后端/Orchestrator 完成最终解析、校验与派发。

底层原理可归纳为：

1. 接收到 `@` 符号。
2. 前端基于 Project Agent 列表做补全与预解析。
3. 后端/Orchestrator 权威解析用户 `@` 的 Agent 名字并给对应的 Agent 发消息。

### 7. 用户给 Agent 下发任务后的即时反馈
为了满足“消息已发出”和“Agent 已开始工作”的体验，链路必须按以下顺序设计：

1. 用户在当前 Task 群聊输入消息并按回车。
2. 前端先做轻量解析，识别消息里的 `@AgentName`，用于即时反馈。
3. 前端立即 optimistic append 用户消息到当前 Task 群聊。
4. 前端立即把该 Agent 的 UI 状态切到 `running` 或 `queued/running`。
5. 前端立刻调用后端提交接口。
6. 后端持久化用户消息到当前 Task Talk。
7. 后端创建或推进对应执行。
8. 后端推送状态事件，前端据此确认或修正 Agent 状态。
9. 后端继续真实执行。

这里的关键不是“后端全部做完再显示”，而是：

- 先让用户马上看到消息已进入群聊
- 先让用户马上看到对应 Agent 已经开始工作

### 8. Agent 对 Agent 的消息流
前端需要能看到“Agent 对 Agent 的消息流”，但底层机制要明确区分“展示语义”和“真实执行语义”。

正确机制是：

- 某个 Agent 完成当前阶段工作
- Orchestrator 读取这个 Agent 的完成结果
- Orchestrator 再读取当前 Project 拓扑里这个 Agent 被配置允许触发的下游 Agent
- 如果满足触发条件，Orchestrator 代为生成一条协作消息，展示成“这个 Agent @ 了其他 Agent”
- 随后由 Orchestrator 真正向下游 Agent 发送消息并启动执行

也就是说，前端看到的可能是：

- `Build: @UnitTest 请开始单元测试。`
- `Build: @TaskReview 请检查当前交付是否达标。`
- `Build: @IntegrationTest 请开始集成测试。`
- `BA: @Build 请继续推进实现。`

但底层并不是“Build 自己直接调用下游”，而是：

- Build 完成
- Orchestrator 根据 trigger 配置判断下游
- Orchestrator 写入一条拟人化消息到 Task 群聊
- Orchestrator 真实触发下游 Agent

### 9. `@` 触发规则：只有拓扑允许时才真正执行
这是本版计划里必须明确写死的规则。

规则如下：

1. 用户在 Task 群聊中 `@AgentX`：
   - 作为直接派发，允许启动对应执行
   - 同时把 AgentX 状态改为运行中
2. 前端看到一条 `AgentA @AgentB` 风格的消息：
   - 这条消息通常由 Orchestrator 在 `AgentA` 完成后生成
   - 只有当当前 Project 拓扑允许 `AgentA -> AgentB` 时，Orchestrator 才会真正触发 `AgentB`
   - 如果拓扑不允许，则不生成伪装成 `AgentA @AgentB` 的协作消息，也不启动 `AgentB`；如需可观测性，只能生成一条系统说明消息

因此：

- 群聊里的 `@` 是一层协作可视化表达
- 拓扑配置决定的是“是否真的生效”
- 真正向下游 Agent 发消息并启动执行的是 Orchestrator

### 10. 右上角拓扑图：必须是真图，且支持编辑
拓扑图不是辅助装饰，而是核心工作区之一。

最低要求：

- 节点真实可见
- 节点之间的边真实可见
- 用户能看出当前谁允许触发谁
- 图形布局清晰，不是纯文本列表模拟

推荐实现方式：

- 使用 React Flow 一类图编辑组件
- 节点表示 Agent
- 边表示“完成后允许触发”的关系
- 节点可点击
- 边可新增、删除、变更

### 11. 点击 Agent 节点后的配置交互
当用户在拓扑图里点击某一个 Agent 节点后，应弹出一个配置框。

这个配置框至少支持：

1. 展示当前 Agent 的基本信息。
2. 展示“该 Agent 会去跟哪些 Agent / 完成后允许触发哪些 Agent”的现有配置。
3. 提供一个可选择的 Agent 列表。
4. 用户可勾选或取消勾选某些下游 Agent。
5. 用户保存后，Project 当前拓扑立即更新。
6. 拓扑图根据更新后的配置立即重新渲染。
7. 如果新增了一个下游 Agent，图上立即新增一条从当前 Agent 指向下游 Agent 的线。
8. 如果移除了一个下游 Agent，图上立即删除对应的线。

这里要再次明确：

- 点拓扑图中的 Agent，是改关系
- 不是改这个 Agent 的 config 文件

### 12. 下游 Agent 选择模型
当用户配置某个 Agent 的下游时，推荐使用如下模型：

- 当前节点：`sourceAgent`
- 下游候选列表：Project 内除自己外的全部 Agent
- 已选中的下游集合：`nextAgents[]`
- 触发条件首版统一为“当前 Agent 完成后允许触发”

例如：

- 点中 `Build`
- 弹框里勾选 `UnitTest`
- 再勾选 `TaskReview`
- 再勾选 `IntegrationTest`
- 保存后，拓扑图更新为：
  `Build -> UnitTest`
  `Build -> TaskReview`
  `Build -> IntegrationTest`

也就是说，拓扑图本身就是配置结果的可视化：

- 配置里多一个下游，图里就多一条线
- 配置里少一个下游，图里就少一条线
- 图完全根据拓扑配置动态刷新

### 13. 拓扑修改后的行为
拓扑是 Project Level 的实时配置，Task 不持有自己的拓扑快照。

因此：

- 用户编辑的是 Project 当前拓扑
- 新建 Task 时，直接读取当前 Project 拓扑
- 已存在的 Task 在后续调度判定中，同样读取当前 Project 拓扑
- 用户修改拓扑后，右上角拓扑图立即刷新，后续调度立即按新拓扑生效

所以：

- 只有 Project 拥有可编辑拓扑
- Task 只承载聊天记录、执行状态和运行上下文
- Task 群聊里的触发判定，永远依据 Project 当前生效中的拓扑

### 14. Agent 与配置修改后的行为
Agent 也是 Project Level 的配置，Task 不持有自己的 Agent 副本或配置快照。

因此：

- 右下角展示的是 Project 全量 Agent，只是状态按当前 Task 语境展示
- 用户编辑 Agent 原始配置文件后，后续新的派发按最新配置生效
- 已经启动中的单次 Agent 执行不要求被中途热改写

所以：

- Agent 名单是 Project 级唯一真源
- Agent 原始配置文件也是 Project 级唯一真源
- Task 只记录“哪些 Project Agent 在这个 Task 中做过什么、当前状态是什么”

### 15. Orchestrator 职责
Orchestrator 的职责分为“群聊反馈”和“执行调度”两部分。

群聊反馈职责：

- 向前端暴露当前 Project 的 Agent 名单与当前拓扑数据
- 权威解析用户消息中的 `@AgentName`
- 在 Agent 完成后，根据 trigger 配置生成“Agent @ Agent”的协作可视化消息
- 把这些协作消息回推到当前 Task 群聊
- 推送 Agent 状态变化事件

执行调度职责：

- 读取并扫描 OpenCode Agent 原始配置文件
- 读取 Project 当前拓扑
- 在 Task 启动时解析出 Project 下全部可用 Agent
- 创建或推进 Task
- 创建对应 Zellij session
- 为每个 Agent 创建或绑定对应 panel，并维护 `panel <-> agent` 映射
- 启动首个 Agent
- 在某个 Agent 执行完成后，根据当前 Project 拓扑决定允许触发哪些下游 Agent
- 由 Orchestrator 真正向下游 Agent 发送消息并启动执行
- 更新 Task 与 Project Agent 在该 Task 下的状态
- 标记 Task 完成或失败

这里要注意：

- 前端看到的 Agent 间消息，是协作可视化
- 真正的消息下发与调度决定，仍由 Orchestrator 按拓扑统一控制

### 16. Task 启动时的 Agent 发现与 panel 绑定
启动一个新 Task 时，Orchestrator 必须先完成一次 Project 级 Agent 发现，再进入执行阶段。

启动顺序应当是：

1. 读取 Project 当前目录下的 Agent 配置源。
2. 优先扫描 OpenCode 的 Agent 配置，尤其是：
   - `.opencode/agents/**/*.md`
   - 以及后续 OpenCode 实际采用的其他 Agent 配置格式
3. 汇总出当前 Project 的完整 Agent 名单、基础元信息和配置来源。
4. 基于这份 Project Agent 名单创建当前 Task 的运行时实例视图。
5. 创建当前 Task 对应的 Zellij session。
6. 按 Agent 逐个启动对应的 OpenCode pane。
7. 为每个 pane 记录唯一的运行时映射，例如：
   - `taskId`
   - `sessionName`
   - `paneId`
   - `agentName`
8. 后续所有派发、状态追踪、结果通道定位，都通过这份 `panel <-> agent` 映射定位到目标 pane。

这里要明确：

- Agent 名单来自 Project 配置，不来自 Task 自己维护的副本
- `panel <-> agent` 映射是 Task 运行时状态，不是新的配置源
- pane 可以被销毁和重建，但 `agentName -> 当前有效 pane` 的运行时映射必须始终可追踪

### 17.1 最终回复优先的消息采集原则
系统要采集的是“这次任务最终给用户看的回复”，而不是把 Agent 在执行过程中的全部低层输出搬运到聊天界面。

因此必须遵守：

- Task 群聊默认不展示工具调用细节
- Task 群聊默认不展示 grep、搜索、读写文件、命令执行等低层轨迹
- Task 群聊默认只展示该轮任务的最终回复
- 如果需要展示中间结果，也只能展示被 Orchestrator 提炼过的阶段消息，而不是原始工具日志

换句话说：

- pane 是执行面
- Task 群聊是结果面
- 两者不做逐行镜像

### 17. OpenCode 启动策略
当 Orchestrator 为某个 Agent 启动对应 pane 时，应显式指定这个 pane 代表哪个 Agent。

按当前方案，推荐约束为：

- 一个 pane 对应一个 Agent 运行实例
- 启动 OpenCode 时显式传入 Agent 选择参数
- 如果运行环境支持 `--agents` 形式的参数，就由 Orchestrator 维护“哪个 panel 对应哪个 agent”的绑定关系
- 如果最终 OpenCode CLI 实际只有 `--agent` 这一类单 Agent 启动参数，则退化为“每个 pane 启一个固定 Agent 实例”，整体架构不变

换句话说，系统真正依赖的不是某个具体 flag 名字，而是这条运行时约束：

- Orchestrator 必须知道每个 pane 里跑的是哪个 Agent
- 这个绑定关系必须可持久记录、可查询、可恢复

### 18. 任务派发与结果回写的传输层
在已经拥有 `Task -> Zellij session -> pane -> agent` 这条完整映射之后，传输层应采用 `Zellij + OpenCode Server API` 的混合模型，而不是只依赖 Zellij。

更直接的做法是：

- 配置更新直接改 Project 内的 OpenCode 原始配置文件
- Zellij 负责创建和管理 session / pane，并维护 `panel <-> agent` 绑定
- 如果需要把文本真正送进某个 pane 的交互界面，可以继续通过 Zellij CLI 输入
- 但 Agent 的会话消息、最后一条回复、运行中/已完成/idle 等语义状态，不依赖 Zellij 屏幕内容判断
- 这些语义状态统一通过 OpenCode Server 的 HTTP API 或 SSE 事件流获取
- 群聊里的阶段结果、最终结果、`Agent -> Agent` 协作消息，统一由 Orchestrator 根据 OpenCode 的消息与状态事件进行转写和回推

因此，首版的建议是：

- 不依赖 pane 原始屏幕内容作为最终结果真源
- 不依赖屏幕抓取去判断某个 Agent 是否完成或是否 idle
- OpenCode Server API 是获取会话语义状态的主链路
- Zellij 是执行容器与 pane 编排层，不是 Agent 状态真源

这里要特别强调：

- 这不叫“模拟 OpenCode 发消息”，而是 Orchestrator 作为外层控制面，驱动真实的 OpenCode pane 执行，并通过 OpenCode API 获取真实消息与状态
- Task 群聊里的消息始终是产品层表达，不要求与 OpenCode 内部原始消息格式一一对应

### 18.1 为什么不能只靠 Zellij
Zellij 能提供的是 pane 级控制与观测，不是 Agent 级语义状态。

也就是说，Zellij 可以：

- 列出 pane / tab / session
- 向指定 pane 写入输入
- 观察 pane 当前渲染内容
- 在“pane 直接运行一个会退出的命令”时，通过 pane exit status 判断命令是否结束

但对于“长期存活的交互式 OpenCode Agent pane”，Zellij 不能可靠回答这些问题：

- 这个 Agent 当前是不是已经完成了这一轮任务
- 这个 Agent 现在是不是回到了 idle
- 这一轮任务最后一条 assistant 消息到底是哪一条
- 当前屏幕上的文本里，哪些是工具过程，哪些是最终回复

因此：

- 对长期存活的 Agent pane，不能把 `pane still alive / pane exited / 当前屏幕文本` 误当成 Agent 任务状态
- Zellij 只能作为容器控制层
- Agent 语义状态必须从 OpenCode 自身的 session/message/status/event 面拿

### 18.2 最终结果通道
为了稳定拿到“最后一条任务回复”，结果真源应是 OpenCode 的 session/message/event 数据，而不是 pane 屏幕文本。

Orchestrator 至少应依赖以下能力：

1. 通过 OpenCode session/message API 获取某个 Agent 会话的消息列表。
2. 通过 session status 或事件流判断该 Agent 当前是否仍在运行。
3. 在任务结束后，读取最后一条 assistant 消息作为 `finalMessage` 的上游真源。
4. 如有需要，再由 Orchestrator 把 OpenCode 原始消息归一化成产品层消息格式。

这里的关键是：

- Orchestrator 读取的是 OpenCode 会话里的最终 assistant 消息
- 不是从 pane 屏幕上猜“最后一句是什么”
- pane 内的完整低层输出可以保留用于调试，但不作为 Task 聊天主数据源

### 18.3 阶段消息与最终消息的边界
首版建议把 Agent 结果分成两层：

- `finalMessage`
  这是唯一必须稳定产出的字段，默认由 OpenCode 会话中的最后一条 assistant 消息映射而来，也是默认展示到 Task 群聊里的 Agent 回复
- `progressSummary`
  这是可选字段，只在确实需要的时候，才由 Orchestrator 基于状态事件提炼出一两条阶段消息

明确禁止：

- 把原始工具调用日志直接塞进 Task 群聊
- 把 pane 屏幕逐行同步到 Task 群聊
- 依赖屏幕抓取去推断最终回复边界

### 19. Agent 配置机制
配置机制继续采用 OpenCode 原生本地文件方式。

首版仍以项目内 Agent 原始配置源为准，例如：

- `.opencode/agents/**/*.md`

如果后续 OpenCode 的 Agent 配置采用 `agents.nv` 等其他格式，原则也不变：

- 前端不抽象第二套配置模型
- 前端直接编辑 OpenCode 的原始配置文件

右下角 Project Agent 列表与这个文件编辑器直接联动：

- 用户点击右下角某个 Agent
- 前端弹出编辑窗
- 编辑窗加载该 Agent 对应的 OpenCode 原始配置文件
- 保存后立即写回源文件
- 后续 Task 启动或后续派发前由 Orchestrator 重新扫描并 Reload

这里要与拓扑图点击行为严格区分：

- 右上角点 Agent 节点：修改这个 Agent 会去跟哪些 Agent
- 右下角点 Agent 成员：编辑这个 Agent 的 config 文件

### 20. 前端不做的事情
为避免目标跑偏，以下事项依然不作为当前重点：

- 不做 Project 级统一群聊主视图
- 不把会话拆成“每个 Agent 一个单聊窗口”
- 不展示 Task 内每个 Agent 的实时 stdout/stderr
- 不嵌入 xterm 来复刻真实执行过程
- 不在前端复刻 Zellij `PANEL` 布局
- 不做实时 `PANEL` 监工台
- 不拆出独立的 Agent tools 配置表单系统

这里要明确：

- 前端主交互就是 Task 级别的群聊
- 用户会在这个 Task 群聊里围绕当前任务持续下发指令和讨论
- 这并不和“前端不做的事情”冲突；这里排除的是 Project 级大群聊、单 Agent 单聊、终端监工台这类偏航方案

### 21. 首要验收标准
本版计划完成后，最重要的验收标准是：

1. 左侧是清晰的 `Project + Task` 垂直 `PANEL`。
2. 中间是当前 Task 的群聊消息流，而不是 Project 群聊。
3. 用户能在 Task 群聊里通过 `@AgentName` 对指定 Agent 下发任务。
4. 用户在输入框里输入 `@` 时，光标附近会弹出 Agent 候选列表。
5. 用户可以通过 `Tab` 选中候选 Agent，并完成自动补全。
6. 用户一回车，就能立刻在当前 Task 群聊里看到自己的消息。
7. 用户一回车，就能立刻在右下角 Agent 列表里看到对应 Agent 状态变更。
8. Agent 完成后，前端能在同一 Task 群聊里看到 Agent 对 Agent 的消息。
9. Agent 对 Agent 的 `@` 只有在拓扑允许时才会真正触发执行。
10. 右上角能看到真正的拓扑图。
11. 点击拓扑图中的某个 Agent 节点，会弹出配置框。
12. 用户能在该配置框里修改“这个 Agent 会去跟哪些其他 Agent / 完成后允许触发哪些其他 Agent”。
13. 用户点击右下角某个 Agent 时，会弹出编辑窗，并能直接编辑这个 Agent 对应的 OpenCode 配置文件。
14. 用户新增一个下游 Agent 后，拓扑图中会立即出现一条新的线；移除下游 Agent 后，对应线立即消失。
15. 保存后，拓扑图会根据 Project 当前拓扑动态刷新；新老 Task 后续的调度判定都按最新 Project 拓扑生效。
16. 启动新 Task 时，系统会先扫描 Project 下全部已配置 Agent，建立当前 Task 的 `panel <-> agent` 运行时映射。
17. Orchestrator 能通过 Zellij 会话准确定位到目标 Agent 对应的 pane，并向其下发任务。
18. Orchestrator 能稳定收到目标 Agent 本轮任务的结构化最终结果，至少包含 `status` 与 `finalMessage`，并回写到当前 Task 群聊。
19. Task 群聊默认不展示 Agent 的低层工具调用过程，只展示阶段消息和最终回复。

### 22. 直接落地方向
基于本版计划，后续实现优先级应当调整为：

1. 把当前会话模型收敛为 Task 级群聊 Talk。
2. 把中间主区域改为“当前 Task 的群聊消息流”。
3. 为聊天输入框补齐 `@` 候选列表、光标附近弹层与 `Tab` 自动补全能力。
4. 让消息流支持“人 -> Agent”与“Agent -> Agent”两类 `@mention` 展示。
5. 用户发送消息后，立即更新被艾特 Agent 的前端状态。
6. 左侧固定为 `Project + Task` 垂直 `PANEL`。
7. 右上角落地真实可交互拓扑图。
8. 为拓扑节点点击行为补齐弹框和下游 Agent 选择能力。
9. 在 Orchestrator 中补齐“只有拓扑允许时，Agent 间 `@` 才真正生效”的判定。
10. 右下角展示完整 Agent 群成员列表和状态。
11. 让拓扑图严格根据拓扑配置动态重绘边关系。
12. 为右下角 Agent 列表补齐点击后弹出原始配置文件编辑窗的能力。
13. 在 Task 启动前先扫描 Project 下全部 Agent，建立 `panel <-> agent` 运行时映射。
14. 优先通过 Zellij CLI 完成对目标 pane 的任务下发。
15. 为每个 Agent pane 增加一个极薄的 runner/adapter，用结构化 sidecar 通道把 `finalMessage` 回传给 Orchestrator。
16. 保留 Task 作为执行记录、聊天容器和 Zellij 会话承载单元。
17. 保留 OpenCode 原始 Agent 配置文件作为唯一配置源。

以上即为更新后的正式实施方案。后续设计与实现都应以这份约束为准。
