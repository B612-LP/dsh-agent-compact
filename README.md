# agent-compact

English · [简体中文](README.zh-CN.md)

Context compression for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): lets the **agent autonomously call** `context_compact` to compress a span of the conversation it chooses — the finished, no-longer-needed middle — and replace it with a checkpoint the agent writes itself.

## Why

Compaction is normally a full-context sweep: the official engine only ever compresses from the start of the conversation, so the opening's task plan and direction are **partially lost along with the compressed information**. `context_compact` compresses **only the span the agent selects** — a finished step, a debugged log exchange, an off-track discussion — while the important opening and the recent context stay intact. Span compaction keeps **information loss from compaction as small as possible** — like human memory, the middle is not compressed indiscriminately: what can be summarized is consolidated into a checkpoint, and important details stay word-for-word — the agent decides what is truly dead, and only that gets condensed.

Typical moments to use it:

- a task step is done — compress it, keep the remaining steps and the active instruction live;
- a bug hunt or a wrong research direction is over — compress that exchange into a short "what went wrong / root cause / fix" note;
- the opening requirements are stale — compress the start and restate the current intent.

## What it does

- Start with `action: "inspect"`: a bounded overview samples semantic landmarks across the entire closed surface, rather than forcing pages of tool results. Groups are navigation bounds, **not selected safe tasks**; use `query` for literal search or `mode: "detail", startSeq, endSeq` to inspect omitted rows. `mode: "messages"` retains legacy pagination. Inspection cursors follow surface order, not numeric sequence order.
- Once the concluded task and complete checkpoint are known, `action: "compact", startSeq, endSeq, summary` commits directly with full validation (no prepare round trip). Otherwise `action: "prepare", startSeq, endSeq` returns a session-bound plan and a conservative budget reserving **both checkpoint and submitted-summary copies**, plus call/result/cleanup reserves; then compact with `planId, summary`. Unusually large mixed/Code Mode submissions may exceed the call envelope: submit compaction alone. Plans expire in ten minutes and reject selected-span, route or price changes; outside appends remain allowed. A successful-plan retry needs only `planId` (omit `summary`), returns `already_compacted` with its receipt and performs no second compaction. Exact full-payload retries are cleaned up only when they are pure single direct calls; mixed prose and Code Mode roots stay intact. Never trim required detail to fit a budget.
- Legacy `startAnchor` / `endAnchor` calls remain supported with strict unique-prefix matching of actual message text (never reasoning/tool arguments). A bad selection returns current boundary candidates without modifying history. Preparation checks structure and size only: the agent must still choose a fully concluded, semantically safe task.
- The raw span is archived to the spill store first (`~/.dsh/spill/session-<hash>/<hex>-<seq>.txt`, sequential naming, restart-safe); the path is echoed in the shadow message so the model can read the raw text back.
- The host engine runs the stock transaction — boundary validation, tool-pair balance and surface replacement. A compatible synchronous engine can consume the submitted checkpoint directly; other host paths may invoke the official LLM summarizer. This is **not a guarantee of no extra request**. The result reports actual committed checkpoint pricing separately when available; submitted-summary estimates are not presented as verified real savings.

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
| `minSourceTokens` | `4096` | Skip smaller source spans without mutation. Keep small tasks intact; never merge unrelated/in-flight work or discard required detail to pass. |
| `minNetSavingsTokens` | `2048` | Minimum estimated reduction after the full framed checkpoint, current submission node and result/cleanup reserves. A 472-token span is intentionally not compacted. Estimates do not claim exact provider or whole-workflow savings. |
| `volumeNudgeTokens` | `300000` | Primary **absolute current-occupancy** bands: notice at 5/6 (250k), continuous maintenance at this amount (300k). Once continuous, keep prompting until below 250k. Independent of 500k/1M window size, and not growth since the last compaction. `0` disables these bands. |
| `autoSafetyMarginTokens` | `65536` | Secondary overflow guard: warn before the routed official fallback line by this token margin (capped for very small models). Never delays/scales the primary 250k/300k quality bands. |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## How it works

