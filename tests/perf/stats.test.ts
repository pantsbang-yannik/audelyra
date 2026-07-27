import { describe, it, expect } from 'vitest'
import { quantiles, capacityFor, FrameStats, JANK_FACTOR, HITCH_MS } from '../../src/perf/stats'
import type { FrameSample, PhaseMs } from '../../src/perf/types'

const ZERO_PHASES: PhaseMs = { signal: 0, mapping: 0, state: 0, visual: 0, camera: 0, submit: 0 }

function sample(intervalMs: number, cpuMs = 1, phases: PhaseMs = ZERO_PHASES): FrameSample {
  return { cpuMs, intervalMs, phases }
}

describe('quantiles', () => {
  it('空数组全部返回 0', () => {
    expect(quantiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
  })

  it('单样本时所有分位数都等于该值', () => {
    expect(quantiles([7])).toEqual({ p50: 7, p95: 7, p99: 7, max: 7 })
  })

  it('用 nearest-rank 取值：100 个升序样本', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    const q = quantiles(xs)
    expect(q.p50).toBe(50)  // ceil(0.50*100)=50 → index 49 → 值 50
    expect(q.p95).toBe(95)
    expect(q.p99).toBe(99)
    expect(q.max).toBe(100)
  })
})

describe('capacityFor', () => {
  it('按 时长 × 刷新率 × 1.2 余量 向上取整', () => {
    expect(capacityFor(60, 60)).toBe(4320)   // 60*60*1.2
    expect(capacityFor(60, 120)).toBe(8640)  // 120Hz 下 60 秒不再丢样本
    expect(capacityFor(30, 60)).toBe(2160)
  })
})

describe('FrameStats 环形缓冲', () => {
  it('写满后回绕，只保留最近 capacity 个样本', () => {
    const st = new FrameStats({ capacity: 3, targetIntervalMs: 16.67 })
    for (const v of [10, 20, 30, 40, 50]) st.push(sample(v))
    expect(st.count).toBe(3)
    // 只剩 30/40/50
    expect(st.summarize().intervalMs.max).toBe(50)
    expect(st.summarize().intervalMs.p50).toBe(40)
  })

  it('reset 后计数归零', () => {
    const st = new FrameStats({ capacity: 10, targetIntervalMs: 16.67 })
    st.push(sample(10))
    st.reset()
    expect(st.count).toBe(0)
    expect(st.summarize().frames).toBe(0)
  })
})

describe('三类掉帧指标在同一组样本上给出不同且各自正确的值', () => {
  // 目标间隔 16.67ms。构造：8 个正常帧(16.7) + 1 个 26ms(超 1.5 倍=25.0，算 jank，
  // round(26/16.67)=2 → 错过 1 次 vsync，未达 33ms 不算 hitch) + 1 个 100ms
  // (jank + round(100/16.67)=6 → 错过 5 次 + 超 33ms 算 hitch)
  const st = new FrameStats({ capacity: 100, targetIntervalMs: 16.67 })
  for (let i = 0; i < 8; i++) st.push(sample(16.7))
  st.push(sample(26))
  st.push(sample(100))
  const s = st.summarize()

  it('jankEventRate 数「慢帧事件」个数占比', () => {
    expect(s.jankEventRate).toBeCloseTo(2 / 10, 5) // 26ms 与 100ms 两帧
  })

  it('missedVsyncRate 数「错过的垂直同步次数」，把长卡顿按倍数放大', () => {
    // 错过总数 = 1 + 5 = 6；期望帧数 = 总时长/目标间隔 = (8*16.7+26+100)/16.67
    const totalMs = 8 * 16.7 + 26 + 100
    expect(s.missedVsyncRate).toBeCloseTo(6 / (totalMs / 16.67), 4)
  })

  it('hitchCount 是绝对次数，只数 >33ms 的帧', () => {
    expect(s.hitchCount).toBe(1) // 只有 100ms 那帧
  })

  it('三者确实不相等——证明不是同一个指标的三种叫法', () => {
    expect(s.jankEventRate).not.toBeCloseTo(s.missedVsyncRate, 3)
  })
})

describe('阈值常量语义', () => {
  it('恰好等于 1.5 倍目标间隔不算 jank（严格大于才算）', () => {
    const st = new FrameStats({ capacity: 10, targetIntervalMs: 10 })
    st.push(sample(10 * JANK_FACTOR)) // 恰好 15
    expect(st.summarize().jankEventRate).toBe(0)
  })

  it('恰好等于 HITCH_MS 不算 hitch（严格大于才算）', () => {
    const st = new FrameStats({ capacity: 10, targetIntervalMs: 16.67 })
    st.push(sample(HITCH_MS))
    expect(st.summarize().hitchCount).toBe(0)
  })
})

describe('分段耗时取 p50', () => {
  it('phasesMs 各段独立统计中位数', () => {
    const st = new FrameStats({ capacity: 10, targetIntervalMs: 16.67 })
    st.push(sample(16.7, 5, { signal: 1, mapping: 2, state: 3, visual: 4, camera: 5, submit: 6 }))
    st.push(sample(16.7, 5, { signal: 3, mapping: 4, state: 5, visual: 6, camera: 7, submit: 8 }))
    const p = st.summarize().phasesMs
    // nearest-rank：2 个样本时 p50 的 index = ceil(0.5*2)-1 = 0，取排序后第 0 个
    expect(p.signal).toBe(1)   // [1,3] → 1
    expect(p.mapping).toBe(2)  // [2,4] → 2
    expect(p.state).toBe(3)    // [3,5] → 3
    expect(p.visual).toBe(4)   // [4,6] → 4
    expect(p.camera).toBe(5)   // [5,7] → 5
    expect(p.submit).toBe(6)   // [6,8] → 6
  })

  it('cpuFrameMs p50 来自 cpuMs 列的分位数', () => {
    const st = new FrameStats({ capacity: 10, targetIntervalMs: 16.67 })
    st.push(sample(16.7, 2))   // cpuMs=2
    st.push(sample(16.7, 8))   // cpuMs=8
    const cpu = st.summarize().cpuFrameMs
    // nearest-rank：2 个样本时 p50 的 index = ceil(0.5*2)-1 = 0，取排序后第 0 个
    expect(cpu.p50).toBe(2)    // [2,8] → 2
    expect(cpu.p95).toBe(8)    // ceil(0.95*2)-1 = 1 → [2,8][1] = 8
    expect(cpu.max).toBe(8)
  })
})
