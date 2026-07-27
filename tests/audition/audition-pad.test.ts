import { describe, it, expect } from 'vitest'
import { AuditionPad, AUDITION_PADS, AUDITION_BAND_PEAKS, type PadId } from '../../src/audition/audition-pad'
import { AudioVisualMapper } from '../../src/scenes/nebula/mapping/mapper'
import { defaultRhythmPreset } from '../../src/scenes/nebula/mapping/spec'
import { BODY_PROPERTIES, type BodyProperty, type MappingValues } from '../../src/scenes/nebula/mapping/types'
import { SpectrumBins } from '../../src/scenes/nebula/linework/spectrum-bins'
import type { Signals } from '../../src/engine/types'

const DT = 1 / 60

/** 跑过入场标定期（0.6s）并让静息稳定下来——标定期频段被抬到真歌峰值级，会污染静息断言 */
function settleIdle(pad: AuditionPad, extraFrames = 60): void {
  for (let i = 0; i < 36 + extraFrames; i++) pad.step(DT)
}

/** 推进 n 帧，返回每帧信号（spectrum 是复用缓冲，跨帧比较需先取标量） */
function frames(pad: AuditionPad, n: number): ReturnType<AuditionPad['step']>[] {
  return Array.from({ length: n }, () => pad.step(DT))
}

describe('AuditionPad 静息底', () => {
  it('未触发时 silence=false——否则场景走沉睡 tween，一进试音画面就睡过去', () => {
    const pad = new AuditionPad()
    const s = pad.step(DT)
    expect(s.silence).toBe(false)
    expect(s.bpm).toBe(120) // tempo 特征有值可预期
  })

  it('静息底各量为低但非零：连续型反应要有可感基线', () => {
    const pad = new AuditionPad()
    settleIdle(pad) // 跳过入场标定
    const s = pad.step(DT)
    // loudness/energy 是引擎侧已归一化的 0..1 量
    for (const v of [s.loudness.smooth, s.energy]) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(0.3)
    }
    // 频段是未归一化的原始均值，须落在真歌的安静段量级（p10 附近，见实现注释的实测值）
    expect(s.bands.low).toBeGreaterThan(3)
    expect(s.bands.low).toBeLessThan(15)
    expect(s.bands.mid).toBeGreaterThan(0.5)
    expect(s.bands.mid).toBeLessThan(2.5)
    expect(s.bands.high).toBeGreaterThan(0.005)
    expect(s.bands.high).toBeLessThan(0.1)
  })

  it('静息底不产脉冲事件', () => {
    const pad = new AuditionPad()
    for (const s of frames(pad, 30)) {
      expect(s.beat.onBeat).toBe(false)
      expect(s.drop).toBe(false)
    }
  })

  it('🔴 静息谱恒为全零：无输入时柱形必须完全静止（给静息加微动能绕开满格，但会让柱子自行起伏）', () => {
    const pad = new AuditionPad()
    const seen: number[] = []
    for (let i = 0; i < 600; i++) seen.push(Math.max(...pad.step(DT).spectrum)) // 10s，含入场标定期
    expect(Math.max(...seen), '静息期任意时刻的谱峰值').toBe(0)
  })

  it('入场标定不进谱：进场时柱子不许无故跳一下', () => {
    const pad = new AuditionPad()
    for (let i = 0; i < 40; i++) expect(Math.max(...pad.step(DT).spectrum)).toBe(0)
  })

  it('入场标定：前 0.6s 频段抬到真歌峰值级再落回静息——否则静息值成了历史峰值，首击失灵', () => {
    const pad = new AuditionPad()
    const first = pad.step(DT)
    expect(first.bands.low).toBeGreaterThan(50) // 标定起点接近真歌 max
    expect(first.beat.onBeat, '标定不许发脉冲事件').toBe(false)
    expect(first.drop).toBe(false)
    settleIdle(pad)
    expect(pad.step(DT).bands.low).toBeLessThan(15) // 已落回静息
  })

  it('t 随 dt 累加', () => {
    const pad = new AuditionPad()
    pad.step(0.5)
    expect(pad.step(0.25).t).toBeCloseTo(0.75, 5)
  })
})

