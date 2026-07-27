import { describe, it, expect } from 'vitest'
import { SpectrumBins, BIN_COUNT } from '../../src/scenes/nebula/linework/spectrum-bins'

const flat = (v: number): Float32Array => new Float32Array(512).fill(v)
const step = (b: SpectrumBins, n: number, spec: Float32Array | null, silence = false) => {
  for (let i = 0; i < n; i++) b.update(spec, silence, 1 / 60)
}

describe('对数分桶', () => {
  it('64 桶、输出恒在 [0,1]', () => {
    const b = new SpectrumBins()
    expect(b.values.length).toBe(BIN_COUNT)
    step(b, 30, flat(0.8))
    for (const v of b.values) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
  })
  it('平谱喂满后全桶非零（分桶覆盖完备，无空桶）', () => {
    const b = new SpectrumBins()
    step(b, 60, flat(0.8))
    for (const v of b.values) expect(v).toBeGreaterThan(0.3)
  })
  it('单频尖峰只点亮对应桶邻域：低频尖峰亮低桶不亮高桶', () => {
    const spec = flat(0)
    for (let i = 0; i < 8; i++) spec[i] = 1
    const b = new SpectrumBins()
    step(b, 60, spec)
    expect(b.values[0]).toBeGreaterThan(0.5)
    expect(b.values[BIN_COUNT - 1]).toBeLessThan(0.05)
  })
})

describe('非对称平滑与归一', () => {
  it('attack 快于 release：起跳 3 帧内过半，回落 3 帧后仍高于半', () => {
    const b = new SpectrumBins()
    step(b, 120, flat(0.8)) // 峰值包络建立
    step(b, 30, flat(0))    // 归零
    step(b, 3, flat(0.8))   // 起跳 3 帧
    const rise = b.values[10]
    expect(rise).toBeGreaterThan(0.5)
    step(b, 30, flat(0.8))
    step(b, 3, flat(0))     // 回落 3 帧
    expect(b.values[10]).toBeGreaterThan(0.5) // 慢落还没掉到半
  })
  it('滚动峰值归一：谱整体幅度缩小 10 倍，稳定后输出仍接近满（相对响度语义）', () => {
    const b = new SpectrumBins()
    step(b, 600, flat(0.05)) // 10s：峰值包络收敛到小幅谱
    expect(b.values[10]).toBeGreaterThan(0.6)
  })
  it('fb1 逐桶归一：高频内容仅为低频 1/16，高频桶仍自归一到接近满高（环上半也起舞）', () => {
    const spec = flat(0)
    for (let i = 0; i < 8; i++) spec[i] = 0.8       // 低频强
    for (let i = 256; i < 512; i++) spec[i] = 0.05  // 高频弱但是真实内容
    const b = new SpectrumBins()
    step(b, 120, spec)
    expect(b.values[BIN_COUNT - 1]).toBeGreaterThan(0.6)
  })
  it('fb4 响度权重：响段后进安静段，柱子整体收敛（不再"稍有声音就拉满"）；回到响段快速回满', () => {
    const b = new SpectrumBins()
    step(b, 120, flat(0.8))  // 响段建立全局峰
    expect(b.values[10]).toBeGreaterThan(0.8)
    step(b, 120, flat(0.2))  // 安静段：逐桶比值仍会趋近 1，但响度权重把整体压下来
    expect(b.values[10]).toBeLessThan(0.35)
    step(b, 30, flat(0.8))   // 副歌回来：全局峰未衰减完，权重回 1，快速回满
    expect(b.values[10]).toBeGreaterThan(0.7)
  })
  it('fb1 全局系绳：接近噪声地板的桶（<全局峰 5%）不虚涨', () => {
    const spec = flat(0)
    for (let i = 0; i < 8; i++) spec[i] = 0.8
    for (let i = 256; i < 512; i++) spec[i] = 0.001 // 噪声量级（全局峰的 0.125%）
    const b = new SpectrumBins()
    step(b, 120, spec)
    expect(b.values[BIN_COUNT - 1]).toBeLessThan(0.1)
  })
  it('silence 硬门：静默时目标归零（走 release 平滑，不瞬断），持续静默后全零', () => {
    const b = new SpectrumBins()
    step(b, 60, flat(0.8))
    step(b, 120, flat(0.8), true) // silence=true 时谱值不可信，硬门压零
    for (const v of b.values) expect(v).toBeLessThan(0.01)
  })
  it('null 谱（无信号帧）等同静默目标', () => {
    const b = new SpectrumBins()
    step(b, 60, flat(0.8))
    step(b, 120, null)
    for (const v of b.values) expect(v).toBeLessThan(0.01)
  })
})

