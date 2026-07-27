import type { Signals } from './types'

export class SignalBus {
  private listeners = new Set<(s: Signals) => void>()
  private _latest: Signals | null = null

  // 事件字段帧间折叠：引擎每块同步发布 2 个 hop，rAF 消费方只能看到最后一个——
  // onBeat/drop 这类脉冲事件必须跨 publish 累积，被消费时一次性交付并清零（连续值字段仍取最新）
  private foldedBeat = false
  private foldedStrength = 0
  private foldedDrop = false

  subscribe(fn: (s: Signals) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  publish(s: Signals): void {
    this._latest = s
    this.foldedBeat ||= s.beat.onBeat
    this.foldedStrength = Math.max(this.foldedStrength, s.beat.strength)
    this.foldedDrop ||= s.drop
    for (const fn of this.listeners) fn(s)
  }

  get latest(): Signals | null {
    return this._latest
  }

  /** 丢弃最后一帧与未消费的折叠事件。**信号源切换时必须调用**——否则：
   * ① `takeFrame()` 会继续交付上一路的残留连续量（如试音的 silence:false 会让画面长期
   *    停在「有声」态而非进沉睡，直到有新 PCM 覆盖）；
   * ② 未被消费的 onBeat/drop 会折叠进下一路的首帧，凭空多出一次假鼓点。 */
  clearFrame(): void {
    this._latest = null
    this.foldedBeat = false
    this.foldedStrength = 0
    this.foldedDrop = false
  }

  /** 帧消费：连续值取最新，脉冲事件（onBeat/strength/drop）折叠交付并清零；无信号返回 null */
  takeFrame(): Signals | null {
    if (!this._latest) return null
    const frame: Signals = {
      ...this._latest,
      beat: { onBeat: this.foldedBeat, strength: this.foldedStrength },
      drop: this.foldedDrop
    }
    this.foldedBeat = false
    this.foldedStrength = 0
    this.foldedDrop = false
    return frame
  }
}
