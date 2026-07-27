import { describe, it, expect } from 'vitest'
import { AudioVisualMapper } from './mapper'
import { macroToMapping, MACRO_STYLES, type MacroKnobs } from './macro'
import { defaultRhythmPreset } from './spec'
import { VISUAL_TARGETS, type VisualTarget } from './types'
import type { Signals } from '../../../engine/types'

const DT = 1 / 60
function sig(over: Partial<Signals> = {}): Signals {
  return {
    t: 0,
    loudness: { instant: 0.5, smooth: 0.5 },
    bands: { low: 0, mid: 0, high: 0 },
    spectrum: new Float32Array(0),
    beat: { onBeat: false, strength: 0 },
    bpm: 120, energy: 0, drop: false, silence: false,
    ...over,
  }
}
/** 喂 n 帧，返回最后一帧的 controls。 */
function run(m: AudioVisualMapper, frames: Signals[]): ReturnType<AudioVisualMapper['update']> {
  const v = defaultRhythmPreset()
  let out = m.update(null, v, DT)
  for (const s of frames) out = m.update(s, v, DT)
  return out
}

describe('AudioVisualMapper', () => {
  it('beat 触发 space 脉冲（弹起）', () => {
    const m = new AudioVisualMapper()
    const before = run(m, [sig()])
    const after = run(m, [sig({ beat: { onBeat: true, strength: 1 } }), sig(), sig()])
    expect(after.space).toBeGreaterThan(before.space)
  })
  it('low 提高 thickness', () => {
    const m = new AudioVisualMapper()
    const low = run(m, Array(30).fill(sig({ bands: { low: 0.9, mid: 0, high: 0 } })))
    expect(low.thickness).toBeGreaterThan(0.3)
  })
  it('high 提高 brightness', () => {
    const m = new AudioVisualMapper()
    const hi = run(m, Array(30).fill(sig({ bands: { low: 0, mid: 0, high: 0.9 } })))
    expect(hi.brightness).toBeGreaterThan(0.3)
  })
  it('energy 提高 density 与 space', () => {
    const m = new AudioVisualMapper()
    const hi = run(m, Array(60).fill(sig({ energy: 1 })))
    const lo = run(new AudioVisualMapper(), Array(60).fill(sig({ energy: 0 })))
    expect(hi.density).toBeGreaterThan(lo.density)
    expect(hi.space).toBeGreaterThan(lo.space)
  })
  it('smoothingMs 越大响应越慢：同一冲量首帧涨幅更小', () => {
    const fast = new AudioVisualMapper()
    const vFast = defaultRhythmPreset(); vFast.targets.thickness.primary.smoothingMs = 10
    const vSlow = defaultRhythmPreset(); vSlow.targets.thickness.primary.smoothingMs = 1000
    fast.update(null, vFast, DT)
    const a = fast.update(sig({ bands: { low: 1, mid: 0, high: 0 } }), vFast, DT)
    const slow = new AudioVisualMapper(); slow.update(null, vSlow, DT)
    const b = slow.update(sig({ bands: { low: 1, mid: 0, high: 0 } }), vSlow, DT)
    expect(a.thickness).toBeGreaterThan(b.thickness)
  })
  it('平滑热更：同一 mapper 运行中调大 smoothingMs 立即变慢（调音台拖动实时生效）', () => {
    const m = new AudioVisualMapper()
    const v = defaultRhythmPreset()
    v.targets.thickness.primary.smoothingMs = 10
    for (let i = 0; i < 30; i++) m.update(sig(), v, DT) // 包络器已按 10ms 创建并归零
    v.targets.thickness.primary.smoothingMs = 1000 // 拖动滑块：热更为超慢平滑
    const slow = m.update(sig({ bands: { low: 1, mid: 0, high: 0 } }), v, DT)
    expect(slow.thickness).toBeLessThan(0.1) // 若仍用创建时的 10ms，首帧即冲到 ~0.8
  })
  it('space 平滑生效：smoothingMs 越大，beat 冲量后的弹起越慢', () => {
    const mk = (ms: number): number => {
      const v = defaultRhythmPreset()
      v.targets.space.primary.smoothingMs = ms
      delete v.targets.space.secondary
      const m = new AudioVisualMapper()
      m.update(null, v, DT)
      m.update(sig({ beat: { onBeat: true, strength: 1 } }), v, DT)
      m.update(sig(), v, DT)
      return m.update(sig(), v, DT).space
    }
    expect(mk(60)).toBeGreaterThan(mk(2000) * 2)
  })
  it('space 次源平滑生效：smoothingMs 越大，energy 贡献进入越慢', () => {
    const mk = (ms: number): number => {
      const v = defaultRhythmPreset()
      v.targets.space.secondary!.smoothingMs = ms
      const m = new AudioVisualMapper()
      m.update(null, v, DT)
      let out = m.update(sig({ energy: 1 }), v, DT)
      for (let i = 0; i < 9; i++) out = m.update(sig({ energy: 1 }), v, DT)
      return out.space
    }
    expect(mk(50)).toBeGreaterThan(mk(2000) * 1.5)
  })
  it('downbeat 源只在每第 4 拍触发（独立于 SignalRig 计数）', () => {
    const m = new AudioVisualMapper()
    const v = defaultRhythmPreset()
    // 把 space 主源改成 downbeat，去掉 secondary 干扰，直接观察脉冲何时跳起
    v.targets.space.primary = {
      enabled: true, source: 'downbeat', gain: 1, curve: 'linear',
      smoothingMs: 0, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1,
    }
    delete v.targets.space.secondary
    m.update(null, v, DT)
    const beat = () => m.update(sig({ beat: { onBeat: true, strength: 1 } }), v, DT).space
    const s1 = beat() // beatCount=1，非 downbeat
    beat()            // 2
    const s3 = beat() // 3，仍非 downbeat
    const s4 = beat() // 4 → 4%4==0，downbeat 触发，脉冲跳起
    expect(s4).toBeGreaterThan(s1)
    expect(s4).toBeGreaterThan(s3)
  })
  it('叠加走软限幅：secondary 越过 1 后仍有增量，但被软顶封在安全带内', () => {
    const v = defaultRhythmPreset() // space.primary=beat, space.secondary=energy
    const runN = (energy: number): number => {
      const m = new AudioVisualMapper(); m.update(null, v, DT)
      let out = 0
      for (let i = 0; i < 30; i++) out = m.update(sig({ beat: { onBeat: true, strength: 1 }, energy }), v, DT).space
      return out
    }
    const withEnergy = runN(1)
    const noEnergy = runN(0)
    expect(withEnergy).toBeGreaterThan(noEnergy + 0.05) // 旧硬夹会把两者压成相等（饱和死区）
    expect(withEnergy).toBeLessThan(2) // 软顶 + 弹簧过冲仍在安全带
  })
  it('强度滑块无饱和平台：gain 2 的稳态输出显著高于 gain 1', () => {
    const mk = (gain: number): number => {
      const v = defaultRhythmPreset()
      v.targets.thickness.primary.gain = gain
      const m = new AudioVisualMapper(); m.update(null, v, DT)
      let out = 0
      for (let i = 0; i < 120; i++) out = m.update(sig({ bands: { low: 1, mid: 0, high: 0 } }), v, DT).thickness
      return out
    }
    expect(mk(2)).toBeGreaterThan(mk(1) + 0.1)
  })
})

