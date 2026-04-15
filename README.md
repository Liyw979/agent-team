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
- 支持先单独执行 Task 初始化：先把当前 Project 的全部 Agent 会话与 Zellij pane 启动完成；GUI 输入框会立刻弹出候选 Agent，并默认选中当前列表第一个 Agent
- 全新 Task 初始化 Zellij pane 时，会优先按“先横向后换行”的 tiled grid 摆放，并限制最多两排；pane 顺序直接使用当前前端拖拽后保存的 Agent 排序
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
- 右上角为 Project 级真实拓扑图，点击节点即可编辑“这个 Agent 会去跟哪些 Agent”，也支持整块面板放大查看；放大视图会直接把当前拓扑图放大，Agent 卡片会随视口横向和纵向一起拉伸铺满面板，连线固定走在 Agent 顶部的上方通道内，不会越出拓扑 panel；节点顺序稳定，未显式保存顺序时默认优先取当前列表首个 Agent 作为最左侧起点
- 拓扑边只保留 `success` 一种触发语义，表示当前 Agent 审查通过或执行完成后自动触发下游
- 拓扑图里的 Agent 节点颜色用于表达当前运行状态，不再用颜色区分 built-in / custom；内置与本地类型信息仅在编辑面板等辅助信息里展示
- 审查类 Agent 的“审查通过 / 审查不通过”状态会直接展示在拓扑节点顶部；审查不通过时当前 Task 会直接收口为“不通过”
- 当某个 Task 已运行到当前节点、但拓扑里不存在可自动继续推进的下游节点时，Task 状态会切换为 `waiting`，与群聊中的“保持等待状态”系统消息保持一致
- 当 Task 收口为 `finished` 时，右侧拓扑面板中的每个 Agent 节点都会统一显示为 `已完成`，不再保留 `未启动 / 运行中` 等中间状态；群聊里也会追加一条任务已结束的系统消息。Task 内部的 Agent 成功状态码统一使用 `completed`
- 拓扑图在面板尺寸变化时会保持“Agent 在上、历史区在下、首尾节点贴近左右边界但保留少量留白、顶部预留连线通道”的布局约束，而不是把整张图简单等比缩放后居中
- 拓扑图历史区会优先展示 Agent 最近的运行活动，并明确区分思考、普通消息、步骤与 Tool Call 参数摘要，而不只是单行运行状态
- 右下角展示 Project 全量 Agent，以及它们在当前 Task 语境下的状态；点击 Agent 可直接编辑并保存当前 Agent 名称与 prompt
- Agent 来自用户目录中的自定义配置（`$AGENTFLOW_USER_DATA_DIR/custom-agents.json`），前端仅支持编辑名称与 prompt，权限配置不可编辑；一旦 Project 进入任务驱动阶段（已有 Task 运行记录），仅允许更新 prompt，名称修改、新增与删除会被锁定
- 只允许用户自定义 prompt；启动 OpenCode 时会通过 `OPENCODE_CONFIG_CONTENT` 固定注入 `write / edit / bash / task / patch: deny`
- 当前处于项目开发初期，不要求兼容历史数据；如果现有 Project 状态、拓扑或运行数据与当前实现不一致，优先直接修正当前数据与实现，不额外为旧数据添加兼容分支
- 默认拓扑只在首次初始化且当前无拓扑数据时按当前 Agent 列表自动推断
- Project 是全局注册信息；拓扑、Task、消息、panel 绑定等运行数据都保存在各自 Project 目录下的 `.agentflow/`
- Project 拓扑是唯一真源；Task 后续执行始终读取当前 Project 生效中的拓扑，而不是依赖固定 Agent 名称
- Task 不再快照 Agent 的 prompt / permission 定义；运行时始终读取用户目录里当前生效的自定义 Agent 配置，`.agentflow/state.json` 里的 `taskAgents` 只保留运行态字段
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

## 打包

已验证可成功生成 Windows 可执行目录包的命令：

```bash
npx electron-builder --win dir --x64 --config.win.signAndEditExecutable=false
```

打包完成后，主程序位于 `dist/win-unpacked/agentflow.exe`，同时会带上 `dist/win-unpacked/resources/bin/zellij.exe`。

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
npm run cli -- task send <agentName> "请先分析需求并推进实现。"
npm run cli -- task send <agentName> "请先分析需求并推进实现。" --task <taskId>

# 4. 查看当前目录下的 Task、排障信息和 panel 绑定
npm run cli -- task list
npm run cli -- task debug-info --json
npm run cli -- task debug-info --json --full
npm run cli -- task show <taskId>
npm run cli -- task panels <taskId>

# 4.1 若当前不在本仓库根目录，改用仓库自带入口脚本并显式指定目标 cwd
/Users/liyw/code/agent-team/bin/agentflow task debug-info --cwd "$PWD" --json

