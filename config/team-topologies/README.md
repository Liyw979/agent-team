# 拓扑 JSON5 配置说明

当前仓库里的团队拓扑配置只支持一种 DSL，并统一按 JSON5 语法解析：

- 递归式 `entry + nodes + links`

不再支持旧的：

- `agents + topology.downstream/spawn`

## 1. 最小结构

最小可运行示例：

```json
{
  "entry": "BA",
  "nodes": [
    {
      "type": "agent",
      "id": "BA",
      "prompt": "你是 BA。负责把需求整理清楚。",
      "writable": false
    }
  ],
  "links": []
}
```

根级字段含义：

- `entry`
  当前图的入口节点 ID。任务未显式 `@Agent` 时，会从这个节点开始执行；该值必须能在同一层 `nodes` 中找到。
- `nodes`
  当前图声明的节点数组。每个元素必须是一个对象，且必须通过 `type` 明确声明为 `agent` 或 `spawn`。
- `links`
  当前图声明的有向边数组。每条边都必须使用对象格式，并显式写出 `from`、`to`、`trigger_type`、`message_type`；根图若连接 `__end__` 也不例外。

## 2. `nodes` 怎么写

节点只允许两种类型：

- `agent`
- `spawn`

### 2.1 `agent` 节点

示例：

```json
{
  "type": "agent",
  "id": "Build",
  "prompt": "",
  "writable": true
}
```

字段说明：

- `type`
  节点判别字段。`agent` 表示这是一个执行型 Agent 节点，会被编译成可运行的 Agent。
- `id`
  Agent ID，也是拓扑里的节点 ID；必须全局唯一，父图和子图里也不能重复。
- `prompt`
  Agent 的职责说明。必须显式提供；普通自定义 Agent 不能为空；`Build` 使用 OpenCode 内置 prompt，因此这里必须写空字符串 `""`，不能覆盖。
- `writable`
  是否允许该 Agent 使用写入类能力。必须显式提供，`true` 表示可写，`false` 表示只读；不存在默认可写 Agent，`Build` 也必须显式写。

约束：

- `Build` 继续使用 OpenCode 内置 prompt，不允许在 JSON 里覆盖 `prompt`
- 非内置模板节点如果不提供 `prompt` 或 `prompt` 为空，编译会失败
- 任何 Agent 如果不提供 `writable`，编译会失败

### 2.2 `spawn` 节点

示例：

```json
{
  "type": "spawn",
  "id": "疑点辩论",
  "graph": {
    "entry": "漏洞论证",
    "nodes": [
      {
        "type": "agent",
        "id": "漏洞论证",
        "prompt": "你负责漏洞论证。",
        "writable": false
      },
      {
        "type": "agent",
        "id": "漏洞挑战",
        "prompt": "你负责漏洞挑战。",
        "writable": false
      }
    ],
    "links": [
      {
        "from": "漏洞论证",
        "to": "漏洞挑战",
        "trigger_type": "continue",
        "message_type": "last"
      }
    ]
  }
}
```

字段说明：

- `type`
  节点判别字段。`spawn` 表示这是一个展开型调度节点，不是实际执行 Agent。
- `id`
  spawn 节点 ID；必须全局唯一，父图和子图里也不能重复。
- `graph`
  spawn 展开后要实例化的子图定义。子图自己也必须使用同一套 `entry + nodes + links` DSL。

`graph` 内部字段含义：

- `graph.entry`
  子图入口节点 ID。每个展开出来的实例都会从这个子图入口 Agent 开始执行。
- `graph.nodes`
  子图节点数组，只能包含 `agent` 或嵌套 `spawn` 节点，并且节点 ID 仍然必须全局唯一。
- `graph.links`
  子图内部边数组，格式与根图 `links` 完全一致。

语义：

- `spawn` 不是 agent，所以没有 `prompt`
- `spawn` 固定读取上游输出 JSON5 对象里的 `items` 数组，不支持配置其他字段名
- 每个输入项都会实例化一份 `graph`
- 子图全部完成后，`spawn` 节点自身视为完成
- 完成后按父图里的普通 `links` 继续流转

## 3. `links` 怎么写

`links` 统一写成对象数组。普通业务边必须显式写出 `from`、`to`、`trigger_type`、`message_type`：

```json
[
  {
    "from": "上游节点",
    "to": "下游节点",
    "trigger_type": "transfer",
    "message_type": "last"
  },
  {
    "from": "上游节点",
    "to": "另一个下游节点",
    "trigger_type": "transfer",
    "message_type": "last-all"
  }
]
```

