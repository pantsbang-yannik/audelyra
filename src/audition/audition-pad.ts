// 试音模式 · pad 档：把「一个声音事件」直接合成为 Signals 帧
// 注入 SignalBus，供用户调完一条反应立刻单变量验证——不必等歌放到副歌，可无限重复。
//
// 为什么不播一段短音频喂引擎：引擎特征提取有状态、带时间窗（EnvelopeFollower/Spring、beat tracker 靠
// 连续节拍历史锁 BPM、section-tracker 靠前后能量台阶），孤立播放 0.3s 采样会让 beat/drop/tempo 全部哑火，
// 结果是「在试音里调好、放真歌不是那个样子」，比没有试音更坏。故本模块直接给出事件，
// 音效反馈只走扬声器（见 pad-sound.ts），不进引擎。
//
// 本文件零 DOM、零 electron、零 WebAudio 依赖（纯逻辑抽离惯例，接线在 ui/audition-bar.ts）。
import type { Signals } from '../engine/types'

export type PadId = 'beat' | 'drop' | 'high' | 'low' | 'silence'

export interface PadDef {
  id: PadId
  /** pad 面上的话——说的是「声音里发生了什么」，不是「画面会怎样」（画面由用户的反应决定） */
  label: string
  /** 键盘加速键（单字符，大写显示；按钮本身必须可点，键盘不是唯一入口） */
  key: string
}

// 顺序即 UI 排布顺序：三个脉冲型在前，两个持续型在后
export const AUDITION_PADS: readonly PadDef[] = [
  { id: 'beat', label: '鼓点', key: 'A' },
  { id: 'drop', label: '副歌炸', key: 'S' },
  { id: 'low', label: '低频', key: 'D' },
  { id: 'high', label: '高频', key: 'F' },
  { id: 'silence', label: '静下来', key: 'G' },
]

/** 静息底：安静但「活着」。silence 必须为 false——否则场景走沉睡 tween（index.ts uSleep），
 * 一进试音画面就睡过去，连续型反应看不出基线。bpm 给 120 让 tempo 特征有值（否则兜底 0.5 亦可，
 * 但显式给值使 tempo 反应在试音里可预期）。 */
// 🔴 频段值必须用**真实音乐的量级**，不能想当然按 0..1 给：
// `Signals.bands` 是未归一化的原始频段均值（features.ts 的 `avg(from,to)`），
// 实测真歌（src/assets/traces/onboarding-demo.jsonl，60s）：
//   low  p10=11.07 p50=18.95 p90=35.99 max=66.95
//   mid  p10=1.57  p50=2.50  p90=4.12  max=8.42
//   high p10=0.03  p50=0.07  p90=0.45  max=1.32
// 三段量级差两个数量级。按 0..1 给会让试音工作在真实音乐里几乎不存在的工作点上——
// 试音与实际播放就不再吻合；且 mapper 对频段做滚动峰值归一后，量级不对会让动态失真。
// 静息取各段 p10（安静时的真实水平），冲量取 p90~max。
// loudness/energy 不在此列——引擎侧已归一化为 0..1（契约 v1.1），照 0..1 给即正确。
const IDLE = {
  loudness: 0.18,
  low: 11,
  mid: 1.6,
  high: 0.03,
  energy: 0.15,
  bpm: 120,
} as const
/** 静息底的频段微动周期（秒，互质避免三段同步起落）。
 * 为什么静息不能是恒定值：mapper 对频段做滚动峰值归一，恒定输入会让峰值收敛到当前值、
 * 归一化结果恒为满值 1.0（与 SpectrumBins 的栅栏成因同源）。真实音乐的频段能量本就持续起伏，
 * 故此处叠三条慢波。**这份微动不进 spectrum**（见 step 内注释），故柱形仍完全静止，
 * 只有粒径/亮度一类连续量会有极轻的呼吸。 */
const IDLE_WOBBLE = { low: 3.7, mid: 2.3, high: 1.7 } as const
const IDLE_WOBBLE_DEPTH = 0.45 // 谷值 = 基线 × (1-0.45)

const SPECTRUM_BINS = 512

/** 一次 pad 触发的包络：脉冲字段只在触发帧交付（bus.takeFrame 的折叠语义保证不丢），
 * 连续字段按 decaySec 线性衰减回静息底。 */
interface Impulse {
  id: PadId
  /** 剩余时间（秒），归零即出队 */
  left: number
  decaySec: number
  /** 本次触发是否还没交付过脉冲字段（onBeat/drop 只交付一帧） */
  pulsePending: boolean
}

