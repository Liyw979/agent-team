# Agent Flow

面向 OpenCode 的 Project / Task 两层 Code Agent 编排桌面工具。

## 技术栈

- Electron 32
- React 19 + TypeScript + TailwindCSS
- React Flow
- Zustand
- OpenCode Server (`opencode serve`)
- Zellij
- 文件存储：全局 `projects.json` + Project 内 `.agentflow/state.json`

## 当前实现范围

- Project / Task 两层结构：Project 作为高层协作容器，Task 作为最小执行单元
- 左侧固定为 `Project + Task` 垂直面板，中间主区域始终展示当前 Task 群聊
- 左侧 Task 列表支持右键删除 Task；删除时会同时清理该 Task 对应的 Zellij session
- 左侧 Task 列表会定期与 Zellij session 状态同步；如果对应 session 已被外部删除，或只剩 `EXITED - attach to resurrect` 这类非活跃残留，关联 Task 会自动从列表中移除
- 每个 Task 对应独立 Zellij session，并为当前 Project 的全部 Agent 建立 `panel <-> agent` 运行时映射
- 支持先单独执行 Task 初始化：先把当前 Project 的全部 Agent 会话与 Zellij pane 启动完成，再向入口 Agent 发送第一条消息
- 全新 Task 初始化 Zellij pane 时，会优先按最多三列的 tiled grid 摆放，避免默认布局过宽过扁；pane 顺序直接使用当前前端拖拽后保存的 Agent 排序
- Zellij pane 不再按运行态动态重排，后续顺序只跟随前端拓扑/团队成员区里用户保存的 Agent 排序
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane
- Task 群聊支持 `@AgentName` 提交任务，输入 `@` 会弹出候选 Agent 列表，支持方向键、鼠标和 `Tab` 自动补全
- 群聊中同时展示 `user -> agent`、`agent -> agent` 高层协作消息，以及 Agent 最终回复
- 当一个 Agent 同时触发多个下游 Agent 时，群聊会合并展示为一条批量 `agent -> agent` 派发消息，而不是拆成多条重复消息
- 无论是用户 `@Agent` 还是 Agent 派发下游，底层发送给目标 Agent 的 Prompt 都会统一封装为 `[From]`、`[Message]`、`[Requeirement]` 三段结构
- 当一个 Agent 正常派发下游 Agent 时，系统会自动把当前 Project Git Diff 的精简摘要附加到转发 Prompt 的 `[Requeirement]` 段；返工链路不附带该摘要
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent
- 右下角团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定右上角拓扑图从左到右的节点排列
- 右上角为 Project 级真实拓扑图，点击节点即可编辑“这个 Agent 会去跟哪些 Agent”，也支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部的上方通道内，不会越出拓扑 panel；节点顺序稳定，可指定一个“最左起点” Agent，默认优先取 `BA`
- 拓扑边支持三种触发语义：`success` 表示当前 Agent 完成后 100% 自动触发下游，`failed` 表示只有当前 Agent 决策为“需要修改”时才触发下游返工，`manual` 表示只有当前 Agent 显式指定 `NEXT_AGENTS` 时才触发
- 拓扑图里的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息里展示
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，包括普通消息与 Tool Call 参数摘要，而不只是单行运行状态
- 右下角展示 Project 全量 Agent，以及它们在当前 Task 语境下的状态；点击 Agent 会直接打开原始配置文件查看器
- `.opencode/agents/**/*.md` 动态加载，前端只读查看 OpenCode 原始 Agent 文件，不支持直接编辑
- Agent frontmatter 采用最新的 `permission:` 配置字段，值使用 `allow / ask / deny`
- 当前默认 Agent 集合为 `BA / build / CodeReview / DocsReview / IntegrationTest / UnitTest`
- `build` 使用 OpenCode 内置 Agent，不需要项目自己在 `.opencode/agents` 里额外定义 Markdown 文件
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认工作流是 `BA -> build -> (DocsReview / UnitTest / IntegrationTest)`，随后 `IntegrationTest -> BA`
- `CodeReview` 默认保留为可选 Agent，不会自动接入默认链路，只有用户手动修改拓扑时才会加入
- Project 是全局注册信息；拓扑、Task、消息、panel 绑定等运行数据都保存在各自 Project 目录下的 `.agentflow/`
- Project 拓扑是唯一真源；Task 后续执行始终读取当前 Project 生效中的拓扑，而不是依赖固定 Agent 名称
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取当前 Project 下 `.opencode/agents/**/*.md` 的最新内容，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
- 若本机未安装或无法连接 `opencode serve`，会退化为模拟响应

## 目录结构

