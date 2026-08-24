---
title: "向量检索不是记忆的全部：Agent 记忆的隐式关联盲区与可验证路由"
description: "基于 InMind 对长期 Agent 记忆的诊断，本文解释为什么“能直接回忆”不等于“会在决策时想起”，并给出一套 bridge-first 路由设计：原始记忆、受控决策状态、可审计知识桥和查询时回退路径如何协同。"
pubDate: 2026-08-24
track: "agent-memory"
category: "Agent Memory"
tags:
  - "agent memory"
  - "long-term memory"
  - "retrieval"
  - "personalization"
  - "memory evaluation"
  - "provenance"
  - "context routing"
draft: false
---

## 来源说明与本文边界

本文的主要材料是 Li 等在 2026 年 7 月发布的 [Keep It InMind](https://arxiv.org/abs/2607.24368)（下文称 InMind）及其[公开仓库](https://github.com/imlrz/InMind)。论文研究的是一个很具体的失败：长期记忆里确实保存了用户事实，但后来一个不包含该事实词面线索的问题到来时，检索器没有把它送入模型上下文。

我也参考了 [MEMPROBE](https://arxiv.org/abs/2606.24595)：它提醒我们，任务完成或表面个性化并不能证明记忆产物本身保留了正确的用户状态；以及 [LongMemEval-V2](https://arxiv.org/abs/2605.12493) 的官方实现：它把环境经验记忆约束为明确的 `insert(trajectory)` 和 `query(query)` 接口。这两项材料用于界定评测与接口边界，不用于给本文方案背书。

这不是医疗、法律、金融或合规建议，也不是把用户画像永久塞进 system prompt 的主张。文中“过敏”“权限”等例子仅用于说明决策关联的结构。任何高风险结论都必须保留领域规则、来源、人工审核和产品本身的安全流程。

## 先给结论

一个 Agent 在“你对 X 有什么偏好？”这类直接问题上答对，只能说明它可能存住了 X；不能说明 X 会在另一个语义距离很远、但决策上相关的问题出现时被调出。**这是 query-conditioned retrieval 的接口限制，不是简单把 embedding 换大、top-k 调高就能保证解决的问题。**

我建议把长期记忆拆成两个目的不同的面：

1. **原始证据面（record）**：完整、可撤销、带来源和权限的事件/对话/工具结果，用于精确检索、审计和复核。
2. **受控决策状态面（decision state）**：只承载少量、经策略允许在某类决策前可见的状态声明；每条都带有效期、适用域、敏感级别与证据指针。

二者之间不能靠“总结器觉得重要”直接跳转。需要一条可审计的 **bridge-first 路由**：在写入时标出潜在决策类别，在读入时由确定性策略、受审阅的领域规则或有出处的知识桥决定哪些状态可以预先暴露；对剩余问题仍回退到普通检索。这样不能消灭未知关联，却把最危险的“已经记住却没有用上”变成可测试、可撤销的工程对象。

## 技术问题：直接召回成功，为何间接决策仍会失败

设用户记忆为 $m$，当前问题为 $q$。常见 RAG 路径是：

```text
q -> embedding / keyword / graph expansion -> top-k memories -> answer model
```

它隐含一个通常不被写出的假设：真正决定答案的 $m$ 与 $q$ 在某个可计算相关性空间中足够接近。对于“我是否偏好无糖？”这样的直接问题，假设往往成立；但对于“帮我选择这份菜单”与“用户有某种配料限制”之间的关系，连接它们的是外部知识或领域规则，而不是文本相似度。

InMind 的设计很干净：每个任务同时有直接问题和间接问题，并要求公共来源能支撑两者之间的知识桥。目标事实被插入长会话的中部，后续还有普通互动干扰。论文作者报告：多种向量、图和 agentic memory 配置的直接召回可以很高，但间接应用最高只有 16.0%；六个记忆系统中最高为 14.4%。把目标事实直接放到上下文后，所用 backbone 的间接回答达到 84.0%。这是作者报告的受控实验结果，不代表任何生产系统的通用性能。

更重要的是它把失败拆开了：

| 观察 | 更可能的解释 | 不能据此推断什么 |
| --- | --- | --- |
| 直接问题答错 | 未写入、遗忘、索引失败或 reader 失败 | 不能定位到关联推理 |
| 直接问题答对，间接问题答错 | 事实可能已保存，但未在需要时进入上下文 | 不能简单归咎于模型“不懂常识” |
| 目标事实进了上下文，仍答错 | 可能是知识桥、推理、规则解释或答案生成失败 | 不能用扩大检索范围解决 |
| 间接问题答对但无证据 | 可能猜对或依赖外部先验 | 不能证明记忆真的发挥作用 |

这正是很多线上记忆系统缺的一层可观测性：它们记录了“检索到几条”“模型是否答对”，却没有记录“决策事实是否在模型看到问题之前就有机会影响判断”。

## 机制拆解：为什么更大 top-k 和更强向量仍有边界

检索增强有价值，也应继续作为主路径。但在隐式关联场景，三个常见补救分别有硬边界。

### 1. 增大 embedding 维度或 top-k

InMind 评估中，增加 embedding 维度能提高 answer-blind target recall，却没有根本弥合间接应用差距。原因不神秘：当 query 的表示在目标记忆出现前就已经固定，检索器没有信号知道该向哪个遥远概念扩展。更大的候选集只会同时增加 token、延迟和无关敏感信息暴露。

### 2. 用图检索替代向量检索

图能把“实体 A - 属性 B - 事件 C”显式连起来，但图扩展仍需要一个入口节点或查询锚点。若“菜单”没有可用边引到“配料”再到“用户限制”，图只是把盲区从 cosine similarity 换成邻接选择。图的优势在于可以记录桥及其来源，而不是天然知道所有桥。

### 3. 始终注入完整用户画像

InMind 的 200 行 always-in-state probe 在作者实验中显著缩小了差距：它在间接问题达到 68.8%，而最佳 query-time 配置为 16.0%。但论文也明确把它当作诊断，不是部署建议。完整画像每轮可见会扩大隐私暴露、加剧过期信息影响，并在规模增长时发生状态拥挤。

工程上应采纳它的诊断结论，而不是照搬实现：**需要在 query 前可见的不是全部历史，而是一小组可证明相关、可撤销的决策状态。**

## 架构：record、decision state 与 knowledge bridge 三层分工

下面是我会采用的最小架构。它不是新的“记忆大一统数据库”，而是给现有 memory store 增加一个受治理的投影层。

```text
               write path
conversation / tool result
        |
        v
[evidence recorder] -----> immutable record store
        |                         |
        |                         +--> vector / keyword / graph retrieval
        v
[state proposal] --> policy + human gate --> decision-state registry
                                               |
public/domain rules --> bridge registry ------+
                                               |
                                               v
                                     query pre-router
                                      /             \
                        compact decision state       ordinary retrieval
                                      \             /
                                       v           v
                                    evidence packet
                                           |
                                           v
                                     answer / action gate
```

### 原始证据面：不让摘要成为唯一真相

每条 record 都应指回真实的对话片段、用户表单、工具返回或人工录入，而不能只有 Agent 自己写的一句“用户不喜欢 X”。最小模型如下：

```ts
type MemoryRecord = {
  id: string;
  tenantId: string;
  scope: "user" | "project" | "team";
  sourceType: "user-message" | "tool-result" | "human-entry";
  sourceRef: string;
  sourceHash: string;
  occurredAt: string;
  classification: "normal" | "sensitive" | "restricted";
  consent: "implicit" | "explicit" | "denied";
  tombstonedAt?: string;
};
```

`sourceHash` 和 `sourceRef` 的目标不是密码学炫技，而是让之后的审核能回答：“这条状态从哪来的？原话是否被误读？撤回时应该删哪些投影？”当记录被纠正或撤销，依赖它的 state 和 bridge activation 都必须重新计算。

### 决策状态面：只存会改变行动的最小声明

decision state 不是百科式 profile。它是对某个动作族有明确影响、可复核且允许被提前暴露的声明。例如“项目使用只读生产凭据”可以影响所有生产诊断步骤；“该仓库禁止自动推送”可以影响发布动作。状态必须携带目的约束：

```yaml
id: ds-prod-readonly-credential
claim: "生产环境诊断只允许只读凭据"
subject_scope: project:payments
applies_to:
  - production-diagnosis
  - incident-investigation
not_for:
  - deployment
  - data-mutation
evidence_refs:
  - memrec:ops-418
  - policy:access-control-v3
classification: restricted
visibility: pre-query-if-action-class-matches
valid_from: 2026-08-01
expires_at: 2026-11-01
review:
  owner: platform-security
  status: approved
  reviewed_at: 2026-08-02
```

其中 `not_for` 很关键。没有否定范围的 state 会从“辅助决策”膨胀成“到处影响模型的永久指令”。

### 知识桥：把关联写成可审核的规则，不让模型暗猜

bridge 将动作类别、对象特征和可用状态连接起来。桥可以是代码库配置、产品规则、公开法规的受审阅映射，或领域专家批准的逻辑。它不应把从网页随手抽取的自然语言当作可执行权限。

```ts
type KnowledgeBridge = {
  id: string;
  fromActionClass: "deploy" | "purchase" | "production-diagnosis";
  predicate: {
    entityType: string;
    property: string;
    operator: "equals" | "contains" | "in";
    value: string | string[];
  };
  activatesStateKinds: string[];
  evidenceRef: string;
  authority: "domain-policy" | "maintainer-approved";
  risk: "low" | "medium" | "high";
  expiresAt?: string;
};
```

对于高风险决策，bridge 只能缩小可行动范围或触发人工复核，不能独自批准操作。例如“用户提供了某限制”可以要求系统展示提示、引用证据、向用户确认，不能让模型把它扩展成诊断或建议。

## 状态机：一条事实如何被提议、激活、撤销

```text
observed
  -> proposed
  -> evidence-verified
  -> policy-reviewed
  -> active
  -> projected-for-query
  -> expired | superseded | revoked

any state --(source correction / consent withdrawal)--> quarantined
quarantined --(re-review)--> active | revoked
```

这里的核心原则是：**写入与激活分离**。用户的一句话可以成为 record；是否成为跨任务可见的 decision state，需要来源、作用域、有效期和策略检查。这样既能防止记忆投毒，也能防止一个临时偏好被错误提升为长期约束。

## 查询编排：先做动作分类，再合并受控状态与检索证据

一个实用的 query pre-router 不需要用大模型把所有事情再推理一遍。对于已定义的工作流，优先用工具类型、路由、表单字段、任务元数据和确定性分类；只有不确定时才调用低权限模型分类器。

```text
request
  -> identify tenant, scope, tool and action class
  -> fetch states whose applies_to matches action class
  -> evaluate eligible bridges against request metadata
  -> apply consent, classification, expiry and token budget filters
  -> retrieve record evidence for unresolved claims
  -> assemble labeled evidence packet
  -> answer, ask clarification, or require human review
```

伪代码刻意把“可见”与“可行动”分开：

```ts
function buildMemoryPacket(request: Request, now: Date): EvidencePacket {
  const action = classifyAction(request);
  const states = findActiveStates({
    tenantId: request.tenantId,
    scope: request.scope,
    action,
    now,
  });

  const activated = states.filter((state) =>
    isAuthorized(state, request) &&
    bridgeRegistry.matches(action, request.metadata, state) &&
    !state.notFor.includes(action),
  );

  const evidence = retrieveRecords({
    query: request.text,
    scope: request.scope,
    excludeClassifications: request.allowedClassifications,
  });

  return enforceBudgetAndLabels({ action, activated, evidence });
}
```

生产实现应避免让 `classifyAction` 直接读取用户私密 record，也不要在检索过滤中把 `allowedClassifications` 写反。对每一个 activation 写审计日志：使用了哪条 state、由哪条 bridge 激活、引用了哪些证据、是否被人工覆盖。

## 一个可复制的工程落地方案

先在低风险、规则清晰的场景开始，例如团队内部的研发 Agent：代码审查、发布、故障排查和文档变更。不要一上来处理消费者健康、金融或身份信息。

```text
memory/
  records/                 # append-only source records
  states/                  # approved decision-state documents
  bridges/                 # reviewed bridge rules
  policies/                # scope, consent, retention policies
  fixtures/                # direct / indirect paired test cases
  audits/                  # activation and override logs
  evals/                   # metrics, judge inputs, run manifests
```

工具栈的选择理由：关系型数据库保存 record、state、audit 的事务关系和撤销索引；向量或关键词索引用于 record 回退检索；版本库保存 bridge 与 policy 的代码审阅历史；对象存储保存大附件；任务队列执行过期、重建和 replay。不要将权限判断藏在 embedding metadata 或 prompt 文字里。

### 七天试点 SOP

| 天数 | 工作 | 人工审核点 | 可交付物 |
| --- | --- | --- | --- |
| 1 | 选择一个项目与三个动作类别 | 确认不含敏感用户数据 | scope 与风险清单 |
| 2 | 盘点 30 条已有 record，写来源与撤销规则 | 随机抽查原文对齐 | record schema 与迁移脚本 |
| 3 | 提议不超过 10 条 decision state | maintainer 审核每条 claim 与有效期 | approved state registry |
| 4 | 写 10 条 bridge，只允许“提示/阻止/转人工” | 安全负责人审阅高风险 bridge | versioned bridge rules |
| 5 | 构造直接/间接成对 fixture | 领域 owner 核验桥是否真实改变决策 | fixture 集与期望 verdict |
| 6 | 跑 shadow mode，不把状态送入真正执行器 | 审核错误 activation 与漏 activation | 运行日志和 diff |
| 7 | 比较基线、普通检索、bridge-first 三种路径 | 决定继续、修订或回滚 | evaluation report |

“shadow mode”意味着 packet 会被构建和评分，但不会改变外部动作。这是一周内就能验证价值、又不会把新记忆逻辑直接推到生产执行面的办法。

## 可验证指标：不要只看最终答对率

InMind 的 paired direct/indirect 思路很值得借用，但企业自己的指标必须覆盖安全和成本。

| 指标 | 定义 | 健康信号 | 失败信号 |
| --- | --- | --- | --- |
| direct recall | 直接询问状态时，证据是否正确可见 | 高 | 写入/索引/撤销链有问题 |
| indirect activation recall | 间接 fixture 中，决定性 state 是否被送入 packet | 高且带 bridge id | 只会背事实，不会用事实 |
| bridge precision | 实际 activation 中经人工确认相关的比例 | 高 | 预投影噪声与隐私暴露上升 |
| evidence coverage | active state 有可追溯 source ref 的比例 | 100% | 无来源的摘要成为事实 |
| stale-state rate | 已过期或被撤销状态仍被激活的比例 | 0 | 回收链断裂 |
| action override rate | 人工推翻 state/bridge 结论的比例 | 可解释且下降 | 规则错误或作用域漂移 |
| packet budget | 每次额外注入 token 与延迟 | 有上限 | 用安全换无止境上下文 |

对每个 indirect fixture 同时记录四个 verdict：`state_stored`、`state_activated`、`bridge_valid`、`decision_correct`。这使排障可以准确落在写入、路由、知识桥或 answer/action gate，而不是只得到一个“模型表现不好”。

## 我会如何验证：用负向测试证明系统不会“想当然”

第一批 fixture 不应只写成功案例。至少加入以下负例：

1. **同词不相关**：query 出现相似词，但 bridge 不成立，验证不会因 lexical overlap 过度激活。
2. **过期状态**：record 仍可检索，但 state 已过期，验证预投影不再生效。
3. **跨项目污染**：项目 A 的发布约束不能被项目 B 的请求看到。
4. **来源撤回**：删除或纠正 source record 后，关联 state 必须进入 quarantine，不能继续影响动作。
5. **高风险桥**：bridge 尝试触发执行型能力时，必须变为“要求人工审核”，而不是获得自动批准。
6. **未知关联**：没有有效 bridge 时，系统应明确回退到普通检索或澄清提问，不能伪造关联理由。

验收脚本应固定输入、固定 registry revision、记录模型版本，并分别跑 baseline RAG、always-visible diagnostic 和 bridge-first。always-visible 只作为上界诊断：如果它能做对、bridge-first 做错，问题在路由或桥；如果两者都做错，问题可能在知识桥或任务定义。任何模型 judge 的结论都需要抽样人工复核，尤其是涉及安全、权限和用户敏感信息的 fixture。

## 工程判断：把“何时预先可见”当作产品策略，而非检索参数

InMind 最有价值的地方，不是建议大家放弃 RAG，而是把一个长期被吞进“检索质量”的问题单独命名。对产品团队而言，真正需要设计的是 **visibility policy**：

- 哪些事实只能 query-time 按需检索？
- 哪些事实在某个动作类别前必须被显式检查？
- 谁能把普通 record 提升为 decision state？
- 哪些 bridge 必须有权威来源、双人审批或固定失效时间？
- 当 bridge 不存在时，是询问、拒绝、检索还是转人工？

这些选择取决于业务风险，不能由 benchmark 分数替代。像“构建命令的已知失败模式”可以有较宽松的预投影策略；身份、健康、财务和人事信息则应该默认窄 scope、短 TTL、最小曝光，并优先要求用户确认。

## 适用场景

这套设计最适合以下条件同时满足的系统：动作类别相对明确、状态确实改变决策、可以维护少量权威规则、且需要审计为什么 Agent 做出某种建议或限制。

- 研发与运维：项目约束、环境陷阱、发布冻结、只读/写入能力边界。
- 企业知识 Agent：角色、项目、客户合同条款在特定工作流中的受控可见性。
- 个性化助手：在得到明确同意且低风险的前提下，把稳定偏好作为有限决策状态，而非把完整对话永久常驻。
- 安全审计 Agent：把授权范围、系统所有者、扫描模式和已知误报处理成可回溯的 gating state。

它不适合用来绕过权限、扩大画像收集，或在缺少可靠来源与领域 owner 的开放式建议任务中假装建立了“知识桥”。

## 失败模式与回滚

| 失败模式 | 早期征兆 | 处理与回滚 |
| --- | --- | --- |
| state 泛滥 | packet token 稳步上涨，activation 没有提升正确率 | 收紧 `applies_to`，撤回低价值 state，回到检索路径 |
| bridge 过度泛化 | 相似但不相关的请求频繁被阻止 | 将 bridge 改为更具体 predicate，加入反例 fixture |
| 过期或撤销失效 | 已修正事实仍出现在审计日志 | 停用 registry revision，重建依赖图，补 tombstone replay |
| 作用域越界 | 别的项目/租户看到不该见的状态 | 立即禁用 pre-router，执行 scope 回归测试与访问审计 |
| 模型伪造桥 | 输出声称“由于历史偏好”但 packet 没有该 state | 要求回答引用 packet id；无引用时降级为澄清或检索 |
| 规则成为隐形 prompt | 无人知道为什么状态总被注入 | 所有 bridge 和 policy 版本化、可审阅、可导出 |

回滚要有两层：先在配置层将特定 bridge revision 置为 disabled，立刻停止新 activation；再在数据层将受影响 state 标为 quarantined，保留 record 用于审计而不继续投影。不要通过物理删除日志来“修复”错误，因为那会让后续无法解释误动作是如何发生的。

## 局限分析

第一，InMind 证明的是一类精心构造、经专家核验的隐式关联，而不是所有真实工作中的关联分布。论文的 always-in-state 实验也同时改变了状态格式和 updater，因此它说明“提前可见足以恢复大量差距”，并不能孤立证明某个特定组件的因果贡献。

第二，bridge-first 只是把问题移动到规则的维护与审核上。未知、跨域、变化极快的关联仍可能漏掉；强行补更多规则会重新走向难维护的规则库。它更适合关键而有限的动作族，不是通用记忆的替代品。

第三，任何提前暴露状态的机制都会增加最小权限和隐私设计压力。对于敏感数据，正确答案通常不是“做更聪明的关联”，而是缩小用途、获得确认、减少保存，或者根本不写入。

## 自审

- **事实可靠性：** InMind 的任务构造、125 个任务、paired control、作者报告的 16.0%/14.4%/84.0%/68.8% 均明确归因于论文；MEMPROBE 和 LongMemEval-V2 只用于评测与接口背景。
- **来源完整性：** 使用论文与官方仓库作为主来源，没有把社区排行榜当核心证据。
- **不是摘要复述：** 文章新增了 record/state/bridge 数据模型、状态机、权限边界、负向 fixture、七天 shadow-mode SOP 与回滚路径。
- **不把推断写成事实：** bridge-first 是我的工程建议，未宣称已被论文验证为最优方案。
- **薄内容检查：** 含机制图、表格、接口、伪代码、可验证指标、失败模式与局限。
- **站内差异：** 本站已讨论环境经验、schema 演化与检索控制；本文专门讨论“已记住但未在间接决策中显现”的 query-conditioned blind spot 与可审计 visibility policy。
