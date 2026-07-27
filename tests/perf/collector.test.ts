import { describe, it, expect } from 'vitest'
import { PerfCollector } from '../../src/perf/collector'

/** 跑一帧：beginFrame(start) → endFrame(start+cpuMs) */
function frame(c: PerfCollector, start: number, cpuMs = 1): void {
  c.beginFrame(start)
  c.endFrame(start + cpuMs)
}

describe('setMode 重置帧计时哨兵', () => {
  it('关探针后隔很久重开，首帧 intervalMs 不被那段挂钟间隔污染', () => {
    const c = new PerfCollector()
    c.setMode('hud', { displayHz: 60 })
    frame(c, 1000); frame(c, 1016); frame(c, 1032) // 三帧正常，间隔约 16ms
    c.setMode('off')
    // 关闭期间挂钟走了 60 秒
    c.setMode('hud', { displayHz: 60 }) // 重开，重建空窗口
    frame(c, 61000) // 首帧
    // 若哨兵没重置，intervalMs = 61000 - 1032 ≈ 60000，直接污染刚重建的空窗口
    expect(c.frameStats.summarize().intervalMs.max).toBeLessThan(1000)
  })
})

describe('startSegment 重置延迟哨兵', () => {
  it('上一场景残留的 pcmIn/signalOut 不被新场景首帧当成延迟样本', () => {
    const c = new PerfCollector()
    c.setMode('bench', { displayHz: 60 })
    c.markPcmIn(1000)
    c.markSignalOut(1002) // 信号进来了，但那一帧没走到 endFrame 消费
    c.startSegment(10, 60) // 新场景 measure 起点
    frame(c, 6000) // 5 秒后首帧
    // 若哨兵没重置，会冒出 engine≈2 / wait≈4998 这条陈旧样本
    expect(c.latencySamples.length).toBe(0)
  })

  it('新场景内正常的 pcm→signal→帧 仍能正确产出延迟样本', () => {
    const c = new PerfCollector()
    c.setMode('bench', { displayHz: 60 })
    c.startSegment(10, 60)
    c.markPcmIn(5000)
    c.markSignalOut(5003)
    c.beginFrame(5005)
    c.endFrame(5010)
    expect(c.latencySamples.length).toBe(1)
    expect(c.latencySamples[0].engine).toBe(3) // 5003 - 5000
  })
})

describe('activeTier 真源', () => {
  it('未回填时为 null，回填后可读', () => {
    const c = new PerfCollector()
    expect(c.activeTier).toBeNull()
    c.setActiveTier('low', 100_000)
    expect(c.activeTier).toEqual({ name: 'low', particles: 100_000 })
  })
})