- **Agent-written checkpoint**: `summary` is mandatory only for commit. `runWithExternalSummary()` installs a one-shot ticket per engine + agent identity only in the synchronous call into Basic; `finally` removes it even on abort/rejection. No ticket is installed during archival. Legacy session-ID summary caches are discarded, so a failed call cannot leave text for a later official compaction. Without a ticket the stock summarizer remains unchanged.
- **System-prompt guidance**: the bundle registers a global prompt section (`tool:context_compact`, order 118) that tells the agent to use `context_compact` proactively — compress finished steps at topic boundaries instead of waiting for automatic full-context compaction.
- **Absolute context-quality bands (v0.2.4)**: a required `systemPrompt.context()` contribution (`agent-compact:volume-nudge`, order 50) uses `tokenMeter.measure(session).totalTokens`, the same usage-anchored estimate as the official engine. **250k starts a notice; 300k starts continuous maintenance until below 250k.** These are absolute current-occupancy bands for both 500k and 1M models, not window percentages and not growth since the previous checkpoint. A compaction event never clears the current occupancy or its continuous-maintenance state; inadequate reductions keep the reminder active. The primary bands work even when model metadata is unavailable.
- **Secondary overflow guard**: an async assembly waterfall caches model metadata per exact durable provider/model AND LLM service scope and re-renders the same assembly. Admission refresh uses the synchronous registered provider. The official line is `floor(min(C * thresholdRatio, C - requestOutputReservation - headroomTokens))`, including exact-route policy. An absolute `autoSafetyMarginTokens` warning (capped at a quarter of the official budget only for small models) protects routes whose fallback line arrives earlier; it does not move the primary quality bands. Missing/mismatched metadata never fabricates a capacity. Model changes and host reloads re-evaluate pressure.
- **Safe, useful chunks**: prioritize substantial concluded sub-tasks before optional new work, one span per call, and continue if still high. Preserve requirements/corrections verbatim, exact paths/IDs, decisions, verified evidence, unresolved risks and next steps. Protect in-flight spans; unrelated running jobs do not block other concluded spans. If no useful safe span exists, keep the information and explain the blocker instead of forcing a lossy checkpoint.
- **Emergency fallback is unchanged**: the plugin does not disable, defer or intercept the official auto-compactor. A model can ignore a prompt or a single large input/tool result can cross the official line in one step; this is not a guarantee that official summarization can never occur. The purpose is to provide a large early maintenance window rather than waiting for that emergency. Pressure-mode changes are logged with plugin version, session ID, pressure, official limit and target (no conversation text).
- **Anchor matching** (`src/normalize.ts`): `normText` collapses whitespace and maps CJK full-width punctuation to half-width (，→, etc.), applied to both anchors and node text. Matching keeps **unique-prefix** semantics: zero hits → "not found" with closest-node hints; more than one hit → "AMBIGUOUS".
- **Restart-safe sequential archives**: the next number is derived by scanning the session's spill directory (`max+1`) — gap-free; the backend's random hex prefix makes filename collisions impossible.
- **Conservative cleanup**: only a pure, single direct `context_compact` tool-call message may be paired with its result for cleanup. Prose, reasoning, multiple calls, and Code Mode root messages are never discarded. Value checks conservatively charge the current call and reserves rather than assuming asynchronous cleanup succeeds. Reported source counts are **gross replaced tokens**, not net savings.
- **Serialized compaction and preflight**: acquire the plugin session lock before any await, use official tool-pairing validation and recheck span content, route and pricing after archival. Plans permit outside appends but never silently switch targets. Basic still performs its own whole-surface stability check: concurrent traffic may legitimately reject a commit; inspect again instead of blindly retrying the old checkpoint. No operation claims that its selected task is semantically safe just because preflight passes.
- **Spill backend fallback**: with a local spill backend the root is fixed; other backends degrade gracefully (no `root` field → in-memory counter), and compaction itself is unaffected.

## License

MIT. The patch derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
