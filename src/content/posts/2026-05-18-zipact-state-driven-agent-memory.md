---
title: "ZipAct：Agent 记忆不一定要回放历史，也可以维护状态"
description: "TMLR 2026-05-17 接收的 ZipAct 把 agent 的交互历史压缩成 Goal、World、Constraint 三类结构化状态，让动作生成只看当前状态表和最新观察。它提醒我们，长任务记忆的关键不只是存储更多历史，而是把可执行状态、负反馈和约束持续更新到一个可验证的工作记忆里。"
pubDate: 2026-05-18
category: "论文解读"
tags:
  - "AI memory"
  - "agent memory"
  - "context compression"
  - "memory-augmented agents"
  - "memory evaluation"
  - "RAG"
  - "forgetting"
draft: false
---

## 来源说明

本文基于 2026-05-18 的每日 AI 记忆系统研究发布流程写成。今天发现的最强新材料是 OpenReview 页面显示 2026-05-17 发布、2026-05-17 最后修改、已被 TMLR 接收的论文《ZipAct: Zipping Interaction History into a Compact State for Efficient LLM Agents》。OpenReview 页面列出作者为 Zhiming Pan、Junyu Luo、Zhiping Xiao、Kaize Ding、Xiao Luo、Ming Zhang，并给出复现代码仓库链接。

需要说明一个来源细节：OpenReview 条目已经显示 TMLR 接收和作者信息，但 PDF 首页仍保留匿名审稿模板文字。本文以 OpenReview 元数据判断论文状态，以 PDF 内容分析机制和实验，不把作者报告的结果描述成独立复现实验。

稳定 slug：`2026-05-18-zipact-state-driven-agent-memory`。

参考来源：

