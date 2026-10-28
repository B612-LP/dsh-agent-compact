# agent-compact

[English](README.md) · 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供上下文压缩:让 **agent 自主调用** `context_compact`,把对话中一段它选定的、已经用完不再需要的区间,替换成 agent 自己写的检查点。

## 为什么

压缩通常意味着全量清扫:官方引擎只能从会话开头压,开头的任务规划、方向也会随着信息压缩丢失一部分。`context_compact` 只压缩 **agent 选中的那一段** —— 一个完成的工作步骤、一段排查完的日志、一段跑偏的讨论 —— 重要的开头和最近的内容原样保留。**区间压缩把压缩带来的信息丢失降到最小** —— 像人的记忆一样,中间的记忆不是无差别压缩:能总结的巩固成检查点,重要的细节逐字保留 —— 哪些内容真的没用了,由 agent 自己判断,只压那一部分。

首要目的是**保护对用户任务的注意力**，不是为了压缩而压缩。低于质量阈值时专注当前任务，不仅为维护而检查或压缩上下文；必要的细致检查和工具调用仍应正常进行，不人为限制工具次数。

达到质量维护阈值后，典型的安全边界:

- 一个任务步骤完成了 —— 压掉它,剩余步骤和活动指令保持存活;
- 排查完的 bug、一个错误的调研方向 —— 把这段压成简短"错在哪 / 根因 / 修正方向"记录;
- 开头的需求过期了 —— 压掉开头,重新表述当前意图。

## 它做什么

- 正常只需两次调用：先 `action: "inspect"` 一次获取完整语义候选索引、结构边界与 `scanId`；第二次 `action: "compact", scanId, ranges: [{startSeq, endSeq, summary}, ...]` 批量提交全部选中的已完成内容。不再逐段 prepare，也不设单段大小或净收益闸门，3000-token 小段可参加。连续范围可含多个已完成主题，不连续范围之间的在途内容原样保留。
- 候选是否已经完成由 agent 结合现有对话判断，不是工具自动批准。索引默认/最多返回200个语义标记，明确报告上限遗漏及辅助消息/工具结果省略情况；必要时才使用可选搜索或范围详情。所有选中范围先校验，再在同一锁内串行提交。部分失败会返回逐段回执，不能宣称整批回滚或盲目重压已提交段；仅传 scanId 可回读回执。旧单段/锚点/prepare 路径保留兼容，但不再按大小/收益拒绝。
- 原始区间全文先归档到 spill(`~/.dsh/spill/session-<hash>/<hex>-<序号>.txt`,顺序命名、重启安全);路径通过 shadow 消息回显,模型可随时读回原文。
- 宿主引擎执行官方事务：边界校验、工具对平衡、表面替换。v5优化器通过真实Cordis对象、异步操作、选区和replay输入绑定自写检查点，避免动态代理反复包装造成栈溢出及摘要注入失配；不兼容的宿主路径仍可能调用官方摘要器，不作零额外请求保证。

工具调用本身按正常轮次计费；兼容引擎可直接消费自写检查点。官方手动/应急摘要仍可能因上游故障失败，本插件不修改其重试策略。

## 安装

```sh
# 从发布仓库安装
dsh plugin --profile web add @mimichunterz/agent-compact

# 或本地目录
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` 会在 profile 目录内转发给 pnpm 并把 bundle 追加到 `dsh.profile.bundles`(参见官方 [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md))。**重启 profile 后**,所有会话都能看到 `context_compact` 工具。

插件自带的 `cordis.patch.yml` 会把 spill 归档根目录固定到 `~/.dsh/spill`(部署可用 profile 的 `cordis.patch.yml` 再覆盖)。

## 卸载

```sh
dsh plugin --profile web remove @mimichunterz/agent-compact
```

`dsh plugin remove` 在 profile 目录内转发给 `pnpm remove`:卸载包,并把 bundle 从 `dsh.profile.bundles` 中剔除。**重启 profile 后**,所有会话都不再看到 `context_compact` 工具。无论当初是从发布仓库还是本地目录安装的,卸载都用同一个包名。

