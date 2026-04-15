# AGENTS

当前项目不再内置本地 Agent 模板文件，也不再依赖 `.opencode/agents/**/*.md` 作为运行真源。
Agent 统一由“用户目录中的自定义配置”提供，运行时会把该配置注入 OpenCode。

## 当前约定

- 自定义 Agent 配置保存在用户目录：`$AGENTFLOW_USER_DATA_DIR/custom-agents.json`（未显式设置时使用默认用户数据目录）；其中既保存已写入当前 Project 的 Agent，也保存当前 Project 的“内置模板 prompt 覆盖”
- 命令执行失败等诊断日志统一写入用户数据目录下的 `logs/agentflow.log`
- 每个 Project 都会启动各自独立的 `opencode serve`，并只在该实例启动前一次性注入当前 Project 的 Agent 配置；单个 serve 运行中不会对配置做 reload / 二次注入
- 只允许用户自定义 prompt；运行时会固定把 `write / edit / bash / task / patch` 权限强制为 `deny`
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认拓扑只在 Project 首次初始化、且当前还没有拓扑数据时按当前 Agent 列表自动推断
- Project 一旦已有拓扑，后续运行时只认当前拓扑，不会再根据固定名字做调度判断
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取用户目录里当前 Project 当前生效的自定义 Agent 配置，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
- Project 只保留全局注册信息；拓扑、Task、消息、panel 绑定等运行数据保存在各自 Project 目录下的 `.agentflow/`
- CLI 不再在 `<project>/.agentflow/projects.json` 静默回退创建本地 Project registry；若默认全局目录不可写，必须显式设置 `AGENTFLOW_USER_DATA_DIR`
- GUI 主布局为：左侧 `Project + Task` 列表，右侧上方大拓扑图，右侧下方左聊天、右 Agent 列表
- 右下角团队成员面板顶部仅展示当前 Task 的 panel 绑定摘要，不再额外显示最后一条群聊消息预览
- 当一个 Agent 同时触发多个下游 Agent 时，聊天区会合并展示为一条批量 `Agent -> Agent` 派发消息，而不是拆成多条重复消息
- 拓扑边只保留一种触发语义：`success`，表示当前 Agent 审查通过或执行完成后自动触发下游
- Agent 一旦给出需要继续响应的 `<revision_request> ...` 尾段，系统会把当前 Task 直接收口为“不通过”；失败链路不再单独派发固定 Agent
- 若当前节点执行完成后，拓扑里不存在可自动继续推进的下游节点，Task 会进入 `waiting` 状态；左侧 Task 列表与群聊系统消息都必须同步反映这个状态
- 当 Task 收口为 `finished` 时，右侧拓扑面板中的每个 Agent 节点都必须统一显示为 `已完成`，不再保留 `未启动 / 运行中` 等中间状态；聊天区也要追加一条“任务已经结束”的系统消息。Agent 运行态成功码统一使用 `completed`
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent
- 左侧 Task 列表支持右键删除 Task；删除时会同时清理该 Task 对应的 Zellij session
- 左侧 Task 列表会定期与 Zellij session 状态同步；如果对应 session 已被外部删除，或只剩 `EXITED - attach to resurrect` 这类非活跃残留，关联 Task 会从列表中自动移除
- 后台 Task 整体完成后，左侧 Task 列表会为未查看的已完成项显示提醒，并在对应 Project 卡片上汇总提醒数量；点开该 Task 后提醒会自动消除
- 拓扑节点顶部会直接展示 Agent 当前状态徽标，包括 `未启动 / 运行中 / 已完成 / 执行失败`，审查类 Agent 则显示 `审查通过 / 审查不通过`
- 右上角拓扑图支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部上方的通道内，不会越出拓扑 panel；节点下游关系仍可通过点击节点编辑
- 团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定拓扑图从左到右的节点排列
- 拓扑图中的 Agent 节点顺序是稳定的：未显式保存顺序时默认优先取当前列表首个 Agent 作为最左侧起点
- 拓扑图中的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息中展示
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane；macOS 下会固定新开独立 Terminal 窗口后再 attach，Windows 下会尽量把新拉起的终端窗口自动切到全屏
- 右下角团队成员面板中，每个 Agent 名称旁都会提供一个“打开 Pane”按钮；点击后会优先补齐当前 Task 的 pane 绑定，并直接打开该 Agent 自己的 OpenCode attach 独立终端窗口，而不是带出整个 Zellij session 网格
- Zellij pane 内部启动命令会按平台生成：macOS / Linux 使用 `/bin/sh`，Windows 使用 `cmd.exe`，不再把 POSIX shell 语法直接下发到 Windows pane
- macOS / Linux 仍要求本机可执行 `zellij`；Windows 会直接使用项目内置的 `download/zellij.exe`，打包后对应应用内的 `resources/bin/zellij.exe`；只有这两个位置都缺失时才会追加系统提醒
- Windows 打包前必须先刷新当前源码对应的 Electron 产物，禁止直接复用旧 `out/`；推荐命令为 `npm run dist:win`，其中会先执行 `npm run build` 生成最新 `out/main`、`out/preload`、`out/renderer`，再生成 `dist/win-unpacked/` 目录产物，主程序位于 `dist/win-unpacked/agentflow.exe`
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便 debug 当前会话
- 当前实现为每个 Project 启动独立的 `opencode serve`；实例会优先尝试监听 `127.0.0.1:4096`，若端口已被占用，则自动切换到本机空闲端口，并让该 Project 的 pane attach / 健康检查跟随实际端口
- Zellij pane 顺序只跟随前端拓扑/团队成员区里用户拖拽后保存的 Agent 排序，不再根据运行态动态重排
- 全新 Task 首次初始化、且当前还没有托管 pane 时，Zellij 会优先按“先横向后换行”的 tiled grid 创建初始 pane 布局，并限制最多两排，内部 pane 会按当前保存的 Agent 顺序排布
- 运行中的 Agent 会通过 OpenCode HTTP session 消息接口轮询实时工具调用与摘要，并显示在拓扑图节点内
- GUI 中点击 Agent 支持直接编辑并保存当前 Agent 的名称与 prompt；“内置 Agent 模板”仍是可选项，不会自动写入当前 Project，可先单独编辑可编辑模板的 prompt 再按需写入为 Agent，且模板修改只影响当前 Project，不影响新项目默认值。Build 也作为默认模板提供，但它使用 OpenCode 自带 prompt，不支持在这里修改 prompt，仅支持按需写入当前 Project 与删除已写入项；一旦当前 Project 出现 Task 启动记录，Agent 与内置模板配置都会被锁定，不允许继续修改
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示仍保留原始 `@Agent` 文本，但底层发送给目标 Agent 的正文会自动去掉开头用于寻址的 `@Agent`，不额外拼接结构化前缀
- 这类批量 `Agent -> Agent` 派发消息仅用于聊天区展示给人看，不会作为“尚未收到的群聊历史”再次转发给下游 Agent
- Agent 自动触发下游 Agent 时，会封装 `[Initial Task]` 与 `[From <AgentName> Agent]` 结构化段落；其中 `[Initial Task]` 固定承载当前 Task 的首条用户任务。同时会在 `[Project Git Diff Summary]` 段附带当前 Project Git Diff 的精简摘要，帮助下游 Agent 快速感知最新改动
- CLI 默认使用当前目录作为 project cwd
- CLI 只支持当前 Agent 名称
- CLI 支持单独的 `task init` 初始化步骤：先创建 Task，并把全部 Agent 的 OpenCode session / Zellij pane 启动完成；GUI 输入框会优先弹出候选 Agent 并默认选中当前列表第一个 Agent，CLI 仍通过 `task send <agent> <message...>` 指定目标
- `task send <agent> <message...>` 成功后会打印可复制的 panel 打开命令

## 文档同步要求

以下变更必须同步检查并在需要时更新 `README.md` 与本文件：

- 默认 Agent 模板变化
- 内置 Agent 集合变化
- 默认拓扑推断规则变化
- Project 全局注册或 Project 内 `.agentflow/` 存储布局变化
- CLI 命令、别名或默认行为变化
- 会影响协作者理解当前系统行为的 UI 或编排逻辑变化
