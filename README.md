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
- 后台 Task 整体完成后，左侧 Task 列表会为未查看的已完成项显示提醒，并在对应 Project 卡片上汇总提醒数量；点开该 Task 后提醒会自动消除
- 每个 Task 对应独立 Zellij session，并为当前 Project 的全部 Agent 建立 `panel <-> agent` 运行时映射
- 支持先单独执行 Task 初始化：先把当前 Project 的全部 Agent 会话与 Zellij pane 启动完成；GUI 输入框会立刻弹出候选 Agent，并默认选中 `Build`
- 全新 Task 初始化 Zellij pane 时，会优先按最多三列的 tiled grid 摆放，避免默认布局过宽过扁；pane 顺序直接使用当前前端拖拽后保存的 Agent 排序
- Zellij pane 不再按运行态动态重排，后续顺序只跟随前端拓扑/团队成员区里用户保存的 Agent 排序
- GUI 聊天区标题栏支持直接打开当前 Task 对应的 Zellij session；打开前会先补齐当前 Task 的全部 Agent pane；macOS 下会固定新开独立 Terminal 窗口后再 attach，Windows 下会尽量把新拉起的终端窗口自动切到全屏，并统一使用项目内置的 `zellij.exe`
- 右下角团队成员面板里，每个 Agent 名称旁都会提供“打开 Pane”按钮；点击后会优先补齐当前 Task 的 pane 绑定，并直接打开该 Agent 自己的 OpenCode attach 独立终端窗口，不会带出完整 Zellij session 网格
- macOS / Linux 仍要求本机可执行 `zellij`；Windows 会直接使用项目内置的 `download/zellij.exe`，打包后对应应用内的 `resources/bin/zellij.exe`
- Task 群聊支持 `@AgentName` 提交任务，输入 `@` 会弹出候选 Agent 列表，支持方向键、鼠标和 `Tab` 自动补全
- 群聊中同时展示 `user -> agent`、`agent -> agent` 高层协作消息，以及 Agent 最终回复
- 当一个 Agent 同时向多个下游 Agent 传递时，群聊会合并展示为一条批量 `agent -> agent` 派发消息，而不是拆成多条重复消息
- 同一个 Agent 的最终回复后若紧接着自动向下游传递，群聊会把“最终回复 + 下游派发提示”合并成同一条消息；合并后只追加 `@目标Agent` 标记，避免连续出现两条重复的同名 Agent 卡片
- 同一个上游 Agent 在收到回流意见后再次成功交付时，会重新派发当前拓扑里满足条件的全部下游 Agent；不会因为某个下游在上一轮已成功执行过，就被静默跳过
- 审视 Agent 给出“需要修改 / 审视不通过”后，群聊会把该 Agent 的高层结论与发给下游整改 Agent 的请求合并展示成同一条消息；默认先展示高层结论与整改细节，再在消息末尾统一追加 `@目标Agent` 标记
- Agent 最终回复写入群聊时，只会在命中“正式结果 / 最终回复 / 最终交付 / 结论”等明确交付标题时提取对应尾部章节展示；像 BA 这类先分析再给正式结果的回复，群聊会优先展示最后的正式交付内容，不展示前面的自我分析过程；若只是普通结构化文档而不存在这类标题，则保留完整正文，避免误截断到“备注”等附录章节
- 群聊落库与 Agent 间转发只使用 OpenCode 返回消息里的公开 `text` part；`reasoning`、步骤和工具调用不会混入群聊正文或下游 Prompt
- 这类批量 `agent -> agent` 派发消息仅用于群聊展示给人看；Agent 自动派发下游时，不再补充任何群聊历史，但会携带完整用户消息与当前这一次的上游结果；若上游结果已完整包含用户消息，会自动去重
- 用户在 Task 群聊里直接 `@Agent` 时，群聊展示仍保留原始 `@Agent` 文本；底层以 `raw` 方式转发给目标 Agent 的消息会统一封装成单行 `[发送者] <正文>`，并自动去掉仅用于寻址的开头或结尾 `@Agent`
- Agent 自动派发下游时会拆成结构化段落：用户原始需求放入 `[User Message]`，上游结果放入动态的 `[@来源 Agent Message]` 段；对非 `Build` 下游，系统会把当前 Project Git Diff 的精简摘要附加到转发 Prompt 的 `[Requeirement]` 段；发给 `Build` 时不再附带 `[Requeirement]`
- 每个 Agent 都会按名称自动分配一套稳定配色；聊天记录里会使用对应的浅色底、描边与标签色来区分不同 Agent
- 右下角团队成员列表支持直接调整 Agent 顺序；该顺序会持久化到拓扑配置，并直接决定右上角拓扑图从左到右的节点排列
- 团队成员面板顶部仅展示当前 Task 的 panel 绑定摘要，不再额外显示最后一条群聊消息预览
- 右上角为 Project 级真实拓扑图，点击节点即可编辑“这个 Agent 会去跟哪些 Agent”，也支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部的上方通道内，不会越出拓扑 panel；节点顺序稳定，未显式保存顺序时默认优先取 `BA` 作为最左侧起点
- 拓扑边现在分为三种关系：`association` 表示当前 Agent 正常完成本轮任务后直接传递下游；`review_pass` 表示当前 Agent 输出“【DECISION】检查通过”后才传递下游；`review_fail` 表示当前 Agent 输出“【DECISION】需要修改”后才传递下游；同一对上下游只允许三选一
- 拓扑图里的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息里展示
- 拓扑节点会在标题栏最右侧展示一个最小化状态 icon，对应 `未启动 / 运行中 / 已完成 / 执行失败`；只有存在出去 `review_pass / review_fail` 边的 Agent 才会显示 `审视通过 / 审视不通过` 这组状态文案；完整状态文案仅在鼠标悬停 icon 时显示，标题栏主体优先留给 Agent 名称；若存在 `review_fail` 下游边，审视不通过时会自动派发到这些下游继续修复；若存在 `review_pass` 下游边，审视通过时会继续传递到这些下游
- 当某个 Task 已运行到当前节点、但拓扑里不存在可自动继续推进的下游节点时，Task 状态会切换为 `waiting`，与群聊中的“保持等待状态”系统消息保持一致
- 当当前 Task 下的全部 Agent 都进入 `✅/已完成` 状态时，Task 会自动收口为 `finished`，并在群聊里追加一条任务已结束的系统消息
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态
- 右下角展示 Project 全量 Agent，以及它们在当前 Task 语境下的状态；点击 Agent 会直接打开原始配置文件查看器，名称旁按钮则会打开该 Agent 对应的 OpenCode attach 独立终端窗口
- `.opencode/agents/**/*.md` 动态加载，前端只读查看 OpenCode 原始 Agent 文件，不支持直接编辑
- Agent frontmatter 采用最新的 `permission:` 配置字段，值使用 `allow / ask / deny`
- 对只读 Agent，除了 `write / edit / bash` 之外，还需要一并限制 `patch / task`；运行时也会把这类缺省项自动硬化为 `deny`，避免通过子代理间接改文件
- 当前默认 Agent 集合为 `BA / Build / CodeReview / TaskReview / IntegrationTest / UnitTest`
- `Build` 是项目内部名称，底层使用 OpenCode 内置 `build` agent，不需要项目自己在 `.opencode/agents` 里额外定义 Markdown 文件
- 只有存在出去 `review_pass / review_fail` 边的 Agent，才按审视 Agent 处理；只有这类 Agent 会被注入审视用的 DECISION system prompt
- 审视 Agent 会通过 OpenCode HTTP 配置接口被默认强制注入 `write / edit / bash: deny`
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- `TaskReview` 现在承担“任务交付审视”角色
- 默认工作流里，`BA -> Build`、`Build -> (UnitTest / IntegrationTest)` 使用 `association`；`UnitTest / IntegrationTest -> TaskReview` 使用 `review_pass`；`TaskReview / UnitTest / IntegrationTest / CodeReview -> Build` 使用 `review_fail`
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
├── download/
│   └── zellij.exe
└── README.md
```

## 存储布局

- 全局 Project 注册信息位于用户数据目录下的 `projects.json`
- 每个 Project 自己的拓扑、Task、消息、panel 绑定等数据位于 `<project>/.agentflow/state.json`
- OpenCode runtime 和 pane runtime 也统一落到 `.agentflow/` 下，便于随 Project 一起迁移
- CLI 不再在 `<project>/.agentflow/projects.json` 静默回退创建本地 Project registry；如果默认全局用户目录不可写，必须通过 `AGENTFLOW_USER_DATA_DIR` 显式指定另一份可写的全局 registry 目录

## 开发

```bash
npm install
npm run electron:dev
```

## CLI

项目同时提供一套复用 `Orchestrator` 的 CLI，CLI 和 GUI 走同一套 Project / Task / Agent / 拓扑图 / Panel 运行时能力。

```bash
npm run cli -- help
```

常用命令示例：

```bash
# 1. 列出当前目录下的全部 Agent
npm run cli -- agent list

