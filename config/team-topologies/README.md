# 拓扑 JSON 配置说明

当前仓库里的团队拓扑 JSON 只支持一种 DSL：

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
      "name": "BA",
      "prompt": "你是 BA。负责把需求整理清楚。"
    }
  ],
  "links": []
}
```

含义：

- `entry` 指定任务入口节点
- `nodes` 定义所有节点
- `links` 定义节点之间的流转关系

## 2. `nodes` 怎么写

节点只允许两种类型：

- `agent`
- `spawn`

### 2.1 `agent` 节点

示例：

```json
{
  "type": "agent",
  "name": "Build",
  "writable": true
}
```

字段说明：

- `type`
  节点判别字段，用来决定当前节点按哪种结构解析。
  当值为 `agent` 时，当前节点按执行型节点解析：声明 `prompt` / `fromTemplate` / `writable`，不声明 `graph`
- `name`
  节点名，必须全局唯一
- `prompt`
  非内置模板节点必须提供
- `writable`
  是否允许写文件。`Build` 即使不显式写 `writable: true`，运行时也会被视为可写
- `fromTemplate`
  仅在你需要把节点名和模板名分开时使用

约束：

- `Build` 继续使用 OpenCode 内置 prompt，不允许在 JSON 里覆盖 `prompt`
- 非内置模板节点如果不提供 `prompt`，编译会失败

### 2.2 `spawn` 节点

示例：

```json
{
  "type": "spawn",
  "name": "疑点辩论",
  "itemsFrom": "findings",
  "graph": {
    "entry": "正方",
    "nodes": [
      {
        "type": "agent",
        "name": "正方",
        "prompt": "你是正方。"
      },
      {
        "type": "agent",
        "name": "反方",
        "prompt": "你是反方。"
      }
    ],
    "links": [
      ["正方", "反方", "needs_revision"]
    ]
  }
}
```

字段说明：

- `type`
  节点判别字段，用来决定当前节点按哪种结构解析。
  当值为 `spawn` 时，当前节点按展开型节点解析：声明 `graph`，不声明 `prompt`
- `name`
  spawn 节点名，必须全局唯一
- `itemsFrom`
  可选。默认读取上游输出里的 `items` 数组；如果你的上游输出字段是 `findings` 或其他名字，就显式写出来
- `graph`
  子图定义。子图自己也必须使用同一套 `entry + nodes + links` DSL

语义：

- `spawn` 不是 agent，所以没有 `prompt`
- 每个输入项都会实例化一份 `graph`
- 子图全部完成后，`spawn` 节点自身视为完成
- 完成后按父图里的普通 `links` 继续流转

## 3. `links` 怎么写

`links` 统一写成三元组或四元组数组：

```json
[
  ["上游节点", "下游节点", "association"],
  ["上游节点", "下游节点", "association", "all"]
]
```

当前支持的触发值只有三种：

- `association`
  表示普通协作流转。当前节点执行完成后，会沿这条边把结果继续派发给下游节点。
- `approved`
  表示审查通过后才流转。通常用于 reviewer / 裁决类节点在确认“通过”后，再把流程推进到下一个节点。
- `needs_revision`
  表示审查不通过后的回流。当前节点明确要求继续修改或继续回应时，流程会沿这条边把意见退回给对应下游节点。

第 4 个可选字段用于控制这条边派发下游时要不要带上历史消息：

- `last`
  默认值。只传递上游最后一条正文，就是当前系统原本的行为。
- `none`
  不传递上游最后一条正文。
- `all`
  传递当前 Task 的完整消息记录。运行时会过滤掉纯展示用的派发消息，只保留真正的历史正文。

示例：

```json
[
  ["BA", "Build", "association"],
  ["Build", "CodeReview", "association", "last"],
  ["CodeReview", "Build", "needs_revision"]
]
```

含义：

- `association`
  普通协作流转；当前节点完成后直接把结果交给下游继续执行
- `approved`
  审查通过后流转；只有当前节点判定“通过”时才会触发这条边
- `needs_revision`
  审查不通过后回流；当前节点要求继续修改、补充或回应时，会沿这条边退回

## 4. 研发团队示例

`development-team.topology.json` 现在使用的就是递归式 DSL：

```json
{
  "entry": "BA",
  "nodes": [
    { "type": "agent", "name": "BA", "prompt": "..." },
    { "type": "agent", "name": "Build", "writable": true },
    { "type": "agent", "name": "CodeReview", "prompt": "..." },
    { "type": "agent", "name": "UnitTest", "prompt": "..." },
    { "type": "agent", "name": "TaskReview", "prompt": "..." }
  ],
  "links": [
    ["BA", "Build", "association"],
    ["Build", "CodeReview", "association"],
    ["Build", "UnitTest", "association"],
    ["Build", "TaskReview", "association"],
    ["CodeReview", "Build", "needs_revision"],
    ["UnitTest", "Build", "needs_revision"],
    ["TaskReview", "Build", "needs_revision"]
  ]
}
```

## 5. 漏洞团队示例

`vulnerability-team.topology.json` 展示了递归 `spawn` 的写法：

- 根图入口是 `初筛`
- `初筛` 的默认 prompt 要求每轮只返回一个可疑漏洞点
- `疑点辩论` 是 `spawn` 节点
- `spawn.graph` 里定义正方、反方、裁决总结的子图
- 在这份漏洞团队拓扑里，`裁决总结` 的要求是：若裁定为真实漏洞，就输出正式漏洞报告；若裁定为误报，就什么都不做
- 根图写的是 `["疑点辩论", "初筛", "association"]`，因此 `裁决总结` 完成本轮裁决后，会按 `association` 触发 `初筛` 继续寻找下一个 finding

## 6. 当前硬约束

- 团队拓扑 JSON 只支持递归式 `entry + nodes + links`
- 节点 `type` 是判别字段，只允许 `agent` 或 `spawn`
- 当 `type = "agent"` 时，节点按执行型结构解析：使用 `prompt` / `fromTemplate` / `writable`，不使用 `graph`
- 当 `type = "spawn"` 时，节点按展开型结构解析：使用 `graph`，不使用 `prompt`
- 节点名必须全局唯一，不能在父子图里重名
- `graph.entry` 必须指向本层真实存在的节点
- `links` 里的 source / target 必须都能在当前层 `nodes` 中找到
- `spawn` 节点没有 `prompt`
- 非内置模板 agent 必须提供 `prompt`
- `Build` 不允许覆盖 `prompt`
