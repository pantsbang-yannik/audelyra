// 性能采集器单例——薄壳：持有纯逻辑实例，被各探针点调用。
// off 态零开销纪律：每个探针点先查 perf.enabled 早退，不做任何计算。
import { FrameStats, capacityFor } from './stats'
import { GpuTimingAccumulator } from './gpu-timing'
import type { FrameSample, LatencySample, PerfMode, PhaseMs } from './types'

const ZERO_PHASES = (): PhaseMs => ({ signal: 0, mapping: 0, state: 0, visual: 0, camera: 0, submit: 0 })

/** HUD 常驻时的缓冲时长：够算 1 分钟窗口的分位数 */
const HUD_WINDOW_SEC = 60

export class PerfCollector {
  private _mode: PerfMode = 'off'
  private _targetIntervalMs = 1000 / 60
  private stats = new FrameStats({ capacity: capacityFor(HUD_WINDOW_SEC, 60), targetIntervalMs: 1000 / 60 })
  private readonly gpuAcc = new GpuTimingAccumulator()
  private latency: LatencySample[] = []

  private frameStartMs = 0
  private lastFrameStartMs = 0
  private phases = ZERO_PHASES()
  private lastPcmInMs = -1
  private lastSignalOutMs = -1
  /** 已被某帧消费过的 signalOut 不再重复计延迟——否则无信号时同一个时刻会被反复计入 */
  private consumedSignalOutMs = -1

  get mode(): PerfMode {
    return this._mode
  }

  /** 探针点的早退判据。热路径上只读这一个布尔 */
  get enabled(): boolean {
    return this._mode !== 'off'
  }

  get trackGpu(): boolean {
    return this._mode === 'bench'
  }

  get frameStats(): FrameStats {
    return this.stats
  }

  get gpu(): GpuTimingAccumulator {
    return this.gpuAcc
  }

  get targetIntervalMs(): number {
    return this._targetIntervalMs
  }

  /** 实际生效档位（单一真源）。场景 init 按 backend 自动选档时（tier='auto'），真正生效的档位
   * 只有场景自己知道——不回传的话 HUD/报告只能硬编码猜成 high，低配机上稳定显示 high/450k 但
   * 实际跑 low 档，档位是解读性能数字的必要上下文，猜错就是误导。场景确定档位后调 setActiveTier。 */
  private _activeTier: { name: string; particles: number } | null = null

  setActiveTier(name: string, particles: number): void {
    this._activeTier = { name, particles }
  }

  get activeTier(): { name: string; particles: number } | null {
    return this._activeTier
  }

  get latencySamples(): readonly LatencySample[] {
    return this.latency
  }

  setMode(mode: PerfMode, opts: { displayHz?: number; windowSec?: number } = {}): void {
    this._mode = mode
    if (opts.displayHz && opts.displayHz > 0) {
      this._targetIntervalMs = 1000 / opts.displayHz
      this.stats = new FrameStats({
        capacity: capacityFor(opts.windowSec ?? HUD_WINDOW_SEC, opts.displayHz),
        targetIntervalMs: this._targetIntervalMs,
      })
    }
    // 无论是否重建 stats——mode 切换即采集中断，哨兵必须归零
    this.resetTiming()
  }

  /** 开一段新的测量窗口（bench 每场景 measure 起点调用），清空所有累积 */
  startSegment(durationSec: number, displayHz: number): void {
    this._targetIntervalMs = 1000 / displayHz
    this.stats = new FrameStats({
      capacity: capacityFor(durationSec, displayHz),
      targetIntervalMs: this._targetIntervalMs,
    })
    this.gpuAcc.reset()
    this.latency = []
    this.resetTiming()
  }

  /** 重置帧计时与延迟哨兵到构造初值。setMode/startSegment 都必须调用——采集连续性一旦中断
   * （关探针、切场景），这四个字段就是陈旧的：off 期间挂钟走了几十秒，重开首帧会把这段间隔
   * 当成一帧 intervalMs；上一场景残留的 pcmIn/signalOut 会被下一场景首帧当成真实延迟样本。
   * 这与 GPU 侧 epoch 作废在飞回调（gpu-timing.ts）是同一类跨会话污染，CPU 侧靠重置哨兵解决。 */
  private resetTiming(): void {
    this.lastFrameStartMs = 0
    this.lastPcmInMs = -1
    this.lastSignalOutMs = -1
    this.consumedSignalOutMs = -1
  }

  beginFrame(nowMs: number): void {
    this.frameStartMs = nowMs
    this.phases = ZERO_PHASES()
  }

  markPhase(key: keyof PhaseMs, ms: number): void {
    this.phases[key] += ms
  }

  endFrame(nowMs: number): void {
    const intervalMs = this.lastFrameStartMs === 0 ? this._targetIntervalMs : this.frameStartMs - this.lastFrameStartMs
    this.lastFrameStartMs = this.frameStartMs
    const sample: FrameSample = {
      cpuMs: nowMs - this.frameStartMs,
      intervalMs,
      phases: this.phases,
    }
    this.stats.push(sample)
    this.gpuAcc.onFrame()
    // 内部延迟：本帧消费到一个尚未被计过的信号才记样本
    if (this.lastSignalOutMs >= 0 && this.lastSignalOutMs !== this.consumedSignalOutMs && this.lastPcmInMs >= 0) {
      this.consumedSignalOutMs = this.lastSignalOutMs
      const engine = this.lastSignalOutMs - this.lastPcmInMs
      const wait = this.frameStartMs - this.lastSignalOutMs
      const render = nowMs - this.frameStartMs
      if (engine >= 0 && wait >= 0) {
        this.latency.push({ engine, wait, render, total: engine + wait + render })
      }
    }
  }

  markPcmIn(nowMs: number): void {
    this.lastPcmInMs = nowMs
  }

  markSignalOut(nowMs: number): void {
    this.lastSignalOutMs = nowMs
  }
}

export const perf = new PerfCollector()