如果插件是通过 profile 的 `cordis.patch.yml` 行挂载的(dev 模式),还需要把那一行删掉,否则下次启动 patch 会把它重新挂上。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoArchive` | `true` | `context_compact` 在替换区间前先把原始区间全文存到 spill 归档 |
| `minSourceTokens` / `minNetSavingsTokens` | `0` | 仅兼容旧配置，已不执行大小/净收益闸门；估算只供参考。 |
| `volumeNudgeTokens` | `350000` | 绝对当前占用：仅达到此值（35万）才开始质量维护提醒，降至此值以下立即停止，即使此前已激活。30万/25万都不预提醒，也不锁定到更低的解除线。50万/100万窗口一致，不是距上次压缩的增长量。`0` 关闭质量提醒。 |
| `autoSafetyMarginTokens` | `65536` | 补充防溢出：在官方实际线之前留此token余量，小模型自动限制此余量。若官方线高于质量阈值，安全提醒和解除目标都不低于质量阈值；仅官方硬兜底线已不高于质量阈值，或已关闭质量提醒时，允许更早安全提醒。 |

通过 profile 的 `cordis.patch.yml` 或 bundle patch 插入行来配置。

## 工作原理

- **agent 自写检查点**：每个 ranges 成员携带完整 summary。`runWithExternalSummary(engine, agent, summary, run, {start, end})` 使用异步操作局部票据，匹配真实引擎/agent/区间/replay输入，finally在成功、异常或取消时回收。无会话ID摘要缓存，其他调用不能抢用；官方自动压缩不变。
- **系统提示词引导**:插件注册一个全局提示词 section(`tool:context_compact`,order 118)，低于阈值时保护任务注意力，达到维护阈值后在安全话题边界压缩已完成的步骤，而不是等自动全量压缩。必要的细致任务检查不受人为工具次数限制。
- **绝对占用主动维护(v0.3.0)**:required 动态上下文(`agent-compact:volume-nudge`,order 50)使用与官方同源的 `tokenMeter.measure(session).totalTokens`。**仅当前占用达到350000 token才开始质量维护提醒，低于350000立即停止，即使此前已激活；300000仍安静，没有更早预提醒或更低解除锁定线**。50万/100万窗口都用相同阈值，不用窗口百分比，也不是距上次压缩的增长量。压缩事件不清零当前占用，压完仍达到35万就继续；模型元数据不可用也不影响主规则。
- **补充防溢出**:异步 assembly waterfall 按精确路由及 LLM 服务作用域预取元数据，同一组装返回前重算提示，同步 provider 用于准入刷新。官方线为 `floor(min(C*thresholdRatio, C-请求输出预留-headroomTokens))`，包含模型覆盖；安全余量仅在小模型时限制为官方预算的1/4。若官方线高于质量阈值，安全提醒和解除目标都不低于所配置的质量阈值（默认35万）：普通50万路由不会提前提醒或锁定到35万以下（默认官方线40万，提醒/解除线均35万），默认100万路由原有更晚的安全线不变。**仅官方硬兜底线已不高于质量阈值，或质量提醒已关闭时，允许更早安全保护**。未知时不猜容量；已不安全的路由丢失元数据时，也不能在预算重新明确前误判为已恢复安全。
- **保护必要信息**：达到阈值后集中一次检查、第二次批量处理全部选中的已完成内容，再回到任务。不强制每次仅一子任务，也不按单段大小/收益拦截；保留要求/纠正原话、路径/ID、决策、证据、风险及下一步。仅保护在途内容和有效消息结构，不能为省token丢必要信息。
- **官方只作应急兜底**:不关闭、不拦截、不延迟官方自动压缩。提示无法保证模型必定执行，单次巨大输入/工具返回也可能一步跨过提前维护区，因此不承诺官方压缩永不触发。维护模式变化会记录版本、会话ID、压力、官方线和目标，不记录对话正文。
- **锚点定位**(`src/normalize.ts`):`normText` 折叠空白并把 CJK 全角标点映射为半角(，→, 等),锚点与节点文本共用同一函数;仍保持**唯一前缀**语义(0 命中 → not found + 最近节点提示;多命中 → AMBIGUOUS)。
- **重启安全的顺序归档**:fs 扫描会话目录取 `max+1` 顺序递增,无空洞;后端自带随机 hex 前缀,文件名永不冲突。
- **配对清理**:携带完整 `summary` 参数的工具调用消息节点 + tool/result 各被替换成一条极小的 shadow 消息,避免检查点文本在表面出现两份(同一消息含多个工具调用时安全跳过)。
- **批量串行化与回执**：同一会话整批持有一把锁，全部成员先验证再逐段提交，期间重验内容与路由。非全有或全无事务：部分成功保留成功段，未尝试段不动；宿主写入后异常会核对持久证据，不能确认时报告outcome_unknown并保留原文归档，不能冒称未提交或盲目重压。
- **spill 后端降级**:本地 spill 后端固定 root;换用其他后端时按可用性降级(无 `root` 字段则回退内存计数),压缩本身不受影响。

## License

MIT。补丁逻辑参考 `@deepseek-ai/dsh-compaction-basic` 及 DeepSeek Harness 相关包(MIT,Copyright DeepSeek)—— 见 [`LICENSE`](LICENSE)。
