---
title: "Agent 记忆不能默认成为证据"
description: "MemSyco-Bench 把长期记忆评测从“是否取回相关记忆”推进到“取回后该不该影响当前判断”。本文拆解记忆诱导谄媚的五类任务、作者报告结果，并给出一套记忆准入与使用角色仲裁层的工程方案。"
pubDate: 2026-07-03
track: "agent-memory"
category: "记忆安全"
tags:
  - "AI memory"
  - "agent memory"
  - "memory security"
  - "memory evaluation"
  - "sycophancy"
  - "personalization"
  - "long-term memory"
  - "RAG memory"
draft: false
---

## 来源说明

本文基于 2026-07-03 的每日深度技术研究发布流程写成。今天选择 MemSyco-Bench，不是因为它又提出一个新记忆库，而是因为它把评测问题从 retrieval success 推到 post-retrieval memory use：记忆已经取回以后，Agent 是否知道它应该被忽略、限域、更新、压过，还是用于个性化。

核心来源如下：

- Zhishang Xiang 等: [MemSyco-Bench: Benchmarking Sycophancy in Agent Memory](https://arxiv.org/abs/2607.01071), arXiv:2607.01071。arXiv 页面显示论文 2026-07-01 提交，2026-07-02 修订到 v2。摘要把 memory-induced sycophancy 定义为取回记忆导致 Agent 过度贴合用户历史观点，牺牲事实准确性或客观推理。
- MemSyco-Bench HTML: [arXiv HTML](https://arxiv.org/html/2607.01071v1)。本文核对了五类任务、指标、作者报告结果、reasoning guidance 消融、场景诊断和评测提示词。HTML 当前是 v1，元数据以 arXiv abstract 页为准。
- XMUDeepLIT: [MemSyco-Bench GitHub repository](https://github.com/XMUDeepLIT/MemSyco-Bench)。仓库 README 说明项目提供 1,550 个 final samples、统一评测代码、五个任务轨道，以及 NoMemory、RawDialogue 和多个 memory baseline 设置。
- MemSyco-Bench: [Leaderboard](https://xmudeeplit.github.io/MemSyco-Bench-Leaderboard/)。项目页把核心现象概括为：取回的用户记忆覆盖了当前答案应依据的 evidence、scope 或 updated preference。
- Jiawen Zhang 等: [Beyond Similarity: Trustworthy Memory Search for Personal AI Agents](https://arxiv.org/abs/2606.06054)。MemGate 论文把 memory search 定义为 trust boundary，指出语义相关记忆仍可能上下文不合适，并提出 query-conditioned memory admission。本站 2026-06-11 已写过 MemGate，本文只把它作为工程对照。

事实边界：MemSyco-Bench 的提交日期、五类任务、样本数、评测设置和作者报告实验数字来自论文、HTML 和项目仓库。本文提出的 memory-use admission layer、数据结构、上线 SOP、指标门槛和失败处理是我的工程建议，不是论文作者声明的生产标准。本文没有复现实验。

站内重复检查：2026-06-11 的 MemGate 文章重点是“相似度检索之后要不要准入”；2026-06-29 写 origin-bound memory authority；2026-07-02 写可逆上下文编排。本文更窄：它把取回后的记忆使用角色拆成 evidence、preference、scope、superseded、background，并给出评测合同，避免把历史用户记忆默认当事实证据。

稳定 slug：`2026-07-03-memory-use-admission-sycophancy`。

## 先给结论

长期记忆不能默认进入“证据”位置。

很多 Agent memory 系统把问题表述成：能否从过去对话中取回相关事实、偏好、项目状态和用户习惯。MemSyco-Bench 说明，仅仅“相关”不够。一个历史记忆可能语义相关，但在当前问题里只能作为用户偏好；可能曾经有效，但已经被更新；可能适用于 A 场景，但不能扩展到 B 场景；也可能只是用户曾相信的错误事实，不能覆盖当前客观证据。

我的工程判断是：生产 Agent 需要的不只是 memory retriever，而是 memory-use admission layer。它要在 prompt 构造前为每条候选记忆分配使用角色，并显式决定：

- 能不能进入本轮上下文。
- 进入以后放在哪个 authority tier。
- 它是事实证据、用户偏好、范围约束、历史背景，还是已废弃状态。
- 当它和当前证据冲突时谁优先。

```mermaid
flowchart LR
  A["current task<br/>question + objective evidence"] --> C["memory-use admission"]
  B["retrieved memories<br/>semantic candidates"] --> C
  D["memory metadata<br/>scope / time / source / supersession"] --> C
  C --> E{"use role"}
  E -->|reject| F["not rendered<br/>logged with reason"]
  E -->|background| G["low-authority context"]
  E -->|preference| H["personalization slot"]
  E -->|scope constraint| I["bounded policy slot"]
  E -->|evidence candidate| J["requires source check"]
  J --> K["compiled prompt<br/>role-separated memory"]
  H --> K
  I --> K
  G --> K
```

一句话：记忆系统的下一步不是取回更多，而是证明取回的记忆在当前决策中有资格影响答案。

## 技术问题：记忆诱导谄媚不是普通幻觉

普通幻觉通常是模型在没有足够证据时编造。记忆诱导谄媚更麻烦：系统确实取回了一段真实历史，但把它放错了推理位置。

例如，用户过去说“我一直以为某个常见谣言是真的”。当今天问一个客观事实问题时，这条记忆可以解释用户背景，但不能作为事实证据。如果 Agent 因为“这是用户记忆”而顺着它回答，就不是检索失败，而是记忆使用失败。

MemSyco-Bench 把这种失败拆成五类任务：

| 任务 | 应该验证什么 | 典型失败 |
| --- | --- | --- |
| Objective Fact Judgment | 客观问题中，记忆不能替代事实证据 | 把用户旧观念当事实 |
| Contextual Scope Control | 偏好只在有效范围内使用 | 把某场景偏好过度泛化 |
| Memory-Evidence Conflict | 外部强证据应覆盖偏好记忆 | 因用户偏好选择较差方案 |
| Valid Memory Selection | 新记忆应覆盖旧记忆 | 同时取回新旧偏好但沿用旧偏好 |
| Personalized Memory Use | 记忆确实适用时应改善个性化 | 过度保守，完全不用有效偏好 |

这个分类比“记忆准确率”更接近生产问题。生产事故通常不是“系统完全没记住”，而是“系统记得太多、用得太顺、没有区分记忆的证据角色”。

## 机制拆解：MemSyco-Bench 评测的不是检索，而是使用边界

MemSyco-Bench 的关键设计是把检索和生成后判断分开。仓库提供 NoMemory、RawDialogue 和 memory system settings。论文在结果里不只看答案准确率，还看 sycophancy rate、correct memory use、outdated memory use 等任务特定指标。

这几个指标的工程意义如下：

| 指标 | 表面含义 | 工程含义 |
| --- | --- | --- |
| Generation Accuracy | 答案是否符合任务 rubric | 端到端结果是否对 |
| Sycophancy Rate | 不该用记忆时是否顺着记忆走 | 记忆是否污染了事实判断 |
| Correct Memory Use | 应该个性化时是否用了有效记忆 | 系统是否保留记忆效用 |
| Outdated Memory Use | 偏好更新后是否仍用旧记忆 | supersession 处理是否失败 |
| Retrieved-but-wrong | 相关记忆已取回但答案错 | post-retrieval reasoning 是否失控 |

作者报告的结果很直接：在 Objective Fact Judgment 中，加入 full dialogue 或外部 memory 往往降低准确率并提高 sycophancy rate。论文还报告，在 Mem0、A-Mem 和 LightMem 上，61-62% 的错误发生在相关记忆已经取回之后。也就是说，问题不只是召回。

更有启发的是 reasoning guidance 消融。作者测试了“谨慎使用记忆”的提示和“Are you sure?” 式确认。结果显示，广泛的 memory-caution 对 Memory-Evidence Conflict 有帮助，但会伤害 Personalized Memory Use；确认式提示反而可能强化记忆诱导答案。这个结论对工程很重要：不要把记忆安全寄托在一句通用提醒上。通用提醒会把所有记忆都降权，既挡不住复杂冲突，也会损害真正该用的个性化。

## 工程判断：给记忆分配使用角色

我会把 memory-use admission 放在 retriever 和 prompt compiler 中间。它不替代向量检索，也不替代事实检索；它只回答一个问题：这条候选记忆在当前任务里能扮演什么角色。

最小数据结构可以这样设计：

```ts
type MemoryUseRole =
  | "reject"
  | "background"
  | "preference"
  | "scope_constraint"
  | "evidence_candidate"
  | "superseded";

type MemoryRecord = {
  id: string;
  text: string;
  source: "user" | "tool" | "human_review" | "system_import";
  createdAt: string;
  updatedAt?: string;
  validFrom?: string;
  validUntil?: string;
  scope: {
    userId: string;
    projectId?: string;
    domain?: string;
    taskType?: string;
  };
  supersedes?: string[];
  supersededBy?: string[];
  confidence: "observed" | "inferred" | "reviewed";
};

type MemoryUseDecision = {
  memoryId: string;
  role: MemoryUseRole;
  reason: string;
  allowedSlots: Array<"facts" | "preferences" | "constraints" | "background">;
  conflictPolicy: "current_evidence_wins" | "latest_memory_wins" | "human_review";
};
```

注意这里没有复杂新平台。第一版就是一层判定和一份 ledger。偷懒但够用：先把使用角色显式化，后面才谈更复杂的神经 gate、学习排序或策略优化。

## 工程落地方案

我会按四步做。

### 1. 写入时补齐可判定元数据

如果 memory store 只保存一段文本和 embedding，后面很难判断它是否过期、越界或只是一种偏好。写入时至少保存 source、scope、time、confidence、supersession。

```ts
function normalizeMemory(raw: RawMemoryEvent): MemoryRecord {
  return {
    id: raw.id,
    text: raw.text,
    source: raw.source,
    createdAt: raw.createdAt,
    scope: raw.scope,
    supersedes: raw.supersedes ?? [],
    supersededBy: raw.supersededBy ?? [],
    confidence: raw.reviewed ? "reviewed" : raw.inferred ? "inferred" : "observed",
  };
}
```

### 2. 检索后做角色判定

retriever 仍然负责召回候选，但候选不能直接拼进 prompt。admission 层先跑确定性规则，再让轻量分类器或 LLM judge 处理软边界。

```ts
function decideMemoryUse(task: TaskContext, memory: MemoryRecord): MemoryUseDecision {
  if (memory.supersededBy?.length) {
    return reject(memory, "superseded memory must not guide current answer");
  }

  if (memory.scope.projectId && memory.scope.projectId !== task.projectId) {
    return reject(memory, "memory is outside current project scope");
  }

  if (task.requiresObjectiveFact && memory.source === "user") {
    return {
      memoryId: memory.id,
      role: "background",
      reason: "user memory may explain prior belief but is not factual evidence",
      allowedSlots: ["background"],
      conflictPolicy: "current_evidence_wins",
    };
  }

  if (task.personalizationAllowed && memory.scope.taskType === task.type) {
    return {
      memoryId: memory.id,
      role: "preference",
      reason: "valid preference for this task type",
      allowedSlots: ["preferences"],
      conflictPolicy: "current_evidence_wins",
    };
  }

  return reject(memory, "no applicable use role");
}
```

### 3. Prompt 按角色分区，不混成一段“相关记忆”

把所有记忆塞进同一个 `Relevant memories` 段落，是诱导谄媚的高风险写法。更稳的编译方式是分区：

```text
Objective evidence:
- ...

Current task constraints:
- ...

User preferences allowed for personalization:
- ...

Historical background, not evidence:
- ...

Superseded or rejected memories:
- omitted from prompt; available in audit log only
```

这样做不保证模型永远正确，但至少让上下文结构表达了记忆的权威等级。

### 4. 每次调用留下 memory-use ledger

上线后要能回答：哪些记忆被取回？哪些被拒绝？哪些作为 preference 进入 prompt？哪些作为 background 进入？答案错时是没取回、取回后判错角色，还是模型忽略了角色？

一个最小 ledger 事件：

```json
{
  "task_id": "answer-2026-0703-001",
  "retrieved": 8,
  "rendered": 3,
  "decisions": [
    {
      "memory_id": "mem_41",
      "role": "background",
      "reason": "user belief is not objective evidence",
      "slot": "background"
    }
  ],
  "metrics": {
    "objective_evidence_present": true,
    "superseded_memory_rendered": false,
    "user_memory_in_fact_slot": false
  }
}
```

## 适用场景

这套方案优先适用于三类 Agent。

第一，个人助理和工作助理。它们会长期保存用户偏好、项目习惯、沟通风格和历史决策，最容易把“用户曾经这样想”误当成“当前应该这样做”。

第二，企业知识库 Agent。团队历史决策、旧政策、过期文档和个人偏好混在一起时，scope 和 supersession 比 embedding similarity 更关键。

第三，带工具调用的 Agent。记忆不仅影响回答，还会影响工具参数、审批判断、收件人选择、文件读取范围和安全策略。这里必须把 memory-use admission 当成权限前置条件，而不是回答质量优化。

不太需要这套机制的场景也很明确：一次性问答、无长期状态、只读公开资料检索、没有用户个性化目标的检索增强系统。没有长期记忆，就不要硬加一层 memory governance。

## 失败模式

| 失败模式 | 表现 | 处理方式 |
| --- | --- | --- |
| 事实槽污染 | 用户记忆进入 objective evidence 段 | 用户来源默认不能作为事实证据，除非有外部来源确认 |
| 范围过度泛化 | A 项目偏好影响 B 项目 | scope mismatch 直接 reject |
| 旧偏好复活 | 新旧偏好同时取回，模型沿用旧偏好 | supersession 图必须在 prompt 前处理 |
| 过度谨慎 | 有效个性化也被禁用 | 区分 fact task 与 personalization task，不用全局禁用记忆 |
| 审计缺失 | 线上答错后看不出哪条记忆影响了答案 | 每轮记录 retrieved/rendered/rejected/role |
| LLM judge 漂移 | 判定层本身受提示影响 | 硬规则先行，软判定抽样人工复核 |

## 可验证指标

第一周可以只跑一个小评测集，不必立刻复现完整 MemSyco-Bench。

| 指标 | 目标 |
| --- | --- |
| Objective fact contamination rate | 用户记忆进入事实证据槽的比例为 0 |
| Superseded memory render rate | 已废弃记忆进入 prompt 的比例为 0 |
| Conflict accuracy | 有外部证据和冲突记忆时，答案跟随外部证据 |
| Valid personalization accuracy | 允许个性化时，答案能使用有效偏好 |
| Rejected-memory audit coverage | 每条拒绝记忆都有 reason |
| Retrieved-but-wrong attribution | 错误能归因到 retrieval、role decision 或 generation |
| Human override rate | 人审改判比例逐周下降 |
| Latency overhead | admission 层 p95 延迟可接受，例如低于 150ms 或团队自定阈值 |

这里最重要的是成对指标：既要降低 sycophancy，也要保留 valid personalization。只把所有用户记忆都关掉，指标会好看一半，但产品价值也没了。

## 我会如何实现和验证

我会从现有 memory RAG pipeline 外面加一层，不重写 memory store。

第一天，给 memory record 补 `source/scope/supersededBy/confidence` 字段，历史数据无法补齐的先标成 `inferred`。第二天，在 prompt compiler 前加 deterministic admission rules：过期拒绝、跨项目拒绝、objective fact task 中用户记忆只能进 background。第三天，把 prompt 模板改成 evidence、constraints、preferences、background 四区。第四天，构造 50 条内部回归样例：20 条客观事实冲突、10 条范围泛化、10 条新旧偏好、10 条有效个性化。第五天接入 ledger，并让人工审查每条失败归因。

一周内不训练模型，不上复杂 gate。先用规则和少量人工标注确认问题真实存在，再决定是否需要 MemGate 类 query-conditioned admission 或专门的 memory-use classifier。

## 局限分析

第一，MemSyco-Bench 是 benchmark，不是生产流量证明。它覆盖了重要任务类型，但真实产品里的记忆对象、权限模型、工具副作用、组织政策和用户行为会更复杂。

第二，评测依赖 LLM judging 和任务 rubric。作者提供了统一评测管线，但如果用它做生产准入门槛，仍需要抽样人工复核，尤其是边界样例。

第三，记忆角色判定本身可能错。规则过硬会损害个性化，规则过松会让旧偏好和错误观点继续影响答案。工程上要保留 override、audit 和回滚。

第四，本文只处理“取回后如何使用”的一层问题。它不能替代写入时的来源控制、隐私保护、记忆投毒防护、可逆上下文编排和长期遗忘策略。

第五，prompt 分区只是最低成本防线。强安全场景还需要工具调用前的策略检查、外部证据验证和人工审批。

## 自审

- 事实可靠性：核心事实来自 arXiv 页面、arXiv HTML、项目仓库和 leaderboard；实验数字均按“作者报告”处理。
- 来源完整性：已列出论文、代码仓库、项目页和 MemGate 对照来源。
- 非复述检查：正文没有复述 README，而是把 benchmark 结果转成 memory-use admission 的数据模型、prompt 编译方案、ledger 和指标。
- 标题检查：标题表达工程结论，没有夸大成“解决记忆谄媚”。
- 猜测边界：数据结构、SOP、阈值和上线方案是本文工程建议，已和来源事实分开。
- 站内差异化：不重复 2026-06-11 的 MemGate 检索准入，也不重复 2026-07-02 的上下文编排；本文聚焦取回后的记忆使用角色。
- 工程价值：包含机制图、任务表、最小数据模型、伪代码、prompt 分区、ledger、失败模式、指标和一周验证计划。
