// 基准编排状态机。纯逻辑：不碰 DOM、不碰 three、不碰 electron——
// 场景怎么"跑起来"由宿主（bench-host.ts）在回调里实现，本文件只负责时序与动作脚本。
// 这样编排本身完全可测。

export type BenchSceneName =
  | 'idle' | 'playback' | 'stress-live' | 'galaxy' | 'engine-latency' | 'power-playback' | 'soak'

/** 输入源：none=无信号；trace=Signals 直灌 bus（视觉基准）；pcm=预解码音频送 engine.ingest（引擎基准） */
export type BenchInput = 'none' | 'trace' | 'pcm'

export interface BenchAction {
  kind: 'shape-switch' | 'galaxy-enter' | 'galaxy-exit'
  /** measure 内相对秒数（measure 起点 = 0） */
  atSec: number
  shapeId?: string
}

export interface BenchSceneDef {
  name: BenchSceneName
  input: BenchInput
  warmupSec: number
  measureSec: number
  actions: BenchAction[]
  lyrics: boolean
}

/** 正式测量前空跑，避开着色器编译、缓冲分配、GPU 频率爬坡 */
export const WARMUP_SEC = 5

/** stress-live 的固定切换序列。固定顺序才可重复——随机切形状会让两次跑分不可比。
 * 选型覆盖轮廓点云(heart) + 三类 body 特效(spectrum/waveform/eclipse)——星球/晶体几何生成形状已退役 */
export const STRESS_SHAPE_CYCLE = ['heart', 'spectrum', 'waveform', 'eclipse']

export const SCENES: Record<BenchSceneName, BenchSceneDef> = {
  idle: {
    name: 'idle', input: 'none', warmupSec: WARMUP_SEC, measureSec: 30,
    actions: [], lyrics: false,
  },
  playback: {
    name: 'playback', input: 'trace', warmupSec: WARMUP_SEC, measureSec: 60,
    actions: [], lyrics: false,
  },
  'stress-live': {
    name: 'stress-live', input: 'trace', warmupSec: WARMUP_SEC, measureSec: 50,
    actions: STRESS_SHAPE_CYCLE.map((shapeId, i) => ({
      kind: 'shape-switch' as const, atSec: 10 * (i + 1), shapeId,
    })),
    lyrics: true,
  },
  galaxy: {
    name: 'galaxy', input: 'trace', warmupSec: WARMUP_SEC, measureSec: 40,
    // galaxy 走独立更新路径（不跑 live 六段），measure 期分段全 0——report 已用「分段覆盖不全」
    // 警告兜底，不假装能测 galaxy 分段。子段精细统计本期不做，需要时另开。
    actions: [
      { kind: 'galaxy-enter', atSec: 0 },
      { kind: 'galaxy-exit', atSec: 30 },
    ],
    lyrics: false,
  },
  'engine-latency': {
    name: 'engine-latency', input: 'pcm', warmupSec: WARMUP_SEC, measureSec: 60,
    actions: [], lyrics: false,
  },
  'power-playback': {
    name: 'power-playback', input: 'trace', warmupSec: WARMUP_SEC, measureSec: 60,
    actions: [], lyrics: false,
  },
  soak: {
    name: 'soak', input: 'trace', warmupSec: WARMUP_SEC, measureSec: 1800,
    actions: [], lyrics: false,
  },
}

/** 一键流程。power-playback 需与外部 powermetrics 采样窗口对齐、soak 要半小时，都单独触发 */
export const SUITE: BenchSceneName[] = ['idle', 'playback', 'stress-live', 'galaxy', 'engine-latency']

export type BenchPhase = 'pending' | 'warmup' | 'measure' | 'done'

export interface BenchHooks {
  onSceneEnter(def: BenchSceneDef): void
  onMeasureStart(def: BenchSceneDef): void
  onAction(def: BenchSceneDef, action: BenchAction): void
  onSceneExit(def: BenchSceneDef): void
  onDone(): void
}

export class BenchRunner {
  private readonly defs: BenchSceneDef[]
  private index = -1
  private elapsedInPhase = 0
  private firedActions = 0
  private _phase: BenchPhase = 'pending'

  constructor(names: BenchSceneName[], private readonly hooks: BenchHooks) {
    this.defs = names.map((n) => SCENES[n])
  }

  get phase(): BenchPhase {
    return this._phase
  }

  get currentScene(): BenchSceneName | null {
    return this.defs[this.index]?.name ?? null
  }

  get totalSec(): number {
    return this.defs.reduce((a, d) => a + d.warmupSec + d.measureSec, 0)
  }

  tick(dtSec: number): void {
    if (this._phase === 'done') return
    if (this._phase === 'pending') {
      this.advanceScene()
      return
    }
    this.elapsedInPhase += dtSec
    const def = this.defs[this.index]
    if (this._phase === 'warmup') {
      if (this.elapsedInPhase >= def.warmupSec) {
        this.elapsedInPhase = 0
        this._phase = 'measure'
        this.hooks.onMeasureStart(def)
      }
      return
    }
    // measure：先派发到点的动作，再判断本场景是否结束
    while (this.firedActions < def.actions.length && def.actions[this.firedActions].atSec <= this.elapsedInPhase) {
      this.hooks.onAction(def, def.actions[this.firedActions])
      this.firedActions++
    }
    if (this.elapsedInPhase >= def.measureSec) {
      this.hooks.onSceneExit(def)
      this.advanceScene()
    }
  }

  private advanceScene(): void {
    this.index++
    this.elapsedInPhase = 0
    this.firedActions = 0
    const def = this.defs[this.index]
    if (!def) {
      this._phase = 'done'
      this.hooks.onDone()
      return
    }
    this._phase = 'warmup'
    this.hooks.onSceneEnter(def)
  }
}
