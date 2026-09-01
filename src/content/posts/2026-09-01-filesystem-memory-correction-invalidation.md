---
title: "文件里明明有，Agent 为什么还是记错：文件系统记忆的纠错与失效"
description: "从 PersonaMem 的最新偏好失败出发，拆解文件系统记忆为什么会在事实完整、引用正确时仍返回旧答案，并给出事件层、有效期、当前视图、历史查询与一致性审计的可实现方案。"
pubDate: 2026-09-01
track: "agent-memory"
category: "Agent Memory"
tags:
  - "filesystem memory"
  - "temporal memory"
  - "memory update"
  - "PersonaMem"
  - "Mem0"
  - "Graphiti"
draft: false
---

一条旧记忆已经被新事实纠正，为什么 Agent 还是会把旧答案说出来？

直觉上，这像是检索不准：换 embedding、加 reranker、把目录整理得更细。但 2026 年 7 月的论文 [Filesystem-Based Memory for LLM Agents](https://arxiv.org/abs/2607.26637) 给出了一个更麻烦的失败。它在 PersonaMem 32k 上把长对话整理成 Markdown 文件树后，答案正确率从逐字记录的 78.1% 跌到 37.5%；研究者逐题检查发现，逐字记录答对而整理版答错的 13 道题里，决定答案的事实一条都没有丢。

内容在，引用也基本对，答案仍然错。真正损坏的是“哪一条现在有效”这层语义。

本文只解决这个问题：**当同一事实槽位发生纠正、状态变化或撤销时，文件系统记忆怎样保留历史，同时保证当前查询不会把旧事实当成现在。** 我会先复盘论文里的失败，再对照 PersonaMem、Mem0 和 Graphiti 的公开实现，最后给出一个可运行的小实验与工程方案。

## 先看一个会真实发生的例子

假设 coding agent 在 8 月 1 日写下：

```text
生产部署命令是 npm run deploy。
```

8 月 20 日，仓库迁移到新的 Vercel 流程，agent 又写下：

```text
生产部署命令是 npm run deploy:prod。
```

两句话都是真实发生过的事实。第一句对 8 月 1 日的仓库成立，第二句对迁移后的仓库成立。错误不是保留第一句，而是把两句都保存成没有时间边界的现在时。

此后用户问“现在怎么部署”，关键词搜索、向量检索和文件遍历都可能同时找到两条。如果读取器只取第一个高相似结果，目录重排、文件名变化或索引更新就足以改变答案。检索器没有幻觉，它忠实地读到了一个**仍被存储层标成有效**的旧事实。

这也是为什么“加日期”还不够。日期只能告诉读取器两条记录何时出现，不能直接回答哪条已经失效。系统还需要一个可执行的不变量：

> 对每个单值事实槽位，在给定作用域和查询时刻，最多只能有一个有效值。

## 论文到底发现了什么

这篇文件系统记忆论文把系统拆成三个角色：管理 agent 接收新内容并维护文件树，搜索 agent 在只读存储上回答带引用的问题，执行 agent 在技能场景中消费检索结果。它比较了 agent 自主整理、逐字会话文件、重组文件和 chunk retrieval，并同时测答案质量、检索成本与存储健康度。

论文的总体结论并不是“文件树无效”。在内容较大的 PersonaMem 上，重组后的存储把单次查询成本从逐字记录的 4.0 美分降到 1.4 美分；128k 档从 3.9 美分降到 1.6 美分。结构确实能减少读取量。

但结构没有自动带来正确性。最典型的是 PersonaMem 32k：

| 存储形态 | 正确率 | 关键特征 |
| --- | ---: | --- |
| Verbatim dump | 78.1% | 保留对话顺序、原始语气和更新位置 |
| Foldered sessions | 62.5% | 有目录，但仍大体保留会话记录 |
| Agent-curated store | 37.5% | 按主题改写并分散到多个文件与章节 |

论文附录把损失归为三类表示问题：旧偏好与新偏好都被写成现在时；第一人称的强烈态度被压成中性特征列表；同一段变化过程被拆散到不同文件和章节。PersonaMem 的题目恰好要求识别“最新偏好”，旧状态又被设计成干扰项，于是整理越远离时间叙事，错误越严重。

需要谨慎解读两点。

第一，这不是“文件系统一定比原始日志差”。在其他基准上，没有一种形态稳定胜出；组织结构最稳定的收益是检索经济性。

第二，论文把问题定位为当前管理 agent 没有稳定执行更新指令，而不是证明“整理后的表示天生做不到”。把管理模型从 gpt-5.4-mini 换成 gpt-5.4 后，固定搜索 agent 在 32 道题上从答对 12 道提高到 18 道，但配对检验的 `p=0.073`，只能算方向性证据，不能写成已经解决。

[PersonaMem 官方仓库](https://github.com/bowen-upenn/PersonaMem/tree/caaae44)也明确把“随时间演化的用户画像”作为测试目标；数据字段直接记录最新偏好在上下文中的距离。因此，这类失败不能用普通事实召回率掩盖，必须单独测 current-state resolution。

## 更新不是一种操作，而是四种不同语义

新记录与旧记录文本冲突时，系统至少要区分四种情况。

| 类型 | 示例 | 应有行为 |
| --- | --- | --- |
| 纠错 | “端口不是 3000，是 4321” | 旧值从一开始就不可信；保留审计记录，不再作为历史事实回答 |
| 状态变化 | “部署命令已迁移为 deploy:prod” | 旧值在迁移前有效，新值在迁移后有效 |
| 撤销 | “以后不要自动发布” | 关闭旧规则，不一定产生新的正向值 |
| 作用域变化 | “这个命令只用于 staging” | 旧事实可能仍有效，但不能留在 production 作用域 |

如果只让 LLM 在 `ADD / UPDATE / DELETE` 里选一个，它很容易把状态变化当纠错，或把作用域变化当删除。文件操作也有同样的问题：覆写原句会失去历史，只追加新句会留下两个“当前值”，删除旧文件则破坏来源追踪。

我更偏向把写入拆成两层：LLM 负责从自然语言提取候选事件，确定性代码负责应用时间与唯一性约束。模型可以提出“这条似乎替代上一条”，但不能自行决定两个当前值同时上线。

## 一个适合文件系统的双层布局

不必为了时间语义立刻上图数据库。Markdown 与 JSONL 也能实现，只要不要把原始事件和当前视图混成同一份文件。

```text
memory/
├── events/
│   └── 2026-08.jsonl              # 不可变：原始更新事件与来源
├── facts/
│   └── project/deploy-command.json # 可演化：带有效期的事实版本
├── current/
│   └── project.md                  # 可重建：只暴露当前有效事实
└── sources/
    └── session-2026-08-20.md       # 证据摘要或原始会话定位
```

事实版本至少需要下面这些字段：

```json
{
  "id": "fact-deploy-v2",
  "slot": "repo:agent-lab|production|deploy-command",
  "value": "npm run deploy:prod",
  "valid_from": "2026-08-20T10:00:00+08:00",
  "valid_to": null,
  "recorded_at": "2026-08-20T10:02:14+08:00",
  "status": "active",
  "supersedes": "fact-deploy-v1",
  "source": "sources/session-2026-08-20.md#deployment-migration",
  "confidence": 1.0
}
```

这里有两套时间。

- `valid_from / valid_to` 描述事实在现实或项目中何时成立，回答“8 月 10 日怎么部署”。
- `recorded_at` 描述记忆系统何时知道这件事，回答“系统当时依据什么作出判断”。

Graphiti 的公开数据模型采用了相似思路：关系边带有 `valid_at`、`invalid_at`、`created_at` 和 `expired_at`；它的[边解析代码](https://github.com/getzep/graphiti/blob/8b61fce/graphiti_core/utils/maintenance/edge_operations.py)会让较新的矛盾关系关闭旧边的有效区间。图结构不是关键，**把失效变成一等字段**才是关键。

## 写入路径：先找同一槽位，再判断如何变化

下面是工程伪代码，不是可直接运行的 SDK：

```text
ingest(observation):
  event = append_to_event_log(observation)
  candidate = extract_fact(event)
  slot = normalize(subject, scope, predicate)
  active = load_active_fact(slot)

  if active is null:
    activate(candidate)
  else:
    relation = classify(candidate, active, source_context)

    if relation == CORRECTION:
      mark_invalid(active, reason="corrected", valid_to=active.valid_from)
      activate(candidate, supersedes=active.id)

    if relation == STATE_CHANGE:
      close(active, valid_to=candidate.valid_from)
      activate(candidate, supersedes=active.id)

    if relation == REVOCATION:
      close(active, valid_to=candidate.valid_from)

    if relation == SCOPE_CHANGE:
      move_or_split_slot(candidate)

  assert active_count(slot, now) <= 1
  rebuild_current_view(slot)
```

关键顺序是“先归一到事实槽位，再做冲突判断”。如果先做全库语义搜索，`staging deploy command` 和 `production deploy command` 可能因为文本相似被错误合并；如果只比较字符串，`喜欢披萨` 和 `最近不吃披萨，因为在治疗`又可能被当作无关事实。

Mem0 当前主分支也暴露了这种设计张力。我在 2026-09-01 检查的 [Mem0 提取提示词（提交 `71fba8d`）](https://github.com/mem0ai/mem0/blob/71fba8d/mem0/configs/prompts.py)中，V3 提取器采用 ADD-only：新事件作为独立记忆写入，偏好变化通过 `linked_memory_ids` 指回相关旧记忆；同一提交的 [`Memory.update()` 实现](https://github.com/mem0ai/mem0/blob/71fba8d/mem0/memory/main.py)仍支持按 ID 显式重写向量内容，并把新旧值写入 history。前者更容易保留事件，后者更容易维护当前值。生产设计通常两者都需要：**追加事实作为证据，物化当前视图作为默认读面。**

## 读取路径必须先判断问题是在问“现在”还是“当时”

有了有效期，检索仍不能只按相似度排序。查询至少先分三类：

1. 当前状态：“现在生产怎么部署？”只搜索 `valid_to = null` 且作用域为 production 的视图。
2. 历史状态：“8 月 10 日怎么部署？”搜索满足 `valid_from <= t < valid_to` 的版本。
3. 变化解释：“为什么命令变了？”读取同一 slot 的版本链与两个来源。

一个实用的返回包可以是：

```json
{
  "answer_value": "npm run deploy:prod",
  "as_of": "2026-09-01T09:30:00+08:00",
  "scope": "repo:agent-lab|production",
  "fact_id": "fact-deploy-v2",
  "source": "sources/session-2026-08-20.md#deployment-migration",
  "previous": "fact-deploy-v1"
}
```

生成模型看到的是已经通过时间与作用域过滤的事实包，而不是两段互相冲突的 Markdown。embedding、BM25 和目录层级仍可用于定位候选 slot，但不负责决定哪个版本有效。

## 小实验：文件一重排，旧值就有一半机会回来

我写了一个不调用模型的机械实验，脚本位于 [`experiments/filesystem-memory-invalidation.mjs`](https://github.com/Alphacl0w/auto-evolution-notes/blob/codex/astro-rebuild/experiments/filesystem-memory-invalidation.mjs)。它生成 32 个项目的部署命令，每个槽位各有一个旧值和一个新值，然后模拟管理 agent 重组目录后文件遍历顺序变化。

第一种读取策略找到第一个词面匹配就返回；第二种先把事件物化成带 `validFrom / validTo / supersedes` 的版本，再只读取查询时刻有效的记录。实际运行环境与命令是：

```bash
node --version
# v24.14.0

node experiments/filesystem-memory-invalidation.mjs
```

200 次确定性重排、共 6400 次当前值查询的结果：

| 策略 | 当前值准确率 | 历史值准确率 | 每次查询候选数 |
| --- | ---: | ---: | ---: |
| 重排后取第一个匹配 | 50.38% | 无法表达 | 2 |
| 有效期物化视图 | 100.00% | 100.00% | 1 |

脚本还检查了两个存储不变量：32 个槽位都恰好只有一个 active 版本，64 条版本记录都保留 source，违规数均为 0。

这个实验不复现论文的 LLM 管理 agent，也不能证明真实问答会提升 49.62 个百分点。它只隔离一个更基础的事实：**当旧值和新值都以无状态的现在时存在时，文件顺序会泄漏进答案；有效期把答案从遍历偶然性变成数据约束。**

## 上线前该测什么

普通 Recall@k 看不出这类错误，因为旧值与新值都可能被成功召回。至少要增加下面一组指标：

- Current-state accuracy：问“现在”时返回最新有效值的比例。
- Historical-state accuracy：指定过去时刻时返回当时有效值的比例。
- Stale answer rate：当前查询最终使用已失效版本的比例。
- Active-slot collision：单值 slot 同时存在多个 active 版本的数量；目标应为 0。
- Update resolution accuracy：纠错、状态变化、撤销、作用域变化四类的分类准确率。
- Source preservation：每个当前值和历史值都能回到原始事件的比例。
- Out-of-order robustness：迟到事件进入后，版本区间仍正确的比例。
- Maintenance cost：每次写入需要读取的候选事实数、LLM token、文件改写字节和 p95 延迟。

测试集不要只写“喜欢 A 后改成喜欢 B”。还要覆盖未来生效、暂时例外、多值偏好、否定句、来源可信度不同、跨项目同名配置、旧事件迟到以及隐私删除。单值唯一性也不能滥用：用户可以同时喜欢两种音乐，只有“production 部署命令”这类槽位才天然是单值。

## 我会怎样在一周内落地

第一天，先选 5 到 10 个高价值单值 slot，例如生产部署命令、默认分支、测试命令、当前负责人和发布域名。不要一开始试图结构化所有记忆。

第二天，增加 append-only event log。每条写入必须有 `observed_at`、`recorded_at`、scope 和 source，原始会话或工具结果只保存定位与必要摘要。

第三天，实现确定性的 slot resolver 与 current view。LLM 只输出候选 slot 和关系类型；代码负责关闭旧版本、写入新版本和执行 active 唯一性检查。

第四天，把读取 API 分成 `get_current(slot)`、`get_at(slot, time)` 和 `explain_change(slot, from, to)`。现有语义检索只负责把自然语言问题映射到 slot。

第五天，从真实项目历史中抽取至少 50 组变化，人工标注四类更新语义，跑 current、historical 和 stale-answer 三项指标。

第六天，加入迟到事件、回滚和来源删除测试。任何一致性断言失败都停止更新 current view，但保留 event log，方便重放修复。

第七天，灰度到只读建议模式：系统返回当前值、来源和上一个版本，由人确认后才允许它影响部署或写操作。连续一周 active collision 为 0、stale answer 达到目标后，再开放低风险自动消费。

## 仍然没有解决的部分

有效期不是万能药。最难的步骤仍是把自然语言映射到正确 slot，并区分纠错和真实变化；这个判断如果错了，结构化字段只会让错误更整齐。对健康、法律、财务或安全策略等高风险记忆，更新应保留人工确认。

时间也不总是精确。用户说“最近开始”“下个月可能”时，`valid_from` 应允许区间或不确定性，而不是编造一个日期。多值事实需要集合语义，规则与技能还可能依赖仓库版本、环境和工具版本，不能只用时间切片。

最后，本文没有复跑论文的完整 PersonaMem 实验。论文 v1 没有附公开复现实验仓库，本文引用的是其公开方法、表格和逐题错误分析；本地脚本是针对一个表示不变量的补充验证，不是论文结果的独立复现。

文件系统仍然很适合 agent memory：透明、可版本控制、可由通用工具操作。只是“文件里存在”从来不等于“现在有效”。目录解决去哪里找，来源解决凭什么相信，而**有效期与当前视图解决此刻应该用哪一条**。

如果你正在设计更完整的文件化记忆运行时，可以继续看[从记住到可运行：Coding Agent 记忆系统正在变成运行时可靠性问题](/articles/2026-05-13-agent-memory-runtime-reliability/)；若要处理环境变化与经验失效，可对照[环境经验不是聊天摘要：Agent Memory 如何记住世界的变化](/articles/2026-08-29-environment-experience-agent-memory/)；关于 `MEMORY.md`、每日笔记和后台整理的差异，则见[Hermes、OpenClaw 与文件化记忆系统对比](/articles/2026-04-29-hermes-memory-system-openclaw-comparison/)。
