import { EnvelopeFollower, Pulse, ArPulse } from '../shared/motion'
import { RollingPeak } from '../../engine/rolling-peak'
import type { Signals } from '../../engine/types'
import { NarrativeTracker, type NarrativeState } from '../../engine/narrative'

// —— Phase C 三层信号语法（spec 2026-07-11 §3/§4：语法通用、方言各异）——
// 叙事层（剧本）：narrative 公开字段（4 态+progress，NarrativeTracker 驱动）——C2 方言消费做蓄力/爆发/消散编排
// 持续层（连续量）：uDrive/uLow/uMid/uHigh（尺度分层燃料：低频→大结构 中频→波纹 高频→细毛刺）/uEnergy/uTempo
// 脉冲层（事件+包络）：uKick/uKickMode/uKickEnv/uBeat/uBeatGlow/uBeatAge（波前时钟）/uDrop

export interface RigUniforms {
  uDrive: { value: number }; uLow: { value: number }; uMid: { value: number }; uHigh: { value: number }
  uEnergy: { value: number }
  uBeat: { value: number }; uBeatGlow: { value: number }; uDrop: { value: number }
  uSleepBreath: { value: number }
  /** 单帧打击冲量：鼓点帧=强度（下限 KICK_FLOOR），其余帧=0。
   *  干脆感的来源——速度跳变（冲击），不是持续力（推挤）。M2 反馈二轮重做 */
  uKick: { value: number }
  /** 本拍运动语言：0=径向凿击 1=涡旋拧转 2=环形冲击波（逐拍哈希轮换，画面不单调） */
  uKickMode: { value: number }
  /** 距上次鼓点秒数（环形冲击波的半径时钟），上限 2 */
  uBeatAge: { value: number }
  /** 律动包络（AR：attack 40ms / release 110ms）——"频谱柱式"快速起落（M2 反馈三轮）。
   *  驱动渲染时位移：2-3 帧内打出去、~0.3s 精确落回，不经物理弹簧；
   *  attack 有限 = 粒子位置连续（产品铁律：粒子是持续物质，永不瞬移） */
  uKickEnv: { value: number }
  /** BPM 归一速度感 0.7..1.6（快歌全场更快——"速度是很重要的"） */
  uTempo: { value: number }
}

const BREATH_PERIOD_SEC = 25
const BAND_FLOOR = 0.02
// 打击锐化（fb5 后 beat.strength=hybrid 合成：能量语境为主、排名微调，真机 p50≈0.65~0.73 / p90≈0.96~1.0）——
// 幂次放大拉开强弱，强拍狠、弱拍轻。
// T10d（Phase C1）复位：0.28/1.5 是信号缝 bug（首 hop 拍点丢失+重复消费）修复前标定的——
// 修复后每拍单触发不再叠加，整体偏轻。下限 0.28→0.34 兜"没力"的底加深、幂次 1.5→1.35
// 中位拍抬升（p50 0.354→0.392 / p90 0.854→0.867），强弱对比 2.2× 保留。
// fb5 对位重标定（2026-07-14）：hybrid 合成把大部分 onBeat 帧的输入抬到高位（三首真歌
// pooled 前置分位 p50≈0.68/p90≈0.99，比 pre-fb5 排名分位高一大截），旧 GAMMA=1.35 下
// uKick p50≈0.60，越过 calibration-kick 的「沉」上限 0.55（trace 回放一律重算后实测）。
// 只动 GAMMA（1.35→1.7），FLOOR 不动——p50 回落到 0.52（三首真歌合并，回放硬线内，
// margin 0.03），floor 仍在 34% 的 onBeat 帧生效（未被架空），强弱对比 p90/p50 从 1.68×→1.88×
// （只增不减，满足 calibration-kick 对比守卫）。目标语义：保住已校准的打击手感，
// 只治 fb5 引入的“输入语境整体抬升”，不重新调打击轻重本身。
// 单一事实源 export：calibration-kick 回放测试直接消费，禁止测试端复制字面量
export const KICK_GAMMA = 1.7
export const KICK_FLOOR = 0.34

/** 确定性伪随机 0..1（同一拍序号结果稳定 → 测试可判定） */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

export class SignalRig {
  private drive = new EnvelopeFollower(0.08, 0.5)
  // T12b（Phase C1）：band 通道 attack 0.1→0.04——高频"细碎"要的是即时性，慢 attack 把颗粒感糊成雾；
  // release 0.4 保留（离场从容）。三通道统一此参数=尺度分层的燃料口径一致
  private low = new EnvelopeFollower(0.04, 0.4)
  private mid = new EnvelopeFollower(0.04, 0.4)
  private high = new EnvelopeFollower(0.04, 0.4)
  // T10a（Phase C1）拆双重平滑：engine 2s EMA 保留，rig 端 0.5s attack 是叠上去的第二层钝化——
  // 段落起来时软边界/idleFloor/energyDim 慢半拍才响应，动静对比被糊掉。改快起慢落：
  // attack 0.08（燃料即时到位）/ release 2.0 保留（离场缓收，安静段不塌）
  private energy = new EnvelopeFollower(0.08, 2.0)
  private lowNorm = new RollingPeak(30, 0.02)
  private midNorm = new RollingPeak(30, 0.02)
  private highNorm = new RollingPeak(30, 0.02)
  private beat = new Pulse(0.18)
  private beatGlow = new Pulse(0.18)
  // 律动包络：attack 33ms（=2 帧 @60fps，"视觉上冲 ≤2 帧"的下限——再短就是瞬移，
  // 位置连续性铁律；T5 打击锐化从 40ms 收紧，砍掉"慢半拍"的场景层份额）+
  // release 110ms（频谱柱级快落）
  private kickEnv = new ArPulse(2 / 60, 0.11)
  private drop = new Pulse(1.2)
  private tempo = new EnvelopeFollower(1.0, 2.0)
  private beatCount = 0
  private lastSite = -1
  private breathPhase = 0
  private beatAge = 2
  private narrativeTracker = new NarrativeTracker()
  /** 叙事层输出（每帧更新）。CPU 值而非 uniform：C2 方言在编排层消费（tween/加成），不直连 GPU */
  narrative: NarrativeState = { phase: 'steady', progress: 0 }

