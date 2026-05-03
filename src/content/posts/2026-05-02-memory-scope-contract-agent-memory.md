---
title: "记忆作用域合约：AI Agent 长期记忆真正难的是边界，不是存储"
description: "从 2026-05-02 的 agent memory 产品面讨论、ChatGPT Project-only memory、Claude 个性化功能和 Mem0/Cloudflare 的工程材料看，生产级记忆系统必须先定义用户、项目、任务和运行审计的边界，再谈向量库、图谱和长上下文。"
pubDate: 2026-05-02
category: "架构优化"
tags:
  - "AI memory"
  - "agent memory"
  - "long-term memory"
  - "personalization"
  - "memory evaluation"
  - "forgetting"
  - "RAG"
draft: false
---

## 来源说明

本文基于 2026-05-02 检索到的新材料和可复核的官方/论文材料写成。当天的新信号是 Adaline Labs 发布的《Agent Memory Is A Product Surface, Not Saved Chat History》，它把 agent memory 的核心问题从“保存聊天记录”转向“产品作用域、治理规则和调试面”。为了避免只复述一篇工程博客，本文同时核对了 OpenAI 关于 ChatGPT Memory 和 Projects 的官方帮助文档、Anthropic 关于 Claude 个性化功能的官方帮助文档、Mem0 的论文和 2026 年工程报告、LOCOMO 评测论文、Cloudflare Agent Memory 的检索设计，以及 2025 年底的 agent memory 综述论文。

稳定 slug：`2026-05-02-memory-scope-contract-agent-memory`。

参考来源：

