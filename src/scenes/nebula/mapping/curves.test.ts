import { describe, it, expect } from 'vitest'
import { applyCurve, softLimit, SOFT_LIMIT_CAP } from './curves'

describe('applyCurve', () => {
  it('linear 恒等', () => {
    expect(applyCurve('linear', 0)).toBeCloseTo(0)
    expect(applyCurve('linear', 0.5)).toBeCloseTo(0.5)
    expect(applyCurve('linear', 1)).toBeCloseTo(1)
  })
  it('端点全部锚定 0 和 1', () => {
    for (const c of ['linear', 'ease', 'punch', 'softClip'] as const) {
      expect(applyCurve(c, 0)).toBeCloseTo(0)
      expect(applyCurve(c, 1)).toBeCloseTo(1, 1)
    }
  })
  it('punch 压低中段（拉开强弱对比）', () => {
    expect(applyCurve('punch', 0.5)).toBeLessThan(0.5)
  })
  it('ease 抬高中段（平滑起步）', () => {
    expect(applyCurve('ease', 0.5)).toBeGreaterThan(0.4)
  })
  it('越界输入被夹', () => {
    expect(applyCurve('linear', -1)).toBeCloseTo(0)
    expect(applyCurve('linear', 2)).toBeCloseTo(1)
  })
})

describe('softLimit', () => {
  it('膝点以下恒等（默认手感不变）', () => {
    expect(softLimit(0)).toBeCloseTo(0)
    expect(softLimit(0.5)).toBeCloseTo(0.5)
    expect(softLimit(0.9)).toBeCloseTo(0.9)
  })
  it('膝点以上单调递增（gain 全行程有增量，无饱和平台）', () => {
    expect(softLimit(1.2)).toBeGreaterThan(softLimit(1))
    expect(softLimit(1.6)).toBeGreaterThan(softLimit(1.2))
  })
  it('渐近封顶于 SOFT_LIMIT_CAP，负输入夹到 0', () => {
    expect(softLimit(10)).toBeLessThanOrEqual(SOFT_LIMIT_CAP)
    expect(softLimit(-1)).toBeCloseTo(0)
  })
})