/** 各 pad 的连续量目标值与时程。脉冲型也给短衰减，让「鼓点」除了 beat 事件还带一点能量抬升——
 * 真实鼓点就是这样，纯事件无能量会让吃 energy 的反应在试音里毫无动静。 */
// 频段峰值取真歌的 p50~max（见 IDLE 上方实测），loudness/energy 用 0..1（引擎已归一化）。
// 🔴 每个 pad 都必须给**完整的三频段**，只是侧重不同——真实音乐里不存在「只有高频、低频为零」的帧。
// 把 high pad 写成只抬 high 会让柱形完全不动：SpectrumBins 的全局响度权重
// （`loud = (当前全场能量/全局峰)^1.6`）按全场能量算，而高频能量只有低频的 ~1/50，
// 全场几乎没能量时整条柱形被压没。伴随频段取各段 p50，即「整体在响、某段突出」。
const PAD_SHAPE: Record<PadId, { decaySec: number; loudness?: number; low?: number; mid?: number; high?: number; energy?: number }> = {
  beat: { decaySec: 0.25, loudness: 0.75, low: 36, mid: 3, high: 0.15, energy: 0.5 }, // 鼓点：低频突出，带一点敲击的中高频
  drop: { decaySec: 0.9, loudness: 0.95, low: 60, mid: 6, high: 0.8, energy: 0.95 }, // 段落级，全段齐上，故时程最长
  low: { decaySec: 0.45, loudness: 0.7, low: 67, mid: 2.5, high: 0.07, energy: 0.45 }, // 低频拉满，其余维持 p50
  high: { decaySec: 0.4, loudness: 0.6, low: 19, mid: 3, high: 1.3, energy: 0.4 }, // 高频拉满，低频维持 p50 撑住整体响度
  silence: { decaySec: 1.5 }, // 无抬升；靠 isSilence() 把各量压到 0
}

const BEAT_STRENGTH = 0.85
/** 同一 pad 连击时的最短间隔（秒）：低于此值视为重复触发，重置包络而非叠加，防连点把连续量顶到饱和 */
const RETRIGGER_FLOOR = 0.03

/** 入场标定：进入试音时先给频段一次「真歌峰值级」的衰减。
 * 为什么需要：下游两处都是**滚动峰值归一**（mapper 的 bandNorms、SpectrumBins 的 binPeaks），
 * 若一进来只有静息值，那静息值本身就成了历史峰值 → 归一化恒为满值 →
 * 第一次按 pad 完全看不出变化，第二次才正常。先标定到音乐量级即可消除这个「首击失灵」。
 * 视觉上是 0.6s 的淡入（画面从亮落到静息），不突兀；且不发任何脉冲事件，不会被误当成鼓点。 */
const CALIBRATE_SEC = 0.6
const CALIBRATE_BANDS = { low: 67, mid: 8.4, high: 1.32 } as const // 真歌各段 max（见 IDLE 上方实测）
/** 标定峰值的对外形态（[low, mid, high]）：装配层进入试音时用它**复位**下游的滚动峰值归一，
 * 使 pad 响应与「之前听过什么歌」无关。仅靠入场标定不够——RollingPeak 只会抬高不会降低，
 * 若历史峰值更高（听过更响的歌），同一个 pad 的响应就会打折，破坏「精确可重复」。 */
export const AUDITION_BAND_PEAKS: [number, number, number] =
  [CALIBRATE_BANDS.low, CALIBRATE_BANDS.mid, CALIBRATE_BANDS.high]

export class AuditionPad {
  private t = 0
  private impulses: Impulse[] = []
  private calibrating = CALIBRATE_SEC

  /** 按下一个 pad。同 pad 连击重置其包络（不叠加）；不同 pad 可共存叠加。 */
  trigger(id: PadId): void {
    const shape = PAD_SHAPE[id]
    const existing = this.impulses.find((i) => i.id === id)
    if (existing && existing.left > shape.decaySec - RETRIGGER_FLOOR) return // 同帧内重复触发，忽略
    if (existing) {
      existing.left = shape.decaySec
      existing.pulsePending = true
      return
    }
    this.impulses.push({ id, left: shape.decaySec, decaySec: shape.decaySec, pulsePending: true })
  }

  /** 是否有冲量在衰减中——UI 用来点亮 pad，接线侧用来判断能否退出试音而不截断画面。 */
  get busy(): boolean {
    return this.impulses.length > 0
  }

