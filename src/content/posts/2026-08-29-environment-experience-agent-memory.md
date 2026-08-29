---
title: "Agent 记忆不等于聊天历史：如何构建可审计的环境经验记忆"
description: "以环境状态、工作流、局部陷阱和前提条件为对象，本文把长期 Agent 记忆拆成事件账本、状态投影、因果边与证据包，并给出一套可复跑的评测契约，避免只用聊天问答分数判断记忆系统。"
pubDate: 2026-08-29
track: "agent-memory"
category: "Agent Memory"
tags:
  - "agent memory"
  - "long-term memory"
  - "memory evaluation"
  - "agent trajectories"
  - "provenance"
  - "state tracking"
  - "workflow knowledge"
draft: false
---

## 来源说明与本文边界

本文主要建立在四份可复核材料上：

1. [AMA-Bench](https://arxiv.org/abs/2602.22769) 讨论长程 Agent 轨迹中的记忆问题，并以六类 Agent 场景构造评测；作者报告现有方法在其设置中经常不能保住因果关系和客观状态。
2. [AMA-Bench 的官方仓库](https://github.com/AMA-Bench/AMA-Bench) 给出了统一的两阶段接口：先从轨迹构造 memory object，再针对问题取回上下文，并公开了评测与实验日志入口。
3. [LongMemEval-V2 官方仓库](https://github.com/xiaowu0162/LongMemEval-V2) 将目标具体化为“在定制环境中成为熟练同事”：它不仅测回答准确度，还测查询延迟，并覆盖静态状态、动态状态、工作流、局部陷阱和前提意识。
4. 8 月预印本 [MESA](https://arxiv.org/abs/2608.10108) 与 [Router-Mem](https://arxiv.org/abs/2608.01285) 分别提出按任务选择多种记忆结构、以及按证据充分度决定是否继续扩展检索。它们是新近的研究信号，不是已被广泛复现的生产结论。

本文不会把上述论文的分数外推到任意模型或业务。文章中的架构、接口和阈值是我的工程建议，目标是帮助团队先建立可观察、可撤销、可对比的记忆系统，再讨论优化模型或向量库。安全敏感的环境状态、凭据和个人资料不应作为默认记忆内容；文中仅讨论受授权的内部 Agent 系统。

## 先给结论

一个能回答“上次用户说了什么”的系统，不等于拥有可用的 Agent 记忆。长程 Agent 真正需要记住的经常不是一句话，而是：**环境现在处在什么状态、此前哪一步改变了它、在这个部署中该按什么工作流操作、哪些看似通用的前提在这里并不成立。**

因此，我不建议把所有轨迹压成摘要后做一次向量检索；也不建议每个问题都读取“图 + 摘要 + 原始日志”的全集。更稳妥的做法是：

```text
原始轨迹 -> 事件账本 -> 状态/工作流/陷阱投影 -> 受限的结构选择器
                                                |                 |
                                                +--> 证据包 --> reader / action gate
```

这套方法有四条约束：

1. **事实先于总结**：每个被 Agent 使用的状态都能追溯到具体观测、工具输出或人工确认。
2. **状态先于相似度**：涉及“现在能不能做”“上次为什么失败”时，优先读取带版本和时间的状态关系，而不是只按文本相似度取片段。
3. **结构按问题选择**：静态位置、时序变化、标准流程和局部例外的证据形态不同，不能假设一种 index 最优。
4. **评测先于宣称**：必须同时测回答、证据充分度、过期状态拒答、延迟、成本和撤销传播；单一 QA 分数不够。

## 技术问题：为什么聊天记忆分数会掩盖环境失忆

传统对话记忆常将历史写成 $H = [u_1, a_1, ..., u_n, a_n]$，在新问题 $q$ 到来时返回 `top-k(H, q)`。这个范式对于偏好、明确事实和跨会话问答很有效，但 Agent 轨迹更接近：

```text
observation -> tool call -> tool output -> action -> environment transition -> verification
```

这里的关键信息往往落在结构中，而不是自然语言描述中。例如，某项配置究竟是“已启用”“已启用但未生效”，还是“被下一步回滚”，只看日志中与 query 最像的一行通常无法判断。

AMA-Bench 作者把任务分为 recall、causal inference、state updating、state abstraction 四类，并报告长上下文 baseline 与若干记忆系统之间存在不稳定差距。该论文的可取之处不在于某一个 57.22% 的结果，而是指出了评测对象的变化：**被压缩和检索的是 Agent 与环境的连续互动，不只是人类对话。**

LongMemEval-V2 的五项能力进一步把问题变得可验收：

| 能力 | 系统必须回答的问题 | 只做向量检索时的典型漏洞 |
| --- | --- | --- |
| 静态状态回忆 | 页面、模块、资源或权限位在哪里？ | 找到旧截图或旧文本，却丢失对象版本 |
| 动态状态跟踪 | 某动作之后对象进入了什么状态？ | 没有应用 transition，只返回最近提及 |
| 工作流知识 | 这个环境里重复任务的安全顺序是什么？ | 摘要里有步骤，但缺少前置条件和结果验证 |
| 环境陷阱 | 这里有哪些会反复触发的局部失败？ | 将一次偶发错误泛化成全局规则 |
| 前提意识 | 哪些其他环境成立的假设在这里失效？ | 把模型先验、团队惯例和环境事实混为一谈 |

我的判断是：这些不是“检索 recall 再提升两个点”的同类问题。它们要求 memory service 至少保留对象标识、时间、作用域、动作、状态转移和证据来源。

## 机制拆解：把轨迹编译成四种互补记忆

### 1. 事件账本：唯一的可复核来源

任何提炼前，先保留不可变的事件记录。它既可以来自浏览器/CLI 轨迹，也可以来自 API 响应、任务系统和人工确认。事件账本不等于完整录屏：大附件可放对象存储，但哈希、时间和访问控制必须留在关系记录中。

```ts
type TrajectoryEvent = {
  id: string;
  runId: string;
  tenantId: string;
  sequence: number;
  occurredAt: string;
  kind: "observation" | "tool-call" | "tool-result" | "action" | "verification" | "human-note";
  subject: { type: string; id: string }[];
  payloadRef: string;
  payloadHash: string;
  classification: "internal" | "restricted";
  supersededBy?: string;
};
```

`sequence` 解决“同一秒内发生多步”的顺序问题，`payloadHash` 解决回放时文件被替换的问题，`supersededBy` 则比物理删除更适合审计和评测。若用户要求删除，仍应按数据治理要求执行真实删除；审计系统仅保留合规允许的最小 tombstone。

### 2. 状态投影：记录对象如何随时间变化

状态投影不是让 LLM 写“我认为已部署成功”。它应把可验证的对象、属性、值和证据写成小记录，并显式标明有效区间。

```yaml
id: state:repo:agent-lab:deployment
subject:
  type: repository
  id: agent-lab
property: production_deployment
value:
  status: ready
  revision: 1f9ebeb
valid_from: "2026-08-29T01:10:00Z"
valid_to: null
evidence:
  - event: evt:vercel:482
    selector: "deployment.readyState"
writer: projection-worker@v3
confidence: verified
access_scope: project:agent-lab
```

对于无法直接结构化的观察，`confidence` 不应假装为 `verified`。可使用 `reported` 或 `inferred`，并令高影响动作只能依赖 `verified` 或人工审批的状态。这个字段让“模型猜到的状态”无法无声地升级为“可执行事实”。

### 3. 工作流投影：把经验变成有前后条件的 runbook

长期 Agent 的价值之一是避免每次都重新试错。但工作流记忆必须区别于一次成功轨迹：它应具备适用范围、前置条件、步骤、验证、反例与 owner。

```ts
type WorkflowMemory = {
  id: string;
  intent: "publish-static-site" | "triage-build-failure";
  environmentSelector: string;
  preconditions: string[];
  steps: { tool: string; inputTemplate: string; expectedEffect: string }[];
  verification: { query: string; expected: string }[];
  exceptions: { when: string; response: string }[];
  evidenceRefs: string[];
  owner: string;
  reviewedAt: string;
  expiresAt?: string;
};
```

运行时不要直接把 `steps` 交给执行器。执行器先检查 `environmentSelector` 与 `preconditions`，再在每一步之后运行 `verification`。这样“记住 workflow”不会退化成无条件重放。

### 4. 陷阱和前提投影：必须可证伪、可过期

局部经验是最容易变成幻觉的记忆。一个 401、一次 DNS 失败或一次不完整迁移都可能被总结器夸大为“该系统不支持 X”。我会要求陷阱记录至少有重复观察、明确适用域和反证条件：

```yaml
claim: "在 staging 环境，图像上传完成后需要等待异步转码事件再读取资源"
scope: environment:staging
supporting_events:
  - evt:upload:118
  - evt:upload:219
counterexample_query: "同版本 production 是否也需要等待？"
status: provisional
expires_at: "2026-09-12T00:00:00Z"
review_required_before_action: true
```

在没有第二次独立证据前，它只能影响探索策略或触发确认，不能阻断生产操作。所谓“前提意识”也应采用同样纪律：先保存“这个前提来自哪里、在什么环境测试过”，而非把它包装成 Agent 的全局常识。

## 查询机制：先识别问题形态，再组装带标签的证据包

MESA 的核心研究假设是：不同任务适合不同记忆结构，最优选择通常既不是只读一种，也不是读全部。Router-Mem 的研究则把“证据是否已足够”单独作为决策。两者的数值结果仍待更多复现，但这两个接口方向很值得工程借鉴。

我会把 query 先编译为受约束的 `MemoryRequest`，而不是直接拿自然语言去搜所有 index：

```ts
type MemoryRequest = {
  question: string;
  taskClass: "state" | "causal" | "workflow" | "gotcha" | "premise";
  subjects: { type: string; id?: string }[];
  asOf: string;
  scope: string;
  allowedClassifications: ("internal" | "restricted")[];
  actionImpact: "read" | "propose" | "execute";
};
```

```text
request
  -> deterministic metadata extraction / low-privilege classifier
  -> taskClass + subject + time + scope
  -> choose state index, event window, workflow registry, or gotcha registry
  -> retrieve minimal evidence
  -> evidence sufficiency check
  -> stop, expand one bounded hop, or ask for clarification
  -> answer / propose / action gate
```

“证据充分”不能等同于 reader 自己说“我有把握”。最低限度可以写成确定性规则：

| 问题形态 | 最小充分条件 | 不满足时 |
| --- | --- | --- |
| state | 同一 subject 的未过期状态 + 可访问证据 | 返回未知或拉取当前观测 |
| causal | 原因事件、受影响状态、二者关系 | 请求更多轨迹，不编造因果 |
| workflow | 匹配环境的已审阅 workflow + 前置条件 | 降级为只读建议或人工审核 |
| gotcha | 至少两条独立证据或人工确认 | 标记为假设，不作为硬规则 |
| premise | 环境特定证据且有时间范围 | 明确说明前提未证实 |

### 一个受限检索器的伪代码

```ts
function resolveMemory(request: MemoryRequest): EvidencePacket {
  const candidates = selectStructures(request.taskClass);
  const packet = retrieveBounded(candidates, request, { maxEvents: 12, maxTokens: 3200 });

  if (isSufficient(packet, request)) return label(packet, "sufficient");
  if (request.actionImpact === "execute") return label(packet, "human-review-required");

  const expanded = expandOneHop(packet, request, { maxCausalEdges: 4 });
  return isSufficient(expanded, request)
    ? label(expanded, "sufficient-after-expansion")
    : label(expanded, "insufficient");
}
```

这段逻辑故意没有“无限循环直到模型满意”。最坏情况下，Agent 应该承认未知、要求当前观测或升级审批，而不是为凑齐答案不断扩大敏感上下文。

## 最小架构：记忆服务、评测服务与动作网关分开

下面是我会采用的部署边界。它适合代码 Agent、内部支持 Agent、数据诊断 Agent 等有长期轨迹的工作负载。

```text
                         write path
Agent trace / tool output / human confirmation
                 |
                 v
          [event ledger] -----> raw payload store
                 |
                 +--> [projection workers]
                         |      |       |
                         v      v       v
                      states workflows gotchas
                         \      |      /
                          [policy + provenance]
                                   |
query -> [memory request] -> [structure selector] -> [evidence packet]
                                                        |           |
                                                        v           v
                                                   reader      action gateway
                                                                  |
                                                                  v
                                                         execute / review / deny
```

职责不应混在同一个 Agent prompt 中：

| 组件 | 允许做什么 | 不允许做什么 |
| --- | --- | --- |
| 事件写入器 | 记录来源、范围、哈希、访问级别 | 将推测提升为事实 |
| 投影 worker | 生成候选状态和工作流 | 绕过策略直接激活高风险规则 |
| memory service | 组装可解释证据包 | 执行工具调用 |
| reader | 基于带标签证据回答或建议 | 伪造证据 ID、修改记忆 |
| action gateway | 复查前置条件、权限和当前状态 | 相信 reader 的自然语言授权 |
| evaluation service | 固定版本回放、评分、导出失败案例 | 使用线上私密数据训练或泄漏日志 |

权限边界可以被配置化，而不是散落在提示词中：

```yaml
memory_policy:
  default_read: deny
  scopes:
    project:agent-lab:
      readers: [blog-agent, deployment-agent]
      allowed_kinds: [state, workflow]
    security:incident:
      readers: [security-agent]
      allowed_kinds: [event, state, gotcha]
  execution:
    require_current_verification_for: [deploy, credential-rotation, data-mutation]
    deny_on_evidence_label: [insufficient, stale, revoked]
```

## 可复跑评测：测“记得”，更要测“正确地不记得”

AMA-Bench 的两阶段 `memory_construction(trajectory)` / `memory_retrieve(memory, question)` 很适合成为本地 harness 的起点；LongMemEval-V2 同时纳入 accuracy 与 query latency，也提醒我们不能忽略服务成本。但生产评测还应加入版本、权限和撤销问题。

### 用固定 manifest 锁住一次实验

```yaml
run_id: env-memory-2026-08-29-a
dataset: internal-fixtures/v0.3
memory_writer: projection-worker@3.1.0
retriever: evidence-router@2.0.0
reader: model-x@temperature-0
as_of: "2026-08-29T00:00:00Z"
budget:
  max_retrieved_events: 12
  max_context_tokens: 3200
  max_expansions: 1
metrics:
  - answer_accuracy
  - evidence_precision
  - stale_state_rejection
  - action_precondition_recall
  - p95_query_latency_ms
  - retrieved_token_cost
  - deletion_propagation_lag
```

没有 manifest 的“今天跑出 85 分”无法与下周比较：模型、数据、index、提示词、时间截面或 reader judge 任一变化都足以改变结果。

### 每条测试都应具有可归因的答案

```ts
type EvalCase = {
  id: string;
  trajectoryRefs: string[];
  question: string;
  class: MemoryRequest["taskClass"];
  asOf: string;
  expected: { answer: string; evidenceIds: string[] };
  forbiddenEvidenceIds?: string[];
  expectedDecision: "answer" | "ask" | "review" | "deny";
};
```

推荐至少准备五组 fixture：

1. **状态更新对**：先设置 A、后设置 B，问题必须返回 B 并拒绝 A。
2. **因果对**：看似相邻的两个事件没有因果关系，避免系统仅按时间线归因。
3. **工作流变体**：同一意图在两个环境有不同前置条件，避免通用 runbook 泄漏。
4. **过期陷阱**：曾经成立的故障说明已修复，系统必须说“旧经验已失效”。
5. **权限隔离对**：答案存在于其他项目，但本请求无权读取；正确结果是拒答或请授权。

### 指标不是越多越好，但必须覆盖失效面

| 指标 | 计算方式 | 它防止什么误判 |
| --- | --- | --- |
| answer accuracy | 正确回答数 / 可回答 case 数 | 只优化日志命中、不优化任务结果 |
| evidence precision | 被引用且确实支撑结论的证据 / 被引用证据 | 用无关上下文“蒙对” |
| evidence recall | 必要 gold evidence 被返回的比例 | reader 失败被错误归罪于索引 |
| stale-state rejection | 正确拒绝过期状态的比例 | 把历史成功当当前事实 |
| transition consistency | 状态变化是否符合已知动作/验证 | 摘要写出不可能状态 |
| workflow precondition recall | 执行前漏掉前置条件的比例 | 经验记忆诱导盲目重放 |
| p95 latency / token cost | 运行分位数和实际输入 token | 用全量上下文换取离线高分 |
| revocation lag | 源事件撤销至所有投影不可见的时间 | 删除请求只删了原文没删派生状态 |

对被判为错误的样本，应保存 `request -> selected structures -> retrieved evidence -> reader answer -> gate decision` 链路。这里可以借鉴 [Agent 证据溯源综述](https://arxiv.org/abs/2606.04990) 所强调的链路思想，但具体 schema 仍需按自己的数据敏感度设计。

## 我会如何实现与验证：四周而非“一次性重写记忆库”

### 第一周：只记事件，不做聪明总结

为一个低风险 Agent 开启事件账本，选择一个稳定任务，例如内部站点发布或只读故障诊断。记录 tool input/output 的引用、对象 ID、时间、权限和验证结果；从历史成功/失败轨迹人工编写 30 条 fixture。此阶段目标是验证数据能否重放，不追求回答正确率。

验收：任取一条结论可在五分钟内找到原始证据；至少 95% 事件带有 scope 与顺序；不把 secret 或原始个人数据写进 evaluation artifact。

### 第二周：增加状态投影与时间截面测试

仅为三个对象类型写确定性投影器，例如 deployment、issue、workflow-run。让每个投影都带 `valid_from`、`valid_to` 和 evidence ID，新增更新覆盖、回滚、过期三类 case。

验收：状态更新对的 stale-state rejection 达到团队设定阈值；每条 `verified` 状态都能通过工具输出或人工审批复核。

### 第三周：加入受限结构选择与证据包

对 state、workflow、gotcha 三类问题分别设置默认结构与 token 上限。先不用强化学习或自由规划，使用 schema、路由和简单规则；无法满足充分条件时统一回退为“需要当前观测”或“需要人工复核”。

验收：相较“全量摘要 + vector top-k”基线，证据 precision 不下降，p95 延迟和检索 token 处于可接受预算；高影响 case 不出现无证据执行。

### 第四周：灰度接入动作网关

只对 `read` 和 `propose` 开放自动回答，`execute` 始终要求当前验证与审批。对每一次人工覆盖记录原因：状态过期、路由错误、证据不足、reader 误解或 policy 不完整。用这些错误反向补 fixture，而不是把人工答案直接写为永久记忆。

验收：所有 deny/review 可以解释为缺了哪项证据或哪个前置条件；撤销演练能在 SLO 内清理派生状态；失败样本都进入回归集。

## 适用场景与不适用场景

适合：拥有可识别对象、重复流程、工具轨迹和当前验证能力的内部工程系统，例如代码仓库维护、发布、工单处理、资产巡检、受授权的数据诊断。

不适合：把私密人生事件或模糊的情绪判断做成跨任务决策状态；没有可回放日志却想让 Agent “自动积累经验”的黑箱系统；需要即时高风险决策、但没有权威数据源或人工审核的场景。

一个务实的判断标准是：如果团队不能为某类 memory 写出“它过期后该怎样证明自己已过期”的测试，就不应让它影响执行动作。

## 常见失败模式与回滚

| 失败模式 | 早期信号 | 处理与回滚 |
| --- | --- | --- |
| 总结覆盖了后续状态 | 回答引用旧 revision | 使旧投影失效，按 event sequence 重建状态 |
| 因果边是模型臆断 | 多次解释无法复现 | 将边降级为 `hypothesis`，reader 不得据此执行 |
| workflow 跨环境泄漏 | staging 规则出现在 production | 收紧 environmentSelector，清除跨 scope 缓存 |
| 陷阱被过度泛化 | 一次错误变成阻断规则 | 要求独立证据或 owner 审核，设置短 TTL |
| 检索不断扩张 | token、延迟随历史线性增长 | 固定扩展 hop，转当前观测或人工 review |
| 删除未传播 | 原记录不可见但 state 仍返回 | 以 evidence 反向索引重算投影，执行撤销演练 |
| 记忆污染 | 来源不明的 instruction 进入 workflow | 默认将外部文本视为 observation，禁止直接生成可执行规则；对高影响投影实行签名/审批门槛 |

最后一项与持久记忆安全直接相关。SMSR 等研究提出用来源证明和检索约束处理多会话记忆投毒；我不主张把任何单篇方案当成万能防线，但“来源、作用域、过期、可撤销”应当是最先落地的通用控制面。

## 局限分析

首先，结构化投影增加了写入成本与数据建模工作；小型个人 Agent 可能只需要带来源的事件日志和朴素关键词检索。其次，本文的充分性规则会提高拒答率，这在探索性任务上未必理想。第三，LLM judge 本身会有偏差，关键 case 需要人工检查或确定性 oracle。最后，环境会变化：今天正确的 runbook 明天可能有害，所以“经验”绝不能绕过当前验证。

AMA-Bench、LongMemEval-V2、MESA 与 Router-Mem 的设置、模型、数据集和指标并不完全相同；不能把它们的分数放在同一排行榜后直接得出优劣结论。本文使用它们来提炼问题与接口，而不是做跨论文的性能比较。

## 发布前自审

- **事实可靠性**：论文、官方仓库和新近预印本均已给出直链；论文结果都明确为作者报告。
- **来源完整性**：核心判断来自 AMA-Bench、LongMemEval-V2；MESA 与 Router-Mem 仅作为待复现的设计信号。
- **非复述**：正文新增了事件账本、状态投影、证据充分条件、评测 manifest、fixture 和四周路线图。
- **非薄内容**：包含机制图、数据模型、策略配置、伪代码、指标、失败回滚和实现验收标准。
- **边界明确**：不承诺通用性能，不将摘要或相似度当作执行授权，不处理未授权外部系统。
- **站内差异化**：这篇文章关注环境轨迹与评测契约；它与此前讨论隐式关联路由的文章互补，但不重复其 decision-state 方案。
