# agent-compact

[English](README.md) · 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供上下文压缩:让 **agent 自主调用** `context_compact`,把对话中一段它选定的、已经用完不再需要的区间,替换成 agent 自己写的检查点。

## 为什么

压缩通常意味着全量清扫:官方引擎只能从会话开头压,开头的任务规划、方向也会随着信息压缩丢失一部分。`context_compact` 只压缩 **agent 选中的那一段** —— 一个完成的工作步骤、一段排查完的日志、一段跑偏的讨论 —— 重要的开头和最近的内容原样保留。**区间压缩把压缩带来的信息丢失降到最小** —— 像人的记忆一样,中间的记忆不是无差别压缩:能总结的巩固成检查点,重要的细节逐字保留 —— 哪些内容真的没用了,由 agent 自己判断,只压那一部分。

典型的使用时机:

- 一个任务步骤完成了 —— 压掉它,剩余步骤和活动指令保持存活;
- 排查完的 bug、一个错误的调研方向 —— 把这段压成简短"错在哪 / 根因 / 修正方向"记录;
- 开头的需求过期了 —— 压掉开头,重新表述当前意图。

## 它做什么

- agent 用 `startAnchor` / `endAnchor` 圈定区间(唯一前缀匹配,全角/半角标点不敏感),并传入**强制要求**的 `summary` —— 自己写的 Markdown 检查点。
- 原始区间全文先归档到 spill(`~/.dsh/spill/session-<hash>/<hex>-<序号>.txt`,顺序命名、重启安全);路径通过 shadow 消息回显,模型可随时读回原文。
- 宿主引擎执行官方事务 —— 边界校验、工具对平衡、表面替换 —— **不发起独立的 LLM 摘要器请求**。

工具调用本身发生在 agent 正常轮次内,按普通轮次正常计费;省掉的只是官方引擎为同一区间"额外再发一次摘要器请求"这件事。

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
| `volumeNudgeTokens` | `300000` | 增长兜底：自上次压缩增长达到该值的 5/6 后持续提醒；`0` 仅关闭此兜底，不关闭绝对压力维护。 |
| `pressureStartRatio` | `0.6` | 在官方自动压缩实际触发线的此比例开始持续维护，不是窗口容量比例。 |
| `pressureTargetRatio` | `0.5` | 压至官方触发线的此比例以下才解除（限制为低于开始线）；必要细节优先于数字目标。 |

通过 profile 的 `cordis.patch.yml` 或 bundle patch 插入行来配置。

## 工作原理

- **agent 自写检查点**:`summary` 是强制参数,工具路径总是走 agent 写的检查点。`patchEngine()`(见 `src/optimizer.ts`)包装引擎的 `summarize()` —— 存在 `_externalSummary`(按会话 id 一次性消费)时直接返回该文本;没有时才转发 stock 实现,该分支只服务于自动压缩路径,保持官方行为不变。
- **系统提示词引导**:插件注册一个全局提示词 section(`tool:context_compact`,order 118),要求 agent **主动**调用 `context_compact` —— 在话题边界压缩已完成的步骤,而不是等自动全量压缩。
- **压力驱动主动维护(v0.2.3)**:required 动态上下文(`agent-compact:volume-nudge`,order 50)使用与官方同源的 `tokenMeter.measure(session).totalTokens`。异步 assembly waterfall 按精确路由及 LLM 服务作用域预取模型信息，并在同一次组装返回前重新生成提示；注册的同步 provider 在请求准入时再次刷新。读取新压力和当前 agent 作用域内官方引擎的已解析配置。官方线为 `floor(min(C*thresholdRatio, C-请求输出预留-headroomTokens))`，包含模型覆盖规则。默认达官方线60%起持续、80%起紧急、压至50%以下解除；**小压缩不能消除仍然偏高的绝对压力提醒**。容量或元数据未知时不伪造阈值，保留增长兜底。切模型、重载后重新评估。
- **保护必要信息**:自然边界主动整理已收尾子任务，每次一个，仍偏满就继续；保留要求/纠正原话、路径/ID、决策、证据、风险及下一步。不动在飞区间；无关后台任务不妨碍压缩其他已结束区间。没有安全有益的跨度时保留并说明原因，不为数字目标强行丢信息。
- **官方只作应急兜底**:不关闭、不拦截、不延迟官方自动压缩。提示无法保证模型必定执行，单次巨大输入/工具返回也可能一步跨过提前维护区，因此不承诺官方压缩永不触发。维护模式变化会记录版本、会话ID、压力、官方线和目标，不记录对话正文。
- **锚点定位**(`src/normalize.ts`):`normText` 折叠空白并把 CJK 全角标点映射为半角(，→, 等),锚点与节点文本共用同一函数;仍保持**唯一前缀**语义(0 命中 → not found + 最近节点提示;多命中 → AMBIGUOUS)。
- **重启安全的顺序归档**:fs 扫描会话目录取 `max+1` 顺序递增,无空洞;后端自带随机 hex 前缀,文件名永不冲突。
- **配对清理**:携带完整 `summary` 参数的工具调用消息节点 + tool/result 各被替换成一条极小的 shadow 消息,避免检查点文本在表面出现两份(同一消息含多个工具调用时安全跳过)。
- **压缩串行化**:每个会话同一时刻只允许一次压缩(引擎事务串行);锚点每次重新解析,重复压缩不会因之前的检查点而过期。
- **spill 后端降级**:本地 spill 后端固定 root;换用其他后端时按可用性降级(无 `root` 字段则回退内存计数),压缩本身不受影响。

## License

MIT。补丁逻辑参考 `@deepseek-ai/dsh-compaction-basic` 及 DeepSeek Harness 相关包(MIT,Copyright DeepSeek)—— 见 [`LICENSE`](LICENSE)。