  /** 「静下来」在演：silence 期间其余量压 0（真静音的语义，不是「音量小」）。 */
  private isSilence(): boolean {
    return this.impulses.some((i) => i.id === 'silence')
  }

  /** 推进一帧并产出注入 bus 的信号。**必须每帧调用**——只注入触发那一帧的话，bus._latest 会永久停在
   * 冲量峰值（连续字段不清零），画面冻结在最亮那一刻。 */
  step(dtSec: number): Signals {
    this.t += dtSec
    for (const i of this.impulses) i.left -= dtSec
    // 交付脉冲前不能先剔除刚触发的冲量：dtSec 可能大于极短 decaySec（掉帧），
    // 故先读取（含 pulsePending），再按 left 清理
    const silence = this.isSilence()

    // 静息频段带慢波微动（见 IDLE_WOBBLE 注释：恒定值会被滚动峰值归一成满值）
    const wob = (periodSec: number): number =>
      1 - IDLE_WOBBLE_DEPTH * 0.5 * (1 - Math.cos((this.t / periodSec) * Math.PI * 2))
    let loudness = silence ? 0 : IDLE.loudness
    let low = silence ? 0 : IDLE.low * wob(IDLE_WOBBLE.low)
    let mid = silence ? 0 : IDLE.mid * wob(IDLE_WOBBLE.mid)
    let high = silence ? 0 : IDLE.high * wob(IDLE_WOBBLE.high)
    let energy = silence ? 0 : IDLE.energy
    let onBeat = false
    let strength = 0
    let drop = false

    // pad 冲量单独累计一份——**只有它能驱动 spectrum**。
    // 静息与入场标定一律不进谱：无输入时柱形必须完全静止。
    // 静息底的微动只服务 mapper 侧的频段归一——那些量驱动粒径/亮度，不表现为「动」。
    let padLow = 0
    let padMid = 0
    let padHigh = 0

    for (const i of this.impulses) {
      const shape = PAD_SHAPE[i.id]
      // 线性衰减系数：触发帧=1，包络末尾=0。left 可为负（掉帧），夹到 0
      const k = shape.decaySec <= 0 ? 0 : Math.max(0, Math.min(1, i.left / shape.decaySec))
      if (i.pulsePending) {
        if (i.id === 'beat') { onBeat = true; strength = Math.max(strength, BEAT_STRENGTH) }
        if (i.id === 'drop') { drop = true; onBeat = true; strength = Math.max(strength, 1) } // 炸开同时是一个强鼓点
        i.pulsePending = false
      }
      if (silence) continue // 「静下来」压过其余 pad 的连续抬升（脉冲已在上面交付）
      // 取最大而非累加：两个 pad 同时按下不应把量顶出值域（下游 softLimit 之外再留一层保险）
      if (shape.loudness) loudness = Math.max(loudness, shape.loudness * k)
      if (shape.low) { low = Math.max(low, shape.low * k); padLow = Math.max(padLow, shape.low * k) }
      if (shape.mid) { mid = Math.max(mid, shape.mid * k); padMid = Math.max(padMid, shape.mid * k) }
      if (shape.high) { high = Math.max(high, shape.high * k); padHigh = Math.max(padHigh, shape.high * k) }
      if (shape.energy) energy = Math.max(energy, shape.energy * k)
    }

    this.impulses = this.impulses.filter((i) => i.left > 0)

    // 入场标定（见 CALIBRATE_SEC 注释）：只抬频段供 mapper 归一化定标，
    // 不发脉冲、不动 energy/loudness、**不进 spectrum**（否则进场时柱子会无故跳一下）
    if (this.calibrating > 0 && !silence) {
      const c = this.calibrating / CALIBRATE_SEC
      low = Math.max(low, CALIBRATE_BANDS.low * c)
      mid = Math.max(mid, CALIBRATE_BANDS.mid * c)
      high = Math.max(high, CALIBRATE_BANDS.high * c)
    }
    if (this.calibrating > 0) this.calibrating = Math.max(0, this.calibrating - dtSec)

    return {
      t: this.t,
      loudness: { instant: loudness, smooth: loudness },
      bands: { low, mid, high },
      spectrum: spectrumFor(padLow, padMid, padHigh, this.t, silence),
      beat: { onBeat, strength },
      bpm: silence ? null : IDLE.bpm,
      energy,
      drop,
      silence,
    }
  }

