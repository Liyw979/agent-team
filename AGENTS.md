# AGENTS

当前项目内置的是一套默认示例协作模板，但运行时不会把这些名字当成系统固定角色。

默认初始化时会生成这些本地 Agent 文件：

- `BA`
- `CodeReview`
- `DocsReview`
- `IntegrationTest`
- `UnitTest`

另外还会附带一个 OpenCode 内置 agent：

- `build`

## 当前约定

- Agent 文件位于 `.opencode/agents/**/*.md`
- Agent frontmatter 使用最新的 `permission:` 配置字段，值使用 `allow / ask / deny`
- `build` 是 OpenCode 自带内置 agent，不对应本地 Markdown 文件
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认拓扑只在 Project 首次初始化、且当前还没有拓扑数据时按 `role / mode / 是否内置` 自动推断
- 当前默认工作流是：`BA -> build -> (DocsReview / UnitTest / IntegrationTest)`，随后 `IntegrationTest -> BA`
- `CodeReview` 目前保留为可选 Agent，不会自动加入默认链路，只有用户手动改拓扑时才会接入
- Project 一旦已有拓扑，后续运行时只认当前拓扑，不会再根据固定名字做调度判断
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取当前 Project 下 `.opencode/agents/**/*.md` 的最新内容，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
- Project 只保留全局注册信息；拓扑、Task、消息、panel 绑定等运行数据保存在各自 Project 目录下的 `.agentflow/`
- GUI 主布局为：左侧 `Project + Task` 列表，右侧上方大拓扑图，右侧下方左聊天、右 Agent 列表
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息
- 拓扑边支持三种触发语义：`success` 表示当前 Agent 完成后 100% 自动触发下游，`failed` 表示只有当前 Agent 决策为“需要修改”时才触发下游返工，`manual` 表示只有当前 Agent 显式指定 `NEXT_AGENTS` 时才触发
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent
- 左侧 Task 列表支持右键删除 Task；删除时会同时清理该 Task 对应的 Zellij session
- 左侧 Task 列表会定期与 Zellij session 状态同步；如果对应 session 已被外部删除，或只剩 `EXITED - attach to resurrect` 这类非活跃残留，关联 Task 会从列表中自动移除
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系仍可通过点击节点编辑
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时默认优先取 `BA` 作为最左侧起点
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息中展示
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，包括普通消息与 Tool Call 参数摘要，而不只是单行运行状态
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane
- Zellij pane 顺序只跟随前端拓扑/团队成员区里用户拖拽后保存的 Agent 排序，不再根据运行态动态重排
- 全新 Task 首次初始化、且当前还没有托管 pane 时，Zellij 会优先按最多三列的 tiled grid 创建初始 pane 布局，内部 pane 顺序直接使用当前保存的 Agent 排序
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内
- GUI 中点击 Agent 只支持查看对应原始配置文件，不支持在应用内直接编辑 `.opencode/agents/**/*.md`
- 用户在 Task 群聊里直接 `@Agent` 时，底层会把原始消息原样发送给目标 Agent，不额外拼接结构化前缀
- Agent `@` 下游 Agent 时，只有显式指定下游或返工链路才会封装 `[From]`、`[Message]`、`[Requeirement]`；对于 `success` 的 100% 自动触发，只会保留 `[From]`、`[Message]`，不会额外拼接 `[Requeirement]`
- Agent 间显式派发下游任务时，会自动在转发 Prompt 的 `[Requeirement]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动；返工链路不附带该摘要
- CLI 默认使用当前目录作为 project cwd
- CLI 只支持当前 Agent 名称
- CLI 支持单独的 `task init` 初始化步骤：先创建 Task，并把全部 Agent 的 OpenCode session / Zellij pane 启动完成，再通过 `task send --task <taskId>` 向入口 Agent 发送第一条消息
- `task send <agent> <message...>` 成功后会打印可复制的 panel 打开命令

## 文档同步要求

以下变更必须同步检查并在需要时更新 `README.md` 与本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agentflow/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化
