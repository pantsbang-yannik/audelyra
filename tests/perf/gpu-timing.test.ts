import { describe, it, expect } from 'vitest'
import { GpuTimingAccumulator, COVERAGE_WARN_THRESHOLD } from '../../src/perf/gpu-timing'

describe('GpuTimingAccumulator 批次记账', () => {
  it('把批次总时长摊成「每帧均值」——覆盖 4 帧、总 20ms → 5ms', () => {
    const acc = new GpuTimingAccumulator()
    for (let i = 0; i < 4; i++) acc.onFrame()
    acc.endBatch(acc.beginBatch(), 20)
    const s = acc.summarize(4)!
    expect(s.batchAvgMs.p50).toBe(5)
    expect(s.batches).toBe(1)
    expect(s.framesCovered).toBe(4)
    expect(s.coverage).toBe(1)
  })

  it('第二批只覆盖自上批 beginBatch 以来的帧数', () => {
    const acc = new GpuTimingAccumulator()
    for (let i = 0; i < 4; i++) acc.onFrame()
    acc.endBatch(acc.beginBatch(), 20)   // 覆盖 4 帧 → 5ms/帧
    for (let i = 0; i < 2; i++) acc.onFrame()
    acc.endBatch(acc.beginBatch(), 12)   // 只覆盖新的 2 帧 → 6ms/帧
    const s = acc.summarize(6)!
    expect(s.batches).toBe(2)
    expect(s.framesCovered).toBe(6)
    expect(s.batchAvgMs.max).toBe(6)
  })
})

describe('single-flight', () => {
  it('in-flight 期间不许发起新批', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    expect(acc.canStartBatch()).toBe(true)
    const e = acc.beginBatch()
    expect(acc.canStartBatch()).toBe(false)
    acc.endBatch(e, 10)
    expect(acc.canStartBatch()).toBe(true)
  })
})

describe('被丢弃的批次', () => {
  it('endBatch(null) 立即解除 in-flight，不因丢弃而卡死后续采样', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), null)
    expect(acc.canStartBatch()).toBe(true)
  })

  it('droppedBatches 与 batches 分开计数，且丢弃不影响后续批的覆盖帧数', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), null)   // 丢弃：本批覆盖的 1 帧就此损失
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), 10)     // 成功——有它 summarize 才非 null
    const s = acc.summarize(2)!
    expect(s.droppedBatches).toBe(1)
    expect(s.batches).toBe(1)
    expect(s.framesCovered).toBe(1)        // 只有成功批的 1 帧被覆盖
    expect(s.coverage).toBe(0.5)
  })
})

describe('epoch 校验：陈旧回调不许污染新会话', () => {
  it('reset 后落地的旧批回调被丢弃，不产生样本也不解除新批的锁', () => {
    const acc = new GpuTimingAccumulator()
    for (let i = 0; i < 4; i++) acc.onFrame()
    const staleEpoch = acc.beginBatch()   // 批 A 发起，尚未 resolve
    acc.reset()                            // 会话边界（bench 切场景）
    for (let i = 0; i < 2; i++) acc.onFrame()
    acc.beginBatch()                       // 批 B 发起
    acc.endBatch(staleEpoch, 20)           // 批 A 的异步回调姗姗来迟
    expect(acc.canStartBatch()).toBe(false) // 批 B 仍在飞，锁不许被旧回调解开
    expect(acc.summarize(2)).toBeNull()     // 旧批时长不许被摊进新会话
  })

  it('同一 epoch 只生效一次，重复 endBatch 不重复计数', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    const e = acc.beginBatch()
    acc.endBatch(e, 10)
    acc.endBatch(e, 10)   // 重复投递（three 的 Promise 复用可能导致）
    const s = acc.summarize(1)!
    expect(s.batches).toBe(1)
  })
})

describe('覆盖率', () => {
  it('coverage = 覆盖帧数 / 总帧数', () => {
    const acc = new GpuTimingAccumulator()
    for (let i = 0; i < 3; i++) acc.onFrame()
    acc.endBatch(acc.beginBatch(), 9)
    // 之后又跑了 7 帧但没再采样
    const s = acc.summarize(10)!
    expect(s.coverage).toBeCloseTo(0.3, 5)
    expect(s.coverage).toBeLessThan(COVERAGE_WARN_THRESHOLD)
  })
})

describe('无样本时返回 null 而不是 0', () => {
  it('一批都没成功 → summarize 返回 null（调用方据此记 reason）', () => {
    const acc = new GpuTimingAccumulator()
    for (let i = 0; i < 5; i++) acc.onFrame()
    expect(acc.summarize(5)).toBeNull()
  })

  it('只有被丢弃的批次也返回 null', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), null)
    expect(acc.summarize(1)).toBeNull()
  })
})

describe('零覆盖帧的批次不产生样本', () => {
  it('两次 beginBatch 之间没有新帧 → 不记样本（防除零）', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), 10)
    acc.endBatch(acc.beginBatch(), 10)   // 中间没有 onFrame
    const s = acc.summarize(1)!
    expect(s.batches).toBe(1)
    expect(Number.isFinite(s.batchAvgMs.p50)).toBe(true)
  })
})

describe('reset', () => {
  it('清空全部记账', () => {
    const acc = new GpuTimingAccumulator()
    acc.onFrame()
    acc.endBatch(acc.beginBatch(), 10)
    acc.reset()
    expect(acc.summarize(1)).toBeNull()
    expect(acc.canStartBatch()).toBe(true)
  })
})
