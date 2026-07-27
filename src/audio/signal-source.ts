// 信号源仲裁（纯逻辑，零 DOM / 零 electron）：「任一时刻只有一路信号灌引擎」这条架构约束的唯一真源。
//
// 为什么要抽出来：此前各信号源的让路条件是散在装配层的一串布尔与或
// （`localActive && !replayActive && !demoActive && !auditionActive` 之类），
// 每新增一个源都得记得去 N 处补条件——连续三轮漏掉了不同的源（trace、序幕 demo、性能基准）。
// 收成纯函数后，新增源只需在此登记并补一条用例，忘了改会被 exhaustive 用例当场抓到。
//
// 两个维度不能压成一个枚举：PCM 来源与「直灌源」是叠加关系而非互斥。
// 本地播放中途拖入 trace，回放结束后本地播放必须自动恢复——若压成单一枚举，
// 「本地仍在后台播着」这一信息就丢了。

/** PCM 来源：系统捕获 or 本地文件播放。二者互斥，本地优先。 */
export type PcmSource = 'live' | 'local'

/** 直灌源：绕过 PCM、直接把 Signals publish 到 bus（或自行 ingest 合成 PCM）的那一路。
 * 'none' = 无人直灌，由 PcmSource 供给。同一时刻最多一个。 */
export type Injector =
  | 'none'
  /** trace 回放（DEV 的 R 键/拖 .jsonl，以及性能基准的 trace 场景） */
  | 'replay'
  /** 首启序幕演示 */
  | 'demo'
  /** 试音模式的合成 pad 信号 */
  | 'audition'
  /** 性能基准注入的合成 PCM（自行 ingest，故系统捕获须让路） */
  | 'bench'

export const INJECTORS: readonly Injector[] = ['none', 'replay', 'demo', 'audition', 'bench']
export const PCM_SOURCES: readonly PcmSource[] = ['live', 'local']

/** 装配层沿用的派生布尔——读取点很多（idle-hint 抑制、星系空闲判定、压制汇流等），
 * 让它们继续读布尔即可，无需改动；写入侧则统一收敛到本模块。 */
export interface SourceFlags {
  /** 系统捕获是否让路（不 ingest） */
  liveMuted: boolean
  replayActive: boolean
  demoActive: boolean
  auditionActive: boolean
  localActive: boolean
}

export function deriveFlags(pcm: PcmSource, injector: Injector): SourceFlags {
  return {
    // 有人直灌、或 PCM 走本地播放，系统捕获都得让路
    liveMuted: injector !== 'none' || pcm === 'local',
    replayActive: injector === 'replay',
    demoActive: injector === 'demo',
    auditionActive: injector === 'audition',
    localActive: pcm === 'local',
  }
}

/** 系统捕获的 PCM 是否该进引擎 */
export function shouldIngestSystemPcm(pcm: PcmSource, injector: Injector): boolean {
  return pcm === 'live' && injector === 'none'
}

/** 本地播放通路的 PCM 是否该进引擎 */
export function shouldIngestLocalPcm(pcm: PcmSource, injector: Injector): boolean {
  return pcm === 'local' && injector === 'none'
}

/** 该直灌源是否**人造信号**（量级由代码写定，而非真实音乐算出）。
 * 只有人造源需要隔离下游的自适应状态（滚动峰值归一、节拍相位）——
 * trace 回放与序幕用的是真实音乐录下来的特征，量级本就真实，不必隔离。 */
export function isSyntheticInjector(injector: Injector): boolean {
  return injector === 'audition'
}

// ───────────────────────────────────────────────────────────────────────────
// 切换编排
//
// 上面的纯函数只回答「什么条件下该让路」。**切换本身**（状态更新与停旧源的先后、
// 钩子会不会重入、何时清帧、何时通知场景隔离）此前留在装配层的两个闭包里裸奔，
// 于是栽了第二次：`setInjector` 先停旧源、后更新状态 ⇒ 停演钩子读到的是旧状态 ⇒
// 钩子里的 `injector === 'audition'` 守卫仍成立 ⇒ 又切一次 ⇒ 无限递归爆栈（试音退不出）。
// 纯函数测得再全也测不到这个——顺序与重入需要「有状态的对象」才谈得上。故一并收进本模块。
// ───────────────────────────────────────────────────────────────────────────

