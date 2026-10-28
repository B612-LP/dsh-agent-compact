# agent-compact

English · [简体中文](README.zh-CN.md)

Context compression for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): lets the **agent autonomously call** `context_compact` to compress a span of the conversation it chooses — the finished, no-longer-needed middle — and replace it with a checkpoint the agent writes itself.

## Why

Compaction is normally a full-context sweep: the official engine only ever compresses from the start of the conversation, so the opening's task plan and direction are **partially lost along with the compressed information**. `context_compact` compresses **only the span the agent selects** — a finished step, a debugged log exchange, an off-track discussion — while the important opening and the recent context stay intact. Span compaction keeps **information loss from compaction as small as possible** — like human memory, the middle is not compressed indiscriminately: what can be summarized is consolidated into a checkpoint, and important details stay word-for-word — the agent decides what is truly dead, and only that gets condensed.

The priority is **protecting attention on the user's task**, not compaction for its own sake. Below the quality threshold, stay focused on the task rather than inspecting or compacting solely for maintenance. Necessary careful checks and tool calls remain welcome; this is not an artificial tool-count limit.

Minimize end-to-end work (inspection, reasoning, drafting and retries), not just call count or compression ratio. Write the current continuation state once, not an exhaustive release history or chronology. Consolidate repeated summaries and superseded attempts; retain historical IDs/details only when they explain a current constraint, decision or risk. Preserve current requirements/corrections verbatim and all still-needed dependencies, precise paths/IDs, evidence, risks and next steps. Draft the submitted summary directly and reuse unchanged text on safe retries; do not drop necessary information to meet an arbitrary length or time target.

Typical safe boundaries once quality maintenance is due:

- a task step is done — compress it, keep the remaining steps and the active instruction live;
- a bug hunt or a wrong research direction is over — compress that exchange into a short "what went wrong / root cause / fix" note;
- the opening requirements are stale — compress the start and restate the current intent.

## What it does

- **Two normal calls:** `action: "inspect"` returns `scanId`, the closed-surface semantic landmark index and exact structural range boundaries; then `action: "compact", scanId, ranges: [{startSeq, endSeq, summary}, ...]` checkpoints **all selected completed content together**. No mandatory per-range prepare. Inspection reports coverage and any cap omissions explicitly (default/max 200 semantic landmarks), without sampling away middle candidates; auxiliary/tool rows remain reachable with optional focused detail/search.
- **No plugin size or savings gates:** 3000-token or smaller completed ranges may participate. A range may cover several contiguous completed topics, and disjoint ranges keep intervening live content intact. The agent decides semantic completion using the conversation already in context; structural candidates are not automatic recommendations. Never sacrifice required details or swallow unfinished work merely to save tokens.
- Scans and batch receipts are session-bound and bounded (latest 2 scans / 4 receipts), with no wall-clock expiry: slow drafting alone does not force a rescan or rewrite. New scans/receipts can evict older handles; plugin reloads or session replacement also invalidate them. Legacy prepared plans keep their ten-minute lifetime. All selected members validate before mutation; host commits run serially under one session lock and revalidate selected content. Outside appends and advisory repricing are allowed. Host engine failures can leave a **partial batch**: per-member receipts identify committed versus untouched ranges, with raw archives; there is no all-or-nothing rollback. Replay `scanId` alone to read the receipt without repeating summaries or completed commits.
- Legacy `startAnchor` / `endAnchor` calls remain supported with strict unique-prefix matching of actual message text (never reasoning/tool arguments). A bad selection returns current boundary candidates without modifying history. Legacy optional preparation checks structure only; the normal path is one batch inspection followed by one batch commit.
- The raw span is archived to the spill store first (`~/.dsh/spill/session-<hash>/<hex>-<seq>.txt`, sequential naming, restart-safe); the path is echoed in the shadow message so the model can read the raw text back.
- The host engine runs the stock transaction — boundary validation, tool-pair balance and surface replacement. The v5 optimizer binds submitted checkpoints to the matching engine, agent, asynchronous operation, span and replay input. Cordis proxies and HMR are normalized to the real engine identity, avoiding stacked recursive wrappers and silent summary-ticket misses. Other incompatible host paths may still invoke the official LLM summarizer. This is **not a guarantee of no extra request**. The result reports actual committed checkpoint pricing separately when available; submitted-summary estimates are not presented as verified real savings.

The tool call itself happens inside the agent's normal turn and is billed like any other turn. Provider overloads can still reject a manual official compaction; this plugin does not change the host command's retry policy.

## Install

```sh
# from a published registry package
dsh plugin --profile web add @mimichunterz/agent-compact

# or from a local checkout
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` forwards to pnpm in the profile directory and appends the bundle to `dsh.profile.bundles` (see the official [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)). **Restart the profile** — every session then sees the `context_compact` tool.

The bundle's own `cordis.patch.yml` pins the spill archive root to `~/.dsh/spill` (deployments can override it again through the profile's `cordis.patch.yml`).

## Uninstall

