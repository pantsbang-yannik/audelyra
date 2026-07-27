import { describe, it, expect } from 'vitest'
import { summarizeReaction, summarySegments, type SummaryBaseline } from '../../src/ui/reaction-summary'
import type { Reaction } from '../../src/scenes/nebula/mapping/types'

/** 造一条反应——只覆盖 UI 暴露的六字段，其余取合法占位值 */
function makeR(over: Partial<Reaction> = {}): Reaction {
  return {
    id: 'body.speed.primary',
    target: { element: 'body', property: 'speed' },
    enabled: true, source: 'tempo', gain: 1, curve: 'linear', smoothingMs: 120,
    inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1,
    ...over,
  }
}
const official = (r: Reaction): SummaryBaseline => ({ kind: 'official', reaction: r })

describe('summarizeReaction（摘要行：只浮出偏离基线的参数）', () => {
  it('与基线完全一致时，只有来源名，没有任何偏离项', () => {
    const r = makeR()
    const s = summarizeReaction(r, official(makeR()))
    expect(s.source).toBe('节奏速度')
    expect(s.deltas).toEqual([])
    expect(s.disabled).toBe(false)
    expect(summarySegments(s)).toEqual({ lead: '节奏速度', note: '' })
  })

  it('gain 偏离基线时浮出「强 X.XX」', () => {
    const s = summarizeReaction(makeR({ gain: 0.6 }), official(makeR({ gain: 1 })))
    expect(s.deltas).toEqual(['强 0.60'])
    // 主段只放来源名，偏离项全进注解段——UI 靠这层拆分把注解渲染得比主段淡一档
    expect(summarySegments(s)).toEqual({ lead: '节奏速度', note: '  强 0.60' })
  })

  it('smoothingMs 偏离时浮出「滑 XXXms」，多项偏离按 强/滑/下限/上限 定序', () => {
    const s = summarizeReaction(
      makeR({ gain: 0.6, smoothingMs: 200, outputMin: 0.45, outputMax: 0.8 }),
      official(makeR()),
    )
    expect(s.deltas).toEqual(['强 0.60', '滑 200ms', '下限 0.45', '上限 0.80'])
  })

  it('浮点尾差在显示精度内不算偏离——比的是格式化结果不是数值', () => {
    const s = summarizeReaction(makeR({ gain: 1.0009 }), official(makeR({ gain: 1 })))
    expect(s.deltas).toEqual([])
  })

  it('显示精度内可分辨的差异才算偏离', () => {
    const s = summarizeReaction(makeR({ gain: 1.02 }), official(makeR({ gain: 1 })))
    expect(s.deltas).toEqual(['强 1.02'])
  })

  it('enabled=false 时标「已关」，且照常罗列其余偏离项——关掉不该吞掉手调过的参数', () => {
    const s = summarizeReaction(makeR({ enabled: false, gain: 0.6 }), official(makeR()))
    expect(s.disabled).toBe(true)
    expect(s.deltas).toEqual(['强 0.60'])
    // 「已关」是这条反应的状态，随来源名同列主段；偏离项仍在注解段，接在其后
    expect(summarySegments(s)).toEqual({ lead: '节奏速度  已关', note: ' · 强 0.60' })
  })

  it('enabled=false 且无偏离项时，注解段为空——只剩「已关」', () => {
    const s = summarizeReaction(makeR({ enabled: false }), official(makeR()))
    expect(summarySegments(s)).toEqual({ lead: '节奏速度  已关', note: '' })
  })

  it('来源被改过不进 deltas——来源名本身就变了，无需重复标记', () => {
    const s = summarizeReaction(makeR({ source: 'beat' }), official(makeR({ source: 'tempo' })))
    expect(s.source).toBe('鼓点')
    expect(s.deltas).toEqual([])
  })

  it('用户手加的反应（基线里没有）常驻显示 强/滑', () => {
    const s = summarizeReaction(makeR({ id: 'u-1', gain: 1, smoothingMs: 120 }), { kind: 'user' })
    expect(s.deltas).toEqual(['强 1.00', '滑 120ms'])
  })

  it('用户手加的反应：下限/上限仍按偏离出厂默认才显示', () => {
    const s = summarizeReaction(makeR({ id: 'u-1', outputMin: 0.45 }), { kind: 'user' })
    expect(s.deltas).toEqual(['强 1.00', '滑 120ms', '下限 0.45'])
  })

  it('宏旋钮未播种（pending）时全部安静——不浮出任何偏离项', () => {
    const s = summarizeReaction(makeR({ gain: 3, smoothingMs: 900 }), { kind: 'pending' })
    expect(s.deltas).toEqual([])
    expect(summarySegments(s)).toEqual({ lead: '节奏速度', note: '' })
  })
})