- Adaline Labs: [Agent Memory Is A Product Surface, Not Saved Chat History](https://labs.adaline.ai/p/agent-memory-is-a-product-surface)
- OpenAI Help: [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- OpenAI Help: [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- Anthropic Help: [Understanding Claude's personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)
- arXiv: [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)
- Mem0: [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- arXiv: [Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753)
- arXiv: [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564)
- Cloudflare: [Agents that remember: introducing Agent Memory](https://blog.cloudflare.com/introducing-agent-memory/)
- Andrej Karpathy: [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## 先给结论

AI agent 记忆系统的下一个工程瓶颈，不是“有没有向量库”，也不是“上下文窗口够不够大”，而是有没有一份可执行的记忆作用域合约。

所谓作用域合约，指的是系统在写入、检索、展示、删除和调试记忆时，能明确回答五个问题：

- 这条记忆属于谁：用户、团队、项目、任务、agent、工具，还是组织？
- 它从哪里来：用户明确声明、模型抽取、工具结果、其他 agent 推断，还是人工维护？
- 它什么时候能影响行为：所有会话、某个项目、某次运行、某个工作流阶段，还是只用于审计？
- 它什么时候应该失效：过期、被新事实覆盖、离开项目、权限变化、用户删除，还是评测失败？
- 它如何被解释和调试：用户或开发者能否看到哪条记忆触发了输出，能否修改、撤销、降权？

如果这些问题没有被产品和系统同时回答，记忆越强，风险越大。一个没有作用域的长期记忆系统，本质上是一个会跨时间、跨项目、跨用户传播旧假设的隐形上下文注入器。

今天的新材料之所以值得写，不是因为它提出了新算法，而是因为它和 ChatGPT Projects、Claude past chat search、Mem0 多作用域 API、Cloudflare 混合检索这些材料指向同一件事：生产级 memory 已经从“存储层能力”变成“边界管理能力”。

## 技术问题：为什么保存更多历史反而会让 agent 更不可靠

很多团队第一次做 agent memory，会把问题理解成“历史上下文不够”。于是系统开始保存对话、总结用户偏好、把文档切块进向量库，再在下一轮把相似片段塞回 prompt。短期看，这能解决冷启动问题。长期看，它会制造四类新故障。

第一，记忆会越界。用户在一个临时调试任务里说“这次跳过测试”，如果被写成全局偏好，coding agent 以后可能在正式发布前也跳过测试。一个客户项目里的合规限制，如果被抽成组织级规则，可能错误影响另一个客户。

第二，记忆会过期。项目架构、用户偏好、数据源、API 限制都会变。语义检索通常更擅长找“像不像”，不擅长判断“还对不对”。旧记忆越相关，越容易以高置信度污染当前决策。

第三，记忆会隐藏影响链。用户看到的是回答，但不知道回答受哪条历史事实影响。开发者看到的是一次模型输出错误，却未必知道错误来自召回、摘要、写入抽取、权限过滤，还是另一个 agent 的中间推断。

第四，记忆会混淆数据类型。用户画像、项目约定、任务状态、工具执行日志、评测结果和安全策略都可能被叫作 memory，但它们的保留期限、权限、可见性和召回路径完全不同。把它们放进同一张 `memories` 表或同一个向量索引，不会自动得到长期记忆，只会得到更难调试的上下文混合物。

这也是长上下文不能替代长期记忆的原因。长上下文解决的是“这一轮能看多少”。记忆系统解决的是“哪些东西值得跨轮保留、如何更新、何时遗忘、由谁控制”。两者相关，但不是同一个机制。

## 今天的新信号：产品开始显式承认记忆边界

Adaline Labs 今天的文章把 agent memory 拆成用户、任务、项目和 operational 四类作用域。这个分类本身不是最终标准，但它抓住了一个工程事实：记忆不是一坨历史文本，而是一组对未来行为有约束力的状态。

OpenAI 的 ChatGPT Projects 文档也显示了同样的方向。项目可以选择 project-only memory；在这种模式下，已保存的个人 memories 不会被项目聊天引用，项目外聊天也不能被项目聊天引用。共享项目还会自动转成 project-only memory，并且不能重新切回默认记忆。这不是“检索算法”的描述，而是明确的上下文边界设计。

OpenAI 的 Memory FAQ 则把 saved memories 和 reference chat history 区分开：前者更像用户希望长期保留的显式条目，后者更像从历史聊天中提取的可变个性化信号。它还提供查看、删除、关闭、临时聊天等控制面。这里的关键不是某个具体 UI，而是产品必须把“记忆如何进入未来上下文”变成用户可理解、可操作的对象。

Anthropic 的 Claude 个性化文档走的是另一条路径：past chat search、profile preferences、project instructions、styles 分别服务于历史检索、用户偏好、项目规则和表达风格。它没有把这些都叫作同一种 memory，而是把不同用途放在不同控制面里。对工程团队来说，这比一个万能 memory 开关更接近真实需求。

这些产品变化说明，记忆系统正在从底层能力走向用户和团队可见的边界设置。真正重要的问题不再是“能否记住”，而是“在正确的地方记住，并且不在错误的地方记住”。

## 机制拆解：一份可执行的记忆作用域合约

工程上，记忆作用域合约至少要拆成四层。

### 1. 用户记忆：个性化，但不能变成过期画像

用户记忆保存沟通风格、偏好、长期目标、稳定约束和用户明确要求保留的信息。它的价值是减少重复说明，让 agent 更快进入工作状态。

但用户记忆最容易过度泛化。一次请求“今天回答短一点”不等于永久偏好；一次饮食限制、预算限制、情绪状态或工作身份也不一定应该长期保存。更敏感的是模型推断出来的用户属性，例如职业、健康、家庭、政治倾向或购买意图。如果系统把推断当事实保存，个性化会变成画像污染。

用户记忆的合约应当包括：

- 默认只保存用户明确表达或强稳定信号，不保存弱推断。
- 每条记忆带来源、创建时间、最后验证时间和可见文本。
- 用户可以查看、删除、改写或关闭引用。
- 对敏感信息采用显式确认或禁止保存策略。
- 当前指令与旧偏好冲突时，当前指令优先，并记录冲突。

这类记忆的指标不是“召回越多越好”，而是 preference usefulness、用户纠错率、错误个性化率和删除后残留引用率。

### 2. 项目记忆：让长期工作连续，但必须隔离

项目记忆保存仓库约定、文档、决策、术语、数据源、客户限制和长期任务背景。它比用户记忆更适合做成 workspace 或 project 级边界，因为同一个用户在不同项目里可能有完全不同的角色和约束。

ChatGPT 的 project-only memory 是一个重要信号：项目记忆需要有隔离模式。一个严肃的 agent 平台也应该允许项目记忆不引用个人记忆、不被其他项目引用，并在共享后自动收紧边界。否则共享项目会把个人偏好、旧聊天或其他项目上下文带进团队空间，形成隐私和可靠性风险。

项目记忆的合约应当包括：

- 明确项目 ID、组织 ID、可访问成员和共享状态。
- 项目内文件、聊天、规则、决策记录和 saved sources 分层存储。
- 共享后默认阻断个人记忆和项目外聊天。
- 项目删除或成员离开后，定义数据保留和副本规则。
- 项目规则优先级高于全局风格偏好，但低于当前用户明确指令和安全策略。

项目记忆最适合人类可审查的材料，比如 Markdown wiki、决策记录、源文件引用和手工确认的规则。Karpathy 的 `llm-wiki` 思路有启发意义：agent 可以维护结构化 wiki，但 wiki 必须被周期性 lint，清理矛盾、过期和孤立条目。项目记忆不能只是“所有项目聊天的 embedding”。

### 3. 任务记忆：保存进行中状态，不要永久化临时尝试

任务记忆保存当前目标、阶段、尝试过的方法、失败原因、待办项、阻塞点和用户刚刚确认的选择。它的生命周期通常短于用户记忆和项目记忆，但对 agent 连续工作很关键。

很多 memory 污染来自任务记忆被错误晋升。调试过程中 agent 可能尝试过一个失败方向，如果这个方向被保存成“项目约定”，下一次任务会继续走错。相反，如果完全不保存任务状态，跨 session 的 agent 又会反复从头读代码、重复失败步骤。

任务记忆的合约应当包括：

- 绑定 `run_id`、`task_id` 或 session，而不是只绑定用户。
- 每条状态标注 `active`、`resolved`、`abandoned` 或 `superseded`。
- 失败尝试只能作为负例或审计证据进入长期层，不能默认作为建议。
- 任务完成后进行压缩：只把稳定决策、可复用流程或明确项目规则晋升。
- 新任务默认不引用旧任务中未验证的临时假设。

这一层和前一篇“经验压缩谱”文章有关，但重点不同。经验压缩讨论的是从 episode 到 skill/rule 的晋升；作用域合约讨论的是晋升前后不能丢失边界。一个失败经验可以成为规则，前提是它有足够证据、明确适用范围和可回滚路径。

### 4. 运行审计记忆：用于调试，不一定用于生成

Operational memory 保存工具调用、审批、部署、回滚、评测结果、权限拒绝、成本、延迟和 agent 间消息。它经常被忽视，但它是调试 memory failure 的关键。

这类记忆不应该随便进入模型上下文。比如“上次部署失败，因为凭证缺失”可能对当前部署有用；但完整日志、错误堆栈、访问令牌片段、客户数据和另一个 agent 的中间猜测，不一定应该被模型读取。运行审计记忆首先是可观测性数据，其次才可能被压缩成可召回经验。

Mem0 报告中提到的 actor-aware memories 很有价值：多 agent 系统必须知道一条记忆来自用户陈述、工具结果、某个 agent 的推断，还是人工确认。Cloudflare Agent Memory 的混合检索设计也说明，实际召回不是单一路径：全文、精确 key、原始消息、向量和 HyDE 向量可能并行，再用融合排序决定候选。

运行审计记忆的合约应当包括：

- source actor：用户、agent、工具、系统、人工审核者。
- evidence pointer：原始消息、工具结果、文件路径、日志 span 或评测样本。
- influence log：本次输出是否使用了这条记忆。
- access policy：哪些 agent 和人能读取，是否可进入 prompt。
- redaction policy：密钥、客户数据和敏感字段必须在写入前或检索前处理。

没有这一层，memory observability 只能靠猜。你知道 agent 答错了，但不知道是哪条旧记忆、哪个检索策略、哪个摘要步骤把它带偏。

## 推荐架构：先建作用域，再选存储

一个生产级 agent memory 系统可以按下面的顺序设计，而不是先决定用哪家向量库。

第一步，定义 memory event schema。至少包含：

```text
id
content
scope_type: user | project | task | operational
scope_id
source_actor
source_type: explicit_user | extracted | tool_result | agent_inference | human_review
evidence_uri
created_at
updated_at
expires_at
status: active | superseded | deleted | expired | quarantined
confidence
sensitivity
retrieval_policy
write_policy
delete_policy
```

第二步，定义作用域优先级。一个合理默认是：安全策略和当前用户指令优先，其次是项目规则，再其次是任务状态，然后才是用户偏好和历史聊天信号。这个顺序不是固定真理，但必须显式化。否则模型会在 prompt 中自行猜测哪个上下文更重要。

第三步，定义检索计划。用户偏好可以走 key-value 加少量语义检索；项目知识可以走全文、结构化 metadata、文件引用和向量混合；任务状态可以走 session/task ID 精确查询；运行审计可以先走 trace/span，再把摘要候选送入模型。不同作用域不应无差别混排。

第四步，定义写入门槛。用户记忆需要显式性和稳定性，项目记忆需要来源和审查，任务记忆需要状态机，运行审计需要红线脱敏。不是所有被模型认为“可能有用”的东西都应该进入长期层。

第五步，定义可观测性。每次 memory-influenced output 都应能追踪：

- 检索了哪些 memory IDs。
- 哪些被注入 prompt。
- 哪些被模型实际引用或影响工具调用。
- 哪些记忆被当前指令覆盖。
- 是否发生作用域冲突、过期命中或权限过滤。

这比单纯记录“向量检索 top-k”更重要。用户投诉“你为什么这样回答”时，系统应该能指出记忆链路，而不是只能说模型生成了这个答案。

## 适用场景

这套作用域合约最适合三类系统。

第一类是长期个人助手。它们需要跨日、跨设备、跨话题保留用户偏好和历史目标，但必须让用户能看见、纠正和删除记忆。否则个性化会逐渐变成不可控画像。

第二类是项目型 coding/research agent。它们需要记住仓库约定、已读论文、设计决策、失败尝试和部署状态。项目隔离尤其关键，因为同一个开发者可能同时服务多个客户或多个代码库。

第三类是企业工作流 agent。客服、销售、财务、运维、合规场景都需要长期状态，但权限、审计、客户隔离和删除请求比“召回率高一点”更重要。这里的 memory 系统必须和身份、权限、日志、数据保留策略一起设计。

不适合的场景也要说清楚。如果 agent 只是一次性问答、无登录用户、无跨 session 任务，或者数据极度敏感且没有治理能力，那么长期记忆可能不是加分项。先做好明确的短期上下文和可删除日志，反而更稳。

## 失败模式

第一，作用域泄漏。用户级记忆影响项目级输出，项目 A 的约定影响项目 B，测试环境经验影响生产环境操作。这类错误通常不是模型能力问题，而是 memory filter 和 scope priority 没有设计好。

第二，当前指令被旧记忆覆盖。用户明确说“这次不要按旧模板写”，系统仍召回旧偏好并强行套用。解决办法不是简单删除旧偏好，而是在冲突时记录 override，并让当前指令优先。

第三，删除不完整。用户删掉 saved memory，但历史聊天、摘要、embedding、缓存和项目源里仍残留同一事实。真正的删除要跨存储层、索引层和摘要层处理。

第四，隐形影响。回答被某条 memory 塑形，但 UI、日志和 trace 都看不到。用户无法纠正，开发者无法定位。

第五，actor 混淆。一个 agent 的推断被另一个 agent 当成用户事实。多 agent 系统如果没有 source actor 和 evidence pointer，很容易把中间假设升级成长期事实。

第六，评测只看召回。LOCOMO、Mem0 论文和工程报告都提示了多维评测的重要性：准确率、token、延迟、成本和题型都要看。生产系统还要加上作用域泄漏率、删除完整性、冲突处理率和用户纠错率。

## 可验证指标

评估一套 agent memory 系统，至少应该跑以下指标。

- Scope leakage rate：某作用域记忆错误影响其他作用域输出的比例。
- Current-instruction override rate：当前指令与旧记忆冲突时，系统正确服从当前指令的比例。
- Deletion completeness：删除请求后，saved memory、历史摘要、embedding、缓存和项目源中残留引用的比例。
- Memory influence trace coverage：受记忆影响的输出中，能回溯到具体 memory ID 和 evidence 的比例。
- Stale memory hit rate：过期或 superseded 记忆被召回并影响输出的比例。
- Actor attribution accuracy：系统能否区分用户陈述、工具结果、agent 推断和人工确认。
- Memory usefulness delta：开启记忆后任务成功率、重复说明次数、用户纠错率、延迟和 token 成本的变化。
- Conflict resolution latency：用户纠正旧事实后，系统停止使用旧事实所需时间。

这些指标可以和 LOCOMO 这类长期对话评测并行使用，但不能互相替代。LOCOMO 能测一部分长期记忆问答能力；真实产品还必须测边界、权限、删除和调试。

## 局限分析

本文没有声称今天出现了新的记忆算法突破。Adaline Labs 的文章是工程观点，不是论文或开源实现；OpenAI 和 Anthropic 的文档说明的是产品能力和控制面，不公开底层检索、写入和排序细节；Mem0 的结果来自其论文和公司报告，需要结合具体应用重新验证。

另一个限制是作用域合约不能单独解决记忆质量。即使边界定义正确，系统仍可能写入错误摘要、检索错误片段、过度依赖模型推断或在高压场景下忽略权限。作用域合约解决的是“什么可以影响哪里”，不是“所有记忆都一定正确”。

我的判断是，2026 年的 agent memory 产品会继续分化：一类向基础设施走，强调多后端、图谱、检索融合和评测；一类向产品控制面走，强调项目隔离、用户可见、删除和共享边界。真正可靠的系统需要两者合并：底层可检索，表层可治理，中间有可观测的作用域合约。

## 发布前自审

- 事实可靠性：日期、产品能力和论文结论来自官方文档、arXiv、Cloudflare 和 Mem0 原始材料；未把 Adaline Labs 的工程观点当成实验事实。
- 来源完整性：包含当天新材料、官方产品文档、论文、评测和工程实现说明。
- 原创性：核心框架是“记忆作用域合约”，重点分析边界、优先级、状态机、观测和指标，不复述原文清单。
- 标题党检查：标题没有宣称突破或终局，只指出长期记忆的关键工程难点。
- 薄内容检查：包含技术问题、机制拆解、适用场景、失败模式、指标和局限。
- 猜测边界：对未公开实现使用“显示方向”“说明控制面”等表述，不推断内部算法。
- 站内重复检查：与 2026-04-28 的基础设施化文章、2026-04-29 的 Hermes/OpenClaw 对比、2026-05-01 的经验压缩谱不同；本文聚焦产品/工程作用域边界。
