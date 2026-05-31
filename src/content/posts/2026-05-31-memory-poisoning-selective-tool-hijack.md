---
title: "记忆投毒进入第二阶段：绕过选择性记忆，劫持工具选择"
description: "从 MemPoison 和 MemMorph 看，Agent 记忆攻击正在从“把恶意内容写进长期记忆”推进到“让恶意内容通过抽取、重写、检索和工具推理链条”。生产系统需要把记忆写入、来源权威、检索召回和工具授权放进同一套评测。"
pubDate: 2026-05-31
track: "security"
category: "安全分析"
tags:
  - "AI memory"
  - "agent memory"
  - "long-term memory"
  - "memory poisoning"
  - "memory-augmented agents"
  - "memory evaluation"
  - "tool use"
  - "prompt injection"
draft: false
---

## 来源说明

本文基于 2026-05-31 的每日 AI 记忆系统研究发布流程写成。今天没有找到足够强的同日 arXiv 新论文，但过去 48 小时内检索到一组尚未在站内处理、且足以支撑原创分析的近期材料：`Hijacking Agent Memory` 在 2026-05-28 提交，提出 MemPoison，重点不是普通长期记忆投毒，而是攻击现代 agent 里常见的选择性抽取、摘要重写和 embedding 检索机制；`MemMorph` 在 2026-05-24 提交，进一步把记忆投毒目标推进到工具选择，让 agent 在没有显式恶意命令的情况下偏向攻击者指定工具。

这和 2026-05-10 的站内文章不同。那篇文章讨论的是长期记忆作为安全边界，以及 Trojan Hippo、MAGE、Opal 等材料揭示的跨会话攻击面；本文聚焦更窄的工程问题：当记忆系统已经开始做筛选、重写、结构化和工具策略学习时，攻击者如何适配这些“防御性”管线，以及评测应该怎样覆盖记忆到工具调用的完整链路。

稳定 slug：`2026-05-31-memory-poisoning-selective-tool-hijack`。

参考来源：

