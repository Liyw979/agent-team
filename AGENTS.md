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
- 对只读 Agent，`write / edit / bash` 设为 `deny` 时，`patch / task` 也必须一起限制；运行时会对这类缺省项自动补成 `deny`，避免借子代理绕过只读约束
- `Build` 是项目内部名称，底层对应 OpenCode 自带内置 `build` agent，不对应本地 Markdown 文件
- 除 `Build` 外，其余本地 Agent、非本地 Agent、公共 Agent 一律按“审查类 Agent”处理；只有 OpenCode 内置 `Build` 是实际执行实现的 Agent
- 审查类 Agent 通过 OpenCode HTTP 配置接口会被默认强制注入 `write/edit/bash: deny`，不依赖它们各自 Markdown 里是否手写了权限
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认拓扑只在 Project 首次初始化、且当前还没有拓扑数据时按 `role / mode / 是否内置` 自动推断
- 当前默认工作流里，`BA -> Build`、`Build -> (DocsReview / UnitTest / IntegrationTest)`、`IntegrationTest -> BA` 使用 `association`；`BA / DocsReview / UnitTest / IntegrationTest -> Build` 使用 `review`
- `CodeReview` 目前保留为可选 Agent，不会自动加入默认链路，只有用户手动改拓扑时才会接入
- Project 一旦已有拓扑，后续运行时只认当前拓扑，不会再根据固定名字做调度判断
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取当前 Project 下 `.opencode/agents/**/*.md` 的最新内容，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
- Project 只保留全局注册信息；拓扑、Task、消息、panel 绑定等运行数据保存在各自 Project 目录下的 `.agentflow/`
- CLI 不再在 `<project>/.agentflow/projects.json` 静默回退创建本地 Project registry；若默认全局目录不可写，必须显式设置 `AGENTFLOW_USER_DATA_DIR`
- GUI 主布局为：左侧 `Project + Task` 列表，右侧上方大拓扑图，右侧下方左聊天、右 Agent 列表
- 右下角团队成员面板顶部仅展示当前 Task 的 panel 绑定摘要，不再额外显示最后一条群聊消息预览
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息
- 同一个 Agent 的最终回复后若紧接着自动触发下游，聊天区会把“最终回复 + 下游派发提示”合并展示成同一条消息；合并后只追加 `@目标Agent` 标记，避免连续出现两条重复的同名 Agent 卡片
- 审查类 Agent 给出“需要修改 / 审查不通过”后，聊天区会把该 Agent 的高层结论与发给下游整改 Agent 的请求合并展示成同一条消息；默认先展示高层结论与整改细节，再在消息末尾统一追加 `@目标Agent` 标记
- Agent 最终回复写入聊天区时，会优先提取其最终交付的尾部章节展示；像 BA 这类先分析再给正式结果的回复，聊天区默认只展示最后的正式交付内容，不展示前面的自我分析过程
- 拓扑边分为两种关系：`association` 表示当前 Agent 只要完成本轮任务就 100% 自动触发下游；`review` 表示当前 Agent 本轮失败、给出“需要修改 / 审视不通过”时才触发下游
- 审查类 Agent 不再固定硬编码回流到 `Build`；是否在审视不通过时继续派发、以及派发给谁，完全由当前拓扑里的 `review` 边决定
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
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane；macOS 下会固定新开独立 Terminal 窗口后再 attach，Windows 下会尽量把新拉起的终端窗口自动切到全屏
- 右下角团队成员面板中，每个 Agent 名称旁都会提供一个“打开 Pane”按钮；点击后会优先补齐当前 Task 的 pane 绑定，并直接打开该 Agent 自己的 OpenCode attach 独立终端窗口，而不是带出整个 Zellij session 网格
- Zellij pane 内部启动命令会按平台生成：macOS / Linux 使用 `/bin/sh`，Windows 使用 `cmd.exe`，不再把 POSIX shell 语法直接下发到 Windows pane
- 若当前电脑未安装 `zellij`，Task 创建后会追加系统提醒；GUI 点击“打开 Zellij”和 CLI 进入 session 时会直接提示先安装 `zellij`；安装提示会区分 macOS 的 `brew install zellij` 与 Windows 的 `winget install --id Zellij.Zellij`
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便 debug 当前会话
- Zellij pane 顺序只跟随前端拓扑/团队成员区里用户拖拽后保存的 Agent 排序，不再根据运行态动态重排
- 全新 Task 首次初始化、且当前还没有托管 pane 时，Zellij 会优先按最多三列的 tiled grid 创建初始 pane 布局，内部 pane 顺序直接使用当前保存的 Agent 排序
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内
- GUI 中点击 Agent 卡片只支持查看对应原始配置文件，不支持在应用内直接编辑 `.opencode/agents/**/*.md`；名称旁“打开 Pane”按钮用于打开该 Agent 对应的 OpenCode attach 独立终端窗口
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示仍保留原始 `@Agent` 文本；底层以 `raw` 方式转发给目标 Agent 的消息会统一封装成单行 `[发送者] <正文>`，并自动去掉仅用于寻址的开头或结尾 `@Agent`
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看；Agent 自动派发下游时，不再补充任何群聊历史，但会携带完整用户消息与当前这一次的上游结果；若上游结果已完整包含用户消息，会自动去重
- 群聊落库与 Agent 间转发只使用 OpenCode 返回消息里的公开 `text` part；`reasoning`、步骤和工具调用不会混入群聊正文或下游 Prompt
- Agent 自动触发下游 Agent 时，会拆成结构化段落：用户原始需求放入 `[User Message]`，上游结果放入动态的 `[@来源 Agent Message]` 段；对非 `Build` 下游，同时会在 `[Requeirement]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动；发给 `Build` 时不再附带 `[Requeirement]`
- CLI 默认使用当前目录作为 project cwd
- CLI 只支持当前 Agent 名称
- CLI 支持单独的 `task init` 初始化步骤：先创建 Task，并把全部 Agent 的 OpenCode session / Zellij pane 启动完成；GUI 输入框会优先弹出候选 Agent 并默认选中 `Build`，CLI 仍通过 `task send <agent> <message...>` 指定目标
- 用户在 Task 群聊里直接发送且未显式指定目标 Agent 时，系统会默认投递给 `Build`，并在群聊历史中自动补上 `@Build`；这类默认首跳转发给 Agent 时，底层格式仍是单行 `[发送者] <正文>`
- `task send <agent> <message...>` 成功后会打印可复制的 panel 打开命令

## 文档同步要求

以下变更必须同步检查并在需要时更新 `README.md` 与本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agentflow/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化
