# 拓扑 YAML 配置说明

当前仓库里的团队拓扑配置只支持一种 DSL，并统一按 YAML 语法解析：

- 递归式 `entry + nodes + links`

不再支持旧的：

- `agents + topology.downstream/group`

## 1. 最小结构

```yaml
entry: BA
nodes:
  - type: agent
    id: BA
    system_prompt: 你是 BA。负责把需求整理清楚。
    writable: false
links: []
```

根级字段含义：

- `entry`
  当前任务默认入口。必须指向某个真实存在的 `agent`；如果写的是 group 内部 agent，编译阶段会自动把 flow 的根入口折叠成它所属的最外层 group。
- `nodes`
  当前图声明的节点数组。节点只允许 `agent` 或 `group`。
- `links`
  整个 YAML 文件唯一的一组有向边定义。所有普通边、group 内部边、group 回到外层的边，以及根图到 `__end__` 的边，都统一写在这里。

## 2. `nodes` 怎么写

节点只允许两种类型：

- `agent`
- `group`

### 2.1 `agent` 节点

```yaml
- type: agent
  id: Build
  system_prompt: ""
  writable: true
```

约束：

- `Build` 继续使用 OpenCode 内置 prompt，因此 `system_prompt` 必须写空字符串 `""`，不能覆盖。
- 非内置 Agent 必须显式提供非空 `system_prompt`。
- 所有 Agent 都必须显式声明 `writable`。
- 若某个 Agent 存在非 `<default>` 的 outgoing trigger，这些 trigger 字面值必须显式出现在它自己的 `system_prompt` 里。

### 2.2 `group` 节点

```yaml
- type: group
  id: 疑点辩论
  nodes:
    - type: agent
      id: 误报论证
      system_prompt: 你负责误报论证。
      writable: false
    - type: agent
      id: 漏洞论证
      system_prompt: 你负责漏洞论证。
      writable: false
```

字段说明：

- `type`
  节点判别字段。`group` 表示这是一个展开型调度节点，不是直接执行的 Agent。
- `id`
  group 节点 ID；必须全局唯一。
- `nodes`
  group 成员数组。可以包含 `agent` 或嵌套 `group`，成员节点 ID 同样必须全局唯一。

语义：

- `group` 本身没有 `system_prompt`、没有 `entry`、没有局部 `links`。
- group 的入口角色由根级 `links` 与根级 `entry` 推导：
  只有一个外部入口成员才是合法配置。
- group 的内部边也由根级 `links` 推导：
  只要一条边的 `from/to` 都位于同一个 group 内部，它就会被编译成该 group 的 `groupRule.edges`。
- group 回到外层的 report 边同样由根级 `links` 推导：
  只要一条边从组内成员指向组外节点，就会被视为 group 的出口。
- group 仍然按“上游正文第一条非空行展开单个子图项”的既有运行时语义工作。

## 3. `links` 怎么写

`links` 统一写成对象数组，显式写出 `from`、`to`、`trigger`、`message_type`、`maxTriggerRounds`；推荐使用 YAML flow map，让每条 link 保持一行：

```yaml
links:
  - { from: 上游节点, to: 下游节点, trigger: "<default>", message_type: last, maxTriggerRounds: 4 }
```

约束：

- `from` 必须指向 `agent`，不能直接指向 `group`。
- `to` 必须指向 `agent` 或根图的 `__end__`，不能直接指向 `group`。
- 整个 YAML 文件只允许这一组根级 `links`；`group` 内部禁止再声明 `links`。
- group 内部 agent 不允许直接连接 `__end__`；只有根图 agent 才能把边连到 `__end__`。
- 当前运行时要求一个 group 只能有一个外部来源和一个入口成员；如果根级 `links` 让同一个 group 同时拥有多个外部入口成员，编译会直接失败。

`trigger` 标签协议：

- `<default>` 表示普通 handoff。
- 其他任意尖括号标签都按字面值精确路由，例如 `<continue>`、`<complete>`、`<approved>`。
- `maxTriggerRounds` 是每条边都必须显式声明的字段；`-1` 表示无限次，其余值必须是大于等于 `1` 的整数。

## 4. `initialMessage`

`agent.initialMessage` 是可选字段，不属于 `links`：

- 它只作用于目标 Agent 的首次启动。
- 它不会替代 `links[].message_type` 的默认转发行为。
- 可以写单个字符串或字符串数组。
- 空数组 `[]` 等同于 `mode = none`。
- 编译阶段会按 YAML 中 Agent 自上而下的定义顺序重排来源。
- group 内 agent 可以引用外层显式可见的 agent，但不能引用 sibling group 内部 agent。

## 5. 漏洞团队示例

`vulnerability.yaml` 当前使用的就是新 DSL：

- `疑点辩论` 是 `group` 节点。
- `线索发现 -> 误报论证` 是 group 的入口边；编译后根图会得到 `线索发现 -> 疑点辩论`，运行时实例入口会继承这条边的 `trigger/messageMode/maxTriggerRounds`。
- `漏洞论证 -> 误报论证`、`误报论证 -> 漏洞论证`、`漏洞论证 -> 讨论总结`、`误报论证 -> 讨论总结` 都写在根级 `links`，但会被编译进 `groupRule.edges`。
- 指向同一 target 的多条同 trigger 入边表示多个可触发来源，任意一条边被触发就会立即派发该 target。
- `讨论总结 -> 线索发现` 写在根级 `links`，会同时体现在根图 `疑点辩论 -> 线索发现` 与该 group 的 report 配置里。

## 6. 当前硬约束

- 团队拓扑 YAML 只支持递归式 `entry + nodes + links`
- 节点 `type` 只允许 `agent` 或 `group`
- `group` 内只允许 `nodes`，不允许 `entry`、`links`、`system_prompt`
- 整个 YAML 文件只有一组根级 `links`
- 节点 ID 必须全局唯一
- `links` 必须使用对象格式，并显式写出 `from / to / trigger / message_type / maxTriggerRounds`
- agent 必须显式提供 `system_prompt` 与 `writable`
- `Build` 不允许覆盖 `system_prompt`