describe('AuditionPad 脉冲交付', () => {
  it('鼓点：onBeat 只在触发帧交付一次，后续帧不再重复', () => {
    const pad = new AuditionPad()
    pad.trigger('beat')
    expect(pad.step(DT).beat.onBeat).toBe(true)
    for (const s of frames(pad, 10)) expect(s.beat.onBeat).toBe(false)
  })

  it('鼓点带 strength 与能量抬升——纯事件无能量则吃 energy 的反应在试音毫无动静', () => {
    const pad = new AuditionPad()
    const idle = pad.step(DT).energy
    pad.trigger('beat')
    const hit = pad.step(DT)
    expect(hit.beat.strength).toBeGreaterThan(0.5)
    expect(hit.energy).toBeGreaterThan(idle)
    expect(hit.bands.low).toBeGreaterThan(0.5)
  })

  it('副歌炸：drop 交付一帧，且同时是一个强鼓点', () => {
    const pad = new AuditionPad()
    pad.trigger('drop')
    const s = pad.step(DT)
    expect(s.drop).toBe(true)
    expect(s.beat.onBeat).toBe(true)
    expect(s.beat.strength).toBe(1)
    expect(s.energy).toBeGreaterThan(0.8)
    for (const n of frames(pad, 10)) expect(n.drop).toBe(false)
  })

  it('掉帧（dt 大于包络时程）仍交付脉冲，不被静默吞掉', () => {
    const pad = new AuditionPad()
    pad.trigger('beat')
    const s = pad.step(2) // 一帧跨过整个 0.25s 包络
    expect(s.beat.onBeat).toBe(true)
    expect(pad.busy).toBe(false) // 且包络已出队
  })
})

describe('AuditionPad 连续量衰减', () => {
  it('低频 pad：触发帧抬到峰值，随后衰减回静息量级', () => {
    const pad = new AuditionPad()
    settleIdle(pad)
    pad.trigger('low')
    const series = frames(pad, 40).map((s) => s.bands.low)
    expect(series[0]).toBeGreaterThan(50) // 真歌 max 量级
    expect(series.at(-1)).toBeLessThan(15) // 回到静息量级（静息带微动，故不比精确值）
    // 冲量段（回到静息前）应单调下降
    const impulseEnd = series.findIndex((v) => v < 15)
    for (let i = 1; i < impulseEnd; i++) expect(series[i]).toBeLessThanOrEqual(series[i - 1] + 1e-9)
  })

  it('高频 pad 把高频拉满，低频只维持 p50——真实音乐没有「只有高频、低频为零」的帧', () => {
    const pad = new AuditionPad()
    settleIdle(pad)
    pad.trigger('high')
    const s = pad.step(DT)
    expect(s.bands.high).toBeGreaterThan(1) // 拉到真歌 high max ~1.32
    // 伴随低频必须有：否则全场能量近零，SpectrumBins 的全局响度权重会把整条柱形压没
    expect(s.bands.low).toBeGreaterThan(15)
    expect(s.bands.low, '但也不该达到低频 pad 的量级').toBeLessThan(40)
    // 与低频 pad 相比，高低配比截然不同
    const padLow = new AuditionPad()
    settleIdle(padLow)
    padLow.trigger('low')
    const sl = padLow.step(DT)
    expect(s.bands.high / s.bands.low, '高频 pad 的高低配比').toBeGreaterThan(sl.bands.high / sl.bands.low * 5)
  })

  it('副歌炸时程明显长于鼓点（段落级 vs 瞬时）', () => {
    const beatFrames = (() => {
      const p = new AuditionPad(); p.trigger('beat')
      let n = 0; while (p.busy && n < 600) { p.step(DT); n++ }
      return n
    })()
    const dropFrames = (() => {
      const p = new AuditionPad(); p.trigger('drop')
      let n = 0; while (p.busy && n < 600) { p.step(DT); n++ }
      return n
    })()
    expect(dropFrames).toBeGreaterThan(beatFrames * 2)
  })

  it('busy 在包络耗尽后转 false', () => {
    const pad = new AuditionPad()
    expect(pad.busy).toBe(false)
    pad.trigger('low')
    expect(pad.busy).toBe(true)
    while (pad.busy) pad.step(DT)
    expect(pad.busy).toBe(false)
  })
})

