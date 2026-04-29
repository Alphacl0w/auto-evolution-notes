---
title: "Hermes Agent 的记忆系统研究：为什么它不像 OpenClaw 那样把 Markdown 当核心事实源"
description: "从 NousResearch/hermes-agent 的官方文档和源码看，Hermes 的记忆系统由小容量常驻记忆、SQLite/FTS5 会话检索、外部记忆提供商和技能系统组成；它和 OpenClaw 的差异不在口号，而在事实源、召回路径、晋升机制和治理边界。"
pubDate: 2026-04-29
category: "开源项目分析"
tags:
  - "Hermes Agent"
  - "OpenClaw"
  - "AI memory"
  - "long-term memory"
  - "agent memory"
  - "context compression"
  - "memory evaluation"
draft: false
---

## 来源说明

本文基于 2026-04-29 可复核材料写成，重点阅读了 NousResearch 的 Hermes Agent 官方文档、`NousResearch/hermes-agent` 仓库源码，以及 OpenClaw 官方文档和 `openclaw/openclaw` 仓库源码。为了避免把第三方对比站的营销话术当事实，本文不引用“谁替代谁”的 SEO 页面，只使用官方文档、仓库 README 和源码路径作为主要证据。

稳定 slug：`2026-04-29-hermes-memory-system-openclaw-comparison`。

参考来源：

