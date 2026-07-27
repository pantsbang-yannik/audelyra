import { describe, it, expect } from 'vitest'
import { EditHistory, HISTORY_LIMIT, COALESCE_WINDOW_MS, type HistorySnapshot } from './edit-history'
import { defaultRhythmPreset } from './spec'
import { DEFAULT_MACRO_KNOBS } from './macro'

/** 造一份可区分的快照：用 speed·primary 的 gain 当指纹，断言时只比这一个数 */
function snap(gain: number): HistorySnapshot {
  const mapping = defaultRhythmPreset()
  mapping.reactions.find((r) => r.id === 'body.speed.primary')!.gain = gain
  return { mapping, macroKnobs: { ...DEFAULT_MACRO_KNOBS } }
}
const gainOf = (s: HistorySnapshot | null): number | null =>
  s ? s.mapping.reactions.find((r) => r.id === 'body.speed.primary')!.gain : null

describe('EditHistory（律动页快照栈）', () => {
  it('空栈：不能撤销也不能重做，undo/redo 返回 null 且不抛', () => {
    const h = new EditHistory()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()
  })

  it('只有基线一步时不能撤销——基线本身没有「上一步」可退', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    expect(h.canUndo()).toBe(false)
  })

  it('基线 + 一次改动：撤销回基线，重做再回改动后', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { now: 1000 })
    expect(h.canUndo()).toBe(true)
    expect(gainOf(h.undo())).toBe(1)
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(true)
    expect(gainOf(h.redo())).toBe(2)
  })

  it('同 key 且在合并窗内：合并成一步，撤销直接回到碰这个控件之前', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { coalesceKey: 'gain:body.speed.primary', now: 1000 })
    // 间隔 5s——真人拖一下要停下来看几秒画面才知道好不好看，这段停顿必须仍算同一步
    h.push(snap(3), { coalesceKey: 'gain:body.speed.primary', now: 6000 })
    expect(h.size).toBe(2) // 基线 + 合并后的一步
    expect(gainOf(h.undo())).toBe(1)
  })

  it('同 key 但超出合并窗：另起一步', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { coalesceKey: 'gain:x', now: 1000 })
    h.push(snap(3), { coalesceKey: 'gain:x', now: 11001 })
    expect(h.size).toBe(3)
    expect(gainOf(h.undo())).toBe(2)
  })

  it('不同 key：即使挨得很近也不合并', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { coalesceKey: 'gain:a', now: 100 })
    h.push(snap(3), { coalesceKey: 'gain:b', now: 200 })
    expect(h.size).toBe(3)
  })

  it('结构性操作（无 key）：连续两次必是两步', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { now: 10 })
    h.push(snap(3), { now: 20 })
    expect(h.size).toBe(3)
  })

  it('撤销后再改动：重做段被截断', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { now: 100 })
    h.push(snap(3), { now: 200 })
    h.undo()
    h.undo()
    h.push(snap(9), { now: 300 })
    expect(h.canRedo()).toBe(false)
    expect(h.redo()).toBeNull()
    expect(gainOf(h.undo())).toBe(1)
  })

  it('撤销后立刻动同一个控件：不许与被撤销掉的那步合并（否则用户刚退回来的状态被吞）', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { coalesceKey: 'gain:x', now: 100 })
    h.undo() // 回到 1
    h.push(snap(5), { coalesceKey: 'gain:x', now: 200 }) // 同 key 同窗，但中间截断过
    expect(h.size).toBe(2)
    expect(gainOf(h.undo())).toBe(1) // 仍退得回基线，而不是空栈
  })

  it('超出上限：丢最旧的一步，指针跟着下移，撤到底不抛', () => {
    const h = new EditHistory({ limit: 3 })
    for (let i = 1; i <= 5; i++) h.push(snap(i), { now: i * 100 })
    expect(h.size).toBe(3)
    expect(gainOf(h.undo())).toBe(4)
    expect(gainOf(h.undo())).toBe(3)
    expect(h.canUndo()).toBe(false)
    expect(h.undo()).toBeNull()
  })

  it('重做后立刻动同一个控件：不许合并（否则用户刚重做回来的那一步被吞）', () => {
    const h = new EditHistory()
    h.push(snap(1), { now: 0 })
    h.push(snap(2), { coalesceKey: 'gain:x', now: 100 })
    h.undo()
    h.redo() // 回到 g=2
    h.push(snap(5), { coalesceKey: 'gain:x', now: 1000 }) // 同 key 同窗，但刚重做过
    expect(h.size).toBe(3)
    expect(gainOf(h.undo())).toBe(2) // 退得回重做出来的那一步，而不是直接落到基线
    expect(gainOf(h.undo())).toBe(1)
  })

  it('默认上限与默认合并窗口：不传 opts 时真的生效为 50 步 / 10000ms（写死数字，防常量被悄悄改小）', () => {
    expect(HISTORY_LIMIT).toBe(50)
    expect(COALESCE_WINDOW_MS).toBe(10_000)

    const h = new EditHistory() // 不传 limit，验证默认上限真的是 50
    for (let i = 1; i <= 52; i++) h.push(snap(i), { now: i })
    expect(h.size).toBe(50)

    const w = new EditHistory() // 不传 coalesceWindowMs，验证默认窗口真的是 10000ms
    w.push(snap(1), { now: 0 })
    w.push(snap(2), { coalesceKey: 'gain:x', now: 0 })
    w.push(snap(3), { coalesceKey: 'gain:x', now: 10_000 }) // 恰好卡在 10000ms 窗内，应合并
    expect(w.size).toBe(2)
    w.push(snap(4), { coalesceKey: 'gain:x', now: 20_001 }) // 距栈顶时间(10000) 超 10000ms，应另起一步
    expect(w.size).toBe(3)
  })
})