# 2. 先初始化一个 Task，并把当前 Project 的全部 Agent 在 Zellij 里启动起来
npm run cli -- task init --title "初始化手动测试"

# 3. 给特定 Agent 发送消息；如果当前目录还没有 Project，会自动创建并注册
npm run cli -- task send BA "请先分析需求并推进实现。"
npm run cli -- task send BA "请先分析需求并推进实现。" --task <taskId>

# 4. 查看当前目录下的 Task、消息和 panel 绑定
npm run cli -- task list
npm run cli -- task show <taskId>
npm run cli -- task panels <taskId>

# 5. 查看和修改拓扑
npm run cli -- topology show
npm run cli -- topology set-downstream Build UnitTest IntegrationTest
npm run cli -- topology allow BA Build
npm run cli -- topology allow UnitTest TaskReview --relation review_pass
npm run cli -- topology allow TaskReview Build --relation review_fail

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
  对应查看当前 Project 拓扑、修改某个 Agent 的下游关系、增删特定传递边
- `panel`
  对应 GUI 里的“打开面板”，通过 `panel focus` 直接打开指定 Task / Agent 的 OpenCode 独立终端窗口

## OpenCode 对齐说明

- 当前实现使用单个 `opencode serve`，默认监听 `127.0.0.1:4096`
- 不同 Project 通过 `x-opencode-directory` 请求头按目录路由到各自工作区实例
- Project 级 Agent 配置按 OpenCode 原生格式读取 `.opencode/agents/**/*.md`，同时允许直接使用项目内部名称为 `Build` 的内置 Agent；其底层仍调用 OpenCode 内置 `build` agent
- 若当前 Project 为空目录，应用会补齐默认 Agent 模板：`BA / CodeReview / TaskReview / IntegrationTest / UnitTest`，并自动附带内置 `Build`
- 默认拓扑只在首次初始化且当前还没有拓扑数据时按 Agent `role / mode / 是否内置` 自动推断；后续运行时不依赖固定名字
- 每次创建 Task 或 Agent 间消息转发前，都会先尝试触发配置 Reload，并通过 HTTP `global/config` 强制把所有审视 Agent 的 `write / edit / bash` 权限置为 `deny`
- `task init` 会先创建 Task，并完成该 Task 下全部 Agent 的 OpenCode session 与 Zellij pane 初始化；GUI 群聊会优先推荐并默认选中 `Build`，若用户直接发送且未显式指定目标，也会默认投递给 `Build`，并在群聊历史里自动补上 `@Build`；这类默认首跳转发给 Agent 时，底层格式仍是单行 `[发送者] <正文>`
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便排查会话问题
- 点击 GUI 聊天区标题栏里的打开按钮时，macOS 会固定新开独立 Terminal 窗口，并优先把窗口切到普通窗口模式下的最大化（Zoom）而不是系统全屏；Windows 会优先使用 Windows Terminal 全屏打开，回退到 `cmd.exe` 时也会尽量自动触发 `F11`，并统一调用项目内置的 `zellij.exe`
- Zellij pane 内部启动命令会按平台生成：macOS / Linux 使用 `/bin/sh`，Windows 使用 `cmd.exe`，不再把 `mkdir -p`、`export` 这类 POSIX 语法直接塞进 Windows pane
- 如果当前电脑未安装 `zellij`，macOS / Linux 下 GUI 和 CLI 都会给出显式提醒；Task 群聊里也会追加一条系统消息说明当前不会创建真实 Zellij pane。Windows 下则会校验项目内置的 `download/zellij.exe`，打包产物会从 `resources/bin/zellij.exe` 启动该二进制，缺失时会直接提示安装包内容不完整
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