  constructor(private u: RigUniforms) {
    this.tempo.value = 1 // 基准速度起步（0 起步会让开场流场冻结数秒）
  }

  /** 场景侧一次性冲量入口（苏醒仪式等）——直接写 uDrop 会被 update 覆写 */
  triggerDrop(strength = 1): void {
    this.drop.trigger(strength)
  }

  /** 频段归一峰值的快照 / 恢复：**信号源切换（如进出试音）时必须成对调用**。
   * 与 mapper.snapshotBandPeaks 同理——半衰期 30s 的自适应状态会跨源残留极久，
   * 不隔离则试音的定标会压低退出后安静歌曲的反应，反之历史响歌也会让 pad 响应打折。 */
  snapshotBandPeaks(): [number, number, number] {
    return [this.lowNorm.peak, this.midNorm.peak, this.highNorm.peak]
  }

  restoreBandPeaks([low, mid, high]: [number, number, number]): void {
    this.lowNorm.setPeak(low)
    this.midNorm.setPeak(mid)
    this.highNorm.setPeak(high)
  }

  update(dt: number, s: Signals | null): number {
    const drive = this.drive.update(s?.loudness.smooth ?? 0, dt)
    this.u.uDrive.value = drive
    this.u.uLow.value = this.low.update(s ? this.lowNorm.update(s.bands.low, dt) * drive : 0, dt)
    this.u.uMid.value = this.mid.update(s ? this.midNorm.update(s.bands.mid, dt) * drive : 0, dt)
    this.u.uHigh.value = this.high.update(s ? this.highNorm.update(s.bands.high, dt) * drive : 0, dt)
    this.u.uEnergy.value = this.energy.update(s?.energy ?? 0, dt)

    // 叙事层：吃引擎原始 energy（hop 域语义，与 trace 回放同源），不吃 rig 包络后的 uEnergy
    this.narrative = this.narrativeTracker.update(dt, {
      energy: s?.energy ?? 0, drop: s?.drop ?? false, silence: s?.silence ?? true,
    })

    // uKick 单帧语义：先清零，本帧有鼓点再置值——下一帧 update 自然归零
    this.u.uKick.value = 0

    let site = -1
    if (s?.beat.onBeat) {
      this.beatCount++
      // 站位与模式由拍序号哈希决定：不可预测重复，但确定性可测（4.6 纪律）
      site = Math.floor(hash01(this.beatCount) * 5)
      if (site === this.lastSite) {
        site = (site + 1 + Math.floor(hash01(this.beatCount + 0.5) * 3)) % 5 // 偏移 1..3，必不等于原值
      }
      this.lastSite = site
      const strength = Math.max(KICK_FLOOR, Math.pow(s.beat.strength, KICK_GAMMA))
      // 每拍必有单帧冲量（干脆）+ 松弛/余韵脉冲；亮度闪光仍隔拍轮换（哈希序列与旧版一致）
      this.u.uKick.value = strength
      this.u.uKickMode.value = Math.floor(hash01(this.beatCount + 3.3) * 3)
      this.beatAge = 0
      this.beat.trigger(strength)
      this.kickEnv.trigger(strength)
      if (hash01(this.beatCount + 7.7) <= 0.5) this.beatGlow.trigger(strength)
    }
    if (s?.drop) this.drop.trigger(1)

    this.u.uBeat.value = this.beat.update(dt)
    this.u.uBeatGlow.value = this.beatGlow.update(dt)
    this.u.uKickEnv.value = this.kickEnv.update(dt)
    this.u.uDrop.value = this.drop.update(dt)

    this.beatAge = Math.min(this.beatAge + dt, 2)
    this.u.uBeatAge.value = this.beatAge

    // BPM → 全场速度感：110BPM 为基准 1.0，慢歌收到 0.7、快歌放到 1.6；1s 包络防突跳
    const tempoTarget = s?.bpm ? Math.min(1.6, Math.max(0.7, s.bpm / 110)) : 1
    this.u.uTempo.value = this.tempo.update(tempoTarget, dt)

    this.breathPhase = (this.breathPhase + dt / BREATH_PERIOD_SEC) % 1
    this.u.uSleepBreath.value = this.breathPhase
    return site
  }
}
