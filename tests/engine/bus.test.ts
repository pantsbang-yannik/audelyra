import { describe, it, expect } from 'vitest'
import { SignalBus } from '../../src/engine/bus'
import type { Signals } from '../../src/engine/types'

function mkSignal(over: Partial<Signals> = {}): Signals {
  return {
    t: 1,
    loudness: { instant: 0.5, smooth: 0.4 },
    bands: { low: 0.3, mid: 0.2, high: 0.1 },
    spectrum: new Float32Array(4),
    beat: { onBeat: false, strength: 0 },
    bpm: 120,
    energy: 0.3,
    drop: false,
    silence: false,
    ...over
  }
}

describe('SignalBus 事件折叠（takeFrame）', () => {
  it('同一同步块内连续 publish 两个 hop（第一个带拍），takeFrame 一次性交付且不丢', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ t: 1, beat: { onBeat: true, strength: 0.8 } }))
    bus.publish(mkSignal({ t: 2, beat: { onBeat: false, strength: 0 } }))

    const frame = bus.takeFrame()
    expect(frame!.beat.onBeat).toBe(true)
    expect(frame!.beat.strength).toBe(0.8)
  })

  it('再次 takeFrame（期间无新 publish）不重复交付，onBeat 回落为 false', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ beat: { onBeat: true, strength: 0.8 } }))
    bus.takeFrame()

    const again = bus.takeFrame()
    expect(again!.beat.onBeat).toBe(false)
    expect(again!.beat.strength).toBe(0)
  })

  it('drop 折叠同构：块内命中一次即交付，随后清零', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ drop: true }))
    bus.publish(mkSignal({ drop: false }))

    expect(bus.takeFrame()!.drop).toBe(true)
    expect(bus.takeFrame()!.drop).toBe(false)
  })

  it('连续值字段（energy/loudness）不折叠，取最后一次 publish 的最新值', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ energy: 0.2, loudness: { instant: 0.2, smooth: 0.2 } }))
    bus.publish(mkSignal({ energy: 0.9, loudness: { instant: 0.9, smooth: 0.9 } }))

    const frame = bus.takeFrame()
    expect(frame!.energy).toBe(0.9)
    expect(frame!.loudness).toEqual({ instant: 0.9, smooth: 0.9 })
  })

  it('subscribe 路径不受折叠影响：每次 publish 都收到（trace 录制完整性不受影响）', () => {
    const bus = new SignalBus()
    const received: Signals[] = []
    bus.subscribe((s) => received.push(s))

    bus.publish(mkSignal({ t: 1, beat: { onBeat: true, strength: 0.8 } }))
    bus.publish(mkSignal({ t: 2, beat: { onBeat: false, strength: 0 } }))

    expect(received).toHaveLength(2)
    expect(received[0].beat).toEqual({ onBeat: true, strength: 0.8 })
    expect(received[1].beat).toEqual({ onBeat: false, strength: 0 })
  })

  it('无信号时 takeFrame 返回 null', () => {
    const bus = new SignalBus()
    expect(bus.takeFrame()).toBeNull()
  })
})

describe('clearFrame（信号源切换）', () => {
  it('清掉最后一帧：takeFrame 回到 null，画面据此进沉睡而非停在上一路的「有声」态', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ silence: false }))
    expect(bus.takeFrame()).not.toBeNull()
    bus.clearFrame()
    expect(bus.takeFrame(), '不清则上一路的 silence:false 会一直留在画面').toBeNull()
    expect(bus.latest).toBeNull()
  })

  it('清掉未消费的折叠事件：不清则会折叠进下一路首帧，凭空多一次假鼓点', () => {
    const bus = new SignalBus()
    bus.publish(mkSignal({ beat: { onBeat: true, strength: 1 }, drop: true }))
    bus.clearFrame()
    bus.publish(mkSignal()) // 新信号源的首帧：本身无脉冲
    const f = bus.takeFrame()!
    expect(f.beat.onBeat, '上一路的 onBeat 不许漏到新源首帧').toBe(false)
    expect(f.beat.strength).toBe(0)
    expect(f.drop).toBe(false)
  })

  it('空 bus 上调用是安全的（幂等）', () => {
    const bus = new SignalBus()
    expect(() => { bus.clearFrame(); bus.clearFrame() }).not.toThrow()
    expect(bus.takeFrame()).toBeNull()
  })
})
