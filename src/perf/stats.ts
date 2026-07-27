// 帧样本统计——环形缓冲 + 分位数 + 三类掉帧指标。纯逻辑，无 DOM / three / electron 依赖。
import type { FrameSample, PhaseMs, Quantiles } from './types'

/** 慢帧判据倍率：间隔 > 1.5×目标才算。取 1.5 而非 1.0 是避开边界抖动——
 * 60Hz 下实测间隔常在 16.6~16.9ms 浮动，按 1.0 倍判会把正常帧大面积误判为掉帧 */
export const JANK_FACTOR = 1.5
/** 可感卡顿阈值：连丢 2 帧以上人眼明确可见。用绝对毫秒而非倍率——体感与刷新率无关 */
export const HITCH_MS = 33
/** 缓冲容量余量：预留 20% 抗帧率超出标称刷新率的情况 */
export const CAPACITY_MARGIN = 1.2

export interface FrameStatsSummary {
  frames: number
  cpuFrameMs: Quantiles
  intervalMs: Quantiles
  /** 慢帧「事件」占比：多大比例的帧慢了 */
  jankEventRate: number
  /** 错过的垂直同步次数占期望帧数之比：一帧卡 100ms 在这里按 5 次计，比事件占比更贴近实际损失 */
  missedVsyncRate: number
  /** 可感卡顿绝对次数。比率类指标会稀释偶发大卡顿，绝对计数不会 */
  hitchCount: number
  /** 各段耗时的 p50 */
  phasesMs: PhaseMs
}

const EMPTY_Q: Quantiles = { p50: 0, p95: 0, p99: 0, max: 0 }

/** nearest-rank 分位数。入参必须已升序排好——调用方负责排序，避免本函数重复拷贝 */
export function quantiles(sortedAsc: number[]): Quantiles {
  const n = sortedAsc.length
  if (n === 0) return { ...EMPTY_Q }
  const at = (p: number): number => sortedAsc[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sortedAsc[n - 1] }
}

/** 缓冲容量：按场景时长 × 刷新率 × 余量。写死容量会在高刷屏上静默丢掉前半段样本 */
export function capacityFor(durationSec: number, displayHz: number): number {
  return Math.ceil(durationSec * displayHz * CAPACITY_MARGIN)
}

export class FrameStats {
  private readonly capacity: number
  private readonly targetIntervalMs: number
  private readonly cpu: Float64Array
  private readonly interval: Float64Array
  private readonly phaseCols: Record<keyof PhaseMs, Float64Array>
  private writeIndex = 0
  private filled = 0

  constructor(opts: { capacity: number; targetIntervalMs: number }) {
    this.capacity = Math.max(1, Math.floor(opts.capacity))
    this.targetIntervalMs = opts.targetIntervalMs
    this.cpu = new Float64Array(this.capacity)
    this.interval = new Float64Array(this.capacity)
    this.phaseCols = {
      signal: new Float64Array(this.capacity),
      mapping: new Float64Array(this.capacity),
      state: new Float64Array(this.capacity),
      visual: new Float64Array(this.capacity),
      camera: new Float64Array(this.capacity),
      submit: new Float64Array(this.capacity),
    }
  }

  get count(): number {
    return this.filled
  }

  push(s: FrameSample): void {
    const i = this.writeIndex
    this.cpu[i] = s.cpuMs
    this.interval[i] = s.intervalMs
    this.phaseCols.signal[i] = s.phases.signal
    this.phaseCols.mapping[i] = s.phases.mapping
    this.phaseCols.state[i] = s.phases.state
    this.phaseCols.visual[i] = s.phases.visual
    this.phaseCols.camera[i] = s.phases.camera
    this.phaseCols.submit[i] = s.phases.submit
    this.writeIndex = (i + 1) % this.capacity
    if (this.filled < this.capacity) this.filled++
  }

  reset(): void {
    this.writeIndex = 0
    this.filled = 0
  }

  summarize(): FrameStatsSummary {
    const n = this.filled
    if (n === 0) {
      return {
        frames: 0,
        cpuFrameMs: { ...EMPTY_Q },
        intervalMs: { ...EMPTY_Q },
        jankEventRate: 0,
        missedVsyncRate: 0,
        hitchCount: 0,
        phasesMs: { signal: 0, mapping: 0, state: 0, visual: 0, camera: 0, submit: 0 },
      }
    }
    const target = this.targetIntervalMs
    const jankThreshold = target * JANK_FACTOR
    let jankFrames = 0
    let missedVsync = 0
    let hitches = 0
    let totalMs = 0
    for (let k = 0; k < n; k++) {
      const v = this.interval[k]
      totalMs += v
      if (v > jankThreshold) jankFrames++
      if (v > HITCH_MS) hitches++
      missedVsync += Math.max(0, Math.round(v / target) - 1)
    }
    const expectedFrames = target > 0 ? totalMs / target : 0
    return {
      frames: n,
      cpuFrameMs: quantiles(this.sortedSlice(this.cpu, n)),
      intervalMs: quantiles(this.sortedSlice(this.interval, n)),
      jankEventRate: jankFrames / n,
      missedVsyncRate: expectedFrames > 0 ? missedVsync / expectedFrames : 0,
      hitchCount: hitches,
      phasesMs: {
        signal: quantiles(this.sortedSlice(this.phaseCols.signal, n)).p50,
        mapping: quantiles(this.sortedSlice(this.phaseCols.mapping, n)).p50,
        state: quantiles(this.sortedSlice(this.phaseCols.state, n)).p50,
        visual: quantiles(this.sortedSlice(this.phaseCols.visual, n)).p50,
        camera: quantiles(this.sortedSlice(this.phaseCols.camera, n)).p50,
        submit: quantiles(this.sortedSlice(this.phaseCols.submit, n)).p50,
      },
    }
  }

  /** 取前 n 个有效槽位并升序排序。只在汇总时调用（1Hz 或场景结束），绝不在渲染帧内调用 */
  private sortedSlice(buf: Float64Array, n: number): number[] {
    const out = new Array<number>(n)
    for (let k = 0; k < n; k++) out[k] = buf[k]
    out.sort((a, b) => a - b)
    return out
  }
}
