// 封面/星云运动方言（Phase C2，spec §4/§5）：第一个 MotionProgram——语法（尺度分层/事件波前/
// 叙事加成）在此翻译成方言 uniform；粒子 kernel/材质是纯消费者。
// 分工纪律：方言 9 uniform 只由本类覆写（index.ts 头部注释为锚）；不碰 SignalRig 名下 14 uniform。
import { ArPulse, EnvelopeFollower, Pulse } from '../../shared/motion'
import type { NarrativePhase, NarrativeState } from '../../../engine/narrative'
import { climaxScale, type MotionSettings } from './types'

export interface MotionUniforms {
  uSwellAmp: { value: number }; uRippleAmp: { value: number }; uJitterAmp: { value: number }
  uWaveSpeed: { value: number }; uWavefrontAmp: { value: number }; uBuildSqueeze: { value: number }
  uNarrDim: { value: number }; uFlash: { value: number }; uTwinkleAmp: { value: number }
}

export interface MotionInputs {
  narrative: NarrativeState
  low: number; mid: number; high: number
  kickEnv: number; dropPulse: number; kickStrength: number
  energy: number // 段落能量（rig uEnergy）：当前无方言消费，本程序不用，仅传导（插座保留）
  /** 音画映射乘子基量（调音台规范化：死线接活）：mapper 每帧输出 0..1，规则关闭时恒 0=中性 */
  mapSpeed: number
  mapDensity: number
}

/** 后期乐器值：index 每帧转交 post.setInstrument（post 缺席=低档无后期，值被丢弃）。
 * climaxGlow=高潮亮度有效缩放（#高潮亮度），post 用它压 bloom 动态放大项 */
export interface PostInstrument { kickGlow: number; radialBlur: number; chroma: number; climaxGlow: number }

export interface MotionProgram {
  update(dt: number, inp: MotionInputs, s: MotionSettings): PostInstrument
}

// —— 光敏安全硬上限（spec §6 铁律：写死在代码，不进旋钮）——
const FLASH_MIN_INTERVAL_SEC = 0.5 // ≤2 闪/秒：光敏危险区从 3Hz 起，2Hz 上限留出安全边距
const FLASH_AMP_MAX = 0.35 // 闪白幅度封顶（材质端 1+0.35×1.2≈1.42× 峰值亮度）
const FLASH_BURST_AMP = 0.35 // 爆发进入闪
const FLASH_HEAVY_AMP = 0.18 // 重拍小闪
const HEAVY_BEAT_THRESHOLD = 0.8 // 最终打击冲量 ≥ 此值算重拍（uKick 域实测 p90≈0.867，0.8≈捕获 top15-20% 强拍）

// —— 幅度合成系数（方言审美默认，亲验期的候选回调项）——
const SWELL_GAIN = 0.9 // 低频→大尺度鼓包
const RIPPLE_GAIN = 0.7 // 中频→中尺度波纹
const JITTER_GAIN = 0.6 // 高频→细尺度毛刺（运动分量；亮度分量=twinkle）
const BUILD_DIM_MAX = 0.3 // 蓄力最深时变暗 30%
const RELEASE_DIM_MAX = 0.12 // 尾音消散轻压 12%（图 8 的亮度语义）
const NARR_DIM_FLOOR = 0.5 // 变暗下限：叙事不许把画面压死

const MAP_SPEED_SPAN = 1.0 // 映射速度跨度：mapSpeed=1 时波前速率 ×2（0.6→1.0：滑块全行程可感，亲验调）
const MAP_DENSITY_SPAN = 1.4 // 映射密度跨度：mapDensity=1 时细闪幅度 ×2.4（0.8→1.4：滑块全行程可感，亲验调）