describe('AuditionPad 静下来', () => {
  it('silence 期间 silence=true 且各量压 0（真静音语义，不是「音量小」）', () => {
    const pad = new AuditionPad()
    pad.trigger('silence')
    const s = pad.step(DT)
    expect(s.silence).toBe(true)
    expect(s.loudness.smooth).toBe(0)
    expect(s.energy).toBe(0)
    expect(s.bands.low).toBe(0)
    expect(s.bpm).toBe(null)
    expect(Math.max(...s.spectrum)).toBe(0)
  })

  it('静下来压过并存的其他 pad 连续抬升，但脉冲仍交付', () => {
    const pad = new AuditionPad()
    pad.trigger('silence')
    pad.trigger('beat')
    const s = pad.step(DT)
    expect(s.silence).toBe(true)
    expect(s.energy).toBe(0) // beat 的能量抬升被压掉
    expect(s.beat.onBeat).toBe(true) // 但事件仍交付
  })

  it('包络结束后回到静息底（画面能醒回来）', () => {
    const pad = new AuditionPad()
    pad.trigger('silence')
    while (pad.busy) pad.step(DT)
    const s = pad.step(DT)
    expect(s.silence).toBe(false)
    expect(s.energy).toBeGreaterThan(0)
  })
})

describe('AuditionPad 叠加与连击', () => {
  it('同 pad 连击重置包络而非叠加：连点不把连续量顶到饱和', () => {
    const pad = new AuditionPad()
    pad.trigger('low')
    const first = pad.step(DT).bands.low
    for (let i = 0; i < 5; i++) pad.step(DT) // 衰减一段
    pad.trigger('low')
    const retrig = pad.step(DT).bands.low
    expect(retrig).toBeGreaterThan(first * 0.9) // 回到峰值附近
    expect(retrig).toBeLessThanOrEqual(first) // 不叠加超出单次峰值
  })

  it('同 pad 连击不产生第二条包络', () => {
    const pad = new AuditionPad()
    pad.trigger('low')
    pad.trigger('low')
    pad.trigger('low')
    let n = 0
    while (pad.busy && n < 600) { pad.step(DT); n++ }
    expect(n).toBeLessThan(40) // 单条 0.45s 包络 ≈ 27 帧；叠加则会明显更久
  })

  it('不同 pad 叠加取最大不累加：两个一起按不越出值域', () => {
    const pad = new AuditionPad()
    pad.trigger('low')
    pad.trigger('drop')
    const s = pad.step(DT)
    // 取最大而非累加：low 的两个 pad 峰值分别 67/60，叠加不得超过较大者
    expect(s.bands.low).toBeLessThanOrEqual(67)
    expect(s.energy).toBeLessThanOrEqual(1)
    expect(s.loudness.smooth).toBeLessThanOrEqual(1)
  })

  it('reset 清空包络与时钟', () => {
    const pad = new AuditionPad()
    pad.trigger('drop')
    pad.step(DT)
    pad.reset()
    expect(pad.busy).toBe(false)
    const s = pad.step(DT)
    expect(s.t).toBeCloseTo(DT, 5)
    expect(s.drop).toBe(false)
  })
})

describe('AUDITION_PADS 声明表', () => {
  it('每个 pad 都有 label 与唯一 key，且 key 是单个大写字符', () => {
    const keys = new Set<string>()
    const ids = new Set<PadId>()
    for (const p of AUDITION_PADS) {
      expect(p.label).toBeTruthy()
      expect(p.key).toMatch(/^[A-Z]$/)
      expect(keys.has(p.key)).toBe(false)
      expect(ids.has(p.id)).toBe(false)
      keys.add(p.key)
      ids.add(p.id)
    }
  })

  it('声明表键集与 trigger 实现一致：每个声明的 pad 都真的产出效果', () => {
    for (const p of AUDITION_PADS) {
      const pad = new AuditionPad()
      pad.step(DT)
      pad.trigger(p.id)
      expect(pad.busy).toBe(true) // 无声明漏实现
    }
  })

  it('未与现有全局快捷键冲突（R trace 录制 / S 海报 / R Drop 均带修饰键或为 R）', () => {
    for (const p of AUDITION_PADS) expect(p.key).not.toBe('R')
  })
})

// —— 端到端可感性：跑 mapper、断言画面输出 ——
// 立这一层的理由同 mapper.test.ts §「宏旋钮端到端可感性」：断言 Signals 的数字变了不等于画面变了
// （脉冲源落进包络槽位、叠加撞进 softLimit 压缩区都会把差异吃掉）。pad 的全部价值就是「按一下看得见」，
// 所以必须把合成信号真喂进 AudioVisualMapper，断言 VisualControls 可辨。
// 阈值均取本机实测值的 ~65%（实测值写在各用例里，改 PAD_SHAPE 后需重测）。

