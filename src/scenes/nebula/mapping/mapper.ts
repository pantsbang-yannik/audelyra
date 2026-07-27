// 纯逻辑映射层：Signals + MappingValues → VisualControls。对形状无知（spec §5.1）。
import type { Signals } from '../../../engine/types'
import { RollingPeak } from '../../../engine/rolling-peak'
import { EnvelopeFollower, Spring } from '../../shared/motion'
import { applyCurve, softLimit } from './curves'
import {
  PROPERTY_CATALOG, addressKey, idleControls, propertySpecAt,
  type AudioFeature, type MappingRule, type MappingValues, type VisualControls,
} from './types'

/** 跨信号源须隔离的 mapper 自适应状态（见 snapshotAdaptive 注释） */
export interface MapperAdaptiveState {
  bandPeaks: [number, number, number]
  beatCount: number
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** 冲量源：单帧尖峰事件，进 pulse 属性时**不预包络**（否则尖峰会被包络吃干净）。
 * 连续源（energy/loudness/频段…）则先各自包络再叠加，产段落级的收放。 */
const IMPULSE_SOURCES: ReadonlySet<AudioFeature> = new Set<AudioFeature>(['beat', 'downbeat', 'drop'])
const SPRING_DAMPING = 0.35 // 弱阻尼=弹起过冲（脉冲手感常量，不暴露）
const DEFAULT_SPRING_MS = 60 // 地址上无 enabled 冲量反应时的弹簧刚度回落值（= 原 primary 默认平滑）
// 静止值（idle）的进出过渡时长：只在用户开关/增删该地址最后一条反应时可见，
// 不加会让「关掉唯一一条背景反应」表现为整张图瞬间跳亮。
const IDLE_BLEND_MS = 200
// 「平滑」滑块 → 弹簧刚度：默认 60ms 恰落回原手感 6Hz；2000ms → 0.5Hz 的慢呼吸
const springFreqFromSmoothing = (ms: number): number => clamp(360 / Math.max(ms, 30), 0.5, 12)

export class AudioVisualMapper {
  private beatCount = 0
  /** key = `${element}.${property}#${reactionId}`——按反应而非按槽位索引，
   * 于是每条反应的「平滑」滑块都独立生效（双层配置哲学：死控件=bug） */
  private envs = new Map<string, EnvelopeFollower>()
  private springs = new Map<string, Spring>()
  // 每帧复用的聚合容器（避免逐帧分配）
  private readonly sums = new Map<string, number>()
  private readonly springMs = new Map<string, number>()
  private readonly usedEnvKeys = new Set<string>()
  /** 本帧「有至少一条 enabled 反应」的地址集合——决定该地址走合成值还是静止值 */
  private readonly driven = new Set<string>()
  /** 频段源的滚动峰值归一（参数与 signal-rig 的 lowNorm/midNorm/highNorm 对齐）。
   * 为什么必须有：`Signals.bands` 是**未归一化的原始频段均值**（features.ts 的 `avg(from,to)`，
   * engine.ts 注释亦写明「bands 是原始频段均值」），实测真歌 low 中位数 ~19、mid ~2.5、high ~0.07——
   * 而规则的 inputMax 固定为 1 且不暴露给用户，于是 low/mid 结构性饱和（thickness 中位数=最大值
   * =0.997，鼓点来了也看不出变化）、high 只用到量程的 7%。
   * loudness 早已做了同款归一（「相对 30s 滚动峰值，与系统音量解耦」），signal-rig 的三频段也做了，
   * 唯独 mapper 漏了这一步——本处即补齐，不是新机制。 */
  private bandNorms: Record<'low' | 'mid' | 'high', RollingPeak> = {
    low: new RollingPeak(30, 0.02),
    mid: new RollingPeak(30, 0.02),
    high: new RollingPeak(30, 0.02),
  }
  /** 本帧的归一化频段值——每帧在 update 开头算一次。
   * 不能放进 readFeature：那里一帧内会被调用多次（每条反应各一次），
   * 逐次 update 会把滚动峰值的时间衰减多算好几倍。 */
  private normBands = { low: 0, mid: 0, high: 0 }

  constructor() {
    for (const [el, props] of Object.entries(PROPERTY_CATALOG)) {
      for (const [p, spec] of Object.entries(props)) {
        if (spec.smoothing === 'pulse') this.springs.set(`${el}.${p}`, new Spring(6, SPRING_DAMPING))
      }
    }
  }

  /** 跨信号源需要隔离的全部自适应状态：**切换（如进出试音）时必须成对快照/恢复**。
   * ① 频段归一峰值——半衰期 30s，残留极久：试音的定标会压低退出后安静歌曲的反应
   *    （67 衰减到 11 约需 112s），反之历史响歌又会让同一个 pad 的响应打折。
   * ② `beatCount`——`downbeat` 是由它 `% 4` 派生的，不隔离则试音里按过的每个鼓点/副歌炸
   *    都会**永久移相真实歌曲的重拍**，且让同一 pad 的结果取决于进入前的历史。 */
  snapshotAdaptive(): MapperAdaptiveState {
    return {
      bandPeaks: [this.bandNorms.low.peak, this.bandNorms.mid.peak, this.bandNorms.high.peak],
      beatCount: this.beatCount,
    }
  }