- NousResearch/hermes-agent: [GitHub repository](https://github.com/NousResearch/hermes-agent)
- Hermes Agent Docs: [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- Hermes Agent Docs: [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- Hermes Agent Docs: [Prompt Assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- Hermes Agent Docs: [Context Compression and Caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- Hermes Agent Docs: [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)
- OpenClaw Docs: [Memory overview](https://docs.openclaw.ai/concepts/memory)
- OpenClaw Docs: [Builtin memory engine](https://docs.openclaw.ai/concepts/memory-builtin)
- OpenClaw Docs: [Dreaming](https://docs.openclaw.ai/concepts/dreaming)
- OpenClaw Docs: [Memory CLI](https://docs.openclaw.ai/cli/memory)
- 源码检查：`NousResearch/hermes-agent` commit `20b759c`，重点文件 `tools/memory_tool.py`、`agent/memory_manager.py`、`agent/memory_provider.py`、`hermes_state.py`、`run_agent.py`、`plugins/memory/*`。
- 源码检查：`openclaw/openclaw` commit `4f540c70`，重点文件 `docs/concepts/memory.md`、`docs/concepts/memory-builtin.md`、`docs/concepts/dreaming.md`、`src/agents/memory-search.ts`、`extensions/memory-core/src/short-term-promotion.ts`。

## 先给结论

Hermes Agent 的记忆系统不是一个单纯的向量库，也不是把所有历史消息塞进 prompt 的“大上下文主义”。它更像四个记忆面叠在一起：

- 小容量、强约束、每个 session 开始时注入 prompt 的 `MEMORY.md` / `USER.md`。
- SQLite `state.db` 保存完整 session 历史，用 FTS5 和 trigram FTS 做跨会话文本检索。
- 可插拔的外部 memory provider，例如 Honcho、Mem0、Hindsight、Holographic、ByteRover、Supermemory 等。
- 技能系统作为 procedural memory，负责保存“怎么做”，而不是保存“事实是什么”。

OpenClaw 的记忆路线不同。它把 plain Markdown 作为核心事实源：`MEMORY.md` 是长期记忆，`memory/YYYY-MM-DD.md` 是短期/日记层，`DREAMS.md` 是 review 面。SQLite、embedding、QMD、LanceDB、Honcho、memory-wiki 都更像围绕 Markdown 事实源建立的索引、晋升和治理层。

所以这两套系统的关键差异不是“谁记得更多”，而是：Hermes 更偏运行时 prompt 稳定性、会话连续性和 provider 扩展；OpenClaw 更偏可审计事实源、自动晋升和人类治理界面。一个像轻量内核加外部记忆总线，另一个像 Markdown 原账本加索引和整理器。

## Hermes 的内置记忆：小而硬，不追求无限容量

Hermes 官方文档把 persistent memory 定义为 bounded curated memory。源码里的 `tools/memory_tool.py` 也能看到这个设计取向：内置记忆只有两个文件，默认位于 `~/.hermes/memories/`：

- `MEMORY.md`：agent 自己的工作笔记，包括环境事实、项目约定、工具坑点和稳定经验。
- `USER.md`：用户画像，包括偏好、沟通风格、身份信息和工作习惯。

默认容量非常小：`MEMORY.md` 约 2,200 字符，`USER.md` 约 1,375 字符。这个限制很有意思。许多 memory 产品会把“能存很多”当卖点，Hermes 反而把常驻记忆压成一个高密度 cache。它的逻辑是：真正应该每次都出现在系统提示词里的事实，数量本来就不该多。

这套设计有三个专业上的好处。

第一，成本稳定。内置记忆在 session 开始时作为 frozen snapshot 注入系统 prompt，中途写入会落盘，但不会改变当前 session 的 prompt 前缀。这避免了每次写 memory 都破坏 prompt cache，也让模型在同一轮长任务里的身份、记忆和工具指导保持稳定。

第二，写入动作可控。`memory` 工具只有 `add`、`replace`、`remove` 三类操作，更新和删除依赖短唯一 substring 匹配。这个方案不华丽，但适合小容量 curated memory：条目少，人工可读，冲突能被直接替换。

第三，安全边界明确。Hermes 在接受 memory entry 前会扫描 prompt injection、凭证外传、SSH 后门路径、不可见 Unicode 等模式。因为这些条目会进入 system prompt，任何“把恶意指令写进长期记忆”的行为都比普通聊天污染更危险。源码里这层扫描不等于完整安全方案，但它说明 Hermes 把 memory 当 prompt 供应链的一部分，而不是普通文本存储。

代价也很清楚：Hermes 的内置 memory 不适合保存大量项目日志、会议纪要或知识库条目。它更像 L1 cache：只放未来几乎一定会再次用到的事实。大规模回忆要走 session search 或外部 provider。

## 会话检索：Hermes 把“历史”放进 SQLite，而不是常驻 prompt

Hermes 的第二层记忆是 session storage。官方文档和源码都显示，Hermes 使用 `~/.hermes/state.db` 保存 session 元数据、完整消息历史和模型配置。`hermes_state.py` 使用 SQLite WAL 模式，包含 `sessions`、`messages`、`messages_fts` 等结构，并通过 FTS5 做全文检索。

当前源码比文档更进一步：`SCHEMA_VERSION = 11`，并且增加了 trigram FTS5 表来处理 CJK 和 substring 查询。这个细节很值得注意。中文、日文、泰文这类文本如果直接使用默认 tokenizer，很容易出现“单字 token 匹配很多但短语不准”的问题。Hermes 专门加 trigram FTS，说明它不是只服务英文命令行日志，而是开始处理真实多语言会话检索。

Hermes 对 session history 的态度是：不要把所有历史压进常驻 memory，而是在需要时搜索。官方文档也区分了 persistent memory 和 session search：前者是少量关键事实，固定 token 成本；后者是无限历史，按需检索并可能调用 LLM 总结。

这对 agent 运行很重要。很多长期记忆系统失败，是因为它们混淆了三件事：

- 用户偏好应该常驻。
- 历史对话应该可检索。
- 任务过程应该可追踪，但不应永久占据 prompt。

Hermes 至少在架构上把这三者拆开了。`MEMORY.md` / `USER.md` 不是历史库，`state.db` 不是每轮都注入的用户画像，session search 也不是长期事实的唯一来源。这个分层是它比很多“外挂一个 vector store”的 agent harness 成熟的地方。

## 外部 provider：Hermes 的记忆扩展是 additive，而不是替换内核

Hermes 的第三层是 memory provider。官方文档列出 8 类外部 provider，包括 Honcho、OpenViking、Mem0、Hindsight、Holographic、RetainDB、ByteRover 和 Supermemory。源码中的 `agent/memory_provider.py` 抽象了 provider 生命周期：初始化、system prompt block、turn 前 prefetch、turn 后 sync、session end extraction、pre-compress hook、tool schema 暴露、tool call 处理等。

这里有两个关键设计。

第一，外部 provider 是 additive。内置 `MEMORY.md` / `USER.md` 不会被 provider 替代。哪怕启用 Honcho 或 Mem0，Hermes 仍保留小容量常驻记忆。这是合理的：外部 provider 适合深召回、自动抽取、知识图谱或用户建模；内置 memory 负责最小可信上下文。

第二，同一时间只允许一个外部 provider。`MemoryManager` 明确限制 only one external provider，避免 tool schema 膨胀和多个后端互相争抢事实解释权。这一点很工程化。多 memory backend 并联听起来强，但如果每个后端都能写、检索、总结、遗忘，agent 很快会面对来源冲突、重复证据和不一致 recall。

以 Holographic provider 为例，它在源码里提供结构化 fact store、entity resolution、trust scoring、FTS5 + Jaccard + HRR 的组合检索，并支持 `contradict`、`feedback` 等工具。它不像内置 memory 那样小而静态，而是更接近“深层事实库”。Hermes 把这类能力放到 provider 层，而不是塞进核心 memory tool，说明它的内核策略是保守的：核心小，扩展深。

## 技能系统：Hermes 把 procedural memory 从事实记忆里拆出来

Hermes README 把 closed learning loop 作为卖点：agent 可以从经验中创建技能，技能在使用中改进，过去会话可以搜索，用户模型可以逐步加深。这里容易被误读成“它会自动变聪明”。更准确地说，Hermes 试图把记忆分成 declarative memory 和 procedural memory。

`MEMORY.md` / `USER.md` 保存事实：用户是谁、机器环境是什么、项目约定是什么。Skills 保存过程：遇到某类任务应该按什么步骤做、哪些命令可靠、哪些检查必须跑。这个区分很关键。把过程塞进普通 memory，最后会得到一堆难以执行的经验句子；把事实塞进技能，又会让技能变成带状态的脚本，迁移和复用都会变差。

和 OpenClaw 对比，Hermes 的技能系统更像 agent 自我改进闭环的一部分；OpenClaw 的记忆系统则更强调日记、晋升、wiki 和人工 review。前者问的是“下次遇到类似任务我该怎么做得更好”，后者问的是“哪些短期观察有资格成为长期事实”。

## 与 OpenClaw 的核心对比

### 1. 事实源：Hermes 是小容量 prompt memory，OpenClaw 是 Markdown 账本

OpenClaw 官方文档说得很直白：模型只记得保存到磁盘的东西，没有隐藏状态。它的事实源是 workspace 里的 Markdown 文件：`MEMORY.md`、`memory/YYYY-MM-DD.md`、`DREAMS.md`。这让 OpenClaw 的 memory 更像个人知识库或运维日志：可以 grep，可以手工改，可以进 Git，可以被 memory-wiki 编译成 claims、evidence 和 dashboard。

Hermes 也使用 Markdown 文件，但它的内置 memory 容量很小，并且不承担完整历史或知识库职责。Hermes 的“历史”主要在 SQLite session DB，“深层建模”交给 provider，“怎么做”交给 skills。它不是 Markdown-first，而是 prompt-cache-first + provider-bus。

我的判断：如果你最重视可审计、可迁移、可人工维护的事实源，OpenClaw 的路线更清晰。如果你最重视 agent runtime 的轻量内核、跨平台 session 连续性和外部 memory provider 扩展，Hermes 的路线更干净。

### 2. 召回路径：Hermes 分 L1/L2/provider，OpenClaw 走 hybrid search + active memory

Hermes 的召回路径大致是：

- L1：`MEMORY.md` / `USER.md` frozen snapshot，session 启动即进入 prompt。
- L2：`session_search` 从 SQLite/FTS5 历史中查找过去对话。
- L3：外部 provider prefetch 或工具调用，例如 Honcho、Mem0、Holographic 等。

OpenClaw 的召回路径则围绕 active memory plugin 展开。默认 `memory-core` 会把 `MEMORY.md` 和 `memory/*.md` 切块，写入每 agent 的 SQLite 索引；配置 embedding provider 后使用 hybrid search，组合向量相似度和关键词匹配。它还支持 QMD sidecar、LanceDB、Honcho、memory-wiki 等旁路。

差异在于：Hermes 的内置 recall 更“窄”，OpenClaw 的内置 recall 更“宽”。Hermes 默认先保证小上下文稳定，再按需搜索；OpenClaw 默认就把 Markdown 记忆文件纳入检索管线，并提供更多可调参数，例如 chunk size、overlap、vector/text 权重、MMR、temporal decay、watch debounce。

### 3. 晋升机制：Hermes 依赖 agent curated memory，OpenClaw 有 dreaming gate

Hermes 的内置 memory 工具要求 agent 主动保存稳定事实，并且官方指导会周期性提醒 agent 维护 memory。这个模型简单，但质量依赖 agent 判断：它要知道什么该存、什么该删、什么时候该合并。

OpenClaw 的 dreaming 更像一个显式晋升系统。短期材料先进入 `memory/YYYY-MM-DD.md` 或 `memory/.dreams/`，再通过 light、REM、deep 三阶段处理。deep phase 使用频率、相关性、查询多样性、时间新鲜度、跨日 consolidation、概念丰富度等信号打分；只有通过阈值的候选才写入 `MEMORY.md`。这比“agent 觉得该记就记”更接近 memory evaluation pipeline。

当然，OpenClaw 的 dreaming 也不等于真理机器。它依赖短期候选质量、召回记录、阈值和模型反思质量。优势是过程可审查，输出有 `DREAMS.md` 和 CLI explain；风险是复杂度更高，也更容易让用户误以为打分高就代表事实正确。

### 4. 遗忘与冲突：Hermes 简单替换，OpenClaw 偏治理

Hermes 内置 memory 的遗忘机制非常直接：`remove` 删除条目，`replace` 更新条目。它适合少量高价值事实。如果启用 Holographic 这类 provider，还能通过 trust scoring、contradict、feedback 处理深层事实冲突。

OpenClaw 的遗忘更分层：你可以直接改 Markdown 源，重建索引；dreaming promotion 会重读 live daily files，避免从已经删除或编辑过的旧 snippet 晋升；memory-wiki 可以做 contradiction 和 freshness tracking。它更适合长期维护，但也要求用户接受“记忆系统是一套治理流程”，不是单个工具函数。

## 工程判断：Hermes 更像 agent runtime 的记忆内核，OpenClaw 更像个人 AI 操作系统的记忆账本

Hermes 的优势在于内核清晰。常驻 memory 小，session history 可搜，provider 插拔，prompt assembly 明确区分 cached system prompt 和 API-call-time additions。它适合开发者把 agent 跑在 VPS、服务器、CLI、消息网关或自动化流程里：agent 不必每次都重新认识用户，也不会把整座历史仓库拖进 prompt。

OpenClaw 的优势在于记忆治理。它承认长期记忆不是一次写入就完事，而是需要短期记录、召回反馈、晋升阈值、人工 review、wiki 编译和索引重建。它更适合个人助手、多渠道入口、长期日常使用、知识沉淀和需要人类审查的场景。

如果用数据库比喻，Hermes 内置 memory 是小而稳定的 config table，session DB 是 append-only event log，provider 是可选的外部 OLAP/graph/search 系统。OpenClaw 则把 Markdown 当 source of truth，SQLite/vector/QMD/wiki 都是围绕这份事实源生成的索引和视图。

我不会写“Hermes 比 OpenClaw 更先进”或“OpenClaw 完胜 Hermes”。这两个系统的记忆哲学不同：

- Hermes 关注 agent 在多执行面里的连续运行。
- OpenClaw 关注个人 AI 助手长期生活在用户工作区里的记忆可维护性。

选型时应该问 workload，而不是问 star 数或宣传词。

## 适用场景

Hermes 更适合：

- 长期运行在服务器上的单人或小团队 agent，需要 CLI、消息网关、cron 和远程执行连续性。
- 任务跨度长，但只有少量事实需要每次常驻，例如用户偏好、项目根目录、工具限制、部署约定。
- 希望接入外部 memory provider，例如 Honcho 用户建模、Mem0 自动抽取、Hindsight 知识图谱或本地 Holographic fact store。
- 需要把技能作为 procedural memory，不想把操作步骤混进事实记忆。

OpenClaw 更适合：

- 个人 AI 助手、WebChat、语音、多渠道消息入口和长期日常工作流。
- 用户希望 memory 是 Markdown，可手工审查、迁移、版本管理和用 Obsidian 类工具阅读。
- 需要短期日志到长期事实的晋升机制，而不是全靠 agent 当场判断。
- 需要 memory-wiki、DREAMS、dashboard、promotion explain 这类治理界面。

## 失败模式

Hermes 的主要失败模式：

- 常驻 memory 太小，agent 把该进 session search 或技能的内容硬塞进 `MEMORY.md`，导致高价值事实被挤掉。
- frozen snapshot 让当前 session 看不到刚写入的 memory，用户误以为“已经记住了就应该马上改变行为”。
- 外部 provider 召回内容被模型当成强证据，但来源、时间和置信度不够清楚。
- provider 只允许一个外部后端，降低冲突风险，也限制了多后端融合实验。
- agent curated memory 依赖模型自律；如果没有人工审查，错误偏好和过时环境事实会长期残留。

OpenClaw 的主要失败模式：

- Markdown 日记大量增长后，如果没有 dreaming 或人工整理，检索命中会变成噪声池。
- hybrid search 的高分片段不一定是事实，只是相关；模型可能把弱相关记忆解释成强证据。
- dreaming 阈值和信号设计复杂，用户可能调不明白，也可能过度信任 promotion 分数。
- 多渠道、多用户、多 agent 场景下，如果 session 隔离和 workspace 边界配置不当，记忆串线风险更高。
- wiki 层提供治理能力，但也引入编译、lint、bridge、digest 等额外维护面。

## 可验证指标

评估 Hermes 和 OpenClaw，不应该只问“能不能记住”。至少要测这些指标：

- 常驻记忆精度：`MEMORY.md` / `USER.md` 中有多少条目仍然正确、具体、可行动。
- 常驻记忆压缩率：同样用户画像和项目上下文，Hermes 2,200/1,375 字符限制下能保留多少关键事实。
- 会话检索命中率：针对过去任务问题，Hermes `session_search` 或 OpenClaw `memory_search` 的 top-k 是否包含必要证据。
- 事实源可追溯性：回答引用的 memory 是否能回到原始 Markdown、session 消息或 provider 记录。
- 冲突处理延迟：用户纠正旧事实后，系统多久停止召回旧事实。
- 晋升误报率：OpenClaw dreaming 写入 `MEMORY.md` 的候选中，有多少不应成为长期事实。
- 写入漏报率：Hermes agent curated memory 漏掉了多少用户明确希望长期保存的偏好、环境事实和项目约定。
- 多语言召回：中文项目名、路径片段、ID、术语在 FTS/trigram/hybrid search 中是否稳定命中。
- prompt 成本：常驻 memory、provider prefetch、session summary 分别带来多少 token 增量。
- 人工维护成本：用户每周需要花多少时间清理、合并、删除和审查 memory。

这些指标比“支持长期记忆”“支持知识图谱”“支持向量搜索”更接近真实工程质量。

## 局限分析

本文没有运行 Hermes 或 OpenClaw 的完整 end-to-end benchmark，也没有用同一批任务日志对两者做召回率测试。因此，本文的结论是架构层判断，不是性能排行榜。

Hermes 的官方文档和源码正在快速变化。本文检查的是 `NousResearch/hermes-agent` commit `20b759c`；OpenClaw 检查的是 `openclaw/openclaw` commit `4f540c70`。后续版本可能改变 provider 数量、memory schema、dreaming 默认策略或索引实现。

另一个限制是外部 provider 的真实质量无法只靠 Hermes 接入层判断。比如 Honcho、Mem0、Hindsight、Supermemory 的抽取、去重、遗忘、权限和评测能力，需要分别读它们自己的实现或服务文档。Hermes 做的是 provider orchestration，不自动证明这些 provider 的 memory 质量。

## 自审

- 事实可靠性：使用 Hermes / OpenClaw 官方文档、GitHub README 和源码检查，不采用第三方营销对比站作为证据。
- 来源完整性：覆盖内置 memory、session storage、prompt assembly、context compression、memory provider、OpenClaw memory overview、builtin engine、dreaming 和 CLI。
- 原创性：重点是架构拆解、机制对比、失败模式和可验证指标，不复述 README。
- 标题风险：标题表达系统差异，不宣称 Hermes 替代 OpenClaw，也不写性能胜负。
- 薄内容检查：包含技术问题、机制拆解、适用场景、失败模式、指标和局限。
- 猜测边界：对 provider 质量、实际 benchmark 和未来版本变化明确标注为未验证。
- 站内重复：区别于 2026-04-28 的基础设施化文章，本文聚焦 Hermes 源码级记忆机制和 OpenClaw 对比。
