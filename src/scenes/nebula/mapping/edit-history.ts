// 律动页编辑历史（撤销/重做）：纯逻辑零 DOM，状态数组 + 指针。
// 存全量快照而非 diff——一份 mapping 就十几条反应，50 步内存可忽略；
// 而宏旋钮一拖本就是整套重铺，diff 反而更大更绕，还容易漏字段。
// 只活在本次运行：不落盘、无迁移（跨会话的退路由「回出厂」兜底，见设计稿决策 5）。
import type { MappingValues } from './types'
import type { MacroKnobs } from './macro'

/** 一步的完整状态——两者必须同时快照：撤销只回 mapping 会让旋钮位置与专业表脱节 */
export interface HistorySnapshot {
  mapping: MappingValues
  macroKnobs: MacroKnobs
}

export interface PushOptions {
  /** 控件身份。同 key 的连续调整在时间窗内合并成一步；结构性操作不传 ⇒ 必不合并 */
  coalesceKey?: string
  /** 当前时刻（毫秒）。由调用方注入，测试才能不依赖真实时钟 */
  now: number
}

/** 快照上限（含基线）——实际可撤销步数 = 上限 - 1 */
export const HISTORY_LIMIT = 50
/** 合并窗口：同一控件两次调整间隔在此之内算同一步（每合并一次就把计时重置，故连续调多久都是一步）。
 * 10s 是按**真人调参节奏**定的——松手后要盯着画面听两小节才知道好不好看，这段停顿必须仍算同一步；
 * 初版按代码节奏拍了 2s，实机验收当场翻车：每拖一次都新开一步，撤销退不回「碰它之前」。 */
export const COALESCE_WINDOW_MS = 10_000

interface Entry {
  snap: HistorySnapshot
  key: string | undefined
  at: number
}

/** 快照的所有权在 push 时移交给本类——调用方须传副本，且此后不得再持引用就地改。
 * 同理 undo/redo 返回的也是内部对象，消费方要写进自己的 draft 前须自行深拷贝。 */
export class EditHistory {
  private entries: Entry[] = []
  /** 指向「当前状态」的下标；-1 = 还没有任何快照 */
  private index = -1
  private readonly limit: number
  private readonly coalesceWindowMs: number
  /** 上一次调用是否是 undo/redo——导航过就不许合并，撤销和重做都算，见 push() 里的用法 */
  private navigated = false

  constructor(opts?: { limit?: number; coalesceWindowMs?: number }) {
    this.limit = opts?.limit ?? HISTORY_LIMIT
    this.coalesceWindowMs = opts?.coalesceWindowMs ?? COALESCE_WINDOW_MS
  }

  get size(): number { return this.entries.length }
  canUndo(): boolean { return this.index > 0 }
  canRedo(): boolean { return this.index >= 0 && this.index < this.entries.length - 1 }

  push(snap: HistorySnapshot, opts: PushOptions): void {
    // 撤销之后的新改动：丢掉重做段
    if (this.index < this.entries.length - 1) this.entries.length = this.index + 1

    // 刚导航过（undo 或 redo）就不许合并——否则撤销/重做后立刻动同一个控件，
    // 会把用户刚退回来/重做回来的那一步直接覆盖掉，等于白操作
    const top = this.entries[this.index]
    const canCoalesce = !this.navigated && !!opts.coalesceKey
      && top !== undefined && top.key === opts.coalesceKey
      && opts.now - top.at <= this.coalesceWindowMs
    this.navigated = false
    if (canCoalesce) {
      top.snap = snap
      top.at = opts.now
      return
    }

    this.entries.push({ snap, key: opts.coalesceKey, at: opts.now })
    this.index = this.entries.length - 1
    while (this.entries.length > this.limit) {
      this.entries.shift()
      this.index--
    }
  }

  undo(): HistorySnapshot | null {
    if (!this.canUndo()) return null
    this.index--
    this.navigated = true
    return this.entries[this.index].snap
  }

  redo(): HistorySnapshot | null {
    if (!this.canRedo()) return null
    this.index++
    this.navigated = true
    return this.entries[this.index].snap
  }
}
