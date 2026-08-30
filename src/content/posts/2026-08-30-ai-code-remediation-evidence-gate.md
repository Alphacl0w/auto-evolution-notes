---
title: "AI 修复 AI 生成代码：把静态告警变成补丁发布的证据门"
description: "基于近期 Just-in-Time 漏洞修复研究，本文给出一个授权代码库内的安全修复流水线：SARIF 归一化、证据包、最小补丁、双重验证与人工发布门，重点控制“修复引入新漏洞”的回归风险。"
pubDate: 2026-08-30
track: "security"
category: "安全工程"
tags:
  - "AI-generated code"
  - "secure coding"
  - "static analysis"
  - "CodeQL"
  - "SARIF"
  - "security remediation"
  - "human in the loop"
draft: false
---

## 来源说明与边界

本文主要参考 2026 年 8 月发布的 [Securing AI-Generated Code](https://arxiv.org/abs/2608.16187)。该预印本在 26 个 LLMSecEval prompt、四个模型和 80 次运行中，将 CodeQL、Bandit 与独立的 LLM validator 组合，并比较是否将初始静态告警一并交给修复模型。论文作者报告：带入静态告警的 P2 在其设置中优于仅使用富化 validator 结果的 P1，但 15% 至 22% 的修复仍引入至少一个新 finding。

我也参考 [GitHub 关于 SARIF 的官方文档](https://docs.github.com/en/code-security/concepts/code-scanning/sarif-files) 和 [CodeQL SARIF 输出说明](https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-cli/sarif-output)：SARIF 是静态分析结果的 JSON 交换格式，且 CodeQL 可以在路径问题中输出 `codeFlows`。这些文档只用于界定结果接口。

本文讨论的是**已授权代码库**的防御性开发流程，不提供针对第三方系统的测试或利用步骤。论文结果是作者的受控实验报告，不构成“AI 可以自主修复并发布安全补丁”的证明。

## 先给结论

AI 修复代码的正确目标不是“让告警数量下降”，而是让每一份候选补丁同时满足四个可检查条件：

```text
原 finding 已消失
AND 功能/契约未被破坏
AND 没有引入同类或相邻的新 finding
AND 补丁理由能追溯到具体证据与范围
```

静态告警应是修复 Agent 的**输入证据**，而不是最终裁决；LLM 的解释应是审阅材料，而不是修改授权。我的建议是将流水线拆成 `detect -> normalize -> enrich -> patch -> verify -> release gate` 六段，并令每一段留下版本化 artifact。高影响补丁仍必须由代码 owner 批准。

## 技术问题：为什么“扫描后让模型修一下”会失控

一个常见但危险的闭环是：

```text
AI 生成代码 -> SAST 告警 -> LLM 读告警 -> 直接改代码 -> 告警减少 -> 合并
```

它隐含三项未经验证的假设：告警定位正确、修复没有破坏业务语义、修复没有把风险移到分析器看不见的位置。近期论文恰好暴露了第三点：即便 P2 在作者实验中将 pooled 静态 finding 降幅从 P1 的 42% 加深到 57%，所有配置仍有 15% 到 22% 的修复引入新 finding。

因此，finding count 是必要指标，但不是发布条件。一个更有用的结果分类是：

| 结果 | 可以推断什么 | 不能推断什么 |
| --- | --- | --- |
| 原告警消失 | 对应规则在当前版本未再命中 | 漏洞一定被彻底消除 |
| 单测通过 | 已覆盖的行为未回归 | 所有安全语义正确 |
| 新告警出现 | 补丁可能扩大了风险面 | 新告警一定可利用 |
| LLM 解释合理 | 有一个待审阅的假设 | 补丁可以自动合并 |

## 机制拆解：让修复模型面对完整而最小的证据包

### 1. 归一化，而不是把原始扫描日志塞进 prompt

CodeQL 与其他扫描器可以经 SARIF 接口交互，但两个 result 的文本相似不代表它们是同一个问题。归一化层应稳定提取 rule、文件、位置、指纹、严重度、路径流和工具版本：

```ts
type Finding = {
  fingerprint: string;
  tool: "codeql" | "bandit" | "other";
  ruleId: string;
  severity: "error" | "warning" | "note";
  location: { uri: string; startLine: number; endLine?: number };
  codeFlow?: { uri: string; line: number; message?: string }[];
  commit: string;
  scannerVersion: string;
};
```

`fingerprint` 必须由稳定规则、相对路径和语义位置生成，不能把临时构建目录或时间戳混进去。否则重扫时无法区分“同一告警仍在”“移动后的同一告警”与“新告警”。

### 2. 富化是理解范围，不是扩大攻击内容

给修复 Agent 的信息应包括目标函数的受限代码窗口、输入输出契约、finding 的稳定字段、相邻调用点、项目安全规范与允许修改文件列表。可以用 CWE 标签说明风险类别，但不要将原始不可信 issue、外部网页内容或 secrets 当作指令输入。

```yaml
patch_task:
  finding: finding:codeql:4d2c
  allowed_paths:
    - src/auth/session.ts
    - tests/auth/session.test.ts
  required_checks:
    - unit:auth-session
    - codeql:security-extended
    - dependency-policy
  prohibited_changes:
    - ci/
    - infra/
  evidence_refs:
    - sarif:baseline:4d2c
    - policy:input-validation-v2
```

允许路径与禁止路径不是形式主义：修复一个输入校验问题时，Agent 不应顺手关闭扫描规则、改宽权限或重写无关鉴权层。

### 3. 只接受最小、可解释的补丁

输出不应是“这是修复后的完整文件”，而是最小 diff 加结构化说明：

```json
{
  "claim": "在进入命令执行适配器前拒绝未在 allowlist 中的子命令",
  "changed_files": ["src/runner/adapter.ts", "tests/runner/adapter.test.ts"],
  "evidence_used": ["finding:codeql:4d2c", "policy:command-exec-v3"],
  "assumptions": ["调用方不依赖任意子命令透传"],
  "verification_plan": ["unit:runner", "sast:delta", "owner-review"]
}
```

`assumptions` 是人工审阅的重点。模型不知道的业务兼容性不能被“看起来更安全”的代码掩盖。

## 架构：检测、修复、验证和发布彼此独立

```text
authorized commit
      |
      v
[parallel scanners] ----> immutable SARIF baseline
      |                          |
      v                          v
[dedupe + policy] ------> evidence packet
                                 |
                                 v
                         [patch proposer, no merge permission]
                                 |
                                 v
                     isolated checkout + tests + rescan
                                 |
                    +------------+------------+
                    |                         |
                    v                         v
                 evidence diff           owner review
                    |                         |
                    +--------> release gate <-+
```

修复 Agent 只具有临时工作区写权限；扫描器只读代码；release gate 读取完整 artifact，但没有生成代码的职责。这样才能避免同一模型同时定义问题、编写修复、判断自己修复正确并合并。

## 补丁状态机

```text
detected -> normalized -> triaged -> patch-proposed -> verifying
   -> accepted-for-review -> approved -> merged
   -> rejected | superseded | verification-failed

any state --(baseline changed)--> stale -> re-triage
```

从 `verifying` 到 `accepted-for-review` 的条件应是确定的：原 finding 不命中、测试通过、没有不可接受的新增 finding、改动路径符合任务范围。任何一个条件不足就进入 `verification-failed`，而非让 Agent 再无限尝试。

## 验证契约：比较的是 patch 前后风险面

静态分析 delta 需要以同一工具版本、同一查询集、同一构建设置运行。否则“告警减少”可能只是规则或覆盖范围变化。GitHub 文档也指出，SARIF 结果包含位置、描述等结构字段，且不稳定的 rule 名称或 URI 会造成重复和处理问题。

```yaml
verification:
  baseline:
    commit: base_sha
    scanners:
      - codeql@2.x:security-extended
      - bandit@1.7.x
  candidate:
    commit: patch_sha
  accept_if:
    original_fingerprint: absent
    tests: passed
    new_error_findings: 0
    changed_paths_subset_of: patch_task.allowed_paths
  escalate_if:
    - path_outside_scope
    - auth_or_crypto_changed
    - finding_fingerprint_unstable
```

当规则只报告代码味道而非可达漏洞时，仍可通过 owner review 接受补丁；但这必须作为明确人工例外，不应由模型自判。

## 可验证指标

| 指标 | 计算 | 用途 |
| --- | --- | --- |
| 原 finding 消除率 | 原指纹消失的 patch / 已验证 patch | 衡量目标修复是否生效 |
| 新 finding 引入率 | 含新增 finding 的 patch / 已验证 patch | 约束“修旧生新” |
| 语义回归率 | 测试/人工审阅失败 patch / 已验证 patch | 衡量功能风险 |
| 证据完整率 | 具备 baseline、diff、重扫和测试 artifact 的 patch 比例 | 避免不可审计自动化 |
| 审批推翻率 | 被 owner 拒绝的候选 / 已审候选 | 发现 prompt 或任务边界问题 |
| 中位验证时延 | 从候选到可审证据包的时间 | 不用盲目自动合并换速度 |

论文作者报告的 15% 到 22% 新 finding 比例正说明：即使静态 finding 总数下降，也应把“新问题引入率”作为一等指标。具体阈值取决于语言、规则集和业务风险，不能照搬论文数字。

## 我会如何实现：一周受控试点

1. 选择一个有完整测试和 CodeQL 配置的内部仓库，只处理低至中风险、可局部修改的 finding。
2. 固定 scanner 容器/版本和 SARIF schema，存储 baseline 与 candidate 的 fingerprints、覆盖信息、执行日志。
3. 让 Agent 只提交小 diff 到隔离分支，要求产生结构化 evidence note；禁止改 CI、安全规则和依赖锁文件。
4. 运行原有测试、变更相关测试和全量重扫；由 code owner 审批全部候选。
5. 一周后按上表复盘 20 至 50 个候选，将 owner 拒绝原因拆为定位、语义、范围、回归和证据不足五类。

成功标准不是“自动合并多少”，而是：候选能减少人工定位工作、每次拒绝都有可归因的原因、没有因流水线绕过现有发布或安全审批。

## 失败模式与回滚

| 失败模式 | 处理 |
| --- | --- |
| Agent 修改扫描配置让告警消失 | 策略拒绝 `ci/`、规则与基线改动；重置隔离分支 |
| 指纹不稳定导致错误 delta | 固定工具/路径归一化，标记结果 `stale` 并人工复核 |
| 补丁通过 SAST 却破坏业务 | 必须保留契约测试和 owner review；回滚候选，不污染基线 |
| 新 finding 出现 | 不合并；将原始 finding 和新增 finding 作为同一 patch 的回归记录 |
| LLM 提示注入影响修复 | 不可信文本仅作 data，工具权限、路径和发布门由确定性策略控制 |
| 高风险 auth/crypto 改动 | 自动转人工安全审阅，不允许自主修复发布 |

## 局限与自审

SAST 不能证明不存在漏洞，测试也无法穷尽语义；本方案只能让自动修复变得更可审计，不能替代威胁建模、人工安全审查和运行时防御。论文使用的模型、数据集、规则集与 Python 任务不代表其他语言或组织。

- **来源与事实**：所有实验数字均标记为论文作者报告，SARIF/CodeQL 接口来自官方文档。
- **工程价值**：给出数据模型、状态机、验证 YAML、指标和一周试点，而非复述摘要。
- **安全边界**：仅限授权仓库的防御性修复，不提供外部目标攻击步骤。
- **非薄内容**：包含机制图、接口、质量门、回滚和人工审核点。