- Hongtao Wang, Se Yang, Yu Chen, Puzhuo Liu: [Hijacking Agent Memory: Stealthy Trojan Attacks Through Conversational Interaction](https://arxiv.org/abs/2605.29960), arXiv:2605.29960
- Xuanye Zhang, Yongsen Zheng, Zhuqin Xu, Kaiyu Zhou, Bowen Shen, Haoran Ou, Tianwei Zhang, Kwok-Yan Lam: [MemMorph: Tool Hijacking in LLM Agents via Memory Poisoning](https://arxiv.org/abs/2605.26154), arXiv:2605.26154
- Sidharth Pulipaka, Stanislau Hlebik, Leonidas Raghav, Sahar Abdelnabi, Vyas Raina, Ivaxi Sheth, Mario Fritz: [Hidden in Memory: Sleeper Memory Poisoning in LLM Agents](https://arxiv.org/abs/2605.15338), arXiv:2605.15338
- Debeshee Das, Julien Piet, Darya Kaviani, Luca Beurer-Kellner, Florian Tramer, David Wagner: [Trojan Hippo: Weaponizing Agent Memory for Data Exfiltration](https://arxiv.org/abs/2605.01970), arXiv:2605.01970
- OWASP Gen AI Security Project: [Memory Is a Feature. It Is Also an Attack Surface](https://genai.owasp.org/2026/05/13/memory-is-a-feature-it-is-also-an-attack-surface/)
- OWASP Gen AI Security Project: [OWASP Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)

## 先给结论

Agent 记忆投毒正在进入第二阶段。

第一阶段的问题是：攻击者能不能把恶意事实、偏好或指令写进长期记忆，并在未来会话中重新激活。Sleeper Memory Poisoning 和 Trojan Hippo 已经把这个问题讲清楚：持久化记忆让 prompt injection 获得了时间维度，payload 可以先写入、后触发、再通过工具产生副作用。

第二阶段的问题更难：如果系统已经不是把对话原文直接存进向量库，而是使用选择性记忆抽取、摘要重写、实体过滤、embedding 检索、结构化规则和工具经验累积，攻击还能不能成立？

MemPoison 和 MemMorph 的答案都偏悲观。MemPoison 指向写入链路：攻击者可以把触发器和载荷包装成一个语义上连贯、看起来像普通实体关系的陈述，让选择性记忆模块把它们一起抽取、一起改写、一起存储。MemMorph 指向读取和行动链路：攻击者不必直接说“调用危险工具”，而是把少量伪装成事实、事故复盘或操作策略的记忆写进去，让 agent 后续自己推理出攻击者想要的工具选择。

这意味着生产系统不能只用“是否有 memory filter”来证明安全。真正要评估的是完整路径：不可信输入能否进入记忆，进入后是否保留来源，重写后是否漂白权威，检索时是否被召回，召回后是否影响计划，计划中是否改变工具选择，工具调用前是否检查了这条记忆的来源和权限。

## 技术问题：选择性记忆不是天然防线

很多 agent memory 系统会把“选择性写入”当成风险缓解手段。它们不会保存完整对话，而是让模型抽取用户偏好、项目事实、工作流规则、实体关系或历史教训。表面上看，这比原文存储安全：明显的 prompt injection 字符串可能被过滤，粗糙命令可能被摘要器丢弃，低质量噪声可能不会进入长期 store。

但选择性记忆也创造了新的攻击目标。攻击者不再需要让恶意内容以原始形式保存，只需要让抽取器认为它值得保存，让重写器保留关键关系，让 embedding 把它放到未来查询附近，让 agent 在使用时把它当成可信经验。

这和普通 RAG 投毒不同。RAG 投毒通常污染的是外部知识库：检索到的文档仍然可以被标为外部来源。长期记忆投毒污染的是 agent 自己的历史状态。经过摘要和抽取后，来源更容易丢失，文本更像“系统已经学到的事实”，权威感更强。

因此，选择性记忆的失败不是“过滤器漏掉坏词”这么简单，而是四个阶段的组合失败：

- 抽取失败：系统把攻击者输入抽成长期事实。
- 重写失败：系统在摘要或规范化时去掉了攻击痕迹，却保留了攻击关系。
- 检索失败：系统在未来任务中把这条记忆召回到高影响上下文。
- 授权失败：工具调用前没有检查当前动作是否依赖低权威或不可信记忆。

只要这四个阶段连起来，攻击内容甚至可以比原始 prompt injection 更稳定。它已经被系统自己的记忆管线重新包装过了。

## 机制拆解

### 1. MemPoison：攻击抽取和重写，而不是只攻击存储

`Hijacking Agent Memory` 的关键假设很现实：现代记忆系统不会机械保存用户说过的每句话。它们会做选择性抽取、重写和压缩。论文认为，很多早期 memory poisoning 攻击默认恶意内容能被直接写入长期记忆，这低估了现代 memory pipeline 的中间处理。

MemPoison 的策略是让攻击内容适应这些中间处理。它有三个核心部件。

第一是 semantic relational bridge。攻击者把触发器和载荷绑定成一个语义上自然的关系陈述，让抽取器认为这是一条完整事实，而不是两段可疑指令。这样，触发条件和恶意效果更可能被一起保存。

第二是 entity masquerading。触发器被优化成类似命名实体的形式，减少被摘要器改写或丢弃的概率。很多 memory extractor 对人名、项目名、组织名、产品名和专有名词更敏感，因为这些实体看起来像值得长期保存的用户上下文。

第三是 joint embedding optimization。攻击文本被优化到 embedding 空间中的特定位置：一方面和未来触发查询足够接近，另一方面和正常记忆保持一定隔离，降低被普通审计发现的概率。论文摘要报告，在不同 agent domain 和 memory mechanism 上，MemPoison 的 attack success rate 最高达到 0.95，并指出机制分析涉及 embedding-space anisotropy 和注意力模式变化。

工程启发是：安全过滤不能只看写入前的原文，也不能只看写入后的最终 memory。真正的审计对象应该包括抽取前输入、抽取中间表示、重写后文本、embedding 位置、召回查询和最终注入上下文。否则，攻击者可以让每个单点看起来都不够异常，但完整链路仍然可触发。

### 2. MemMorph：攻击工具选择，而不是只攻击回答文本

`MemMorph` 把目标从“让 agent 回答错”推进到“让 agent 选错工具”。这是更接近生产风险的方向，因为工具调用才会产生外部副作用。

论文的核心观察是：许多 tool-augmented agents 会从历史经验中学习工具选择偏好。它们可能保存“某 API 在某类任务中更可靠”“遇到某类错误时使用某工具”“某操作流程优先走某服务”等记忆。攻击者如果直接篡改工具 metadata，容易被审计发现；如果把偏置信号伪装成长期经验，agent 可能在后续任务中自己推理出错误选择。

MemMorph 使用少量 crafted records，这些记录伪装成技术事实、incident report 或 operational policy。它们不是显式命令，而是塑造 agent 的背景判断。例如，让某个不该优先使用的工具看起来更稳定、更合规或更适合特定场景。论文摘要报告，它在 3 个 benchmarks、10 个 agent backbones 和 3 种 memory-module implementations 上评估，使用 3 条 injected records 时最高达到 85.9% attack success rate，并在 3 类代表性防御下仍保持效果。

这对工程系统的打击点很明确：工具安全不能只审查工具描述、权限和调用参数，还要审查“为什么 agent 选择了这个工具”。如果选择理由来自长期记忆，就必须知道这些记忆是谁写入、何时写入、来自哪类输入、是否被用户或组织策略确认。

否则，工具 allowlist 只能说明“这个工具本身允许被调用”，不能说明“这次选择它的理由是可信的”。攻击者最想要的恰恰是后者：让 agent 在允许的工具集合里选择一个对攻击者最有利的工具。

### 3. Sleeper Memory 和 Trojan Hippo：为什么完整链路评测必要

Sleeper Memory Poisoning 和 Trojan Hippo 提供了背景基线：长期记忆攻击的危险不在单轮对话，而在跨会话链路。Sleeper Memory Poisoning 评估了记忆是否被写入、后续是否被检索、检索后是否影响 agentic action；Trojan Hippo 则把植入阶段和敏感话题触发阶段拆开，并关注数据外泄。

MemPoison 和 MemMorph 不是替代这些工作，而是补上了链路中的两个更细位置：前者针对选择性写入管线，后者针对工具选择管线。合起来看，长期记忆安全评测至少要覆盖五个问题：

- 恶意内容能否被写入？
- 写入时是否经过摘要、抽取或结构化重写？
- 重写后来源和权威等级是否保留？
- 未来任务中是否被召回并注入？
- 注入后是否改变工具选择、外发动作或安全判断？

只测第一项会低估现代攻击；只测最后一项又很难定位问题发生在哪里。

## 工程判断：记忆安全要从内容过滤升级为状态治理

我会把生产级 agent memory 的安全要求分成五层。

第一层是 source labeling。每条 memory 必须有来源类型：用户显式确认、用户普通对话、外部网页、邮件、工具输出、模型总结、系统策略、人工导入、其他 agent 传入。没有来源标签，就谈不上权限判断。

第二层是 authority scoring。不同来源不应拥有同等权威。组织策略高于网页，用户当前确认高于旧偏好，工具实测结果高于模型猜测，不可信外部内容默认不能变成长期规则。

第三层是 transformation audit。记忆从原文变成摘要、实体、图节点、policy、embedding 或经验记录时，系统应该保留转换链。最危险的不是恶意内容原样存在，而是它被重写成看似干净的高权威陈述。

第四层是 retrieval-to-action trace。每次重要工具调用都应该能回答：哪些 memory 进入了上下文，哪些 memory 影响了计划，哪些 memory 支持了工具选择。如果回答不了，就很难复盘 MemMorph 这类攻击。

第五层是 taint-aware authorization。工具调用授权不能只看用户当前请求和工具 schema，还要看当前计划是否依赖被污染或低权威记忆。只要外发、写库、删数据、发消息、改权限、发起付款等动作依赖不可信 memory，就应该降级、确认或阻断。

这五层不是为了追求形式完美，而是为了避免一个常见误区：把 memory poisoning 当成文本分类问题。它更接近状态治理问题。攻击者污染的是 agent 的未来状态，而不是一次输入字符串。

## 适用场景

第一类是 coding agent。它们会记住项目构建流程、历史修复、依赖风险、部署习惯和 review 偏好。如果攻击者通过 issue、README、网页文档或工具输出写入“某脚本是标准部署路径”之类的记忆，后续 agent 可能主动运行错误命令。

第二类是企业运营 agent。CRM、工单、Slack、邮件和内部文档都会进入上下文，agent 又可能调用发送通知、修改记录、创建订单和触发 workflow 的工具。这里的风险不是回答错，而是工具选择偏移。

第三类是研究和浏览 agent。它们长期读取不可信网页和 PDF，并把阶段性结论保存成记忆。如果来源被漂白，后续研究任务可能反复引用被污染的中间结论。

第四类是个人助理。它们保存偏好、联系人、日程、健康、财务和身份相关信息。记忆投毒可能让系统误判用户授权、沟通风格或敏感信息处理方式。

第五类是多 agent 系统。一个 agent 的输出可能成为另一个 agent 的长期记忆。共享记忆池、团队空间和跨工具同步会放大污染半径。

## 失败模式

第一，实体漂白。攻击触发器被伪装成项目名、人名或策略名，经过抽取后看起来像正常实体。

第二，摘要漂白。原始恶意指令被摘要器改写，明显攻击痕迹消失，但核心偏置关系被保留。

第三，权威漂白。不可信网页或邮件内容被写成“用户偏好”“团队经验”或“最佳实践”。

第四，检索隐身。投毒记忆平时不常出现，只在特定任务、实体或敏感主题下被召回。

第五，工具漂移。agent 在允许的工具集合里逐渐偏向攻击者希望的工具，安全系统只看到“工具本身合法”。

第六，防御错位。团队部署了 prompt injection filter，却没有检查 memory extraction、memory rewrite 和 retrieval-to-action trace。

第七，删除不完整。用户删除可见 memory 后，摘要、embedding、图节点、checkpoint、工具经验表或 agent profile 中仍残留攻击关系。

第八，过度压缩。为了节省 token，系统只保留“结论”，丢掉来源、置信度、时间和反例，导致后续无法判断记忆是否可信。

## 可验证指标

Memory write taint rate：来自不可信输入的内容被写入长期记忆的比例，按来源和权威等级拆分。

Transformation provenance retention：经过抽取、摘要、结构化、embedding 和注入后，memory 仍保留原始来源、时间、作者和信任等级的比例。

Selective-memory bypass rate：攻击样本经过 memory extractor 后，触发器和载荷仍被共同保存的比例。

Retrieval activation rate：投毒记忆在目标任务中被召回并进入上下文的比例。

Memory-to-tool influence rate：工具调用计划中可追溯到长期记忆的比例，尤其是外发和写操作。

Tool-choice attack success rate：攻击者指定工具被选中的比例，同时记录是否越过 baseline、工具 allowlist 和参数校验。

Authority conflict accuracy：当前用户指令、组织策略、旧记忆和外部文档冲突时，agent 选择正确权威来源的比例。

Deletion propagation latency：删除或降权一条 memory 后，相关摘要、索引、图节点、缓存和工具经验多久失效。

Benign utility under taint controls：开启来源隔离、低权威记忆降权、工具确认和写入门控后，正常任务成功率下降多少。

Cross-session persistence horizon：投毒记忆经过多少轮正常会话后仍可触发，用来衡量清理、衰减和重写策略是否有效。

这些指标应该进入回归测试。只在上线前跑一次红队测试不够，因为 memory system 会持续积累新状态，风险会随数据源、工具和用户行为变化。

## 局限分析

这些材料仍以预印本研究为主。MemPoison 和 MemMorph 的报告指标依赖论文里的 agent scaffold、模型、memory modules、任务集和防御设置，不能直接外推到所有生产系统。本文采用它们的机制启发，而不是把攻击成功率当成普适常数。

MemMorph 声称攻击工具选择，但生产工具链通常还有权限、审计、人工确认、参数校验和 egress policy。一个完整系统的实际风险取决于这些层是否把 memory provenance 纳入决策。如果工具执行层足够强，记忆偏置可能只造成计划偏差，不一定造成真实副作用。

MemPoison 关注选择性记忆机制，但不同产品的 extractor、summarizer、embedding model 和存储结构差异很大。某些系统可能因为只允许用户显式确认写入而天然降低风险；另一些系统为了自动学习网页、邮件和工具结果，会暴露更大写入面。

另外，强防御有明显代价。限制不可信输入写入会降低自动学习能力；要求每次外发工具调用都解释 memory 依赖会增加延迟和用户打扰；保留完整 transformation audit 会增加存储和隐私负担。工程上更合理的是按数据敏感度和工具副作用分层，而不是全局禁用记忆。

最后，本文没有把社区讨论作为核心证据。近期社区材料能说明 memory poisoning 已经进入工程讨论，但真正可复核的技术事实仍来自论文、OWASP 原始材料和可审计系统文档。

## 自审

事实可靠性：MemPoison 的提交日期、研究问题、semantic relational bridge、entity masquerading、joint embedding optimization、最高 0.95 attack success rate 和机制分析来自 arXiv:2605.29960 页面。MemMorph 的提交日期、工具选择目标、3 个 benchmarks、10 个 agent backbones、3 种 memory-module implementations、3 条 injected records 和最高 85.9% attack success rate 来自 arXiv:2605.26154 页面。Sleeper Memory Poisoning、Trojan Hippo 和 OWASP ASI06 只作为背景来源。

来源完整性：核心使用两篇近期原始论文，辅以 Sleeper Memory Poisoning、Trojan Hippo 和 OWASP 原始安全材料，没有依赖二手社区帖作为事实基础。

原创性：本文主线是“选择性记忆管线和工具选择链路如何改变 memory poisoning 评测”，不是复述单篇论文摘要。

标题党检查：标题没有声称所有 agent 都已被攻破，只说明研究方向进入绕过选择性记忆和工具选择劫持阶段。

薄内容检查：正文包含来源说明、技术问题、机制拆解、工程判断、适用场景、失败模式、可验证指标、局限和自审。

猜测边界：工程指标和分层治理属于本文判断，已和论文报告事实区分。

站内重复：区别于 2026-05-10 的安全边界文章，本文不再泛谈长期记忆是攻击面，而是聚焦近期 MemPoison/MemMorph 暴露的选择性抽取、重写、检索和工具选择问题。