  /** 退出试音时复位，下次进入从静息底开始。 */
  reset(): void {
    this.impulses = []
    this.t = 0
    this.calibrating = CALIBRATE_SEC // 每次进入都重新标定：上次的滚动峰值已随离场衰减
  }
}

// 谱形按三频段重建——不追求物理真实，只求吃 spectrum 的 body（日食/频谱环/波形线）跟着 pad 起落。
// 复用一块缓冲（每帧新建 512 Float32Array 是热路径上的无谓 GC 压力）；与引擎同惯例——
// engine.ts 的 smoothSpectrum 也是一次分配、逐帧原地更新后 publish 同一引用，
// 下游唯一消费者 spectrumBins.update() 即时读取不跨帧持有。
//
// 🔴 SpectrumBins 是**逐桶滚动峰值归一**（`raw[k] / binPeaks[k]`，注释原文「柱柱都有满高的机会」），
// 这给合成谱设了两道约束，两者必须同时满足：
//   ① **不能喂恒定谱**——每桶峰值会收敛到自身当前值、比值恒为 1 → 64 根柱子全部满格（等高栅栏）。
//   ② **静息必须是零谱**——给静息加微动可以绕开 ①，但那会让柱形在无输入时自行起伏，不可取。
// 定稿解法：**只有 pad 冲量进谱**（静息与入场标定一律不进 → 静息零谱，柱子塌着不动），
// 冲量期间叠**每 bin 独立相位的慢波纹理**，让各桶峰值出现在不同时刻 → 柱形拉开层次（见 BIN_PHASE）。
const spectrumBuf = new Float32Array(SPECTRUM_BINS)
// 🔴 频段边界按**桶空间**取，不按线性 bin 比例：SpectrumBins 用几何级数分桶，
// 线性地按 12%/45% 切 bin 会让低频独占 40/64 桶、高频只剩 10 桶——高频 pad 只点亮环的 1/6，
// 那样高频只能点亮环的 1/6，观感上近乎无反应。
// 反推时注意低端不是几何级数：EDGES 有 `max(e[i], e[i-1]+1)` 保底，
// 前 ~34 桶实际退化成线性 `EDGES[k] = k + 2`（几何步长不足 1 bin）。
// 于是桶 21 ≈ bin 23（线性区）、桶 42 ≈ bin 74（几何区），三段各占约 21 桶才均衡。
const LOW_END = 23
const MID_END = 74
/** 每个 bin 的纹理相位（黄金角步进；确定性、不用 Math.random 以保可测）。
 * 🔴 这是柱形能否参差的关键：SpectrumBins 逐桶自峰归一 = 「每桶除以自己的历史最大值」，
 * 所以**静态谱形对柱高毫无影响**（每桶都在自己刚创的新高上 → 恒为满格，即等高栅栏）。
 * 要参差，唯一办法是让各桶的峰值出现在**不同时刻**——给每个 bin 一个独立相位的慢波即可。
 * 真实音乐的频谱本就是各频率成分各自起伏，这不是凭空加特效，是补上先前被漏掉的真实特性。 */
const BIN_PHASE = ((): Float32Array => {
  const p = new Float32Array(SPECTRUM_BINS)
  for (let i = 0; i < SPECTRUM_BINS; i++) p[i] = (i * 2.39996) % (Math.PI * 2) // 黄金角：相邻错开且长程不重复
  return p
})()
const TEXTURE_RATE = 2.1 // rad/s，约 3s 一周期：慢到不像噪声，快到能在冲量时程内拉开层次
const TEXTURE_DEPTH = 0.4 // 纹理谷值 = 峰值 × (1-0.4)

/** 入参是**pad 冲量**的频段值（不含静息底与入场标定）：没按键就该是零谱，柱子塌着不动。 */
function spectrumFor(padLow: number, padMid: number, padHigh: number, t: number, silence: boolean): Float32Array {
  if (silence || (padLow <= 0 && padMid <= 0 && padHigh <= 0)) {
    spectrumBuf.fill(0)
    return spectrumBuf
  }
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const band = i < LOW_END ? padLow : i < MID_END ? padMid : padHigh
    const texture = 1 - TEXTURE_DEPTH * 0.5 * (1 - Math.cos(t * TEXTURE_RATE + BIN_PHASE[i]))
    // 段内叠 1/f 衰减：真实谱的高频衰减趋势
    spectrumBuf[i] = band * texture * (0.45 + 0.55 / (1 + i * 0.012))
  }
  return spectrumBuf
}