const WARMUP = 180 // 3s 预热：speed 默认 1000ms 平滑要爬很久，不丢会把启动瞬态误当成变化
const OBSERVE = 90 // 1.5s 观察窗：覆盖最长的 drop 包络（0.9s）+ 下游弹簧回落

/** 静息底跑到稳态后触发一个 pad，收集之后 OBSERVE 帧的各视觉量序列 */
function controlsFor(pad: PadId | null): Record<BodyProperty, number[]> {
  const p = new AuditionPad()
  const m = new AudioVisualMapper()
  const values = defaultRhythmPreset()
  for (let i = 0; i < WARMUP; i++) m.update(p.step(DT), values, DT)
  if (pad) p.trigger(pad)
  const series = Object.fromEntries(BODY_PROPERTIES.map((t) => [t, [] as number[]])) as Record<BodyProperty, number[]>
  for (let i = 0; i < OBSERVE; i++) {
    const out = m.update(p.step(DT), values, DT)
    for (const t of BODY_PROPERTIES) series[t].push(out.body[t])
  }
  return series
}

const peak = (a: number[]): number => Math.max(...a)
const trough = (a: number[]): number => Math.min(...a)

describe('AuditionPad 端到端可感性（画面输出层）', () => {
  const base = controlsFor(null)

  it('静息底的自发波动远小于 pad 带来的变化，归因才清楚', () => {
    // 静息故意带慢波微动（恒定值会被滚动峰值归一顶成满值），但幅度须远低于 pad 的 ≥0.2 门槛
    for (const t of BODY_PROPERTIES) {
      expect(peak(base[t]) - trough(base[t]), `${t} 静息波动`).toBeLessThan(0.1)
    }
  })

  it('每个抬升型 pad 都至少让一个视觉量变化 ≥ 0.2——死 pad 等同死滑块，是 bug', () => {
    // 「凡暴露给用户的控件全行程必须肉眼可感」（双层配置哲学硬约束）在 pad 上的对应物。
    // silence 不在此列：它是「降到底」，而静息底本就低（thickness 0.15/density 0.06），
    // 能降的幅度天然受限（实测 0.15）；且它最大的画面动作是场景沉睡 tween——
    // index.ts 的 sleepTween 直接吃 signals.silence，不经 VisualControls，本层测不到。
    for (const p of AUDITION_PADS.filter((p) => p.id !== 'silence')) {
      const s = controlsFor(p.id)
      const maxDelta = Math.max(...BODY_PROPERTIES.map((t) =>
        Math.max(Math.abs(peak(s[t]) - peak(base[t])), Math.abs(trough(s[t]) - trough(base[t])))))
      expect(maxDelta, `${p.id} 画面最大变化`).toBeGreaterThanOrEqual(0.2)
    }
  })

  it('静下来虽是降幅受限，仍须给出 ≥0.12 的画面变化（本层可测的下限）', () => {
    const s = controlsFor('silence')
    const maxDelta = Math.max(...BODY_PROPERTIES.map((t) =>
      Math.max(Math.abs(peak(s[t]) - peak(base[t])), Math.abs(trough(s[t]) - trough(base[t])))))
    expect(maxDelta, 'silence 画面最大变化').toBeGreaterThanOrEqual(0.12) // 实测 0.150
  })

  it('鼓点 → 空间脉冲（默认 space 主源=beat/punch）：实测 Δ0.379', () => {
    const s = controlsFor('beat')
    expect(peak(s.space) - peak(base.space)).toBeGreaterThanOrEqual(0.25)
  })

  it('副歌炸 → 亮度与密度齐升（默认 brightness 主源=beat、density=energy）：实测 Δ0.542 / Δ0.393', () => {
    const s = controlsFor('drop')
    expect(peak(s.brightness) - peak(base.brightness)).toBeGreaterThanOrEqual(0.35)
    expect(peak(s.density) - peak(base.density)).toBeGreaterThanOrEqual(0.25)
  })

  it('低频 → 厚度（默认 thickness 主源=low）：实测 Δ0.456', () => {
    const s = controlsFor('low')
    expect(peak(s.thickness) - peak(base.thickness)).toBeGreaterThanOrEqual(0.3)
  })

  it('高频 → 亮度（默认 brightness 次源=high）：实测 Δ0.491', () => {
    const s = controlsFor('high')
    expect(peak(s.brightness) - peak(base.brightness)).toBeGreaterThanOrEqual(0.32)
  })

  it('静下来 → 各量落到谷底（不是「变小」而是真掉下去）：thickness 实测降 0.150', () => {
    const s = controlsFor('silence')
    expect(trough(base.thickness) - trough(s.thickness)).toBeGreaterThanOrEqual(0.1)
    expect(trough(s.density)).toBeLessThan(trough(base.density))
    expect(trough(s.space)).toBeLessThan(trough(base.space))
  })

  it('⚠️ 已知局限：speed 在所有 pad 下都不动——默认 speed 主源是 tempo，而 pad 不模拟 BPM 变化', () => {
    // 记录而非修复：tempo 是持续状态不是声音事件，硬造一个「变快 pad」语义不成立。
    // 需要验 speed 的用户可把 speed 主源改成 energy/beat/loudness（白名单已允许），
    // 或用试音的②档（内置片段，真有 BPM）。这也是「两档都要」的又一条依据。
    for (const p of AUDITION_PADS) {
      const s = controlsFor(p.id)
      expect(Math.abs(peak(s.speed) - peak(base.speed)), `${p.id} 对 speed 的影响`).toBeLessThan(0.01)
    }
  })
})

