import test from 'node:test'
import assert from 'node:assert/strict'
import {
  numberOrNull,
  pressureRowFieldsOf,
  projectedPressureFromRow,
  occupancyFromMeasurement,
} from '../lib/occupancy.js'

// ---- numberOrNull ----

test('numberOrNull passes finite numbers and rejects everything else', () => {
  assert.equal(numberOrNull(376221), 376221)
  assert.equal(numberOrNull(0), 0)
  assert.equal(numberOrNull(undefined), null)
  assert.equal(numberOrNull(null), null)
  assert.equal(numberOrNull('376221'), null)
  assert.equal(numberOrNull(Number.NaN), null)
  assert.equal(numberOrNull(Number.POSITIVE_INFINITY), null)
})

// ---- pressureRowFieldsOf：行形态兼容 ----

test('pressureRowFieldsOf unwraps the persisted { ver, seq, val } row shape', () => {
  // 形状对齐真实 projcache：~/.dsh/storages/session_projcache/sessions/*.json
  const row = {
    ver: 5,
    seq: 7171,
    val: { surfaceTokens: 234710, contextWindow: 500000, pressureTokens: 376221, sampledSurfaceTokens: 234493 },
  }
  assert.deepEqual(pressureRowFieldsOf(row), {
    pressureTokens: 376221,
    surfaceTokens: 234710,
    sampledSurfaceTokens: 234493,
    projectedTokens: null,
  })
})

test('pressureRowFieldsOf reads an already-unwrapped projection object', () => {
  const row = { pressureTokens: 100, surfaceTokens: 90, sampledSurfaceTokens: 80 }
  assert.equal(pressureRowFieldsOf(row).pressureTokens, 100)
})

test('pressureRowFieldsOf tolerates null/undefined rows and missing fields', () => {
  assert.deepEqual(pressureRowFieldsOf(null), { pressureTokens: null, surfaceTokens: null, sampledSurfaceTokens: null, projectedTokens: null })
  assert.deepEqual(pressureRowFieldsOf(undefined), { pressureTokens: null, surfaceTokens: null, sampledSurfaceTokens: null, projectedTokens: null })
  assert.deepEqual(pressureRowFieldsOf({ ver: 5, seq: 1, val: {} }), { pressureTokens: null, surfaceTokens: null, sampledSurfaceTokens: null, projectedTokens: null })
})

// ---- projectedPressureFromRow：官方 view() 同款公式 ----

test('projectedPressureFromRow recomputes the official view formula from the real regression case', () => {
  // 真实长会话（CJK+JSON 密集）的投影：chars/4 表面值 23.4 万，provider
  // 真实压力 37.6 万——修复前 nudge 因此从未触发。
  const fields = pressureRowFieldsOf({
    ver: 5,
    seq: 7171,
    val: { surfaceTokens: 234710, contextWindow: 500000, pressureTokens: 376221, sampledSurfaceTokens: 234493 },
  })
  assert.equal(projectedPressureFromRow(fields), 376221 + 234710 - 234493)
})

test('projectedPressureFromRow prefers an already-computed projectedTokens (view result)', () => {
  const fields = pressureRowFieldsOf({ pressureTokens: 100, surfaceTokens: 90, sampledSurfaceTokens: 80, projectedTokens: 123 })
  assert.equal(projectedPressureFromRow(fields), 123)
})

test('projectedPressureFromRow falls back to pressureTokens without a sampling anchor', () => {
  assert.equal(projectedPressureFromRow(pressureRowFieldsOf({ pressureTokens: 555 })), 555)
})

test('projectedPressureFromRow clamps negative results to zero and returns null without an anchor', () => {
  const clamped = pressureRowFieldsOf({ pressureTokens: 10, surfaceTokens: 5, sampledSurfaceTokens: 100 })
  assert.equal(projectedPressureFromRow(clamped), 0)
  assert.equal(projectedPressureFromRow(pressureRowFieldsOf({})), null)
})

// ---- occupancyFromMeasurement：tokenMeter 测量口径 ----

test('occupancyFromMeasurement prefers provider-anchored totalTokens over the heuristic surface', () => {
  assert.equal(occupancyFromMeasurement({ totalTokens: 376438, surfaceTokens: 234710 }), 376438)
})

test('occupancyFromMeasurement falls back to surfaceTokens when totalTokens is absent', () => {
  assert.equal(occupancyFromMeasurement({ surfaceTokens: 234710 }), 234710)
})

test('occupancyFromMeasurement returns null for garbage input', () => {
  assert.equal(occupancyFromMeasurement(null), null)
  assert.equal(occupancyFromMeasurement(undefined), null)
  assert.equal(occupancyFromMeasurement({}), null)
  assert.equal(occupancyFromMeasurement('measure'), null)
})

test('occupancyFromMeasurement accepts zero as a legitimate fresh-session value', () => {
  assert.equal(occupancyFromMeasurement({ totalTokens: 0, surfaceTokens: 0 }), 0)
})