字段说明：

- `from`
  边的起点节点 ID；必须能在当前层 `nodes` 中找到。
- `to`
  边的终点节点 ID；必须能在当前层 `nodes` 中找到。
- `trigger_type`
  触发条件，决定这条边什么时候会被调度。
- `message_type`
  消息传递策略，决定沿这条边派发下游时携带哪些上游内容。

根图如果需要显式结束，也可以写 `__end__` 终止边：

```json
[
  {
    "from": "线索发现",
    "to": "__end__",
    "trigger_type": "complete",
    "message_type": "none"
  }
]
```

`__end__` 终止边说明：

- `from`
  终止来源节点名；必须能在根图当前层 `nodes` 中找到。
- `to`
  固定写 `__end__`。
- `trigger_type`
  必填。`__end__` 会按 `complete` / `continue` / `transfer` 这些现有 trigger 语义命中。
- `message_type`
  必填。当前 `__end__` 不消费上游消息正文，但 DSL 仍要求显式写出，建议统一写 `none`。

`trigger_type` 当前支持三种值：

- `transfer`
  表示普通协作流转。当前节点执行完成后，会沿这条边把结果继续派发给下游节点。
- `complete`
  表示当前分支已经完成判定后再流转。通常用于 decisionAgent / 裁决类节点在确认当前分支可以结束后，再把流程推进到下一个节点。
- `continue`
  表示当前分支需要继续处理时的回流。当前节点明确要求继续修改、补充或回应时，流程会沿这条边把意见退回给对应下游节点。

`continue` / `complete` 标签协议：

- Agent 需要命中 `trigger_type = "continue"` 或 `trigger_type = "complete"` 的条件边时，回复开头必须先输出对应标签，再输出正文。
- `<continue>` 表示当前分支还需要继续处理；运行时会匹配当前节点的 `trigger_type = "continue"` 下游边。
- `<complete>` 表示当前分支已经完成判定；运行时会匹配当前节点的 `trigger_type = "complete"` 下游边。
- 根图可以把 `complete` 边直接连到 `__end__`，表示该节点回复以 `<complete>` 开头时直接结束流程。
- 拓扑 JSON 的 prompt 只提示开头标签写法。

示例：

```txt
<continue>
请继续补充这个分支需要处理的证据、修改建议或回应正文。
```

```txt
<complete>
当前分支已经完成判定，可以结束。
```

`message_type` 当前支持三种值：

- `last`
  只传递上游最后一条正文。
- `none`
  不传递上游最后一条正文。
- `last-all`
  只传递当前激活链路里各个 Agent 最后一条历史正文，不再把整个 Task 的历史都塞给下游。

示例：

```json
[
  { "from": "任务分析", "to": "Build", "trigger_type": "transfer", "message_type": "last" },
  { "from": "Build", "to": "CodeReview", "trigger_type": "transfer", "message_type": "last" },
  { "from": "CodeReview", "to": "Build", "trigger_type": "continue", "message_type": "last" }
]
```

含义：

- `transfer`
  普通协作流转；当前节点完成后直接把结果交给下游继续执行
- `complete`
  当前分支完成判定后流转；只有当前节点明确表示这一分支可以结束时才会触发这条边
- `continue`
  当前分支继续处理时回流；当前节点要求继续修改、补充或回应时，会沿这条边退回

## 4. 研发团队示例

`development-team.topology.json5` 现在使用的就是递归式 DSL：

```json
{
  "entry": "任务分析",
  "nodes": [
    { "type": "agent", "id": "任务分析", "prompt": "...", "writable": false },
    { "type": "agent", "id": "Build", "prompt": "", "writable": true },
    { "type": "agent", "id": "CodeReview", "prompt": "...", "writable": false },
    { "type": "agent", "id": "UnitTest", "prompt": "...", "writable": false },
    { "type": "agent", "id": "SecurityReview", "prompt": "...", "writable": false }
  ],
  "links": [
    { "from": "任务分析", "to": "Build", "trigger_type": "transfer", "message_type": "last" },
    { "from": "Build", "to": "CodeReview", "trigger_type": "transfer", "message_type": "last" },
    { "from": "Build", "to": "UnitTest", "trigger_type": "transfer", "message_type": "last" },
    { "from": "Build", "to": "SecurityReview", "trigger_type": "transfer", "message_type": "last" },
    { "from": "CodeReview", "to": "Build", "trigger_type": "continue", "message_type": "last" },
    { "from": "UnitTest", "to": "Build", "trigger_type": "continue", "message_type": "last" },
    { "from": "SecurityReview", "to": "Build", "trigger_type": "continue", "message_type": "last" }
  ]
}
```

