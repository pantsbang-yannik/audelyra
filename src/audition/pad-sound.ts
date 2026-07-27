// 试音模式 pad 的音效反馈：**只走扬声器，绝不进引擎**——
// 图为「合成节点 → ctx.destination」，不经任何 tap，与本地播放的 pcm-tap 通路完全隔离。
// 音效的作用是让耳朵和眼睛同步（按下鼓点时听到一声鼓），画面反应则由注入的 Signals 驱动（audition-pad.ts）。
//
// 全部实时合成，零音频素材：既免掉第三方资产的署名与协议义务，也不必等素材到位就能用。
import type { PadId } from './audition-pad'

/** 一个 pad 的音色配方。抽成纯数据表便于调声，且能被单测校验键集与 PadId 对齐（防漏实现）。 */
export interface PadVoice {
  /** 基音起止频率（Hz）：起→止的指数下滑，相等则为固定音高 */
  fromHz: number
  toHz: number
  /** 包络时长（秒） */
  durSec: number
  /** 峰值增益——提示音性质，整体压低不与音乐抢 */
  peak: number
  /** 叠加的噪声层增益（0=纯音） */
  noise: number
  /** 噪声层高通截止（Hz）：hi-hat 靠它去掉低频糊音 */
  noiseHpHz: number
}

export const PAD_VOICES: Record<PadId, PadVoice> = {
  // kick：120→45Hz 的快速下滑是底鼓的经典配方，短促有冲击
  beat: { fromHz: 120, toHz: 45, durSec: 0.09, peak: 0.28, noise: 0.05, noiseHpHz: 200 },
  // impact：低频下滑 + 大量噪声 = 炸开感；时程与 Signals 侧的 drop 包络（0.9s）呼应但更短，
  // 避免提示音盖过用户要观察的画面
  drop: { fromHz: 180, toHz: 40, durSec: 0.35, peak: 0.3, noise: 0.35, noiseHpHz: 400 },
  low: { fromHz: 70, toHz: 60, durSec: 0.22, peak: 0.3, noise: 0, noiseHpHz: 200 },
  // hi-hat：几乎全噪声 + 高通，基音只起一点金属感
  high: { fromHz: 6000, toHz: 5200, durSec: 0.05, peak: 0.06, noise: 0.22, noiseHpHz: 5000 },
  // 「静下来」放声音本身有点矛盾，故取极轻的下滑音——只作「已切到静音」的确认，不模拟声音
  silence: { fromHz: 440, toHz: 180, durSec: 0.16, peak: 0.09, noise: 0, noiseHpHz: 200 },
}

const NOISE_SEC = 0.5

/** pad 音效播放器。懒建 AudioContext（浏览器要用户手势才允许启动），首次 play 必在点击/按键内。 */
export class PadSound {
  private ctx: AudioContext | null = null
  private noiseBuf: AudioBuffer | null = null
  private muted = false

  setMuted(m: boolean): void {
    this.muted = m
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * NOISE_SEC), this.ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
      this.noiseBuf = buf
    }
    // 系统休眠/切后台会把 ctx 挂起，恢复后首次播放需唤醒
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  play(id: PadId): void {
    if (this.muted) return
    const v = PAD_VOICES[id]
    let ctx: AudioContext
    try {
      ctx = this.ensureCtx()
    } catch {
      return // 无音频输出设备等：音效是锦上添花，静默降级不影响画面验证
    }
    const t0 = ctx.currentTime
    const end = t0 + v.durSec

    const out = ctx.createGain()
    // 指数衰减包络（0 不能进 exponentialRamp，故收到极小值再 setValue 归零）
    out.gain.setValueAtTime(v.peak, t0)
    out.gain.exponentialRampToValueAtTime(v.peak * 0.001, end)
    out.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(v.fromHz, t0)
    if (v.toHz !== v.fromHz) osc.frequency.exponentialRampToValueAtTime(v.toHz, end)
    osc.connect(out)
    osc.start(t0)
    osc.stop(end)

    if (v.noise > 0 && this.noiseBuf) {
      const src = ctx.createBufferSource()
      src.buffer = this.noiseBuf
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = v.noiseHpHz
      const ng = ctx.createGain()
      ng.gain.setValueAtTime(v.noise, t0)
      ng.gain.exponentialRampToValueAtTime(v.noise * 0.001, end)
      src.connect(hp).connect(ng).connect(out)
      src.start(t0)
      src.stop(end)
    }
  }

  dispose(): void {
    void this.ctx?.close()
    this.ctx = null
    this.noiseBuf = null
  }
}
