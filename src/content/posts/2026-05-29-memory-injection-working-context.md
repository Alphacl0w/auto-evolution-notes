---
title: "记忆注入才是 Agent 长期记忆的真正瓶颈"
description: "从 SuperBrain、Claude Code hooks、claude-mem 和 Memory-R2 看，长期记忆系统的难点正在从存储迁移到工作上下文注入：什么时候取、取多少、凭什么取、如何阻止旧记忆污染当前任务。"
pubDate: 2026-05-29
category: "工程解读"
tags:
  - "AI memory"
  - "agent memory"
  - "long-term memory"
  - "memory-augmented agents"
  - "context compression"
  - "memory evaluation"
  - "personalization"
  - "RAG"
draft: false
---

## 来源说明

本文基于 2026-05-29 的每日 AI 记忆系统研究发布流程写成。今天最值得处理的新材料不是一个新的 benchmark，而是一篇工程文章：Alexandre Khoury 发布的 `Claude Code Memory: Storage Is Solved, Injection Isn't`。文章以 SuperBrain 作为案例，指出 Claude Code 的长期记忆瓶颈不在于把观察写到 Markdown、SQLite 或向量库，而在于怎样把相关记忆自动注入到新的工作会话里。

这个材料值得写，是因为它补上了过去几周文章中还没有单独展开的一层：长期记忆的生产效果，常常不是由 memory store 决定，而是由 injection surface 决定。Agent 可以保存很多观察、偏好、项目经验和失败记录，但如果这些内容没有在 `SessionStart`、`UserPromptSubmit`、压缩前后、工具执行后等关键时刻以合适粒度进入上下文，它们就只是冷数据。反过来，注入过多、过旧或作用域错误的记忆，会制造新的干扰和过度个性化。

为避免只复述一篇博客，本文同时使用五类来源：Anthropic Claude Code 官方 memory 与 hooks 文档，用来确认 Claude Code 里可用的记忆文件、hook 事件、stdout 上下文注入和额外上下文长度处理；SuperBrain 文章与仓库说明，用来分析 session memory、observation distillation 和项目作用域注入；`claude-mem` README 与作者文章，用来对照另一个 hook-driven、SQLite/Chroma 支持的外部长期记忆实现；Memory-R2 论文，用来解释为什么 memory operation 的训练和评估需要 credit assignment，而不是只奖励最终轨迹；社区讨论只作为采用信号，不作为技术事实的核心来源。

稳定 slug：`2026-05-29-memory-injection-working-context`。

参考来源：

