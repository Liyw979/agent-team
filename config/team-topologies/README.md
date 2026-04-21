# 拓扑 JSON 配置说明

这份文档说明 `config/team-topologies/*.topology.json` 的写法，目标是让你看着仓库里的现成示例，就能自己写出一个可运行、可试跑的团队拓扑。

文档里的说明全部以当前仓库实现为准，重点结合这两个内置示例：

- `config/team-topologies/development-team.topology.json`
- `config/team-topologies/single-agent-ba.topology.json`

如果你只是想先跑通一份最小配置，先看“最小可运行示例”；如果你想照着研发团队拓扑写自己的版本，直接看“研发团队 JSON 逐段拆解”。

## 1. 一个拓扑 JSON 长什么样

一个团队拓扑文件固定分成两部分：

- `agents`
  定义有哪些 Agent，以及每个 Agent 的 prompt、写权限等。
- `topology`
  定义这些 Agent 之间怎么流转。

最小结构如下：

```json
{
  "agents": [
    {
      "name": "BA",
      "prompt": "你是 BA。负责把需求整理清楚。"
    }
  ],
  "topology": {
    "langgraph": {
      "start": "BA",
      "end": null
    },
    "downstream": {}
  }
}
```

这就是仓库里 `single-agent-ba.topology.json` 的同类型写法。它表示：

- 团队里只有一个 Agent，名字叫 `BA`
- 任务从 `BA` 开始
- 没有任何下游节点
- `BA` 结束后，如果没有后续可推进节点，任务就进入等待或结束态

## 2. `agents` 怎么写

`agents` 是一个数组，数组里的每一项都必须是对象，不能写成字符串。

合法示例：

```json
{
  "name": "Build",
  "writable": true
}
```

不再支持的旧写法：

```json
"Build"
```

### 2.1 必填字段

#### `name`

Agent 名称。后面的 `topology.downstream`、`topology.langgraph.start`、`topology.spawn` 都是靠这个名字引用节点。

示例：

```json
{
  "name": "CodeReview",
  "prompt": "你是代码审查角色。"
}
```

### 2.2 常用字段

#### `prompt`

给 Agent 的系统提示词。

当前实现里有一个硬约束：

- 非内置模板 Agent，必须提供 `prompt`
- `Build` 使用 OpenCode 内置 prompt，不能在 JSON 里再覆盖 `prompt`

所以研发团队拓扑里：

- `BA`、`CodeReview`、`UnitTest`、`TaskReview` 都显式写了 `prompt`
- `Build` 没有写 `prompt`

#### `writable`

是否允许该 Agent 写文件。

当前实现里的真实行为是：

- `Build` 即使不写 `writable: true`，运行时也会被视为可写
- 其他 Agent 只有显式写 `writable: true` 才可写
- 系统允许多个 Agent 同时可写

研发团队拓扑里显式写了：

```json
{
  "name": "Build",
  "writable": true
}
```

这是一种更直观的写法，建议保留。

### 2.3 进阶字段

#### `fromTemplate`

复用某个模板名作为该 Agent 的模板来源。

这个字段当前由编译逻辑支持，但研发团队内置 JSON 没有使用它。你只在确实需要“Agent 名称”和“模板名称”分离时再用它；普通场景直接写 `name + prompt` 更容易读懂。

### 2.4 `agents` 的顺序有什么意义

有意义。

当前实现里，如果你没有额外写 `topology.nodes`，最终节点顺序会优先继承 `agents` 的声明顺序。所以研发团队文件把：

1. `BA`
2. `Build`
3. `CodeReview`
4. `UnitTest`
5. `TaskReview`

按这个顺序写出来，前端拓扑图默认也会按接近这个顺序去展示。

## 3. `topology` 怎么写

`topology` 负责定义流转关系，当前最常用的是三个字段：

- `langgraph`
- `downstream`
- `spawn`

研发团队拓扑只用到了前两个；`spawn` 是更进阶的能力，漏洞挖掘团队示例里有完整样板。

## 4. `topology.langgraph` 怎么写

示例：

```json
"langgraph": {
  "start": "BA",
  "end": null
}
```

### 4.1 `start`

任务从哪些业务节点开始。

当前 JSON 编写入口支持：

- 单个字符串，例如 `"BA"`
- 字符串数组，例如 `["BA", "Planner"]`

研发团队里写的是：

```json
"start": "BA"
```

意思是新任务的第一跳从 `BA` 开始。

### 4.2 `end`

是否显式声明“哪些节点会接到语义上的结束节点”。

当前 JSON 编写入口支持：

- `null`
- 单个字符串
- 字符串数组

研发团队里写的是：

```json
"end": null
```

意思不是“任务永远不会结束”，而是：