// —— 宏旋钮端到端可感性：跑引擎、断言画面输出 ——
// 为什么单独立这一层：macro.test.ts 的自证断言全是 rule.gain / smoothingMs / 三元组，
// 参数数字变了不等于画面变了——脉冲源落进包络槽位、叠加撞进 softLimit 压缩区都会把差异吃掉。
// 本节直接把合成信号喂进 AudioVisualMapper，收集 VisualControls 序列后断言输出可辨。

/** 合成 6 秒 120BPM/60fps 音乐：每 30 帧一拍，主歌 energy 0.40 → 第 4.5 秒起副歌 0.75 */
function songFrames(): Signals[] {
  const out: Signals[] = []
  for (let i = 0; i < 360; i++) {
    const energy = i < 270 ? 0.4 : 0.75
    const loud = 0.25 + energy * 0.5
    out.push(sig({
      t: i / 60,
      energy,
      loudness: { instant: loud, smooth: loud },
      bands: { low: energy * 0.9, mid: energy * 0.6, high: energy * 0.5 },
      beat: i % 30 === 0 ? { onBeat: true, strength: 1 } : { onBeat: false, strength: 0 },
    }))
  }
  return out
}
// 前 3 秒预热丢弃：speed 默认 1000ms 平滑要爬很久，不丢会把启动瞬态误当成「真起伏」
const WARMUP_FRAMES = 180

/** 按一组宏旋钮跑完整首合成曲，返回预热之后每个视觉量的逐帧输出序列 */
function collectControls(knobs: MacroKnobs): Record<VisualTarget, number[]> {
  const m = new AudioVisualMapper()
  const values = macroToMapping(knobs)
  const series = Object.fromEntries(VISUAL_TARGETS.map((t) => [t, [] as number[]])) as Record<VisualTarget, number[]>
  const frames = songFrames()
  for (let i = 0; i < frames.length; i++) {
    const out = m.update(frames[i], values, DT)
    if (i < WARMUP_FRAMES) continue
    for (const t of VISUAL_TARGETS) series[t].push(out[t])
  }
  return series
}
const meanOf = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length
/** 峰谷跨度：画面「动得有多厉害」，均值持平但跨度塌掉同样是用户眼里的「没变化」 */
const spanOf = (a: number[]): number => Math.max(...a) - Math.min(...a)