- Engineering article: [Claude Code Memory: Storage Is Solved, Injection Isn't](https://alexandrekhoury.com/writing/superbrain-session-memory-claude-code)
- GitHub: [m3talux/superbrain](https://github.com/m3talux/superbrain)
- Anthropic Docs: [Manage Claude's memory](https://docs.anthropic.com/en/docs/claude-code/memory)
- Anthropic Docs: [Hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks)
- GitHub: [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- Engineering article: [Claude-mem: Long-term memory for Claude Code](https://jonathanschilling.github.io/posts/claude-mem/)
- arXiv: [Memory-R2: Enhancing Large Language Model Agents with Episodic Memory](https://arxiv.org/abs/2605.14629)
- Community discussion: [Reddit discussion on SuperBrain session memory](https://www.reddit.com/r/ClaudeCode/comments/1l2r9u9/i_built_superbrain_a_semantic_memory_engine_for/)

## 先给结论

Agent 长期记忆的工程重心正在从“把记忆存在哪里”转到“怎样把记忆带回工作上下文”。这不是措辞差异，而是系统边界的变化。

存储层回答的是：历史观察、项目经验、用户偏好、失败路径、工具结果和总结应该保存成 Markdown、SQLite、向量索引、图谱还是数据库记录。注入层回答的是另一个更难的问题：在一次新的任务开始时，系统应该取哪些记忆、放到哪里、占多少 token、保留什么证据、怎样避免陈旧内容覆盖当前文件事实。

SuperBrain 文章的判断很直接：很多工具已经能存，难的是让 Agent 在不用人工提醒的情况下自然使用这些记忆。文章描述的 SuperBrain 用 Claude Code hooks 监听会话事件，把对话和工具使用蒸馏成 observation，再在新会话或新提示进入时注入相关项目记忆。作者报告本地实例中已从 13 个项目沉淀 8,785 条观察，并强调问题不在于 SQLite 或向量库是否存在，而在于上下文注入是否及时、相关、可控。

这个方向和前几天的长期记忆评估文章互补。STATE-Bench、PARE-M 和 GEM 把评估单位从单条记忆推向状态轨迹与环境；今天这篇文章更偏工作台层：如果 memory 不能在正确事件点进入 Agent 的 working context，后面再好的评估指标也只能看到“系统没有用上它知道的东西”。

我的判断是，未来一段时间 coding agent、research agent 和个人助理的记忆差异，不会主要体现在谁的向量库更复杂，而会体现在谁有更好的注入策略：分层作用域、触发时机、预算控制、冲突处理、来源标注和失败回滚。

## 技术问题：保存记忆不等于拥有记忆

很多长期记忆系统的第一版都停在“保存”上。它们可以把用户偏好写入 `CLAUDE.md`，把项目经验写入 Markdown，把片段放进 SQLite 或 Chroma，把 embedding 加进向量索引。演示时也很顺：问一句“你还记得我喜欢什么风格吗”，系统能答出来。

真实任务里，问题不这么出现。用户不会每次都问“请检索记忆”。他们只会说：“继续改昨天那个页面”“按上次的方式发版”“这个仓库还是用旧流程”“别再犯上次的错误”。这时 Agent 需要在任务开始之前，自动知道哪些旧信息会影响当前动作。

这就是注入层的价值。它不只是 retrieval，而是把检索结果转成当前回合可操作上下文的过程。一个可用的注入层至少要回答六个问题。

第一，何时触发。会话开始、用户提交提示、工具调用后、上下文压缩前、压缩后、停止前，适合注入的内容不同。会话开始适合放项目概况和近期工作；用户提示提交时适合根据当前需求补充相关观察；工具调用后适合写入新的证据；压缩前适合保存将被移出上下文的关键状态。

第二，取什么。不能只按向量相似度取最像的片段。对于 coding agent，当前 `git diff`、文件路径、测试命令、包管理器、部署流程和最近失败，比一般语义相似更重要。对于个人助理，用户作用域、项目作用域和任务作用域也必须分开。

第三，放哪里。注入到 system prompt、user prompt、hook stdout、项目文件、MCP 工具返回还是短期 scratchpad，权威性完全不同。一个不可信网页观察不应该和用户长期偏好拥有同等地位。

第四，占多少预算。长期记忆越多，越容易把上下文预算吃掉。注入层必须做 compression、deduplication 和 priority ranking。否则“记得更多”会退化成“把当前任务淹没在旧背景里”。

第五，怎样标注来源。Agent 必须知道一条记忆来自用户明确要求、工具观察、模型总结、文件事实还是历史推断。没有 provenance，冲突时就无法决定谁覆盖谁。

第六，怎样撤销。旧记忆可能过期，用户偏好可能改变，项目流程可能迁移。注入层需要作废、降权和版本化，而不是把旧规则一直带进新会话。

因此，长期记忆的关键问题不是 store capacity，而是 working-context governance。

## SuperBrain 的机制启发

SuperBrain 的文章给出一个清晰的工程分层。底层是 session memory：通过 Claude Code hooks 捕捉会话和工具事件，把原始交互蒸馏为观察。中间层是持久化：文章和仓库都强调记忆以 Markdown 为主，SQLite `index.db` 更像派生索引而不是唯一事实源。上层是注入：在新的 Claude Code 会话中，按项目作用域把相关记忆作为上下文提供给 Agent。

这个设计有三点值得借鉴。

第一，hook 比手动 recall 更接近真实工作流。长期记忆如果依赖用户显式命令，就会在紧急任务里被忘掉。`SessionStart` 这类事件适合注入稳定项目背景，`UserPromptSubmit` 适合根据当前请求追加相关片段，`PreCompact` 适合在上下文被压缩前保留关键状态。这类事件边界让 memory 从“可查询数据库”变成“工作流的一部分”。

第二，Markdown 作为 source of truth 降低了审计成本。向量库适合找相似，SQLite 适合索引和过滤，但长期记忆最怕不可见状态。项目级 Markdown 让人可以直接查看、编辑和删除记忆。对于 coding agent，这一点比追求复杂 memory graph 更实际，因为项目规则和失败记录必须能被开发者审计。

第三，observation distillation 把原始对话变成更小的可注入单位。直接注入完整聊天历史会浪费预算，也会把模型的过程噪声带回来。把会话转换为短 observation，可以把“发生过什么”和“以后要用什么”分开。不过这一步也是风险最大的写路径：蒸馏器可能漏掉条件、误写结论，或者把一次性事实泛化成长期规则。

所以 SuperBrain 的启发不是“Markdown 记忆解决长期记忆”，而是：Agent memory 的有效单位应该贴近注入事件和工作作用域，而不是只贴近存储结构。

## Anthropic hooks 给了什么边界

Anthropic 官方 hooks 文档让这件事更具体。Claude Code hooks 可以在多个生命周期事件上运行命令，包括 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`Stop`、`SubagentStop`、`Notification`、`PreCompact` 等。文档还说明，某些事件的 stdout 可以被加入上下文。例如 `UserPromptSubmit` 的 stdout 会作为上下文加入，`SessionStart` 的 stdout 会被添加到上下文，`UserPromptExpansion` 则用于提示扩展场景。

这意味着长期记忆系统不必只通过主对话提示注入。它可以在会话恢复时提供项目摘要，在用户新提示进入时补充相关记忆，在压缩前保存即将丢失的状态，在工具调用后记录真实文件和命令结果。

但这也扩大了风险面。hook 输出进入上下文后，Agent 可能把它当成高权威信息使用。如果外部记忆里混入网页内容、旧工具输出或模型猜测，就可能越过原本的信任边界。Anthropic 文档还对额外上下文做了长度处理说明：当 `additionalContext` 很长时，系统会写入临时文件并只显示短预览。这提醒我们，注入层必须考虑 token 预算和可见性，而不是假设“多给上下文总是更好”。

官方 memory 文档则给出另一个基线：Claude Code 会从不同作用域的 memory 文件加载指令，例如企业策略、项目 `CLAUDE.md`、用户 memory 和本地项目 memory；在子目录中工作时，也可能按需拉取额外 `CLAUDE.md`。这套机制适合稳定规则，但不等同于动态长期记忆。稳定规则应该少而明确，动态 observation 应该有时间、来源和作用域，否则会把项目说明文件变成一锅历史残渣。

工程上更稳妥的分层是：`CLAUDE.md` 保存长期稳定约束；session memory 保存近期经验和失败；向量或全文索引用来查候选；hook 注入负责把候选压缩成当前任务可用上下文。

## claude-mem 的对照价值

`claude-mem` 是另一个值得对照的实现。它同样把 Claude Code hooks 当成入口，README 描述了五个生命周期 hook：`session_start` 初始化上下文并启动本地工作进程，`user_prompt_submit` 注入相关记忆，`post_tool_use` 跟踪工具执行，`stop` 处理对话片段并用后台 worker 存储记忆，`pre_compact` 在压缩前保存状态。它还提供 MCP 工具，让 Claude 可以保存、搜索、更新和检查记忆，并支持 SQLite 作为默认存储、Chroma 作为可选向量后端。

作者文章把局限写得比较清楚：系统可以把会话知识、项目经验和个人偏好带回后续工作，但仍有性能、存储管理、隐私和跨团队共享问题。这个表述比“无限记忆”更可信。对本文来说，claude-mem 的价值在于证明 hook-driven memory 不是 SuperBrain 的孤例，而是 coding agent 生态正在形成的一种模式。

两者也暴露了同一个核心问题：后台记忆越自动，越需要可观测性。系统不能只告诉用户“我记住了”。它应该能显示本轮注入了哪些记忆、为什么选中、来自哪次会话、是否被用户确认、是否与当前文件事实冲突。

没有这些可观测性，自动记忆会让 Agent 看起来更聪明，但也更难 debug。

## Memory-R2 补上的评估问题

Memory-R2 论文不是今天发布的工程文章，但它补上了注入层背后的评估难题。论文关注 episodic memory 如何增强 LLM agents，并指出一个常见训练问题：memory operations 会改变环境状态，后续 reward 往往混杂了记忆选择、工具行动和模型推理，很难判断某次记忆操作本身是否正确。

它提出的核心思路是 local-global memory operation rerollouts。简单说，不只看完整轨迹最后成功与否，而是在同一个中间状态下比较不同 memory operation 的后果，给记忆操作更清晰的 credit assignment。论文还用课程设置逐步增加历史 session 数量，例如 8、16、32 sessions，测试更长历史下的表现。

这对工程注入层很重要。生产系统不能只看“有记忆版本的平均任务成功率高不高”。它还要评估每次注入是否真的帮了忙。

举例说，Agent 完成了一个发版任务。它可能是因为注入了正确的部署流程成功，也可能是因为当前 README 里已经写得很清楚，记忆只是多余背景。相反，Agent 失败时，也可能不是记忆错了，而是工具权限失败。没有 memory operation 级别的归因，就很难改进注入策略。

因此，一个成熟的长期记忆系统应该把“注入事件”当成可评估对象：候选集合、排序分数、最终注入文本、token 占用、来源、后续动作、结果和人工纠正都要记录。否则，memory evaluation 仍然停留在黑盒 A/B 测试。

## 适用场景

第一类是 coding agent。它们需要记住项目构建命令、测试习惯、部署流程、目录结构、历史失败、review 偏好和安全边界。最有效的注入点通常是 session start 和 user prompt submit：前者提供项目稳定背景，后者按当前文件和任务拉取相关经验。

第二类是研究 Agent。它们需要在多日研究里保持问题定义、候选来源、排除理由、事实置信度和未验证假设。注入层应该更强调 provenance 和 uncertainty，把“已证实事实”“候选线索”“作者推断”分开。

第三类是个人助理。它们需要记住偏好、日程、沟通风格和长期目标，但这类记忆最容易过度个性化。注入层必须严格区分用户全局偏好、项目偏好和一次性临时要求。

第四类是企业流程 Agent。它们需要把客户、订单、工单、权限和合规规则带入任务，但不能让检索内容越权影响行动。这里的注入层要结合访问控制和审计日志，不只是语义检索。

## 失败模式

第一，旧记忆压过当前事实。项目已经从 npm 迁移到 pnpm，但旧观察仍被注入，Agent 继续运行错误命令。

第二，作用域泄漏。某个项目的部署规则被注入到另一个项目，或者个人偏好被带入团队共享任务。

第三，摘要写错。蒸馏器把“这次临时跳过测试”写成“这个仓库发版不需要测试”，后续每次注入都强化错误流程。

第四，检索相似但不相关。当前任务提到 “memory”，系统召回了所有 memory 文章经验，却没有召回真正需要的部署或构建约束。

第五，注入内容不可见。Agent 行为被隐藏记忆影响，用户无法知道它为什么做出某个判断，也无法纠正源头。

第六，预算污染。注入层把太多背景塞进上下文，挤掉当前文件、工具结果和用户最新要求。

第七，安全边界混合。网页内容、工具输出、历史总结和用户指令被放在同一权威层，导致 prompt injection 或权限误用。

## 可验证指标

第一，memory injection hit rate。被注入的记忆中，后续实际被引用、执行或影响计划的比例。只被塞进上下文但没有产生作用，不应算成功。

第二，injection precision。人工或自动审计注入片段是否与当前任务相关，是否作用域正确，是否仍然有效。

第三，stale-memory harm rate。失败任务中由陈旧、冲突或错误记忆造成的比例。

第四，token value per injected memory。每条注入记忆带来的工具调用减少、澄清减少、错误减少或完成率提升，除以它占用的 token。

第五，source trace coverage。重要回答或行动能追溯到哪些记忆、文件、工具输出和用户确认。

第六，correction-to-retirement latency。一条错误记忆被用户纠正后，多久从默认注入路径中移除或降权。

第七，cross-scope leakage rate。项目、用户、团队、组织作用域之间错误注入的频率。

第八，same-task repeated-run reliability。同一任务在相同环境下多次运行时，有记忆注入版本是否比无记忆版本更稳定，而不只是偶尔更快。

这些指标比单纯 recall@k 更接近真实风险。长期记忆不是能不能找回旧片段，而是旧片段进入工作上下文后有没有产生净收益。

## 局限分析

第一，SuperBrain 和 claude-mem 都是工程项目和作者报告，不是独立复现实验。本文只把它们作为机制案例，不把 8,785 条观察、项目数量或功能描述写成普遍效果。

第二，Claude Code hooks 是特定产品的扩展面。它对 coding agent 很有代表性，但不能直接等同于所有 agent runtime。其他系统可能通过 middleware、MCP、server-side retrieval 或 workflow engine 实现类似注入。

第三，Markdown source of truth 适合可审计个人或项目记忆，但在企业多租户、高权限、高并发场景里可能不够，需要数据库事务、访问控制、加密、审计和删除策略。

第四，Memory-R2 的 rerollout 思路提供了评估记忆操作的研究方向，但把它完整迁移到生产系统仍有成本。真实业务环境里，很难为每次注入重放多个替代轨迹。

第五，自动注入可能提高短期体验，也可能降低用户对系统状态的理解。记忆越隐形，越需要 UI 或日志把“本轮使用了哪些记忆”暴露出来。

## 工程判断

如果我要审查一个 Agent memory 系统，现在会先问它的注入层，而不是先问它的数据库。

它是否有明确的 lifecycle 事件？是否区分会话开始、提示提交、工具执行后和压缩前？是否能解释本轮注入了什么？是否有 token 预算？是否能显示来源？是否能在用户纠正后废弃旧记忆？是否把项目规则、用户偏好、网页内容和模型总结放在不同权威层？

这些问题比“用了哪个向量数据库”更决定长期表现。

长期记忆的真正形态，可能不是一个越来越大的仓库，而是一套越来越克制的工作上下文装配系统。它保存很多东西，但每次只带回当前任务需要、来源清楚、作用域正确、仍然有效的一小部分。

这也是今天材料最有价值的提醒：存储解决的是历史能不能留下；注入解决的是历史能不能在正确时间变成行动依据。

## 自审

事实可靠性：SuperBrain 的发布时间、核心判断、hook-driven session memory、Markdown source of truth、SQLite 索引、项目作用域注入和作者报告的观察数量来自 Alexandre Khoury 的文章与 `m3talux/superbrain` 仓库说明。Claude Code memory 文件作用域、`CLAUDE.md` 机制和 memory 管理来自 Anthropic 官方 memory 文档。hook 事件、stdout 上下文注入和额外上下文长度处理来自 Anthropic 官方 hooks 文档。claude-mem 的 hook 列表、SQLite/Chroma、MCP 工具和作者披露的局限来自 README 与作者文章。Memory-R2 的 local-global rerollouts、credit assignment 和多 session 课程设置来自 arXiv 页面。

来源完整性：文章使用工程原文、官方文档、开源仓库和论文作为核心来源；Reddit 只作为社区讨论线索，没有把社区评论当作事实依据。

原创性：本文主线是 memory injection / working context assembly，区别于 2026-05-01 的经验压缩谱、2026-05-13 的 runtime reliability、2026-05-21 的 consolidation write path 和 2026-05-28 的 environment-level evaluation。

标题与内容：标题没有宣称 SuperBrain 或 claude-mem 已解决长期记忆，只指出注入层是瓶颈，符合材料边界。

薄内容检查：文章包含来源说明、技术问题、机制拆解、工程判断、适用场景、失败模式、可验证指标、局限分析和自审，不是博客或 README 摘要改写。

猜测边界：对 injection metrics、working-context governance 和工程分层的建议属于作者工程推断，文中没有写成来源已经证明的事实。

站内重复：仓库内已有文章讨论记忆作用域、运行时可靠性、环境评估、压缩和写路径风险，但没有以 Claude Code hooks、自动注入和 working context assembly 为主线的文章。
