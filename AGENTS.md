# AGENTS

当前项目内置的是一套默认示例协作模板，但运行时不会把这些名字当成系统固定角色。

默认初始化时会生成这些本地 Agent 文件：

- `BA`
- `CodeReview`
- `DocsReview`
- `IntegrationTest`
- `UnitTest`

另外还会附带一个 OpenCode 内置 agent：

- `Build`

## 当前约定

- Agent 文件位于 `.opencode/agents/**/*.md`
- Agent frontmatter 使用最新的 `permission:` 配置字段，值使用 `allow / ask / deny`
- `Build` 是项目内部名称，底层对应 OpenCode 自带内置 `build` agent，不对应本地 Markdown 文件
- 除 `Build` 外，其余本地 Agent、非本地 Agent、公共 Agent 一律按“审查类 Agent”处理；只有 OpenCode 内置 `Build` 是实际执行实现的 Agent
- 审查类 Agent 通过 OpenCode HTTP 配置接口会被默认强制注入 `write/edit/bash: deny`，不依赖它们各自 Markdown 里是否手写了权限
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认拓扑只在 Project 首次初始化、且当前还没有拓扑数据时按 `role / mode / 是否内置` 自动推断
- 当前默认工作流是：`BA -> Build -> (DocsReview / UnitTest / IntegrationTest)`，随后 `IntegrationTest -> BA`
- `CodeReview` 目前保留为可选 Agent，不会自动加入默认链路，只有用户手动改拓扑时才会接入
- Project 一旦已有拓扑，后续运行时只认当前拓扑，不会再根据固定名字做调度判断
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取当前 Project 下 `.opencode/agents/**/*.md` 的最新内容，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
- Project 只保留全局注册信息；拓扑、Task、消息、panel 绑定等运行数据保存在各自 Project 目录下的 `.agentflow/`
- CLI 不再在 `<project>/.agentflow/projects.json` 静默回退创建本地 Project registry；若默认全局目录不可写，必须显式设置 `AGENTFLOW_USER_DATA_DIR`
- GUI 主布局为：左侧 `Project + Task` 列表，右侧上方大拓扑图，右侧下方左聊天、右 Agent 列表
- 右下角团队成员面板顶部展示当前 Task 最后一条群聊消息，以及当前 Task 的 panel 绑定摘要
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息
- 拓扑边只保留一种触发语义：`success`，表示当前 Agent 审查通过或执行完成后自动触发下游
- 审查类 Agent 一旦给出“需要修改 / 审查不通过”，系统会固定触发 `Build`，并把当前 Task 直接收口为“不通过”；这条失败链路不再由拓扑单独配置
- 若当前节点执行完成后，拓扑里不存在可自动继续推进的下游节点，Task 会进入 `waiting` 状态；左侧 Task 列表与群聊系统消息都必须同步反映这个状态
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent
- 左侧 Task 列表支持右键删除 Task；删除时会同时清理该 Task 对应的 Zellij session
- 左侧 Task 列表会定期与 Zellij session 状态同步；如果对应 session 已被外部删除，或只剩 `EXITED - attach to resurrect` 这类非活跃残留，关联 Task 会从列表中自动移除
- 后台 Task 整体完成后，左侧 Task 列表会为未查看的已完成项显示提醒，并在对应 Project 卡片上汇总提醒数量；点开该 Task 后提醒会自动消除
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系仍可通过点击节点编辑
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时默认优先取 `BA` 作为最左侧起点
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息中展示
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，包括普通消息与 Tool Call 参数摘要，而不只是单行运行状态
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane；macOS 和 Windows 下都会尽量把新拉起的终端窗口自动切到全屏
- 若当前电脑未安装 `zellij`，Task 创建后会追加系统提醒；GUI 点击“打开 Zellij”和 CLI 进入 session 时会直接提示先安装 `zellij`
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便 debug 当前会话
- Zellij pane 顺序只跟随前端拓扑/团队成员区里用户拖拽后保存的 Agent 排序，不再根据运行态动态重排
- 全新 Task 首次初始化、且当前还没有托管 pane 时，Zellij 会优先按最多三列的 tiled grid 创建初始 pane 布局，内部 pane 顺序直接使用当前保存的 Agent 排序
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内
- GUI 中点击 Agent 只支持查看对应原始配置文件，不支持在应用内直接编辑 `.opencode/agents/**/*.md`
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示仍保留原始 `@Agent` 文本，但底层发送给目标 Agent 的正文会自动去掉开头用于寻址的 `@Agent`，不额外拼接结构化前缀
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看，不会作为“尚未收到的群聊历史”再次转发给下游 Agent
- Agent 自动触发下游 Agent 时，只会封装 `[From]`、`[Message]`；同时会在 `[Requeirement]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动
- CLI 默认使用当前目录作为 project cwd
- CLI 只支持当前 Agent 名称
- CLI 支持单独的 `task init` 初始化步骤：先创建 Task，并把全部 Agent 的 OpenCode session / Zellij pane 启动完成；GUI 输入框会优先弹出候选 Agent 并默认选中 `Build`，CLI 仍通过 `task send <agent> <message...>` 指定目标
- `task send <agent> <message...>` 成功后会打印可复制的 panel 打开命令

## 文档同步要求

以下变更必须同步检查并在需要时更新 `README.md` 与本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agentflow/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化