- 不额外伪造一个业务意义上的结束节点
- 让运行时根据“是否还有可继续推进的节点”自然收束

这正是研发团队这类常规协作拓扑的推荐写法。

## 5. `topology.downstream` 怎么写

`downstream` 是一个“上游 Agent -> 下游 Agent -> 触发方式”的映射表。

基础形态如下：

```json
"downstream": {
  "上游Agent": {
    "下游AgentA": "association",
    "下游AgentB": "needs_revision"
  }
}
```

当前源码支持的触发值有四种：

- `association`
- `approved`
- `needs_revision`
- `spawn`

### 5.1 `association`

普通协作流转。一个 Agent 完成后，把结果发给下游 Agent。

研发团队里这几条边都属于 `association`：

```json
"BA": {
  "Build": "association"
},
"Build": {
  "CodeReview": "association",
  "UnitTest": "association",
  "TaskReview": "association"
}
```

它表示：

1. 用户任务先交给 `BA`
2. `BA` 整理完需求后，把结果交给 `Build`
3. `Build` 完成实现后，同时触发三个 reviewer：
   `CodeReview`、`UnitTest`、`TaskReview`

### 5.2 `needs_revision`

审查不通过后的回流边。

研发团队里这三条边最关键：

```json
"CodeReview": {
  "Build": "needs_revision"
},
"UnitTest": {
  "Build": "needs_revision"
},
"TaskReview": {
  "Build": "needs_revision"
}
```

意思是：

- 任何一个 reviewer 给出“需要修改”的结论后，意见都会回流给 `Build`
- `Build` 修完以后，会再次触发本轮仍然需要确认的 reviewer

这就是研发团队拓扑形成“实现 -> 审查 -> 回流修复 -> 再审查”闭环的关键。

补充一个当前实现的事实：

- `needs_revision` 边在运行时有默认最大回流轮数 `4`
- 这个轮数最终存在运行时的边记录里
- 但当前内置团队 JSON 示例里的 `downstream` 仍然使用字符串简写，没有在这里直接单独写每条边的 `maxRevisionRounds`

所以你现在照着研发团队 JSON 编写时，可以先只写 `"needs_revision"`；若后续产品把这部分 JSON 编写语法开放成对象，再补单边轮数配置。

### 5.3 `approved`

只在“某个审查或辩论结果被判定为通过”时才触发。

研发团队 JSON 没有使用它，但漏洞挖掘团队的 `spawn.links` 里用了它，把正反双方达成阶段性通过后的结果交给总结 Agent。

### 5.4 `spawn`

表示不是直接把消息交给一个普通下游 Agent，而是触发一个“工厂节点”，再批量实例化一组运行时子 Agent。

研发团队 JSON 没有使用它；如果你只是在写研发、测试、评审这类普通协作拓扑，可以先不碰这个能力。

## 6. 研发团队 JSON 逐段拆解

下面这份文件就是仓库内置的研发团队拓扑：

- `config/team-topologies/development-team.topology.json`

它的核心结构可以读成下面这句话：

> `BA` 先整理需求，`Build` 负责实现，实现完成后同时交给 `CodeReview`、`UnitTest`、`TaskReview`，任何 reviewer 不通过时都回流给 `Build` 继续修。

### 6.1 Agent 列表

研发团队里一共有 5 个 Agent：

| Agent | 作用 | 是否可写 |
| --- | --- | --- |
| `BA` | 整理需求、补全上下文、明确实施建议 | 否 |
| `Build` | 真正修改代码 | 是 |
| `CodeReview` | 只审实现是否优雅、简洁 | 否 |
| `UnitTest` | 只审测试是否覆盖实现 | 否 |
| `TaskReview` | 只审功能是否达到交付标准 | 否 |

这五个角色的拆法很适合作为你自定义拓扑的参考，因为它把“实现”和“不同维度的审查”明确分开了。

### 6.2 起点

```json
"langgraph": {
  "start": "BA",
  "end": null
}
```

这表示整轮协作从 `BA` 起步，而不是让 `Build` 直接拿用户原话开工。

适合这种场景：

- 用户需求比较口语化
- 需要先做范围澄清
- 需要先让 BA 把验收标准讲清楚

### 6.3 主干链路

```json
"BA": {
  "Build": "association"
}
```

这是“需求整理 -> 实现”的主干。

### 6.4 审查并发

```json
"Build": {
  "CodeReview": "association",
  "UnitTest": "association",
  "TaskReview": "association"
}
```

这是“实现完成后并发审查”的主干。

这份写法适合你希望：

- 风格审查
- 测试审查
- 交付审查

三条线并行推进，而不是串行一条一条排队。

### 6.5 审查回流

