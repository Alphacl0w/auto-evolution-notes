---
title: "AI Native 研发工作流的交付契约：让 Agent 产出可审计的变更，而非自动化幻觉"
description: "面向 issue 分诊、CI 调查、文档更新和代码建议，本文给出一套 AI Native 仓库工作流：任务契约、受限产物、证据回执、人工审核与可复跑评测如何协作。"
pubDate: 2026-08-31
track: "ai-native-practice"
category: "AI Native 实践"
tags:
  - "AI Native"
  - "agentic workflow"
  - "software delivery"
  - "human in the loop"
  - "provenance"
  - "repository automation"
  - "quality gate"
draft: false
---

## 来源说明与边界

本文的直接材料包括 [GitHub Agentic Workflows 官方说明](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/about-github-agentic-workflows)、[GitHub 的开发教程](https://docs.github.com/en/actions/tutorials/develop-agentic-workflows-in-github-actions) 与 [GitHub 关于 rationale、confidence、approvals 的说明](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-automation-rationale-and-approvals)。官方文档明确区分了声明式触发器、权限、安全输出与人工审核；也提醒 approvals 是工作流便利功能，不是服务端安全边界。

研究侧参考 [Reproducible, Explainable, and Effective Evaluations of Agentic AI for Software Engineering](https://arxiv.org/abs/2604.01437)，该文分析 Agentic AI 软件工程评测中的复现与解释缺口，并主张保存 Thought-Action-Result 轨迹或其可用摘要；以及 [Agent 执行证据溯源综述](https://arxiv.org/abs/2606.04990)，用于界定“最终结果正确”并不足以说明过程可信。

本文是一套内部研发自动化的工程建议，不是对任何平台的安全保证。它不主张让 Agent 自行合并、发布或改权限；示例中的 GitHub 语法和功能以官方文档为准，预览功能可能变化。

## 先给结论

AI Native 工作流的单位不应是“一段 prompt”，而应是一份**交付契约**：它明确任务输入、允许 Agent 产出的对象、所需证据、谁能审批、失败时如何退出。Agent 可以负责把问题变成候选 issue、PR、报告或文档 diff；但权限、合并和生产动作必须由确定性平台策略与人共同控制。

```text
event -> task contract -> bounded agent run -> evidence receipt
                                      |              |
                                      v              v
                             safe output only   quality / policy gates
                                                     |
                                                     v
                                           suggest, approve, merge, or stop
```

对团队而言，最可复制的路径是从只读、可逆、低影响任务开始：CI 失败归因、issue 分类、变更说明、文档差异提示。不要先做“自动修复并合并”。这样既能积累可比较的任务数据，也不会把模型置信度误当权限。

## 场景定义：一个研发团队的重复工作如何被重新分工

以“每次 PR 更新后，判断测试是否充分并维护相关文档”为例。

| 原流程 | 痛点 | AI Native 后的职责 |
| --- | --- | --- |
| 开发者读 diff、找测试、手动补说明 | 小改动频繁，检查标准不一致 | Agent 提取变更面、提出测试缺口和文档候选 |
| reviewer 判断风险、请求修改 | 上下文重建成本高 | reviewer 审核有证据的建议与风险分类 |
| maintainer 合并与发布 | 容易被“看起来合理”的总结推动 | 平台检查 required checks，maintainer 决定 merge |

这里的关键不是用 Agent 替代 reviewer，而是让 reviewer 不再从零开始检索：他看到的是带文件、测试、规则和不确定性标签的 evidence receipt。

## 技术问题：为什么“高置信度”不等于可以自动执行

GitHub 文档对 approvals 的提醒非常重要：它们只影响某些自动化变更何时以建议出现，并不构成服务端权限边界。拥有写权限的 Agent 仍可能通过其他接口执行写操作。因此，任何设计都必须先回答两个问题：

1. Agent **技术上被允许**做什么？这由 token、仓库权限、网络、容器和 safe outputs 决定。
2. 团队 **流程上希望**它做什么？这由置信度、审核队列和业务风险决定。

把两者写在一个 “confidence >= 0.9 就自动合并” 的规则中是类别错误。置信度只能影响建议排序和人工负荷，不能扩大实际能力。

## 交付契约：将自然语言任务编译为可检查输入输出

一个任务至少包含五个面：范围、输入快照、允许输出、证据、退出条件。

```yaml
id: pr-test-coverage-review
trigger:
  event: pull_request
  types: [opened, synchronize]
scope:
  repository: org/service-a
  ref: pull-request-head
inputs:
  required:
    - git_diff
    - existing_tests
    - ci_status
allowed_outputs:
  - pull_request_review_comment
  - issue_comment
  - markdown_report
forbidden_outputs:
  - merge_pull_request
  - push_to_default_branch
  - change_repository_settings
evidence_requirements:
  - changed_file_reference
  - test_or_rule_reference
  - uncertainty_label
exit_conditions:
  - no_actionable_gap
  - insufficient_context
  - human_review_required
```

这份 YAML 的价值是双重的：运行时可用于限制权限和安全输出；离线可用于判断 Agent 是否完成了该做的事。它也避免 prompt 逐渐膨胀成“能做一切”的隐式授权。

## 状态机：不让未验证文本直接变成仓库事实

```text
triggered -> context-collected -> proposed -> evidence-checked
     -> suggested -> human-approved -> applied
     -> no-op | insufficient-context | policy-denied | expired
```

`proposed` 是模型语言；`evidence-checked` 是确定性检查，例如引用的文件仍位于当前 SHA、测试名称存在、输出路径未越权；`applied` 才是仓库发生改变。每次状态转换应记录 run ID、输入 revision、规则版本和操作者。

## Agent、工具与人的清晰分工

| 角色 | 输入 | 输出 | 不应承担 |
| --- | --- | --- | --- |
| context collector | diff、CI、仓库规则 | 受限上下文包 | 写入仓库 |
| analysis agent | 上下文包、任务契约 | 候选结论与证据引用 | 授权、合并、发布 |
| deterministic checker | evidence receipt | pass/fail/reasons | 创造业务结论 |
| reviewer | 建议、证据、风险标签 | 批准、拒绝、补充要求 | 从零收集所有背景 |
| maintainer / CI | 审批与 required checks | merge / deploy 决策 | 相信模型的自我评价 |

这套分工也适用于研究、运营和数据分析：Agent 可以收集和整理，但事实结论、预算动作、外部发布必须有独立证据和合适的 owner。

## 证据回执：给人看的不是长思维链，而是可复核连接

保留内部 trace 有助于调试，但面向 reviewer 的回执应该更短、更稳定：

```json
{
  "run_id": "pr-842-20260831-01",
  "input_revision": "abc123",
  "decision": "suggest-review-comment",
  "confidence": "medium",
  "claims": [
    {
      "text": "新增鉴权分支缺少拒绝路径测试",
      "evidence": [
        {"type": "diff", "path": "src/auth.ts", "line": 84},
        {"type": "test-search", "query": "denied token", "result": "none"}
      ],
      "limits": "动态集成路径未在本次运行执行"
    }
  ],
  "policy_version": "review-contract-v2"
}
```

这个结构让 reviewer 可以问三个简单问题：证据是否仍对当前 revision 有效？结论是否超出证据？缺失的验证是否已被明确说明？比“模型认为覆盖不足”更可操作。

## 数据与权限边界

工作流默认只读，令 token 权限和 safe outputs 小于或等于任务允许输出。不要把生产 token、未脱敏日志、客户数据或其他仓库的上下文放进通用 Agent 容器。外部文本，包括 issue、PR 描述和构建日志，都应被视为 data，而不是高优先级指令。

```yaml
runtime_policy:
token: read-only
network: deny-by-default
workspace: ephemeral
secrets:
  expose: []
safe_outputs:
  - pr_comment
  - draft_issue
write_paths: []
retention:
  evidence_receipt_days: 30
  raw_trace_days: 7
```

当确实需要创建 PR 时，单独用窄权限 workflow；创建 PR 和合并 PR 仍应是两个契约，避免一次认证跨越整个交付链。

## 可复制 SOP：从一项低风险工作开始

1. 选择一个有明确完成标准的任务，例如“CI 失败摘要”或“PR 缺失测试建议”。
2. 写出 task contract，先只允许评论、报告或 draft issue。
3. 为 30 个历史样本建立人工标注：正确建议、无建议、应升级、应拒绝。
4. 运行 Agent，保存 input SHA、receipt、规则版本和 reviewer 决策。
5. 每周复盘 false positive、false negative、证据缺失和权限越界尝试；先改 contract 与 fixture，再改 prompt。
6. 只有当低风险任务稳定后，才增加受审阅的 PR 创建；生产发布永远保持独立 gate。

## 质量、ROI 与成本评估

| 指标 | 定义 | 目的 |
| --- | --- | --- |
| actionable precision | reviewer 接受的建议 / 全部建议 | 控制噪声 |
| missed-risk rate | 人工发现但 Agent 未标出的风险 / 人工风险 | 控制假阴性 |
| evidence completeness | 含可定位证据和限制说明的 receipt 比例 | 防止空泛结论 |
| median review time | reviewer 从打开到决定的时间 | 衡量真实节省 |
| override rate | 人工推翻 Agent 建议的比例 | 定位契约/策略缺陷 |
| token + runner cost | 单次运行的实际成本 | 避免低价值高频自动化 |

ROI 不应只计“跑了多少次”。一个减少 30% 上下文重建时间、但每周只触发十次的工作流，可能比高频生成低质量评论更值得保留。

## 失败与回滚

| 失败模式 | 兜底策略 |
| --- | --- |
| Agent 引用过期 diff | checker 验证 input SHA；不一致即 `expired` |
| issue 文本诱导越权行为 | 将文本作为非指令 data；safe output 和 token 独立约束 |
| 置信度很高但证据为空 | 强制 receipt schema；缺证据只能建议人工调查 |
| 建议过多淹没 reviewer | 设置每 PR 上限与 no-op 合法出口 |
| workflow 误写仓库 | 使用只读 token；将写操作拆到独立的窄权限契约 |
| 规则/模型升级后质量漂移 | 固定回归集，比较 task contract 与模型版本 |

回滚的基本动作应是禁用触发器、撤销窄 token、保留 receipt 供复盘，而不是删除证据后假装从未发生。

## 工程判断与局限

这套方式比“让 Agent 自由执行”慢，也会增加 schema、fixture 和审阅成本；对一次性的创意任务并不划算。但在重复、可审计、跨人协作的工作中，交付契约能把模型不确定性限制在建议层，把平台权限和业务责任留在确定性控制面。

论文对 TAR 可用性的主张、平台文档的 safe outputs 机制和本文的契约设计是三个不同层次：前两者提供问题与能力背景，后者是我的工程组合。没有组织自己的历史样本和 reviewer 数据，就不能宣称它会提高质量或 ROI。

## 发布前自审

- **事实可靠性**：平台行为引用官方文档；研究主张标记为研究建议。
- **具体性**：包含任务契约、状态机、回执 schema、运行策略、SOP 和指标。
- **人工审核点**：明确 reviewer、maintainer 与平台权限职责。
- **失败与回滚**：涵盖过期证据、提示注入、权限越界和质量漂移。
- **非薄内容/非标题党**：没有宣称自主交付，主题聚焦可审计变更。