# 5. 查看和修改拓扑
npm run cli -- topology show
npm run cli -- topology set-downstream <sourceAgent> <targetAgent1> <targetAgent2>
npm run cli -- topology allow <sourceAgent> <targetAgent>
npm run cli -- topology deny <sourceAgent> <targetAgent>

# 6. 查看 Agent 配置
npm run cli -- agent show <agentName>
npm run cli -- agent cat <agentName>
```

CLI 能力分组：

- `project`
  对应 Project 列表、当前 Project 展示、创建 Project
- `task`
  对应 Task 列表、Task 初始化、Task 群聊查看、排障信息查看、向特定 Agent 发消息、查看当前 Task 的 panel 绑定
- `agent`
  对应 Project 级 Agent 列表、查看 Agent 元信息、读取 Agent prompt
- `topology`
  对应查看当前 Project 拓扑、修改某个 Agent 的下游关系、增删特定传递边
- `panel`
  对应 GUI 里的“打开面板”，通过 `panel focus` 直接打开指定 Task / Agent 的 OpenCode 独立终端窗口

## OpenCode 对齐说明

- 当前实现使用单个 `opencode serve`；会优先尝试监听 `127.0.0.1:4096`，若端口已被非 OpenCode 进程占用，则自动切换到本机空闲端口，并让 pane attach / 健康检查跟随实际端口
- 不同 Project 通过 `x-opencode-directory` 请求头按目录路由到各自工作区实例
- Agent 配置会在 `opencode serve` 启动前一次性注入，且只注入当前 Project 的自定义 Agent（仅 name + prompt，权限固定 deny）
- 默认拓扑只在首次初始化且当前还没有拓扑数据时按 Agent `role / mode / 是否内置` 自动推断；后续运行时不依赖固定名字
- OpenCode 配置只在启动 `opencode serve` 时通过 `OPENCODE_CONFIG_CONTENT` 注入；运行过程中不再做配置 Reload
- `task init` 会先创建 Task，并完成该 Task 下全部 Agent 的 OpenCode session 与 Zellij pane 初始化；GUI 群聊会优先推荐并默认选中当前列表第一个 Agent
- GUI 聊天区里的 `Task Started` 系统消息会附带当前 Task 的 `Zellij Session` 名称与可直接执行的 attach 调试命令，方便排查会话问题
- 点击 GUI 聊天区标题栏里的打开按钮时，macOS 会固定新开独立 Terminal 窗口，并优先把窗口切到普通窗口模式下的最大化（Zoom）而不是系统全屏；Windows 会优先使用 Windows Terminal 全屏打开，回退到 `cmd.exe` 时也会尽量自动触发 `F11`，并统一调用项目内置的 `zellij.exe`
- Zellij pane 内部启动命令会按平台生成：macOS / Linux 使用 `/bin/sh`，Windows 使用 `cmd.exe`，不再把 `mkdir -p`、`export` 这类 POSIX 语法直接塞进 Windows pane
- 如果当前电脑未安装 `zellij`，macOS / Linux 下 GUI 和 CLI 都会给出显式提醒；Task 群聊里也会追加一条系统消息说明当前不会创建真实 Zellij pane。Windows 下则会校验项目内置的 `download/zellij.exe`，打包产物会从 `resources/bin/zellij.exe` 启动该二进制，缺失时会直接提示安装包内容不完整
- 对于首次初始化、尚无托管 pane 的 Task，Zellij 会优先生成“先横向后换行”的 tiled grid 初始布局，并限制最多两排；pane 会严格按当前保存的 Agent 顺序排布
- Session 创建对齐官方 `POST /session`
- 消息发送对齐官方 `POST /session/:id/message`，body 使用 `parts` 数组
- 前端不嵌入终端，不复刻 Zellij PANEL，只展示 Task 级 high level 聊天流、拓扑和 Agent 状态
- Zellij pane 不再根据运行中的 Agent 动态调整位置；如需调整顺序，直接在前端拖拽 Agent 顺序并保存即可
- CLI 只支持当前 Agent 名称（来自用户自定义配置）
- `task debug-info` 默认读取当前 Project 最新 Task，并只输出聊天区里实际展示的合并消息；追加 `--full` 后，才会输出 `zellijSessionId`、`opencodeSessionId`、panel 打开命令和完整运行态数据；也可以显式传入 `taskId`
- `npm run cli -- ...` 必须在本仓库根目录执行；如果人在别的目录排查当前目录对应的 Project，请改用 `/Users/liyw/code/agent-team/bin/agentflow ... --cwd "$PWD"`
- `task show <taskId>` 与 `task init` 在交互式终端里默认直接进入对应 zellij session，`task send` 成功后会输出可复制的 zellij 打开命令

## 后续建议

- 把高层聊天消息做得更接近 “Agent @ Agent” 的可视化协作流
- 为 `.agentflow/state.json` 增加更明确的 schema version 与升级策略
- 补充集成测试