// —— 回归钉：谱链末端的柱子高度 ——
// 回归对象：试音模式下日食/频谱环的柱子曾全部等高铺满，像一排栅栏。
// 根因不在谱形，而在 SpectrumBins 是**逐桶滚动峰值归一**（raw[k]/binPeaks[k]，
// 注释原文「柱柱都有满高的机会」）——恒定谱让每桶峰值收敛到自身当前值，比值恒为 1，全部满格。
// 断言 Signals.spectrum 的数字看不出这个问题，必须把谱喂进真实的 SpectrumBins 看柱子高度。
describe('AuditionPad → SpectrumBins 柱子高度（回归钉）', () => {
  const settle = (bins: SpectrumBins, pad: AuditionPad, frames: number): void => {
    for (let i = 0; i < frames; i++) bins.update(pad.step(DT).spectrum, false, DT)
  }

  it('静息态柱子塌到底（没声音就不许动）', () => {
    const pad = new AuditionPad()
    const bins = new SpectrumBins()
    settle(bins, pad, 300) // 5s——远超滚动峰值的 ~4s 重校准窗口
    expect(Math.max(...bins.values), '静息态最高柱').toBeLessThan(0.01)
  })

  it('冲量期间柱高参差，不是等高栅栏（层次 1 即 bug 复现）', () => {
    const pad = new AuditionPad()
    const bins = new SpectrumBins()
    settle(bins, pad, 180)
    pad.trigger('low')
    let best = 0
    for (let i = 0; i < 30; i++) {
      bins.update(pad.step(DT).spectrum, false, DT)
      best = Math.max(best, new Set(Array.from(bins.values).filter((v) => v > 0.02).map((v) => v.toFixed(2))).size)
    }
    expect(best, '冲量期间的柱高层次数').toBeGreaterThanOrEqual(8)
  })

  it('按下低频 pad 柱子跳起来（塌着不是因为链路是死的）', () => {
    const pad = new AuditionPad()
    const bins = new SpectrumBins()
    settle(bins, pad, 120)
    pad.trigger('low')
    let peak = 0
    for (let i = 0; i < 30; i++) {
      bins.update(pad.step(DT).spectrum, false, DT)
      peak = Math.max(peak, Math.max(...bins.values))
    }
    expect(peak).toBeGreaterThan(0.5)
  })

  it('冲量过后柱子回落——不残留在满格', () => {
    const pad = new AuditionPad()
    const bins = new SpectrumBins()
    settle(bins, pad, 120)
    pad.trigger('drop')
    while (pad.busy) bins.update(pad.step(DT).spectrum, false, DT)
    settle(bins, pad, 120) // 包络耗尽后再跑 2s
    expect(Math.max(...bins.values)).toBeLessThan(0.1)
  })

  /** 触发某 pad 后各桶相对静息基线的最大提升——静息谱非零，故必须看提升而非绝对值 */
  function liftPerBucket(id: PadId): number[] {
    const pad = new AuditionPad()
    const bins = new SpectrumBins()
    settle(bins, pad, 180)
    const baseline = Array.from(bins.values)
    pad.trigger(id)
    const lift = baseline.map(() => 0)
    for (let i = 0; i < 30; i++) {
      bins.update(pad.step(DT).spectrum, false, DT)
      for (let k = 0; k < lift.length; k++) lift[k] = Math.max(lift[k], bins.values[k] - baseline[k])
    }
    return lift
  }

  it('抬升的重心落在各自频段：低频 pad 偏前段、高频 pad 偏后段（按线性 bin 比例切时高频只占 10/64 桶）', () => {
    // 用「抬升的加权重心」而非「桶数」：SpectrumBins 还有一个全局响度权重
    // （loud = (当前全场能量/全局峰)^1.6，注释「安静段全体收敛、副歌打满」），
    // 任何频段的冲量都会连带抬高所有柱子，故按「有抬升的桶数」度量必然全环命中。
    const centroid = (lift: number[]): number => {
      const sum = lift.reduce((a, b) => a + Math.max(0, b), 0)
      if (sum <= 0) return NaN
      return lift.reduce((a, b, i) => a + Math.max(0, b) * i, 0) / sum
    }
    const lowC = centroid(liftPerBucket('low'))
    const highC = centroid(liftPerBucket('high'))
    // 实测 lowC=13.7 / highC=32.4。highC 只比 64 桶的中点略偏后，这个数字本身就量化了
    // 「高频在柱形上辨识度弱」（其总抬升仅为低频的 14%），原因见下一条用例的注释。
    expect(lowC, '低频 pad 抬升重心（64 桶里的位置）').toBeLessThan(20)
    expect(highC, '高频 pad 抬升重心').toBeGreaterThan(28)
    expect(highC - lowC, '两者重心须明显分开').toBeGreaterThan(9) // 实测 11.8
  })

  it('低频 pad 只抬低段柱子，高频 pad 只抬高段（频段语义在柱子上可见）', () => {
    const LOW_BUCKETS = [0, 20] as const   // 对数分桶：前段=低频
    const HIGH_BUCKETS = [44, 64] as const // 后段=高频
    const maxIn = (lift: number[], [a, b]: readonly [number, number]): number => Math.max(...lift.slice(a, b))
    const lowLift = liftPerBucket('low')
    expect(maxIn(lowLift, LOW_BUCKETS), '低频 pad 对低段的抬升').toBeGreaterThan(maxIn(lowLift, HIGH_BUCKETS) + 0.1)
    // 高频侧只要求「高段确有可测抬升」，不要求超过低段：真实音乐的高频能量只有低频的 ~1/50，
    // 抬它几乎不改变全场能量，而全局响度权重又按全场能量抬高所有柱子——
    // 于是高频在柱形上的辨识度天然弱。这是吻合真实的物理事实，不是缺陷；
    // 高频的主要可感通道是亮度（默认 brightness 次源=high，实测静息 0.02 → 0.63）。
    const highLift = liftPerBucket('high')
    expect(maxIn(highLift, HIGH_BUCKETS), '高频 pad 对高段的抬升').toBeGreaterThan(0.03)
  })
})