export class NebulaMotionProgram implements MotionProgram {
  private t = 0
  private lastFlashT = -Infinity
  private prevPhase: NarrativePhase = 'steady'
  // 闪光包络（#光效精修 ③）：由瞬时 Pulse 改 ArPulse——50ms attack「涌起」+ 140ms 半衰「回落」，
  // 消掉原来「啪」地跳白的生硬感；峰值幅度不变（光敏安全门/封顶原样），只让起落更顺、更精致
  private flash = new ArPulse(0.05, 0.14)
  private chroma = new Pulse(0.05) // 色散更短：近似"单帧撕裂"
  private squeeze = new EnvelopeFollower(0.6, 0.15) // 蓄力缓收（酝酿感）、爆发瞬间快松手（释放感）

  constructor(private u: MotionUniforms) {}

  private triggerFlash(amp: number, enabled: boolean): void {
    if (!enabled) return
    if (this.t - this.lastFlashT < FLASH_MIN_INTERVAL_SEC) return // 光敏安全门：频率封顶
    this.lastFlashT = this.t
    this.flash.trigger(Math.min(amp, FLASH_AMP_MAX)) // 幅度封顶
  }

  update(dt: number, inp: MotionInputs, s: MotionSettings): PostInstrument {
    this.t += dt

    // 持续层：尺度分层幅度 = band 包络 × 手感旋钮（语法通用系数见常量区）
    this.u.uSwellAmp.value = inp.low * SWELL_GAIN * s.bombIntensity
    this.u.uRippleAmp.value = inp.mid * RIPPLE_GAIN * s.bombIntensity
    this.u.uJitterAmp.value = inp.high * JITTER_GAIN * s.detailDensity // fb1 后 kernel 已不消费（插座保留），调 JITTER_GAIN 无视觉效果
    this.u.uTwinkleAmp.value = s.detailDensity * (1 + MAP_DENSITY_SPAN * inp.mapDensity)
    this.u.uWaveSpeed.value = s.waveSpeed * (1 + MAP_SPEED_SPAN * inp.mapSpeed)
    this.u.uWavefrontAmp.value = s.bombIntensity

    // 叙事三幕·蓄力：build 相向心收缩随 progress 加深；其余相快速松手
    const squeezeTarget = inp.narrative.phase === 'build' ? inp.narrative.progress * s.buildDepth : 0
    this.u.uBuildSqueeze.value = this.squeeze.update(squeezeTarget, dt)
    // 蓄力变暗（吸气屏息）+ 尾音轻压（消散回落）；下限保画面不死
    const releaseDim = inp.narrative.phase === 'release' ? inp.narrative.progress * RELEASE_DIM_MAX : 0
    this.u.uNarrDim.value = Math.max(NARR_DIM_FLOOR, 1 - this.u.uBuildSqueeze.value * BUILD_DIM_MAX - releaseDim)

    // 高潮亮度压档（#高潮亮度）：闪白触发幅度 ×k（FLASH_AMP_MAX 封顶与 0.5s 频率安全门原样在后）
    const k = climaxScale(s.climaxBrightness)
    // 叙事三幕·爆发：burst 进入边沿=闪白+色散；重拍=小闪+轻色散。闪白全部过光敏安全门；
    // 色散不是亮度频闪，不受频闪开关辖制（撕裂感保留给关频闪的用户）
    if (inp.narrative.phase === 'burst' && this.prevPhase !== 'burst') {
      this.triggerFlash(FLASH_BURST_AMP * k, s.strobeEnabled)
      this.chroma.trigger(1)
    } else if (inp.kickStrength >= HEAVY_BEAT_THRESHOLD) {
      this.triggerFlash(FLASH_HEAVY_AMP * k, s.strobeEnabled)
      this.chroma.trigger(0.6)
    }
    this.prevPhase = inp.narrative.phase
    this.u.uFlash.value = this.flash.update(dt)

    return {
      kickGlow: inp.kickEnv,
      radialBlur: Math.min(1, inp.dropPulse),
      chroma: this.chroma.update(dt),
      climaxGlow: k,
    }
  }
}