export interface SourceSwitchHooks {
  /** 派生布尔已更新，装配层据此刷新自己那几个只读 let */
  onFlags: (flags: SourceFlags) => void
  /** 换源即清 bus 残留帧——takeFrame() 会持续交付 _latest，不清则上一路的连续量滞留画面，
   * 未消费的 onBeat/drop 还会折叠进新源首帧变成一次假鼓点 */
  clearFrame: () => void
  /** 停掉旧的直灌源（抢占者不必自己记得去停别人）。
   * ⚠️ 实现内**只许收摊，不许再切直灌权**——在这里调 setInjector 就是那条爆栈的递归。
   *    试音因此拆成 teardownAudition（只收摊，挂这里）与 exitAudition（只交还直灌权）。 */
  stopInjector?: (which: Injector) => void
  /** 人造源进出（仅在 synthetic 真正翻转时调用一次）：通知场景隔离自适应状态 */
  onSyntheticChange?: (on: boolean) => void
}

/** 「任一时刻只有一路信号灌引擎」的状态持有者与切换编排。零 DOM / 零 engine 依赖。
 *
 * 装配层只做两件事：把钩子接上去、读 `injector` / `pcmSource`。
 * **顺序纪律由本类的实现保证，装配层再没有写反的机会**——这正是收进来的目的。 */
export class SignalSourceArbiter {
  private pcm: PcmSource = 'live'
  private inj: Injector = 'none'
  /** 重入哨兵：只用于给出可读的错误，不用于「修复」重入——真正的防线是下面的更新顺序 */
  private switching = false

  constructor(private readonly hooks: SourceSwitchHooks) {
    hooks.onFlags(deriveFlags(this.pcm, this.inj))
  }

  get injector(): Injector {
    return this.inj
  }

  get pcmSource(): PcmSource {
    return this.pcm
  }

  get flags(): SourceFlags {
    return deriveFlags(this.pcm, this.inj)
  }

  /** 切换直灌源。停旧源 + 清残留帧 + 人造源进出时通知场景隔离。 */
  setInjector(next: Injector): void {
    if (this.inj === next) return
    this.guardReentry('setInjector')
    const prev = this.inj
    const wasSynthetic = isSyntheticInjector(prev)
    // ⚠️ 先更新状态、再停旧源，两步不许对调（成因见本节顶部注释）。
    // 反过来看也成立：钩子读到的是**切换后**的状态，而那正是它收摊时该看到的
    // （压制汇流之类要按新状态重算，读到旧值会算出「试音还在演」）。
    this.inj = next
    this.hooks.onFlags(deriveFlags(this.pcm, next))
    this.switching = true
    try {
      this.hooks.stopInjector?.(prev)
    } finally {
      this.switching = false
    }
    this.hooks.clearFrame()
    const nowSynthetic = isSyntheticInjector(next)
    if (nowSynthetic !== wasSynthetic) this.hooks.onSyntheticChange?.(nowSynthetic)
  }

  /** 切换 PCM 来源（系统捕获 ↔ 本地文件）。与直灌源正交，不互相打断。 */
  setPcmSource(next: PcmSource): void {
    if (this.pcm === next) return
    this.guardReentry('setPcmSource')
    this.pcm = next
    this.hooks.onFlags(deriveFlags(next, this.inj))
    this.hooks.clearFrame() // 换 PCM 来源同样是换源，残留帧不许跨源交付
  }

  /** 停演钩子里再切直灌权 = 递归。静默爆栈 500 层极难查，故在此给出可读的错误。 */
  private guardReentry(from: string): void {
    if (!this.switching) return
    throw new Error(
      `[signal-source] 停演钩子内不得调用 ${from}——它只负责收摊，切换直灌权由调用方负责。`
      + '（这条限制的由来：钩子里再切一次会无限递归，曾导致试音模式退不出。）',
    )
  }
}
