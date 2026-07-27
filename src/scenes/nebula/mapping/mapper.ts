// 纯逻辑映射层：Signals + MappingValues → VisualControls。对形状无知（spec §5.1）。
import type { Signals } from '../../../engine/types'
import { EnvelopeFollower, Spring } from '../../shared/motion'
import { applyCurve, softLimit } from './curves'
import { VISUAL_TARGETS, type AudioFeature, type MappingRule, type MappingValues, type VisualControls, type VisualTarget } from './types'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
// space/brightness 用弹性 Spring 产过冲；其余目标用 EnvelopeFollower
const PULSE_TARGETS: VisualTarget[] = ['space', 'brightness']
const SPRING_DAMPING = 0.35 // 弱阻尼=弹起过冲（脉冲手感常量，不暴露）
// 「平滑」滑块 → 弹簧刚度：默认 60ms 恰落回原手感 6Hz；2000ms → 0.5Hz 的慢呼吸
const springFreqFromSmoothing = (ms: number): number => clamp(360 / Math.max(ms, 30), 0.5, 12)

export class AudioVisualMapper {
  private beatCount = 0
  private envs = new Map<string, EnvelopeFollower>() // key = `${target}.primary|secondary`（pulse 目标的主源走 springs）
  private springs = new Map<VisualTarget, Spring>()

  constructor() {
    for (const t of PULSE_TARGETS) this.springs.set(t, new Spring(6, SPRING_DAMPING))
  }

  /** 取/建包络器，并按当前 smoothingMs 热更时间常数（调音台拖动实时生效）。 */
  private env(key: string, smoothingMs: number): EnvelopeFollower {
    let e = this.envs.get(key)
    if (!e) { e = new EnvelopeFollower(0.001, 0.001); this.envs.set(key, e) }
    e.attackSec = e.releaseSec = Math.max(0.001, smoothingMs / 1000)
    return e
  }

  private downbeatActive(): boolean {
    return this.beatCount % 4 === 0
  }

  private readFeature(s: Signals | null, f: AudioFeature): number {
    if (!s) return 0
    switch (f) {
      case 'beat': return s.beat.onBeat ? s.beat.strength : 0
      case 'downbeat': return s.beat.onBeat && this.downbeatActive() ? s.beat.strength : 0
      case 'low': return s.bands.low
      case 'mid': return s.bands.mid
      case 'high': return s.bands.high
      case 'energy': return s.energy
      case 'drop': return s.drop ? 1 : 0
      case 'loudness': return s.loudness.smooth
      case 'silence': return s.silence ? 1 : 0
      case 'tempo': return s.bpm ? clamp01((s.bpm - 60) / 120) : 0.5
    }
  }

  /** 单条规则的即时映射值（未平滑）：读特征 → 归一到 input 区间 → 曲线 → 缩到 output 区间 × gain。 */
  private evalRule(s: Signals | null, r: MappingRule): number {
    if (!r.enabled) return 0
    const raw = this.readFeature(s, r.source)
    const span = r.inputMax - r.inputMin
    let t = span <= 0 ? 0 : clamp01((raw - r.inputMin) / span)
    if (r.invert) t = 1 - t
    const shaped = applyCurve(r.curve, t)
    return (r.outputMin + (r.outputMax - r.outputMin) * shaped) * r.gain
  }

  update(signals: Signals | null, values: MappingValues, dt: number): VisualControls {
    if (signals?.beat.onBeat) this.beatCount++

    const out = { speed: 0, density: 0, space: 0, brightness: 0, thickness: 0 } as VisualControls
    for (const target of VISUAL_TARGETS) {
      const tm = values.targets[target]
      const primaryTarget = this.evalRule(signals, tm.primary)
      let secondaryTarget = tm.secondary ? this.evalRule(signals, tm.secondary) : 0
      // pulse 目标的次源（段落级连续量）按自己的 smoothingMs 独立包络后再入弹簧——主源冲量保持瞬时
      if (tm.secondary && PULSE_TARGETS.includes(target)) {
        secondaryTarget = this.env(`${target}.secondary`, tm.secondary.smoothingMs).update(secondaryTarget, dt)
      }
      // 叠加统一走软限幅（膝点内恒等、渐近 SOFT_LIMIT_CAP）：gain/叠加越过 1 仍有增量，
      // 无饱和死区；brightness 不再特批硬越界，头部空间由 CAP 统一给
      const combined = softLimit(primaryTarget + secondaryTarget)

      if (PULSE_TARGETS.includes(target)) {
        // 弹性过冲：Spring 追 combined（冲量帧高、其余帧 0）→ attack 快、release 带 overshoot；
        // 刚度由「平滑」滑块派生（热更），阻尼固定保过冲性格
        const spring = this.springs.get(target)!
        spring.freqHz = springFreqFromSmoothing(tm.primary.smoothingMs)
        out[target] = Math.max(0, spring.update(combined, dt))
      } else {
        // 包络输入已被软限幅封顶（≤ SOFT_LIMIT_CAP），无需再夹上界
        out[target] = Math.max(0, this.env(`${target}.primary`, tm.primary.smoothingMs).update(combined, dt))
      }
    }
    return out
  }
}