## 5. 漏洞团队示例

`vulnerability.json5` 展示了递归 `spawn` 的写法：

- 根图入口是 `线索发现`
- `线索发现 -> 疑点辩论` 不是无条件流转：有新的 finding 时，`线索发现` 的回复开头先输出 `<continue>`，再输出 finding 正文，并命中 `{ "from": "线索发现", "to": "疑点辩论", "trigger_type": "continue", "message_type": "last-all" }`
- 没有新的 finding 时，`线索发现` 的回复开头先输出 `<complete>`，并补充本轮已检查范围、当前判断依据、仍未排除但暂缺证据的方向，然后命中 `{ "from": "线索发现", "to": "线索完备性评估", "trigger_type": "complete", "message_type": "last" }`
- `线索完备性评估` 会判断是否还存在明显遗漏：给出 `<continue>` 时，命中 `{ "from": "线索完备性评估", "to": "线索发现", "trigger_type": "continue", "message_type": "last" }`，把具体补查方向回给 `线索发现`；给出 `<complete>` 时，命中 `{ "from": "线索完备性评估", "to": "__end__", "trigger_type": "complete", "message_type": "none" }`，真正结束到 `END`
- `线索发现` 的默认 prompt 要求每轮只返回一个可疑漏洞点，并且回复开头先输出 `<complete>` / `<continue>` 判定标签，再输出正文；当准备结束时，必须额外说明本轮已检查范围与仍未排除的方向
- `疑点辩论` 是 `spawn` 节点
- `spawn.graph` 里定义漏洞论证、漏洞挑战、讨论总结的子图
- 这类 `spawn` 子图当前按 `exitWhen = "all_completed"` 运行：当 `讨论总结` 同时存在来自 `漏洞挑战`、`漏洞论证` 的 `complete` 入边时，运行时会先确认这两个来源角色都已经给出本轮回应，再允许把流程推进到 `讨论总结`；因此单边首轮直接 `complete` 不会再触发总结
- 在这份漏洞团队拓扑里，`讨论总结` 是显式 `writable: true` 的可写 Agent；每轮都必须先把讨论总结写入当前代码仓的 `result/` 目录，再同步输出总结正文
- `讨论总结` 写入 `result/` 时要求每个讨论单独一个文件；当前讨论必须新建新文件，不得覆盖、追加或复用已有讨论总结文件，文件名至少要能区分不同讨论
- `讨论总结` 的默认 prompt 不是只要一个简短结论，而是要求输出完整裁决报告：固定包含“结论概览、finding 描述、代码事实与证据链、正方观点与成立条件、反方观点与不成立理由、争议点裁决、当前已形成的稳定结论、仍未解决的不确定点、后续排查建议”等章节，并明确区分“代码已直接证明”的事实与“根据现有事实做出的推断”
- 根图写的是 `{ "from": "疑点辩论", "to": "线索发现", "trigger_type": "transfer", "message_type": "none" }`，因此 `讨论总结` 完成本轮裁决后，会按 `transfer` 触发 `线索发现` 继续寻找下一个 finding

## 6. 当前硬约束

- 团队拓扑 JSON5 只支持递归式 `entry + nodes + links`
- 节点 `type` 是判别字段，只允许 `agent` 或 `spawn`
- 当 `type = "agent"` 时，节点按执行型结构解析：使用 `prompt` / `writable`，不使用 `graph`
- 当 `type = "spawn"` 时，节点按展开型结构解析：使用 `graph`，不使用 `prompt`
- 节点 ID 必须全局唯一，不能在父子图里重复
- `graph.entry` 必须指向本层真实存在的节点
- `links` 必须使用对象格式，并显式写出 `from` / `to` / `trigger_type` / `message_type`
- `links` 里的 `from` / `to` 必须都能在当前层 `nodes` 中找到
- `spawn` 节点没有 `prompt`
- `spawn` 固定从上游输出的 `items` 数组展开子图
- agent 必须显式提供 `prompt` 与 `writable`
- `Build` 不允许覆盖 `prompt`