- OpenReview: [ZipAct: Zipping Interaction History into a Compact State for Efficient LLM Agents](https://openreview.net/forum?id=ZssIalqqrz)
- OpenReview PDF: [ZipAct PDF](https://openreview.net/pdf?id=ZssIalqqrz)
- GitHub: [Thomas-mci-21/ZipAct_TMLR](https://github.com/Thomas-mci-21/ZipAct_TMLR)

## 先给结论

ZipAct 值得写，不是因为它又发明了一个 memory store，而是因为它把 agent 长任务里的一个工程问题说得很直白：很多 agent 不是缺少长期记忆，而是每一步都把完整历史重新塞给模型，导致上下文越来越长、噪声越来越多、成本按轨迹长度平方级增长。

它的做法很克制。系统不让 Actor 反复读取全部 thought、action、observation 历史，而是维护一个结构化状态表：

- Goal State：全局目标、当前子目标、后续计划。
- World State：当前位置、库存、对象状态或环境事实。
- Constraint State：失败反馈、负约束、已访问位置，防止重复无效动作。

每一步执行后，State Updater 读取上一状态、上一动作和新观察，把变化写回状态表。下一步动作生成时，Actor 只看当前状态表和最新观察。这样，历史不再默认进入上下文，只有被提炼成状态的部分才会影响后续行为。

我的判断是：ZipAct 更像一种工作记忆管理机制，而不是完整长期记忆系统。它不解决跨会话用户偏好、组织知识、删除合规或记忆生命周期治理；它解决的是单个长任务内，agent 如何不被自己的执行历史淹没。这个边界很重要，因为工程上常把“长期记忆”“上下文压缩”“任务状态”和“RAG”混成一个词，最后系统既难评测也难维护。

## 技术问题：完整历史是最朴素也最昂贵的记忆

ReAct 及其大量变体的默认做法，是把过去的观察、推理和动作串起来，作为下一步决策上下文。这个设计容易实现，也方便调试，因为所有历史都在 prompt 里。但长任务会让它暴露两个问题。

第一是成本问题。假设平均每步产生固定长度的交互内容，第 `t` 步要读前面约 `t` 步历史，总 token 消耗会随步数呈二次增长。ZipAct 论文把这个称为 context snowball，并给出 ALFWorld 50 步任务的示意：ReAct 累积处理 token 明显高于线性方法。

第二是注意力污染。完整历史并不等于高质量记忆。长轨迹里会混入失败尝试、无关观察、重复搜索和已被证伪的假设。模型每一步都重读这些内容，可能忘记早期关键负反馈，或者在已经搜索过的位置重复尝试。论文用 ALFWorld 里的搜索失败案例说明：历史越长，越容易把“这个柜子没有目标物”这类负约束淹没掉。

这也是 ZipAct 与普通摘要压缩的区别。普通摘要问的是“如何把历史写短”；ZipAct 问的是“下一步行动真正需要哪些状态变量”。前者倾向把轨迹概括成文本，后者把轨迹编译成可更新的任务状态。

## 机制拆解：Actor 无记忆，Updater 负责记忆

ZipAct 的架构可以拆成两个角色。

Actor 是一个 memory-less decision engine。它不读取完整历史，只基于状态表和最新观察产生 thought 和 action。这个约束看似激进，但它迫使系统把“长期有用的信息”显式写进状态，而不是依赖模型在长 prompt 里自己找。

State Updater 是语义压缩器。每一步执行后，它接收旧状态、动作和环境返回，判断目标是否推进、世界事实是否改变、是否产生新的失败约束，然后输出结构化 JSON 更新。论文里的核心循环可以概括为：

1. 初始化状态，读入任务目标和环境初始观察。
2. Actor 基于状态表选择动作。
3. 环境执行动作并返回观察。
4. Updater 把观察编译为 Goal、World、Constraint 的增量更新。
5. 重复直到成功或达到步数上限。

这个分工对 agent memory 有一个实用启发：记忆读路径和写路径应该分离。读路径要短、稳定、面向决策；写路径可以更仔细地做抽取、合并、冲突处理和负反馈归档。如果把两者混在一个越来越长的聊天记录里，短期实现简单，长期会很难控制。

## 三类状态各自解决什么问题

Goal State 解决的是目标漂移。长任务里，模型容易被当前观察牵走，忘记原始目标或当前子目标。把 `global goal`、`current objective` 和计划队列显式放进状态，可以让每一步都回到“现在要推进什么”。

World State 解决的是环境 grounding。agent 需要知道自己在哪里、手里有什么、哪些对象被打开、哪个页面处于什么状态。ZipAct 的消融结果很有意思：只保留 Goal、去掉 World 和 Constraint 的版本，在三个 benchmark 上成功率为 0。这说明目标本身不是可执行记忆，环境状态才是行动的基础。

Constraint State 解决的是重复失败。负约束和访问记录把“哪里已经试过”“哪个动作无效”“什么条件不成立”保存下来。论文报告中，去掉 Constraint 后平均成功率明显低于完整 ZipAct。这符合工程直觉：很多 agent 失败不是因为不会想新方案，而是因为不会稳定记住已经失败的路。

这三类状态放在一起，比单纯 RAG 更接近任务执行状态机。RAG 常回答“当前问题相关的历史片段是什么”；ZipAct 的状态表回答“当前任务世界现在是什么样、下一步不能做什么、还要推进哪个目标”。

## 实验信号：省 token 不是唯一指标

论文在 ALFWorld、ScienceWorld、WebShop 三个文本环境上评测 ZipAct，并比较 ReAct、观察 masking、周期摘要和 Reflexion。使用的模型包括 GPT-4o-mini、GPT-4o、Qwen-2.5-7B-Instruct 和 Qwen-2.5-32B-Instruct。

作者报告的核心结果是：ZipAct 相比 ReAct 在不同模型上减少约 60.8% 到 67.6% token，同时平均成功率保持或提升。比如 GPT-4o-mini 下，ReAct 平均成功率为 38.6%、平均 token 为 158k；ZipAct 平均成功率为 44.0%、平均 token 为 62k。GPT-4o 下，ReAct 平均成功率为 59.3%、平均 token 为 163k；ZipAct 为 61.3%、53k。

但这里不能只看 token reduction。论文自己也提醒，低 token 不必然等于低端到端延迟，因为 ZipAct 每步还要进行状态更新，系统延迟取决于模型调用次数、provider overhead 和本地编排成本。工程评估时应该看“单位成功任务总成本”，而不是只看 prompt token。

另一个值得注意的结果是 Reflexion。它通常有更高成功率，但 token 成本也更高。这个结果说明 ZipAct 不是要取代所有反思机制，而是提供另一种成本位置：当场景要求较低延迟和较稳定成本时，结构化状态可能比追加更多反思文本更可控。

## 工程判断：这类记忆适合放在哪里

ZipAct 最适合长步数、强环境状态、动作空间明确、反馈可解析的 agent。

第一类是 web automation。购物、表单、后台系统操作、浏览器任务都需要记录当前页面、筛选条件、已点击项、失败选择和购买约束。这些信息天然适合放进 World 和 Constraint，而不是反复回放全部 DOM 观察历史。

第二类是 text-game 或模拟环境 agent。ALFWorld 和 ScienceWorld 这样的环境有明确动作、位置、对象和反馈。状态表能让 agent 像一个简单 planner 一样维护世界状态。

第三类是部分 coding agent 子任务。完整代码修复更需要依赖图、文件证据和测试反馈，ContextWeaver 那类方法更贴近它。但在某些窄任务里，ZipAct 的思想仍有用：把当前目标、已检查文件、失败命令、不可改接口和下一步计划维护成状态表，而不是把全部终端输出和思考历史塞回 prompt。

不太适合的场景也要说清楚。开放式研究、创意写作、用户画像、跨月偏好记忆和企业知识库问答，并不总有稳定动作空间和可结构化世界状态。强行套 G-W-C schema，可能会把复杂语义压成过窄字段，导致看似简洁但实际丢失证据。

## 和已有记忆路线的区别

与本站之前写过的经验压缩谱相比，ZipAct 不讨论 episode 如何长期晋升为 skill 或 rule。它只处理当次任务内，如何把执行轨迹压成可用状态。因此它更短周期、更贴近工作记忆。

与 ContextWeaver 相比，ZipAct 不显式构建历史依赖图。ContextWeaver 关心“当前动作依赖哪些早期证据”，适合证据链复杂的工具型任务；ZipAct 关心“当前世界状态是什么”，适合状态变量清晰的环境任务。一个偏证据链，一个偏状态机。

与普通 RAG memory 相比，ZipAct 的记忆单元不是文档 chunk，而是任务状态字段。检索不是 top-k 相似度，而是当前状态直接进入决策上下文。它牺牲了开放召回能力，换来更短、更稳定、更可检查的上下文。

## 失败模式

第一，状态更新错误。Updater 如果把一次偶然观察写成稳定事实，Actor 后续会基于错误世界状态行动。相比普通历史记录里的噪声，状态表里的错误更危险，因为它会以“当前真相”的形式出现。

第二，状态字段过窄。G-W-C schema 对文本环境很自然，但真实业务流程可能有权限、时间、版本、用户偏好、风险等级、外部依赖等状态。如果 schema 没有覆盖，系统会把关键约束丢在历史外面。

第三，负约束过度保守。Constraint State 记录失败可以防止重复搜索，但也可能把暂时失败误认为永久禁止。例如一次网络错误、权限暂未生效或页面延迟，不应该被永久写成“这个动作无效”。

第四，缺少来源追踪。论文主要强调状态压缩和成功率，但生产系统还需要知道每个状态字段来自哪次观察、哪个工具结果、何时更新、置信度如何。没有 provenance，开发者很难调试“为什么 agent 认为抽屉是空的”。

第五，跨会话记忆外推。ZipAct 的结果不能直接证明长期个人记忆有效。单任务状态压缩和跨会话长期记忆是两类问题。前者关注执行轨迹，后者还要处理作用域、遗忘、删除、偏好变化和冲突。

## 可验证指标

如果把 ZipAct 思想移植到生产 agent，我会优先看这些指标。

1. State accuracy：抽样检查 Goal、World、Constraint 字段是否与原始观察一致。
2. State provenance coverage：每个关键状态字段是否能回到具体观察、动作或工具结果。
3. Negative constraint precision：被写入 Constraint 的失败约束中，有多少确实应该阻止后续动作。
4. Repeated failure rate：在无新证据情况下，agent 是否重复访问同一无效位置、执行同一失败动作或提出同一被证伪假设。
5. Task-success-normalized cost：每个成功任务的模型调用次数、prompt token、completion token、状态更新时间和端到端延迟。
6. Schema escape rate：最终失败案例中，有多少是因为关键信息无法放入当前状态 schema。
7. Recovery after bad update：人为注入错误状态后，系统能否通过新观察纠正，而不是一直沿错误状态行动。

这些指标比“压缩率”更关键。压缩率高但状态错，agent 会更快地失败；状态短但不可追溯，系统会更难调试；负约束多但不精确，agent 会变得保守甚至卡死。

## 对 AI 记忆系统的启发

ZipAct 给 AI memory 的主要启发是：不是所有记忆都应该以历史片段存在。对长任务 agent 来说，更有价值的可能是一个持续维护的状态对象。

一个实用架构可以这样分层：

- raw trace 保留在日志里，用于审计和复盘，不默认进入 prompt。
- working state 放在短上下文里，承载当前目标、世界事实和约束。
- evidence store 保存状态字段的来源，便于调试和回滚。
- long-term memory 只接收经过验证、跨任务复用的事实、偏好或规则。

这样做能避免一个常见误区：把“长期记忆”当成无限聊天记录。真正可用的 agent memory 应该区分 trace、state、evidence 和 reusable memory。ZipAct 处理的是 state 层，它不能替代完整记忆系统，但它提醒我们，很多 agent 在谈 long-term memory 之前，应该先把当次任务的工作记忆做好。

## 自审

事实可靠性：核心事实来自 OpenReview 条目和论文 PDF。接收日期、作者、代码链接以 OpenReview 元数据为准；机制、实验和局限分析以 PDF 为准。作者报告结果未写成独立复现事实。

来源完整性：文章列出 OpenReview、PDF 和代码仓库入口。未使用二级摘要作为事实依据。

原创性：本文主线是“状态驱动工作记忆”，与本站 2026-05-01 的经验压缩谱、2026-05-03 的依赖结构化记忆、2026-05-14 的环境经验评测不同。

标题与内容：标题没有宣称 ZipAct 解决长期记忆，只说 agent 记忆可以维护状态，符合文章边界。

薄内容检查：文章包含技术问题、机制拆解、工程判断、适用场景、失败模式、可验证指标和局限分析，不只是复述摘要。

猜测边界：对生产适用性的判断均以“我的判断”“适合”“不适合”表达，没有把推断写成论文结论。

站内重复：仓库内未发现 ZipAct、context snowball 或状态表主题文章。相邻主题已有文章已在文中区分。
