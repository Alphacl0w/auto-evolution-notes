---
title: "让 AI 做数据分析的正确方式：把自然语言问题编译成可复跑的分析 DAG"
description: "以“每周指标异常分析”为例，本文给出一个 AI Native 数据分析工作流：Agent 负责澄清意图、生成 AnalysisSpec 和解释候选；确定性执行器负责 SQL、Notebook 与质量检查；数据 owner 负责定义、结论和发布审批。"
pubDate: 2026-08-27
track: "ai-native-practice"
category: "AI Native 实践"
tags:
  - "AI Native"
  - "data analysis"
  - "agentic workflow"
  - "reproducibility"
  - "data governance"
  - "human in the loop"
  - "workflow DAG"
draft: false
---

## 来源说明与适用边界

本文不是“让 Agent 自己决定业务结论”的方案。它把 Agent 放在问题澄清、分析规格生成、候选解释和报告草拟的位置；数据查询、指标计算、质量断言与发布仍由确定性系统和人承担。

主要依据如下：

- [From Research Question to Scientific Workflow](https://arxiv.org/abs/2604.21910) 提出语义层、确定性工作流生成层和领域 Skills 三层拆分。作者报告：固定 intent 能生成确定的 DAG；Skills 在其 150 个查询的实验里将 full-match intent accuracy 从 44% 提升到 83%。这些是特定科学计算实现中的作者结果，不是通用数据分析承诺。
- [SciAgentArena](https://arxiv.org/abs/2606.12736) 的结论值得克制解读：当前 Agent 在结构明确、验收标准清楚的数据分析工作流里更有帮助，但在开放式探索和新颖洞见上仍不稳定。
- [AgentDS](https://arxiv.org/abs/2603.19005) 对六个行业、17 个挑战的比较显示，AI-only baseline 在领域推理上仍有限，而最强结果来自人机协作。它支持“保留领域 owner”的工作分工，不证明某一个具体产品流程。
- [GitHub Agentic Workflows 文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/about-github-agentic-workflows) 则提供工程参照：自然语言工作流仍应在 frontmatter 声明权限、安全输出和预算，写动作必须受控且人工保留审批。

场景假定数据团队已经有受控的数据仓库、指标定义、只读服务身份和基础 BI 资产。没有这些前提时，先补数据治理，不要把 LLM 当成数据治理的替代品。

## 先给结论

AI Native 数据分析最值得自动化的，不是让模型“看看表然后给洞见”，而是把反复出现、但跨越业务语言和技术语言的翻译工作做成受控流水线：

```text
自然语言问题
  -> AnalysisSpec（人工可审阅的意图）
  -> validated DAG（确定性可复跑的计划）
  -> read-only execution（SQL / notebook / quality checks）
  -> evidence packet（表、图、查询、假设、限制）
  -> analyst review（结论、动作、发布）
```

核心约束是：**相同的已批准 `AnalysisSpec` 必须编译出相同的 DAG；Agent 的每条解释都必须区分“计算结果”“已验证业务事实”“待验证假设”；没有通过数据质量门的结果不得生成对外结论。**

这比多开几个“分析 Agent”更重要。因为真正昂贵的返工往往不是 SQL 写不出来，而是指标口径错、时间窗混用、样本偏差没声明、结论没有证据、或者一个漂亮图表在下周无法复现。

## 场景定义：每周指标异常分析

以一个内部运营场景为例：每周一，业务负责人看到“付费转化率下降”，希望知道下降在哪个环节、是否真实、下一步由谁验证。原始流程通常是：提问人发一句模糊消息，分析师追问口径、翻文档、手写 SQL、清洗数据、做图、在 Slack 里解释，然后下周很难确定是否沿用了同一条件。

AI Native 后的目标不是取消分析师，而是把过程变成可观察的状态流转：

```text
new
  -> scoped
  -> spec-drafted
  -> owner-approved
  -> compiled
  -> executing
  -> quality-gated
  -> evidence-reviewed
  -> published | rejected | needs-clarification
```

“付费转化率下降”在 `new` 状态还不是可执行任务。它至少缺少分子/分母、市场、产品、时间窗、对照期、数据敏感级、行动阈值和可接受的不确定性。Agent 的第一价值是把缺失项变成明确问题，而不是偷偷补全。

## 原流程痛点：为什么直接让 Agent 连数据库会放大错误

| 原流程问题 | 直接 Agent 查询的坏结果 | 受控 DAG 的处理 |
| --- | --- | --- |
| 指标名含义不唯一 | 选了相似字段，数字合理但口径错误 | Skill 将名称映射到 versioned metric id |
| 时间窗口语化 | “上周”与自然周/滚动 7 天混淆 | Spec 固定时区、起止日期、对照规则 |
| 数据迟到或回填 | 将未完成数据误当趋势 | 质量节点检查 freshness、completeness、backfill |
| 维度切片太多 | 偶然波动被写成原因 | 预注册切片、标注探索性结果 |
| 图表可视但不可追溯 | 截图进入周报，查询丢失 | 每个图绑定 query hash、数据快照与版本 |
| Agent 过度自信 | 推断因果或给业务建议 | 输出分类为 fact / finding / hypothesis / recommendation |

AgentDS 的结果尤其提醒数据团队：能写 Python、能调用工具，不等于能掌握行业特有的因果、风险与多模态信号。人必须保留在“问题是否值得问、口径是否成立、结论是否可行动”的位置。

## 目标工作流：语义层、确定性层、知识层与审批层

借鉴科学工作流的三层拆分，我会为数据分析加入一个显式审批层：

```text
                     reviewed metric / policy Skills
                                  |
request -> intake agent -> AnalysisSpec -> validator -> DAG compiler
                                  |                        |
                             human approval            read-only runner
                                                           |
                                                           v
                                               quality checks + artifacts
                                                           |
                                                           v
                                              explanation agent -> draft report
                                                           |
                                                           v
                                                    data owner review
```

### 语义层：Agent 只生成可审阅意图

Agent 读取被批准的 metrics glossary、数据目录和当前请求，生成结构化 `AnalysisSpec`。它不可直接发 SQL 到生产仓库，也不可自行提高数据访问级别。

```ts
type AnalysisSpec = {
  id: string;
  revision: number;
  question: string;
  metric: {
    id: string;
    definitionRevision: string;
    numerator: string;
    denominator: string;
  };
  population: { market: string[]; product: string[]; exclusions: string[] };
  time: { timezone: string; start: string; end: string; comparison: "prior-period" | "year-over-year" };
  dimensions: string[];
  hypotheses: string[];
  dataClassification: "internal" | "restricted";
  allowedOutputs: ("aggregate-table" | "chart" | "draft-report")[];
  approval: "pending" | "approved" | "rejected";
};
```

关键字段是 `definitionRevision`。没有它，指标文档更新后，同一个 metric id 可能在不同周代表不同含义，历史结论无法解释。

### 知识层：把数据团队经验做成受版本控制的 Skills

Skills 不必神秘，初版就是数据 owner 看得懂的 Markdown/YAML 文件：术语映射、可用维度、最小样本、禁用切片、数据延迟、可用表、常见陷阱和审阅人。

```yaml
skill: payment-conversion
metric_id: payments.conversion_rate
definition_revision: 2026-06
source_model: mart_payment_funnel_daily
freshness_slo_hours: 18
timezone: Asia/Shanghai
required_dimensions: [platform, acquisition_channel]
forbidden_dimensions: [email, phone, raw_user_id]
minimum_denominator: 500
known_caveats:
  - "退款事件最多延迟 48 小时"
  - "渠道归因窗口为 7 天"
owners: [growth-analytics]
```

Skills 不能给 Agent 任意数据库权限；它们只声明语义和约束。每次运行记录到底用了哪个 skill revision，便于在定义变更后重跑历史分析。

### 确定性层：编译器而不是模型来生成可执行 DAG

一旦 `AnalysisSpec` 已批准，编译器按固定模板生成步骤。相同 spec、相同 skill 和相同 compiler revision 产生同一 DAG；LLM 不参与自由改写 SQL。

```yaml
dag:
  id: analysis-2026w35-conversion-v1
  nodes:
    - id: validate_freshness
      type: quality_check
      input: mart_payment_funnel_daily
      rule: freshness_lte_hours:18
    - id: aggregate_metric
      type: parameterized_query
      template: conversion_by_dimension_v3
      parameters_from: AnalysisSpec
    - id: check_denominators
      type: quality_check
      rule: denominator_gte:500
    - id: compare_periods
      type: deterministic_stat_test
      input: aggregate_metric
    - id: render_chart
      type: chart_template
      input: compare_periods
    - id: build_evidence_packet
      type: artifact_manifest
      inputs: [aggregate_metric, compare_periods, render_chart]
  edges:
    - [validate_freshness, aggregate_metric]
    - [aggregate_metric, check_denominators]
    - [check_denominators, compare_periods]
    - [compare_periods, render_chart]
    - [render_chart, build_evidence_packet]
```

若 `validate_freshness` 失败，DAG 应结束为 `blocked-by-data-quality`，而不是生成一篇语气保守却仍会被转发的“可能下降”报告。

### 审批层：人审核的是边界与结论，不是每一行代码

| 审批点 | 负责人 | 审核什么 | 不做什么 |
| --- | --- | --- | --- |
| Spec approval | metric/data owner | 口径、粒度、时间窗、敏感级、预注册切片 | 不手写 SQL |
| Access approval | data steward | 数据域和输出是否最小必要 | 不判断业务结论 |
| Evidence review | analyst | 质量门、对照、图表、假设和限制 | 不为数据缺失编故事 |
| Publish approval | business owner | 是否可行动、是否需要进一步实验 | 不把草稿当最终事实 |

这不是人为拖慢自动化。明确的审核点会减少“没有人真正对这句结论负责”的返工。

## Agent、工具与人的分工

| 角色 | 输入 | 输出 | 权限边界 |
| --- | --- | --- | --- |
| Intake Agent | 自然语言请求、glossary | 缺失字段问题、Spec 草案 | 无数据仓库凭据 |
| Spec Validator | Spec、Skill schema | pass / clarification / reject | 只读 Skills |
| DAG Compiler | 已批准 Spec、模板库 | 可复跑 DAG、query manifest | 无 LLM、无动态 SQL |
| Execution Sentinel | DAG 状态、质量输出 | 状态、失败摘要、artifact refs | 只读数据副本 |
| Explanation Agent | evidence packet、approved glossary | fact/hypothesis 分离的报告草稿 | 不可调用查询工具 |
| Data Analyst | 草稿、artifact | 审阅结论与修改 | 可请求重新运行 |
| Business Owner | 已审阅报告 | 发布/实验/暂缓决定 | 不改原始 artifact |

Explanation Agent 的隔离很重要。它只看到经过质量门的 evidence packet，无法自行“再查一点”未授权数据，也不会把反复 exploratory query 混进最终结论。

## 数据与权限边界

```yaml
execution_identity:
  warehouse_role: analytics_agent_readonly
  allowed_models: [mart_payment_funnel_daily, dim_channel]
  denied_models: [raw_events, pii_customer, employee_hr]
network: deny
result_limits:
  maximum_rows: 10000
  aggregation_required: true
  export_formats: [parquet, csv_aggregated]
retention:
  intermediate_days: 7
  approved_evidence_days: 180
write_actions:
  warehouse: deny
  dashboard: deny
  report_destination: draft_only
```

原始数据不应随 prompt 在模型供应商或日志系统之间流动。优先在数据边界内完成聚合，只将最小聚合结果、字段字典、质量状态和必要的统计摘要交给 Explanation Agent。访问控制、脱敏、审计和地域要求仍需由组织的数据平台落实。

## 可复制 SOP：一周上线一个“指标异常分析”试点

| 天数 | 工作 | 人工审核点 | 交付物 |
| --- | --- | --- | --- |
| 1 | 选一个已有指标和一个只读数据 mart | metric owner 确认定义与敏感级 | metric Skill v1 |
| 2 | 收集 10 个历史问题，标出歧义与常见追问 | 分析师确认问题字段 | AnalysisSpec schema |
| 3 | 写 validator 与 3 个固定 query template | 数据工程确认模板无写入能力 | compiler prototype |
| 4 | 加 freshness、row count、denominator、null 等质量节点 | owner 设定失败即阻断条件 | quality gate |
| 5 | 用 3 个历史周的冻结快照 replay | 分析师比较人工与 DAG 产物 | artifact diff report |
| 6 | 让 Explanation Agent 只根据 evidence packet 写草稿 | 业务 owner 标注过度推断 | review rubric |
| 7 | 以 shadow mode 发送草稿，不自动发布 | 共同评估质量、耗时、成本 | go / revise / stop 决定 |

首周不接实时仪表盘、不做自动告警回复、不生成面向客户的结论。先确认“历史问题能不能稳定编译、质量失败会不会停止、草稿是否明显减少人工整理时间”。

## 我会如何验证：三臂比较，而不是只看 Agent 写得快不快

采用三条路径跑同一批冻结历史问题：

1. **人工基线**：现有分析师流程，记录从接单到可审阅报告的时间和返工次数。
2. **Agent 直连基线**：允许模型生成探索性查询，但不允许发布，用于暴露不受控路径的错误模式。
3. **Spec-to-DAG 工作流**：本文方案，固定 templates 与审批点。

对每个问题建立 answer key：正确 metric revision、时间窗、必需质量门、预期 artifact、可接受结论范围和禁止推断。评分不应只由 LLM judge 决定；数据 owner 需抽样核验口径与图表，自动检查则核验 DAG hash、query parameter、质量 gate 与输出 schema。

```text
question -> approved spec -> expected DAG hash -> frozen snapshot
         -> quality verdict -> evidence manifest -> reviewed conclusion
```

若 Agent 直连路径更快，但其 time window 或 metric revision 错误更多，它不应被判定为更优。若 Spec-to-DAG 路径在复杂新问题上频繁要求澄清，这可能是正确行为，而不是失败。

## 质量、ROI 与成本指标

| 指标 | 定义 | 目标解释 |
| --- | --- | --- |
| spec acceptance rate | 一次审核通过的 Spec 比例 | 太低说明 intake/Skill 不清楚 |
| definition fidelity | 输出是否使用批准的 metric revision 和时间窗 | 必须接近 100% |
| quality-stop precision | 数据质量失败时是否正确停止 | 防止“坏数据也出报告” |
| replay equivalence | 同样输入是否得到同样 DAG 和 artifact hash | 测量可复跑性 |
| unsupported-claim rate | 报告中没有 artifact 支撑的结论比例 | 控制 AI 叙事漂移 |
| analyst edit distance | 人工对草稿的实质修改量 | 测量草稿价值，不等于文笔 |
| time to reviewed insight | 从完整问题到已审阅结论的时长 | 真实交付周期 |
| cost per accepted report | 推理、仓库、执行与人工审核总成本 | 避免只看 token 价格 |
| clarification rate | Agent 主动要求补充的比例 | 过高要改 Skill，过低可能在瞎猜 |

ROI 的计算要把人工审核算进去。若 Agent 每周节省 4 小时提数，却让 owner 多花 6 小时纠错，它是负收益。相反，若它没有减少最终审核时间，却让每个结论可复跑、可追溯，也可能在高风险决策里有正价值；这需要由团队显式定价。

## 报告模板：强制区分结果与解释

Explanation Agent 的输出使用固定结构，避免把相关性写成原因：

```markdown
## 已验证结果
- 指标、时间窗、数据新鲜度、对照期。
- 已通过/未通过的质量检查。

## 观察到的切片
- 仅列出预注册或明确标注为探索性的维度。

## 待验证假设
- 每个假设对应下一步数据、实验或 owner。

## 不支持的推断
- 当前数据不能说明因果、个体行为或长期趋势。

## Artifact
- AnalysisSpec revision、DAG hash、query manifest、chart refs。
```

“不支持的推断”不是客套话。它让读者看见边界，也让下一轮工作从可验证假设开始，而不是从上周的叙事继续滚雪球。

## 失败模式与回滚方案

| 失败模式 | 早期信号 | 处理与回滚 |
| --- | --- | --- |
| Skill 过期 | 定义 revision 不匹配、owner 频繁修正 | 冻结自动运行，更新 Skill 后 replay 历史样本 |
| 模糊请求被擅自补全 | clarification rate 异常低、口径争议上升 | 强制 validator 进入 `needs-clarification` |
| 模板覆盖不了新问题 | 编译失败或大量人工改 DAG | 保持人工路径，新增模板必须评审 |
| 数据质量门过松 | 后续发现回填改变结论 | 提高 freshness/completeness 阈值，标记受影响报告 |
| Explanation 过度推断 | unsupported-claim rate 上升 | 缩小输入到 evidence packet，要求引用 artifact id |
| 成本失控 | 重试、扫描维度、查询量异常 | 限制 max runtime/credits/scan bytes，终止运行 |
| 敏感数据进入报告 | row-level 输出或标识符出现 | 立即撤回草稿，轮换访问、检查日志和 policy |

回滚要有两个开关：`publish_enabled=false` 立即停止草稿进入目标频道；`compiler_revision` 回退到上一个已验证版本。已有 artifact 不应静默删除，而应标为 superseded 并指向替代 run，保留审计链。

## 工程判断

这条路径适合指标定义较稳定、重复出现、可以使用冻结快照或只读副本的分析工作，例如运营周报、漏斗诊断、库存/履约监控、产品实验复盘、工程质量趋势。它不适合把从未定义过的问题直接自动化，也不适合让 Agent 对高风险人群、信贷、医疗、雇佣等领域做无人审核的决策。

论文中的科学计算 DAG 与企业数据分析并不相同，但两者共享一个有用原则：把 LLM 的不确定性收在语义翻译和解释草稿中；把数据访问、执行、质量和副作用交给验证器、模板和审批链。SciAgentArena 与 AgentDS 的结果进一步说明，清楚的任务结构和人机协作不是过渡方案，而是当前可靠性的前提。

## 局限分析

第一，确定性 DAG 能保证相同输入产生相同计算，不保证业务问题本身问得对，也不保证数据生成过程没有偏差。它是可复现性控制，不是洞见真实性证明。

第二，固定 templates 会限制探索性分析。对于真正新颖的调查，强行编译可能制造假精确；此时应转入有明确预算与人工指导的 exploration mode，并禁止将其结果直接当作已验证周报。

第三，AgentDS 和 SciAgentArena 都是评测环境，不能替代企业自己的数据质量、隐私、安全和 ROI 测量。文中论文结果均为作者报告，未被当成对该方案的性能承诺。

第四，Skills 是新的治理对象。写错的 vocabulary mapping 或指标约束会系统性传播错误，因此需要 owner、版本化、回放测试和变更审计，不能把 Markdown 当成“无需维护的提示词”。

## 自审

- **事实可靠性：** 科学工作流论文的架构和数字均明确归因于作者实验；SciAgentArena 与 AgentDS 的结论按其评测范围表述；GitHub 文档仅作为权限/安全输出的工程参照。
- **来源完整性：** 使用原始论文和官方文档，没有依赖无可复核的案例营销。
- **AI Native 实践要求：** 包含场景、原流程、目标工作流、分工、数据权限、SOP、质量/ROI、成本、失败与回滚、人工审核点。
- **工程价值：** 提供 `AnalysisSpec`、Skill、DAG、权限策略、三臂验证、指标和报告模板。
- **不夸大：** 没有声称 AI 能自主发现可靠业务洞见；明确保留 owner 审核与澄清路径。
- **站内差异：** 本站已有研究证据与论文复现工作流；本文针对企业数据分析的语义到 DAG 编译、只读执行和结论发布治理。