// —— 信号源切换：试音与真实播放不得互相污染 ——
// 下游两处都是**滚动峰值归一**（mapper 的 bandNorms、SignalRig 的三个 Norm），半衰期 30s，
// 且实例在场景闭包里跨试音进出持续存在。若不隔离，会双向出错：
//   ① 试音的入场标定（真歌 max 量级）会压低退出后安静歌曲的频段反应，且残留上百秒；
//   ② 之前放过的响歌会让同一个 pad 的响应打折，破坏 pad「精确可重复」的立身之本。
// 隔离手段是 snapshot/restore（场景经 Scene.setAuditionActive 成对调用）。
// ⚠️ 本节必须复用**同一个 mapper 实例**跨越切换——每次 new 一个新的就测不到污染。
// 场景层（nebula/index.ts 的 setAuditionActive）吃 three.js/WebGPU 不可在 node 环境构造，
// 故此处手工复现它的两步：进入 = snapshot + restore(AUDITION_BAND_PEAKS)，退出 = restore(snapshot)。
// 改那边的顺序或漏掉复位，本节应当失败。
describe('试音与真实播放的自适应状态隔离', () => {
  /** 造一帧真实量级的信号（peak=1 表示按真歌 max 给，0.15 表示安静段） */
  const realFrame = (scale: number): Signals => ({
    t: 0,
    loudness: { instant: 0.5 * scale, smooth: 0.5 * scale },
    bands: { low: 67 * scale, mid: 8.4 * scale, high: 1.32 * scale },
    spectrum: new Float32Array(512).fill(30 * scale),
    beat: { onBeat: false, strength: 0 },
    bpm: 120,
    energy: 0.5 * scale,
    drop: false,
    silence: false,
  })

  /** 喂 n 秒某个量级的真实信号，返回最后一帧的 thickness（默认预设下由 low 驱动） */
  function feedReal(m: AudioVisualMapper, scale: number, sec: number): number {
    const values = defaultRhythmPreset()
    let out = 0
    for (let i = 0; i < sec * 60; i++) out = m.update(realFrame(scale), values, DT).body.thickness
    return out
  }

  it('snapshot/restore 能还原频段归一峰值（setPeak 可降，seed 只能升故不够用）', () => {
    const m = new AudioVisualMapper()
    feedReal(m, 1, 1) // 峰值抬到真歌 max 量级
    const snap = m.snapshotAdaptive().bandPeaks
    expect(snap[0]).toBeGreaterThan(50)

    // 模拟被试音标定顶到更高，再还原
    m.restoreBandPeaks([200, 50, 10])
    expect(m.snapshotAdaptive().bandPeaks[0]).toBe(200)
    m.restoreBandPeaks(snap)
    expect(m.snapshotAdaptive().bandPeaks).toEqual(snap)
  })

  it('🔴 不隔离时：试音的定标会压低退出后安静歌曲的反应（回归对象）', () => {
    const m = new AudioVisualMapper()
    feedReal(m, 0.15, 2) // 一首安静的歌
    const before = feedReal(m, 0.15, 1)

    // 试音入场标定（真歌 max 量级）灌进同一个 mapper——不做任何隔离
    const pad = new AuditionPad()
    const values = defaultRhythmPreset()
    for (let i = 0; i < 120; i++) m.update(pad.step(DT), values, DT)

    const afterNoIsolation = feedReal(m, 0.15, 1)
    expect(afterNoIsolation, '安静歌曲的厚度被试音定标压低').toBeLessThan(before * 0.6)
  })

  it('✅ 隔离后：同一 mapper 跨「真实→试音→退出→真实」，安静歌曲的反应基本复原', () => {
    const m = new AudioVisualMapper()
    feedReal(m, 0.15, 2)
    const before = feedReal(m, 0.15, 1)

    // ↓ 场景侧 setAuditionActive(true) 的两步：存档 + 复位到试音标定量级
    const snap = m.snapshotAdaptive().bandPeaks
    m.restoreBandPeaks(AUDITION_BAND_PEAKS)
    const pad = new AuditionPad()
    const values = defaultRhythmPreset()
    for (let i = 0; i < 120; i++) m.update(pad.step(DT), values, DT)
    m.restoreBandPeaks(snap) // ← 退试音（setAuditionActive(false)）

    const after = feedReal(m, 0.15, 1)
    expect(after, '还原后应回到进入前的水平').toBeCloseTo(before, 2)
  })

  it('✅ 隔离后：pad 的响应不再取决于之前听过什么歌（可重复性）', () => {
    const padPeakAfterListening = (scale: number): number => {
      const m = new AudioVisualMapper()
      feedReal(m, scale, 3) // 先听一首（响 or 安静）
      const snap = m.snapshotAdaptive().bandPeaks

      m.restoreBandPeaks(AUDITION_BAND_PEAKS) // ← 场景侧 setAuditionActive(true) 的复位那一步

      const pad = new AuditionPad()
      const values = defaultRhythmPreset()
      for (let i = 0; i < 120; i++) m.update(pad.step(DT), values, DT) // 入场标定 + 静息
      pad.trigger('low')
      let peak = 0
      for (let i = 0; i < 40; i++) peak = Math.max(peak, m.update(pad.step(DT), values, DT).body.thickness)
      m.restoreBandPeaks(snap) // ← setAuditionActive(false) 的还原那一步
      return peak
    }
    const afterLoud = padPeakAfterListening(1.2) // 之前放过很响的歌
    const afterQuiet = padPeakAfterListening(0.15) // 之前放过很安静的歌
    // 入场标定把峰值统一定标到真歌 max，故两种历史下 pad 峰值应几乎一致
    expect(Math.abs(afterLoud - afterQuiet), 'pad 峰值不该随听歌史漂移').toBeLessThan(0.1)
  })
})

