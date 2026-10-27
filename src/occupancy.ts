// 占用量（occupancy）解析的纯函数：从 tokenMeter 测量结果或
// sessionProjections 的 contextPressure 行中选出最能代表“当前请求压力”的
// token 数。供 index.ts 的 nudge 基线与增长测量使用；全部输入缺失时返回
// null，由调用方把整个特性降级为 no-op。
//
// 背景：nudge 曾经只认 chars/4 启发式的 surfaceTokens，对 CJK 与 JSON 密集
// 的会话系统性低估（token-meter 自己的文档承认这一点），长会话会涨到真实
// 压力 75% 仍一次提醒都不发。因此这里优先取 provider 真实 usage 锚定的值。

export interface TokenMeasurementLike {
  /** 官方测量的当前请求压力：provider usage 锚 + 表面增量重定价。 */
  totalTokens?: unknown
  /** 同一次测量的启发式表面值（chars/4 口径）。 */
  surfaceTokens?: unknown
}

export interface PressureRowFields {
  pressureTokens: number | null
  surfaceTokens: number | null
  sampledSurfaceTokens: number | null
  projectedTokens: number | null
}

export function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// contextPressure 行的三种可能形态：{ ver, seq, val } 持久化包装、解包后的
// 投影对象、展示层 view() 的现算结果。统一读出数值字段。
export function pressureRowFieldsOf(row: unknown): PressureRowFields {
  const rec = row as { val?: unknown } | null | undefined
  const inner = rec && typeof rec === 'object' && rec.val && typeof rec.val === 'object' ? rec.val : row
  const p = (inner ?? {}) as Record<string, unknown>
  return {
    pressureTokens: numberOrNull(p.pressureTokens),
    surfaceTokens: numberOrNull(p.surfaceTokens),
    sampledSurfaceTokens: numberOrNull(p.sampledSurfaceTokens),
    projectedTokens: numberOrNull(p.projectedTokens),
  }
}

// 官方展示层 view() 的同款公式：pressureTokens + (surfaceTokens −
// sampledSurfaceTokens)，无采样锚时退回 pressureTokens 本身。
export function projectedPressureFromRow(fields: PressureRowFields): number | null {
  if (fields.projectedTokens !== null) return fields.projectedTokens
  if (fields.pressureTokens === null) return null
  if (fields.surfaceTokens !== null && fields.sampledSurfaceTokens !== null) {
    return Math.max(0, fields.pressureTokens + fields.surfaceTokens - fields.sampledSurfaceTokens)
  }
  return fields.pressureTokens
}

// tokenMeter 测量结果的占用值：优先 totalTokens（provider 锚定，即官方
// projectedTokens 的同源口径），退回 surfaceTokens。
export function occupancyFromMeasurement(m: TokenMeasurementLike | null | undefined): number | null {
  if (!m || typeof m !== 'object') return null
  return numberOrNull(m.totalTokens) ?? numberOrNull(m.surfaceTokens)
}