  restoreAdaptive(s: MapperAdaptiveState): void {
    this.restoreBandPeaks(s.bandPeaks)
    this.beatCount = s.beatCount
  }

  restoreBandPeaks([low, mid, high]: [number, number, number]): void {
    this.bandNorms.low.setPeak(low)
    this.bandNorms.mid.setPeak(mid)
    this.bandNorms.high.setPeak(high)
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
      // 频段读归一化后的值（本帧缓存，见 normBands 注释）：原始 bands 量级远超 inputMax=1
      case 'low': return this.normBands.low
      case 'mid': return this.normBands.mid
      case 'high': return this.normBands.high
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

  /** 只读测试口（惯例同 user-backdrop.stateForTest）：验包络器确实被回收 */
  get envCountForTest(): number {
    return this.envs.size
  }

  /** 回收已删除反应的包络器：反应可增删后，不回收会让 envs 随编辑次数单调增长。 */
  private pruneEnvs(): void {
    if (this.envs.size <= this.usedEnvKeys.size) return
    for (const k of this.envs.keys()) if (!this.usedEnvKeys.has(k)) this.envs.delete(k)
  }

  update(signals: Signals | null, values: MappingValues, dt: number): VisualControls {
    if (signals?.beat.onBeat) this.beatCount++
    // 频段归一化每帧一次（null 帧给 0 且不推进峰值衰减，与 signal-rig 的 `s ? … : 0` 同款处置）
    if (signals) {
      this.normBands.low = this.bandNorms.low.update(signals.bands.low, dt)
      this.normBands.mid = this.bandNorms.mid.update(signals.bands.mid, dt)
      this.normBands.high = this.bandNorms.high.update(signals.bands.high, dt)
    } else {
      this.normBands.low = this.normBands.mid = this.normBands.high = 0
    }

    this.sums.clear()
    this.springMs.clear()
    this.usedEnvKeys.clear()
    this.driven.clear()

    // ① 逐条反应求值，按地址累加。
    // disabled 的反应**不跳过**——evalRule 返回 0 后照常进包络，于是关掉一条反应是平滑落下而非瞬跳。
    for (const r of values.reactions) {
      const spec = propertySpecAt(r.target)
      if (!spec) continue // 非法地址（sanitize 已滤过，此处纯防御）
      const key = addressKey(r.target)
      if (r.enabled) this.driven.add(key)
      let v = this.evalRule(signals, r)
      if (spec.smoothing === 'pulse' && IMPULSE_SOURCES.has(r.source)) {
        // 冲量进 pulse 属性：保持瞬时（尖峰交给弹簧产 attack + overshoot），
        // 其「平滑」滑块转而决定弹簧刚度。同地址多条冲量取最快的一条——弹簧是共享的物理体，
        // 取最小值保证最脆的那条不被别的拖慢，同时每条滑块都仍有影响（无死控件）。
        if (r.enabled) this.springMs.set(key, Math.min(this.springMs.get(key) ?? Infinity, r.smoothingMs))
      } else {
        const envKey = `${key}#${r.id}`
        this.usedEnvKeys.add(envKey)
        v = this.env(envKey, r.smoothingMs).update(v, dt)
      }
      this.sums.set(key, (this.sums.get(key) ?? 0) + v)
    }

    // ② 逐地址合成输出。遍历目录而非 sums——一条反应都没有的地址也要出值（用户删光的情形）。
    const out = idleControls() as unknown as Record<string, Record<string, number>>
    for (const [el, props] of Object.entries(PROPERTY_CATALOG)) {
      for (const [p, spec] of Object.entries(props)) {
        const key = `${el}.${p}`
        // 叠加统一走软限幅（膝点内恒等、渐近 SOFT_LIMIT_CAP）：gain/叠加越过 1 仍有增量，
        // 无饱和死区；头部空间由 CAP 统一给，下游系数按此标定。
        // 静止值不进软限幅——它是「无人驱动时的底」，不是叠加项，进了会被压出 0.4% 的偏差。
        const idleEnvKey = `${key}#idle`
        let combined = softLimit(this.sums.get(key) ?? 0)
        if (spec.idle !== 0) {
          this.usedEnvKeys.add(idleEnvKey)
          const want = this.driven.has(key) ? 0 : spec.idle
          const blended = this.env(idleEnvKey, IDLE_BLEND_MS).update(want, dt)
          // 吸附：指数逼近永远差最后一点，不吸附则「没写任何背景反应」的用户会永久拿到 99.4% 亮度。
          // 那 0.6% 肉眼看不见，但「零配置观感与改造前逐像素相同」是可验证的承诺，不留这种尾巴。
          combined += Math.abs(blended - want) < 1e-3 ? want : blended
        }
        if (spec.smoothing === 'pulse') {
          const spring = this.springs.get(key)!
          spring.freqHz = springFreqFromSmoothing(this.springMs.get(key) ?? DEFAULT_SPRING_MS)
          out[el][p] = Math.max(0, spring.update(combined, dt))
        } else {
          // 平滑已在①按条做过（每条反应各自的 smoothingMs），此处不再叠第二层包络
          out[el][p] = Math.max(0, combined)
        }
      }
    }
    this.pruneEnvs() // 必须在②之后：静止值的包络键也是在②里登记的
    return out as unknown as VisualControls
  }
}