// —— beatCount（重拍相位）也必须隔离 ——
// downbeat 不是 Signals 的字段，是 mapper 用 beatCount % 4 派生的。试音里按下的每个鼓点/副歌炸
// 都会让 beatCount++，若不隔离就会**永久移相真实歌曲的重拍**，且让同一 pad 的结果取决于进入前历史。
describe('试音不得移相真实播放的重拍', () => {
  /** 把 space 的主源改成 downbeat 并**去掉次源**，用它的输出观测四拍相位。
   * 次源（energy）必须去掉：它持续供能会让 space 恒大于零，重拍与非重拍分不开。 */
  function downbeatProbe(): MappingValues {
    const v = defaultRhythmPreset()
    v.reactions = v.reactions.filter((r) => r.id !== 'body.space.secondary')
    Object.assign(v.reactions.find((r) => r.id === 'body.space.primary')!,
      { source: 'downbeat', curve: 'linear', smoothingMs: 30 })
    return v
  }
  const beatFrame = (onBeat: boolean): Signals => ({
    t: 0,
    loudness: { instant: 0.5, smooth: 0.5 },
    bands: { low: 19, mid: 2.5, high: 0.07 },
    spectrum: new Float32Array(512).fill(20),
    beat: { onBeat, strength: 1 },
    bpm: 120,
    energy: 0.5,
    drop: false,
    silence: false,
  })

  /** 连喂 n 拍（每拍之间隔 10 帧），返回每拍是否被判为重拍。
   * 判据取「相对本轮最大值的一半」而非绝对阈值——space 走弹簧有过冲余韵，绝对阈值分不干净。 */
  function beatPattern(m: AudioVisualMapper, v: MappingValues, beats: number): boolean[] {
    const vals: number[] = []
    for (let b = 0; b < beats; b++) {
      vals.push(m.update(beatFrame(true), v, DT).body.space)
      for (let i = 0; i < 10; i++) m.update(beatFrame(false), v, DT)
    }
    const mx = Math.max(...vals)
    return vals.map((x) => x > mx * 0.5)
  }

  it('基线：重拍每 4 拍出现一次', () => {
    const m = new AudioVisualMapper()
    const v = downbeatProbe()
    const pattern = beatPattern(m, v, 8)
    expect(pattern.filter(Boolean).length, '8 拍里应有 2 次重拍').toBe(2)
  })

  it('🔴 不隔离时：试音按过鼓点会把真实歌曲的重拍相位移位（回归对象）', () => {
    const v = downbeatProbe()
    const withoutAudition = (() => {
      const m = new AudioVisualMapper()
      beatPattern(m, v, 4) // 先放 4 拍真歌
      return beatPattern(m, v, 8)
    })()
    const withAudition = (() => {
      const m = new AudioVisualMapper()
      beatPattern(m, v, 4)
      const pad = new AuditionPad() // 试音里按一个鼓点（beatCount 因此 +1）
      pad.trigger('beat')
      for (let i = 0; i < 20; i++) m.update(pad.step(DT), v, DT)
      return beatPattern(m, v, 8)
    })()
    expect(withAudition, '相位被试音移位').not.toEqual(withoutAudition)
  })

  it('✅ 隔离后：快照/还原 beatCount，相位与从未进过试音一致', () => {
    const v = downbeatProbe()
    const baseline = (() => {
      const m = new AudioVisualMapper()
      beatPattern(m, v, 4)
      return beatPattern(m, v, 8)
    })()
    const m = new AudioVisualMapper()
    beatPattern(m, v, 4)
    const snap = m.snapshotAdaptive() // ← setAuditionActive(true)
    const pad = new AuditionPad()
    pad.trigger('beat')
    pad.trigger('drop')
    for (let i = 0; i < 40; i++) m.update(pad.step(DT), v, DT)
    m.restoreAdaptive(snap) // ← setAuditionActive(false)
    expect(beatPattern(m, v, 8), '还原后相位应与基线一致').toEqual(baseline)
  })
})