```json
"CodeReview": {
  "Build": "needs_revision"
},
"UnitTest": {
  "Build": "needs_revision"
},
"TaskReview": {
  "Build": "needs_revision"
}
```

这是整个研发团队拓扑最值得照抄的部分。

它表达的不是“谁失败谁自己修”，而是：

- reviewer 只负责指出问题
- 真正回到 `Build` 去改代码
- 改完后再重新进入下游审查

这比把 reviewer 也设成可写 Agent 更清晰。

## 7. 怎么写一个用于试跑或测试的拓扑

如果你的目标是“先验证拓扑写法对不对”，不要一上来就抄完整研发团队。最省事的方式是分两步。

### 7.1 第一步，先写最小单 Agent 版本

```json
{
  "agents": [
    {
      "name": "BA",
      "prompt": "你是 BA。负责把任务补充为清晰、可执行的需求。"
    }
  ],
  "topology": {
    "langgraph": {
      "start": "BA",
      "end": null
    },
    "downstream": {}
  }
}
```

这一步只验证三件事：

- JSON 结构是对的
- Agent 声明能被编译
- `task headless` / `task ui` 能正常启动

### 7.2 第二步，再扩成最小研发闭环

如果单 Agent 能跑通，再升级成下面这个“最小研发测试版”：

```json
{
  "agents": [
    {
      "name": "BA",
      "prompt": "你是 BA。负责把需求整理成可执行说明。"
    },
    {
      "name": "Build",
      "writable": true
    },
    {
      "name": "TaskReview",
      "prompt": "你是任务交付审视角色。请判断当前结果是否达到交付标准，并在不满足时明确要求继续修改。"
    }
  ],
  "topology": {
    "langgraph": {
      "start": "BA",
      "end": null
    },
    "downstream": {
      "BA": {
        "Build": "association"
      },
      "Build": {
        "TaskReview": "association"
      },
      "TaskReview": {
        "Build": "needs_revision"
      }
    }
  }
}
```

这份拓扑的价值是：

- 比单 Agent 更接近真实研发闭环
- 但只保留一个 reviewer，调试成本低
- 能直接验证 `association` 和 `needs_revision` 这两种最核心的边

### 7.3 怎么运行这份测试拓扑

在仓库根目录执行：

```bash
bun run cli -- task headless --file config/team-topologies/your-test.topology.json --message "请完成一个最小功能开发测试。"
```

如果你想看 UI：

```bash
bun run cli -- task ui --file config/team-topologies/your-test.topology.json --message "请完成一个最小功能开发测试。"
```

## 8. 什么时候该从“测试版拓扑”升级成研发团队拓扑

当你已经确认下面几件事都成立，就可以直接照着研发团队 JSON 拆成正式版本：

- 你确实需要需求整理角色
- 你确实希望代码实现与审查职责分开
- 你确实希望测试审查和任务交付审查独立存在
- 你确实需要 reviewer 不通过时统一回流给 `Build`

最常见的升级方式就是把：

- `BA -> Build -> TaskReview -> Build`

扩成：

- `BA -> Build -> CodeReview`
- `BA -> Build -> UnitTest`
- `BA -> Build -> TaskReview`

再把三个 reviewer 的不通过都回流给 `Build`。

## 9. 常见错误

### 9.1 把 `agents` 写成字符串数组

错误：

```json
{
  "agents": ["Build"]
}
```

正确：

```json
{
  "agents": [
    {
      "name": "Build",
      "writable": true
    }
  ]
}
```

### 9.2 自定义 Agent 没写 `prompt`

错误：

```json
{
  "name": "CustomPlanner"
}
```

原因：

- `CustomPlanner` 不是内置模板
- 当前编译逻辑会直接拒绝这种定义

### 9.3 在 `downstream` 里引用了没声明的 Agent

错误：

```json
"downstream": {
  "Build": {
    "TaskReview": "association"
  }
}
```

但 `agents` 里没有 `TaskReview`。

当前编译逻辑会直接报错，因为拓扑里引用的每个节点都必须先在 `agents` 中声明。

### 9.4 试图给 `Build` 再写自定义 `prompt`

当前实现里，`Build` 使用 OpenCode 内置 prompt。团队 JSON 如果给 `Build` 额外写 `prompt`，编译会拒绝。

## 10. 一句话记忆

如果你只想快速写出一份能跑的拓扑，可以按这个顺序思考：

1. 先列出 `agents`
2. 再决定 `start` 是谁
3. 再画出 `association` 主干
4. 最后补上哪些 reviewer 会用 `needs_revision` 回流给谁

对照研发团队 JSON 来看，最核心的结构其实就一句话：

> `BA` 负责把任务说清楚，`Build` 负责改代码，多个 reviewer 并发审查，不通过统一回流给 `Build`。
