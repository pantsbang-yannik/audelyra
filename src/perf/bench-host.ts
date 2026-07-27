// 基准执行宿主——薄壳：把 BenchRunner 的回调翻译成对场景/引擎的真实操作，
// 并在每个场景 measure 结束时把 collector 的累积摘要收进报告。
import { BenchRunner, type BenchAction, type BenchSceneDef, type BenchSceneName } from './bench-runner'
import { perf } from './collector'
import { quantiles } from './stats'
import { DEV_DISCLAIMER } from './report'
import type { LatencyQuantiles, PerfReport, PerfReportMeta, SceneResult } from './report'
import type { GpuUnavailableReason } from './gpu-timing'

export interface BenchHostDeps {
  /** 场景输入控制 */
  startTrace(): void
  stopTrace(): void
  startPcm(): Promise<void>
  stopPcm(): void
  /** 场景状态控制 */
  setShape(shapeId: string): void
  setLyricsEnabled(on: boolean): void
  enterGalaxy(): void
  exitGalaxy(): void
  /** 元信息 */
  meta(): Promise<PerfReportMeta>
  gpuUnavailableReason(): GpuUnavailableReason | null
  tierName(): string
  particleCount(): number
  displayHz(): number
  onProgress(text: string): void
}

function q2(xs: number[]): { p50: number; p95: number } {
  const q = quantiles([...xs].sort((a, b) => a - b))
  return { p50: q.p50, p95: q.p95 }
}

export class BenchHost {
  constructor(private readonly deps: BenchHostDeps) {}

  async run(names: BenchSceneName[]): Promise<PerfReport> {
    const results: SceneResult[] = []
    const displayHz = this.deps.displayHz()
    // 跟踪"当前是否有场景已 setup 但还没 teardown"——中途 tick 抛错时用它兜底清理，
    // 否则 trace/pcm 的 rAF/interval 会残留在后台持续灌 bus，replayActive 卡死在 true
    let currentDef: BenchSceneDef | null = null

    await new Promise<void>((resolve, reject) => {
      const runner = new BenchRunner(names, {
        onSceneEnter: (def) => {
          currentDef = def
          this.deps.onProgress(`${def.name}：预热中…`)
          this.applySceneSetup(def)
        },
        onMeasureStart: (def) => {
          this.deps.onProgress(`${def.name}：测量中…`)
          // 清空累积：warmup 期的着色器编译/频率爬坡样本不许进统计
          perf.startSegment(def.measureSec, displayHz)
        },
        onAction: (def, action) => this.applyAction(def, action),
        onSceneExit: (def) => {
          results.push(this.collect(def))
          this.teardownScene(def)
          currentDef = null // 已正常收尾，无需兜底
        },
        onDone: () => resolve(),
      })

      let last = performance.now()
      const step = (now: number): void => {
        try {
          runner.tick(Math.min((now - last) / 1000, 0.1))
        } catch (err) {
          // tick 内部（含场景 applyXxx 回调、onSceneExit 里的 collect）同步抛错时，
          // onSceneExit 可能没跑到——若有未收尾的场景，尽力而为清理一次输入源
          if (currentDef) {
            try {
              this.teardownScene(currentDef)
            } catch {
              // 尽力而为：teardown 本身失败也不能挡住 reject
            }
            currentDef = null
          }
          // 必须 reject，否则 rAF 循环静默停摆，外层 await run() 永久挂起，runBench 的 finally 也进不去
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        last = now
        if (runner.phase !== 'done') requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })

    const meta = await this.deps.meta()
    return {
      meta,
      scenes: results,
      // startup 恒为 null：冷启动要重启应用，不可能在一次 bench 里测，单独采集（见 Task 11）
      startup: null,
      // 使用限制随 JSON 落盘——只写在 formatSummary 的输出里，直接读 JSON 的人就看不到了
      disclaimer: meta.buildType === 'dev' ? DEV_DISCLAIMER : null,
    }
  }

  private applySceneSetup(def: BenchSceneDef): void {
    this.deps.setLyricsEnabled(def.lyrics)
    if (def.input === 'trace') this.deps.startTrace()
    else if (def.input === 'pcm') void this.deps.startPcm()
  }

  private teardownScene(def: BenchSceneDef): void {
    if (def.input === 'trace') this.deps.stopTrace()
    else if (def.input === 'pcm') this.deps.stopPcm()
    if (def.name === 'galaxy') this.deps.exitGalaxy() // 兜底：确保退出星系态，不污染下一场景
    this.deps.setLyricsEnabled(false)
  }

  private applyAction(_def: BenchSceneDef, action: BenchAction): void {
    if (action.kind === 'shape-switch' && action.shapeId) this.deps.setShape(action.shapeId)
    else if (action.kind === 'galaxy-enter') this.deps.enterGalaxy()
    else if (action.kind === 'galaxy-exit') this.deps.exitGalaxy()
  }

  private collect(def: BenchSceneDef): SceneResult {
    const s = perf.frameStats.summarize()
    const gpu = perf.gpu.summarize(s.frames)
    const lat = perf.latencySamples
    let latencyMs: LatencyQuantiles | null = null
    if (def.input === 'pcm' && lat.length > 0) {
      latencyMs = {
        engine: q2(lat.map((x) => x.engine)),
        wait: q2(lat.map((x) => x.wait)),
        render: q2(lat.map((x) => x.render)),
        total: q2(lat.map((x) => x.total)),
      }
    }
    return {
      name: def.name,
      tier: this.deps.tierName(),
      particles: this.deps.particleCount(),
      durationSec: def.measureSec,
      frames: s.frames,
      cpuFrameMs: s.cpuFrameMs,
      intervalMs: s.intervalMs,
      jankEventRate: s.jankEventRate,
      missedVsyncRate: s.missedVsyncRate,
      hitchCount: s.hitchCount,
      gpu,
      gpuUnavailableReason: gpu === null ? (this.deps.gpuUnavailableReason() ?? 'no-batches') : null,
      phasesMs: s.phasesMs,
      latencyMs,
    }
  }
}