```sh
dsh plugin --profile web remove @mimichunterz/agent-compact
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory: it uninstalls the package and reconciles the bundle out of `dsh.profile.bundles`. **Restart the profile** — every session then stops seeing the `context_compact` tool. The same package name works whether you installed from the registry or from a local checkout.

If the plugin was additionally mounted through a row in the profile's `cordis.patch.yml` (dev mode), remove that row too, otherwise the patch re-mounts it on the next boot.

## Configuration

| field | default | meaning |
|---|---|---|
| `autoArchive` | `true` | `context_compact` saves the full raw span to a spill artifact before replacing it |
| `minSourceTokens` | `0` | Deprecated compatibility field, ignored: no minimum source-size gate. |
| `minNetSavingsTokens` | `0` | Deprecated compatibility field, ignored: net estimates are informational, never a per-range rejection gate. |
| `volumeNudgeTokens` | `350000` | Primary **absolute current-occupancy** threshold: quality-maintenance reminders start only at this amount (350k) and stop immediately below it, even after a previously active reminder. No earlier 300k/250k notice or lower reset threshold. Independent of 500k/1M window size, and not growth since the last compaction. `0` disables these reminders. |
| `autoSafetyMarginTokens` | `65536` | Secondary overflow guard: warn before the routed official fallback line by this token margin (capped for very small models). When the official line is above the quality threshold, both the warning and its reset target are floored at that threshold. Earlier safety warnings remain allowed only when the official hard fallback line is at or below the quality threshold, or quality reminders are disabled. |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## How it works

- **Agent-written checkpoints**: each selected batch range carries its full `summary`. `runWithExternalSummary(engine, agent, summary, run, {start, end})` uses an operation-local asynchronous ticket; `finally` revokes it on success, abort or failure. A matching `compactRegion` and replay input are required; direct/unrelated summarize calls cannot steal it. Old v4 proxy wrapper chains are safely recovered on real Basic engine prototypes; no session-ID summary cache is used.
- **System-prompt guidance**: the bundle registers a global prompt section (`tool:context_compact`, order 118) that tells the agent to protect task attention below the threshold and, when maintenance is due, compact finished steps at safe topic boundaries instead of waiting for automatic full-context compaction. Necessary careful task checks are not restricted by a tool-count quota.
- **Absolute context-quality threshold (v0.3.0)**: a required `systemPrompt.context()` contribution (`agent-compact:volume-nudge`, order 50) uses `tokenMeter.measure(session).totalTokens`, the same usage-anchored estimate as the official engine. **Quality-maintenance reminders start only at 350000 tokens and stop below 350000, even if previously active; 300000 is quiet, with no earlier notice or lower latch.** This absolute current-occupancy threshold is identical for 500k and 1M models, not a window percentage or growth since the previous checkpoint. A compaction event never resets the current occupancy; reductions that leave it at or above 350k keep the reminder active. The primary threshold works even when model metadata is unavailable.
- **Secondary overflow guard**: an async assembly waterfall caches model metadata per exact durable provider/model AND LLM service scope and re-renders the same assembly. Admission refresh uses the synchronous registered provider. The official line is `floor(min(C * thresholdRatio, C - requestOutputReservation - headroomTokens))`, including exact-route policy. The absolute `autoSafetyMarginTokens` warning is capped at a quarter of the official budget for small models. If the official line is above the quality threshold, both the warning and safety-reset target are floored at the configured quality threshold (350k by default): a normal 500k route cannot warn or latch below it (default official line 400k, warning/reset 350k). A default 1M route retains its later warning/reset lines. **Earlier safety warnings are an exception only when the official hard fallback line is at or below the quality threshold, or quality reminders are disabled.** Missing/mismatched metadata never fabricates a capacity; losing metadata cannot certify an already unsafe route as recovered until its budget is known again. Model changes and host reloads re-evaluate pressure.
- **One concentrated maintenance pass**: inspect once, choose all concluded ranges from the conversation already in context, then batch commit. Multiple completed topics can share a contiguous range; there is no one-subtask-per-call rule or per-range source/net gate. Preserve exact requirements/corrections, paths/IDs, decisions, evidence, risks and next steps. Keep intervening live gaps and in-flight work; unrelated running jobs do not block completed content. Return to the task below the threshold.
- **Emergency fallback is unchanged**: the plugin does not disable, defer or intercept the official auto-compactor. A model can ignore a prompt or a single large input/tool result can cross the official line in one step; this is not a guarantee that official summarization can never occur. The purpose is to provide a large early maintenance window rather than waiting for that emergency. Pressure-mode changes are logged with plugin version, session ID, pressure, official limit and target (no conversation text).
- **Anchor matching** (`src/normalize.ts`): `normText` collapses whitespace and maps CJK full-width punctuation to half-width (，→, etc.), applied to both anchors and node text. Matching keeps **unique-prefix** semantics: zero hits → "not found" with closest-node hints; more than one hit → "AMBIGUOUS".
- **Restart-safe sequential archives**: the next number is derived by scanning the session's spill directory (`max+1`) — gap-free; the backend's random hex prefix makes filename collisions impossible.
- **Conservative cleanup**: only a pure, single direct `context_compact` tool-call message may be paired with its result for cleanup. Prose, reasoning, multiple calls, and Code Mode root messages are never discarded. Informational batch estimates count the submitted call once and reserve result/cleanup overhead, without assuming cleanup succeeds. Reported source counts are **gross replaced tokens**, not net savings.
- **Serialized compaction and preflight**: acquire the plugin session lock before any await, use official tool-pairing validation and recheck selected content/route after archival. Batch pricing is informational; legacy prepared plans also bind prices. Outside appends are allowed, but targets never silently switch. Basic still performs its own whole-surface stability check: concurrent traffic may legitimately reject a commit; inspect again instead of blindly retrying the old checkpoint. No operation claims that its selected task is semantically safe just because preflight passes.
- **Spill backend fallback**: with a local spill backend the root is fixed; other backends degrade gracefully (no `root` field → in-memory counter), and compaction itself is unaffected.

## License

MIT. The patch derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