describe('映射速度→响应速率（调音台规范化：死线接活）', () => {
  it('rateMul 缺省与显式 1 等价；rateMul=3 回落显著更快（速度感=柱子更跟手）', () => {
    const a = new SpectrumBins()
    const one = new SpectrumBins()
    const fast = new SpectrumBins()
    for (let i = 0; i < 120; i++) {
      a.update(flat(0.8), false, 1 / 60)
      one.update(flat(0.8), false, 1 / 60, 1)
      fast.update(flat(0.8), false, 1 / 60, 3)
    }
    expect(one.values[10]).toBeCloseTo(a.values[10], 10) // 缺省=1 行为不变
    for (let i = 0; i < 6; i++) {
      a.update(flat(0), false, 1 / 60)
      fast.update(flat(0), false, 1 / 60, 3)
    }
    expect(fast.values[10]).toBeLessThan(a.values[10]) // 快 3 倍回落更深
  })
})

describe('snapshotAdaptive / restoreAdaptive（信号源切换隔离）', () => {
  /** 各 bin 不同值的谱：恒定平谱会让逐桶自峰归一把所有桶顶成 1.0，观测不出差异 */
  const shaped = (scale: number): Float32Array => {
    const a = new Float32Array(512)
    for (let i = 0; i < 512; i++) a[i] = scale * (0.3 + 0.7 / (1 + i * 0.01))
    return a
  }

  it('归一基准（逐桶峰值 + 全局峰）被还原——不还原则真实频谱会暂时偏矮', () => {
    const b = new SpectrumBins()
    for (let i = 0; i < 60; i++) b.update(shaped(10), false, 1 / 60)
    const snap = b.snapshotAdaptive()

    // 模拟人造源灌入远高的量级（试音的入场定标）
    for (let i = 0; i < 60; i++) b.update(shaped(60), false, 1 / 60)
    expect(b.snapshotAdaptive().peak, '污染后全局峰应显著抬高').toBeGreaterThan(snap.peak * 3)

    b.restoreAdaptive(snap)
    const back = b.snapshotAdaptive()
    expect(back.peak).toBeCloseTo(snap.peak, 5)
    expect(Array.from(back.binPeaks)).toEqual(Array.from(snap.binPeaks))
    expect(Array.from(back.values)).toEqual(Array.from(snap.values))
  })

  it('还原后继续喂原量级，柱形与从未被污染时一致', () => {
    const clean = new SpectrumBins()
    const polluted = new SpectrumBins()
    for (let i = 0; i < 60; i++) {
      clean.update(shaped(10), false, 1 / 60)
      polluted.update(shaped(10), false, 1 / 60)
    }
    const snap = polluted.snapshotAdaptive()
    for (let i = 0; i < 60; i++) polluted.update(shaped(60), false, 1 / 60) // 被人造源污染
    polluted.restoreAdaptive(snap)

    for (let i = 0; i < 30; i++) {
      clean.update(shaped(10), false, 1 / 60)
      polluted.update(shaped(10), false, 1 / 60)
    }
    for (let k = 0; k < BIN_COUNT; k++) {
      expect(polluted.values[k], `桶 ${k}`).toBeCloseTo(clean.values[k], 5)
    }
  })

  it('快照是深拷贝：后续更新不改写已存快照', () => {
    const b = new SpectrumBins()
    for (let i = 0; i < 30; i++) b.update(shaped(10), false, 1 / 60)
    const snap = b.snapshotAdaptive()
    const copy = Array.from(snap.values)
    for (let i = 0; i < 30; i++) b.update(shaped(50), false, 1 / 60)
    expect(Array.from(snap.values)).toEqual(copy)
  })
})
