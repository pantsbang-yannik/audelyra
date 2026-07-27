// GPU 批次采样记账。纯逻辑，无 three 依赖——调用方负责真正发起 resolve 并把结果喂进来。
//
// 为什么是「批次」而不是「逐帧」：three 的 resolveTimestampsAsync 返回的是 query pool
// 自上次清空以来全部 pass 的时长总和，而异步回读要跨若干帧完成，期间新帧继续累积进下一批。
// 因此拿不到逐帧序列，只能把批次总时长摊成均值——报告字段命名为 batchAvgMs 而非 gpuFrameMs，
// 避免被误读为逐帧值。需要 GPU 尾部分布请用 Instruments 的 Metal System Trace 离线抓。
import { quantiles } from './stats'
import type { Quantiles } from './types'

export type GpuUnavailableReason = 'feature-unsupported' | 'webgl-backend' | 'no-batches'

/** 覆盖率低于此值时摘要须显式标注「GPU 采样覆盖不足」 */
export const COVERAGE_WARN_THRESHOLD = 0.5

export interface GpuTimingSummary {
  /** 批次均值序列的分布。注意：这是批次均值的分位数，不是逐帧 GPU 耗时的分位数 */
  batchAvgMs: Quantiles
  batches: number
  framesCovered: number
  coverage: number
  droppedBatches: number
}

export class GpuTimingAccumulator {
  private frames = 0
  private lastBatchStartFrame = 0
  private inFlight = false
  private pendingCoveredFrames = 0
  private samples: number[] = []
  private framesCovered = 0
  private dropped = 0
  /** 批次代号。GPU resolve 是异步的，回调可能在 reset() 之后才落地——
   * 没有它，上一场景的耗时会被摊进下一场景的样本，且会错误解开新批的 single-flight 锁 */
  private epoch = 0

  /** 每帧调用一次，纯计数 */
  onFrame(): void {
    this.frames++
  }

  /** 严格 single-flight：不依赖 three 内部的 Promise 复用，自持标志 */
  canStartBatch(): boolean {
    return !this.inFlight
  }

  /** 发起一批 resolve 前调用，锁定本批覆盖的帧数。返回的 epoch 必须原样带回 endBatch */
  beginBatch(): number {
    this.pendingCoveredFrames = this.frames - this.lastBatchStartFrame
    this.lastBatchStartFrame = this.frames
    this.inFlight = true
    return ++this.epoch
  }

  /** resolve 完成后调用，epoch 为对应 beginBatch 的返回值。
   * totalMs 为 null 表示该批被丢弃（pool 溢出或后端拒绝）。
   * epoch 不匹配 = 该回调属于已被 reset 作废的旧批，或是重复投递，直接丢弃。 */
  endBatch(epoch: number, totalMs: number | null): void {
    if (epoch !== this.epoch) return
    this.epoch++ // 本批已结算，同 epoch 的重复投递从此不再生效
    this.inFlight = false
    if (totalMs === null) {
      this.dropped++
      return
    }
    if (this.pendingCoveredFrames <= 0) return // 无覆盖帧，摊不出均值
    this.samples.push(totalMs / this.pendingCoveredFrames)
    this.framesCovered += this.pendingCoveredFrames
  }

  /** 无成功批次时返回 null——调用方据此在报告里记 gpu:null + reason，绝不填 0 */
  summarize(totalFrames: number): GpuTimingSummary | null {
    if (this.samples.length === 0) return null
    const sorted = [...this.samples].sort((a, b) => a - b)
    return {
      batchAvgMs: quantiles(sorted),
      batches: this.samples.length,
      framesCovered: this.framesCovered,
      coverage: totalFrames > 0 ? this.framesCovered / totalFrames : 0,
      droppedBatches: this.dropped,
    }
  }

  reset(): void {
    this.frames = 0
    this.lastBatchStartFrame = 0
    this.inFlight = false
    this.pendingCoveredFrames = 0
    this.samples = []
    this.framesCovered = 0
    this.dropped = 0
    this.epoch++ // 作废所有在飞批次：它们的回调落地时 epoch 已对不上，自然失效
  }
}