const MID: Omit<MacroKnobs, 'style'> = { strength: 0.5, response: 0.5 }

describe('宏旋钮端到端可感性（画面输出层）', () => {
  it('四档之间画面可辨：任意两档至少一个视觉量的均值差 ≥ 0.06', () => {
    // 实测（两旋钮居中）各对的最大均值差：均衡vs节奏 0.106、均衡vs氛围 0.509、均衡vs低音 0.528、
    // 节奏vs氛围 0.509、节奏vs低音 0.528、氛围vs低音 0.175。最紧的一对是 0.106，阈值取其 ~60%
    const ids = MACRO_STYLES.map((s) => s.id)
    const series = new Map(ids.map((id) => [id, collectControls({ style: id, ...MID })]))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = series.get(ids[i])!, b = series.get(ids[j])!
        const maxDiff = Math.max(...VISUAL_TARGETS.map((t) => Math.abs(meanOf(a[t]) - meanOf(b[t]))))
        expect(maxDiff, `${ids[i]} vs ${ids[j]} 画面均值最大差`).toBeGreaterThanOrEqual(0.06)
      }
    }
  })

  it('风格覆盖的视觉量必须真的动起来：非常量源的稳态峰谷跨度 ≥ 0.10', () => {
    // 守 mapper 的架构约束：脉冲源（beat/downbeat）只在 space/brightness 的 primary 走 Spring 才有效，
    // 落进任何 secondary 或 density/thickness/speed 的 primary 都会被 EnvelopeFollower 吃掉
    // （单帧脉冲响应系数 1-exp(-dt/tau)，tau=200ms 时仅 0.08）→ 画面「整体偏移且几乎不动」。
    // 实测最小的一格是氛围档 speed 0.164，其余 0.315~0.776；阈值取 ~60%。
    // 反向验证：节奏档 speed 改回 source:'beat' 时该格只有 0.053，本条即变红。
    // speed 在均衡档源是 tempo（BPM 恒定即常量，设计如此），按源豁免而非按档豁免。
    for (const { id } of MACRO_STYLES) {
      const values = macroToMapping({ style: id, ...MID })
      const series = collectControls({ style: id, ...MID })
      for (const t of VISUAL_TARGETS) {
        if (values.targets[t].primary.source === 'tempo') continue
        expect(spanOf(series[t]), `${id}/${t} 峰谷跨度`).toBeGreaterThanOrEqual(0.10)
      }
    }
  })

  it('劲儿左半程可感：均衡档克制端的 space 峰谷跨度比中点收窄 ≥ 0.09', () => {
    // 硬约束「全行程可感」的左半边。左半程只动主导 gain（背景恒 1×），差异只体现在动态范围，
    // 均值几乎不变（实测 0.543 vs 0.559）——所以断言峰谷跨度而不是均值。
    // 实测跨度 克制 0.595 vs 中点 0.758 → 差 0.163，阈值取 ~60%。
    // 反向验证：LEAD_GAIN_MIN 改回 0.6 时差只有 0.045（0.713 vs 0.758），本条即变红。
    const calm = collectControls({ style: 'balanced', strength: 0, response: 0.5 })
    const mid = collectControls({ style: 'balanced', ...MID })
    expect(spanOf(mid.space) - spanOf(calm.space)).toBeGreaterThanOrEqual(0.09)
  })

  it('劲儿右半程可感：均衡档狂放端的 space 均值比中点低 ≥ 0.23', () => {
    // 右半程压背景 → 拍间不再有连续底色，画面从「常亮」变成「一顿一顿」，均值随之掉下来。
    // 实测均值 中点 0.559 vs 狂放 0.173 → 差 0.386，阈值取 ~60%。
    const mid = collectControls({ style: 'balanced', ...MID })
    const wild = collectControls({ style: 'balanced', strength: 1, response: 0.5 })
    expect(meanOf(mid.space) - meanOf(wild.space)).toBeGreaterThanOrEqual(0.23)
  })

  it('跟手两端可感：均衡档脆端的 space 峰谷跨度比柔端大 ≥ 0.68', () => {
    // 实测跨度 脆端 1.700（弹簧快而过冲）vs 柔端 0.563（慢到把冲量抹平）→ 差 1.137，阈值取 ~60%
    const crisp = collectControls({ style: 'balanced', strength: 0.5, response: 0 })
    const soft = collectControls({ style: 'balanced', strength: 0.5, response: 1 })
    expect(spanOf(crisp.space) - spanOf(soft.space)).toBeGreaterThanOrEqual(0.68)
  })
})
