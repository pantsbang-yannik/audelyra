import { describe, it, expect } from 'vitest'
import {
  EnvelopeFollower, Pulse, ArPulse, Spring, Tween,
  easeStandard, easeImpact, easeDrift, quantizeToBeatGrid
} from '../../src/scenes/shared/motion'

describe('EnvelopeFollower', () => {
  it('attack 快 release 慢', () => {
    const env = new EnvelopeFollower(0.05, 0.5)
    env.update(1, 0.1)
    const afterAttack = env.value
    expect(afterAttack).toBeGreaterThan(0.8)
    env.update(0, 0.1)
    expect(env.value).toBeGreaterThan(afterAttack * 0.6) // 释放慢，掉不多
  })
})

describe('Pulse', () => {
  it('trigger 置值，半衰期衰减，重复 trigger 取更大者', () => {
    const p = new Pulse(0.2)
    p.trigger(1)
    expect(p.update(0.2)).toBeCloseTo(0.5, 5)
    p.trigger(0.3) // 现值 0.5 > 0.3，不回退
    expect(p.value).toBeCloseTo(0.5, 5)
  })
})

describe('ArPulse', () => {
  it('attack 段渐升（首帧不满值=防瞬移）、~50ms 达峰、指数快落、弱触发不打断强余韵', () => {
    const p = new ArPulse(0.04, 0.11)
    p.trigger(1)
    p.update(1 / 60)
    expect(p.value).toBeGreaterThan(0.1)
    expect(p.value).toBeLessThan(0.999) // 有限 attack：不允许单帧满血（位置连续性铁律）
    p.update(1 / 60)
    p.update(1 / 60)
    expect(p.value).toBeGreaterThan(0.85) // ~50ms 达峰——依然干脆
    const peak = p.value
    for (let i = 0; i < 20; i++) p.update(1 / 60) // ≈0.33s ≈ 3 个半衰期
    expect(p.value).toBeLessThan(peak / 7) // 快落
    const before = p.value
    p.trigger(before / 2) // 弱触发不回退现值
    expect(p.value).toBe(before)
  })
})

describe('Spring', () => {
  it('欠阻尼会过冲并收敛', () => {
    const s = new Spring(3, 0.3)
    let overshot = false
    for (let i = 0; i < 600; i++) {
      s.update(1, 1 / 120)
      if (s.value > 1.02) overshot = true
    }
    expect(overshot).toBe(true)
    expect(s.value).toBeCloseTo(1, 1)
  })
  it('低帧率不数值发散：12Hz 弱阻尼弹簧在 30fps 喂冲量后输出有界（大 dt 子步积分兜底）', () => {
    const s = new Spring(12, 0.35) // mapper 平滑滑块最小档=12Hz（springFreqFromSmoothing 上限）
    const dt = 1 / 30              // host 允许 dt 到 0.1；低配机 30fps 常态
    s.update(1, dt)               // 冲量帧
    let maxAbs = 0
    for (let i = 0; i < 120; i++) maxAbs = Math.max(maxAbs, Math.abs(s.update(0, dt)))
    expect(maxAbs).toBeLessThan(2) // 旧显式欧拉 w·dt=2.5>2 会指数爆到 100+
  })
})

describe('Tween', () => {
  it('按缓动推进并结束', () => {
    const tw = new Tween()
    tw.start(0, 10, 1, easeStandard)
    tw.update(0.5)
    expect(tw.value).toBeGreaterThan(5) // easeStandard 前半程快
    tw.update(0.6)
    expect(tw.value).toBe(10)
    expect(tw.active).toBe(false)
  })
})

describe('缓动曲线', () => {
  it.each([easeStandard, easeImpact, easeDrift])('f(0)≈0, f(1)≈1, 单调', (f) => {
    expect(f(0)).toBeCloseTo(0, 2)
    expect(f(1)).toBeCloseTo(1, 1)
    for (let t = 0; t < 1; t += 0.1) expect(f(t + 0.1)).toBeGreaterThanOrEqual(f(t))
  })
})

describe('quantizeToBeatGrid', () => {
  it('取最近的允许拍数（120BPM 拍长 0.5s）', () => {
    expect(quantizeToBeatGrid(0.4, 120)).toBeCloseTo(0.5, 5)   // 1 拍
    expect(quantizeToBeatGrid(1.7, 120)).toBeCloseTo(2, 5)     // 4 拍（1小节）
    expect(quantizeToBeatGrid(0.2, 120)).toBeCloseTo(0.25, 5)  // 半拍
  })
  it('bpm 为 null 原样返回', () => {
    expect(quantizeToBeatGrid(0.7, null)).toBe(0.7)
  })
})