```txt
agentflow/
├── electron/
│   ├── main/
│   │   ├── index.ts
│   │   ├── orchestrator.ts
│   │   ├── store.ts
│   │   ├── zellij-manager.ts
│   │   └── opencode-client.ts
│   └── preload.ts
├── shared/
│   ├── ipc.ts
│   └── types.ts
├── src/
│   ├── components/
│   ├── store/
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── config/
│   ├── agentflow.kdl
│   └── opencode.example.json
└── README.md
```

## 存储布局

- 全局 Project 注册信息位于用户数据目录下的 `projects.json`
- 每个 Project 自己的拓扑、Task、消息、panel 绑定等数据位于 `<project>/.agentflow/state.json`
- OpenCode runtime 和 pane runtime 也统一落到 `.agentflow/` 下，便于随 Project 一起迁移

## 开发

```bash
npm install
npm run electron:dev
```

## CLI

项目同时提供一套复用 `Orchestrator` 的 CLI 入口，CLI 和 GUI 走同一套 Project / Task / Agent / 拓扑图 / Panel 运行时能力。

```bash
npm run cli -- help
```

常用命令示例：

```bash
# 1. 列出当前目录下的全部 Agent
npm run cli -- agent list

# 2. 先初始化一个 Task，并把当前 Project 的全部 Agent 在 Zellij 里启动起来
npm run cli -- task init --title "初始化手动测试" --agent BA

# 3. 给特定 Agent 发送消息；如果当前目录还没有 Project，会自动创建并注册
npm run cli -- task send BA "@BA 请先分析需求并推进实现。"
npm run cli -- task send BA "请先分析需求并推进实现。" --task <taskId>

# 4. 查看当前目录下的 Task、消息和 panel 绑定
npm run cli -- task list
npm run cli -- task show <taskId>
npm run cli -- task panels <taskId>

# 5. 查看和修改拓扑
npm run cli -- topology show
npm run cli -- topology set-downstream build DocsReview UnitTest IntegrationTest
npm run cli -- topology allow BA build --trigger success
npm run cli -- topology allow CodeReview build --trigger failed

# 6. 查看 Agent 原始配置文件
npm run cli -- agent show BA
npm run cli -- agent cat BA
```

CLI 能力分组：

- `project`
  对应 Project 列表、当前 Project 展示、创建 Project
- `task`
  对应 Task 列表、Task 初始化、Task 群聊查看、向特定 Agent 发消息、查看当前 Task 的 panel 绑定
- `agent`
  对应 Project 级 Agent 列表、查看 Agent 元信息、读取 OpenCode 原始配置文件
- `topology`
  对应查看当前 Project 拓扑、修改某个 Agent 的下游关系、增删特定触发边
- `panel`
  对应 GUI 里的“打开面板”，通过 `panel focus` 聚焦指定 Task / Agent 的 Zellij pane

## OpenCode 对齐说明

- 当前实现使用单个 `opencode serve`，默认监听 `127.0.0.1:4096`
- 不同 Project 通过 `x-opencode-directory` 请求头按目录路由到各自工作区实例
- Project 级 Agent 配置按 OpenCode 原生格式读取 `.opencode/agents/**/*.md`，同时允许直接使用 OpenCode 内置 `build` Agent
- 若当前 Project 为空目录，应用会补齐默认 Agent 模板：`BA / CodeReview / DocsReview / IntegrationTest / UnitTest`，并自动附带内置 `build`
- 默认拓扑只在首次初始化且当前还没有拓扑数据时按 Agent `role / mode / 是否内置` 自动推断；后续运行时不依赖固定名字
- 每次创建 Task 或 Agent 间消息转发前，都会先尝试触发配置 Reload
- `task init` 会先创建 Task，并完成该 Task 下全部 Agent 的 OpenCode session 与 Zellij pane 初始化；随后再通过 `task send --task <taskId>` 向入口 Agent 发送第一条消息
- 对于首次初始化、尚无托管 pane 的 Task，Zellij 会优先生成最多三列的 tiled grid 初始布局，并直接使用当前保存的 Agent 排序来决定 pane 顺序
- Session 创建对齐官方 `POST /session`
- 消息发送对齐官方 `POST /session/:id/message`，body 使用 `parts` 数组
- 前端不嵌入终端，不复刻 Zellij PANEL，只展示 Task 级 high level 聊天流、拓扑和 Agent 状态
- Zellij pane 不再根据运行中的 Agent 动态调整位置；如需调整顺序，直接在前端拖拽 Agent 顺序并保存即可
- CLI 只支持当前 Agent 名称，例如 `BA`
- `task show <taskId>` 与 `task init` 在交互式终端里默认直接进入对应 zellij session，`task send` 成功后会输出可复制的 zellij 打开命令

## 后续建议

- 把高层聊天消息做得更接近 “Agent @ Agent” 的可视化协作流
- 为 `.agentflow/state.json` 增加更明确的 schema version 与升级策略
- 补充集成测试
