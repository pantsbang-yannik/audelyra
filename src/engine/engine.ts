import { HOP_SIZE, extractFeatures, mixToMono } from './features'
import { BeatDetector } from './beat'
import { EnergyTracker } from './energy'
import { SignalBus } from './bus'
import { RollingPeak } from './rolling-peak'
import type { PcmFrame, Signals } from './types'
import { perf } from '../perf/collector'

/** fb5 力度合成：tie 排名管「段落内谁更狠」，能量语境管「这段整体该不该响」——
 * EnergyTracker 峰谷区间归一追踪全曲新高（不自我归一化），均匀副歌全过线（冷却限流成规律）、
 * 均匀安静段一致克制。权重是校准 sanctioned 旋钮（spec fb5），改动必须过三首真歌硬线。
 * 校准终值（2026-07-14 三首真歌网格扫描；spec 起点 0.6/0.55 翻脸率三首全挂 0.24/0.27/0.47）：
 * 能量为主轴（高能段饱和到 1，冷却限流成规律），排名做段内 ±0.14 微调——
 * rank 权重更高时相邻拍 flux 噪声直接穿透 0.75 线，翻脸率必破 0.15 硬线。 */
export const BEAT_RANK_W = 0.14
export const BEAT_ENERGY_W = 1.02
export function hybridBeatStrength(rank: number, energy: number): number {
  return Math.min(1, Math.max(0, BEAT_RANK_W * rank + BEAT_ENERGY_W * energy))
}

export class AudelyraEngine {
  readonly bus = new SignalBus()
  private pending = new Float32Array(0)
  private t = 0
  private beat: BeatDetector | null = null
  private energy: EnergyTracker | null = null
  private sampleRate = 48000
  private smoothLoudness = 0
  private loudRel = new RollingPeak(30, 1e-4)
  private smoothSpectrum: Float32Array | null = null

  ingest(frame: PcmFrame): void {
    // 内部延迟起点（性能基线）：side-channel 打点，不给 Signals 加字段——
    // Signals 会被 trace 序列化，加字段会污染既有 trace 资产的兼容性
    if (perf.enabled) perf.markPcmIn(performance.now())
    if (!this.beat || this.sampleRate !== frame.sampleRate) {
      this.sampleRate = frame.sampleRate
      this.beat = new BeatDetector(frame.sampleRate, HOP_SIZE)
      this.energy = new EnergyTracker(frame.sampleRate, HOP_SIZE)
    }
    const mono = mixToMono(frame)
    const merged = new Float32Array(this.pending.length + mono.length)
    merged.set(this.pending)
    merged.set(mono, this.pending.length)

    let off = 0
    while (merged.length - off >= HOP_SIZE) {
      this.processHop(merged.subarray(off, off + HOP_SIZE))
      off += HOP_SIZE
    }
    this.pending = merged.slice(off)
  }

  private processHop(hop: Float32Array): void {
    const hopSec = HOP_SIZE / this.sampleRate
    this.t += hopSec
    const f = extractFeatures(hop, this.sampleRate)
    // 节拍 v2 吃原始整谱（trace 里的谱是 0.25 EMA 平滑版，校准在平滑谱上过线，真机原始谱只会更锐）
    const b = this.beat!.push(f.spectrum, this.t)
    // 频谱派生响度：与 trace 完全同源（bands 是原始频段均值），离线校准即真机行为
    const specLoud = f.bands.low * 1.0 + f.bands.mid * 0.8 + f.bands.high * 0.6
    const e = this.energy!.push(specLoud, f.rms, this.t)

    // 响度相对化（契约 v1.1）：相对 30s 半衰期滚动峰值归一化，与系统音量解耦
    if (this.loudRel.peak === 0 && f.rms > 0) this.loudRel.seed(Math.max(f.rms, 1e-4)) // 首样本播种
    const instantLoud = f.rms > 0 ? this.loudRel.update(f.rms, hopSec) : this.loudRel.update(0, hopSec)
    this.smoothLoudness += 0.15 * (instantLoud - this.smoothLoudness)
    if (!this.smoothSpectrum) this.smoothSpectrum = new Float32Array(f.spectrum.length)
    for (let i = 0; i < f.spectrum.length; i++) {
      this.smoothSpectrum[i] += 0.25 * (f.spectrum[i] - this.smoothSpectrum[i])
    }

    const signals: Signals = {
      t: this.t,
      loudness: { instant: instantLoud, smooth: this.smoothLoudness },
      bands: f.bands,
      spectrum: this.smoothSpectrum,
      beat: b.onBeat ? { onBeat: true, strength: hybridBeatStrength(b.strength, e.energy) } : b,
      bpm: this.beat!.bpm,
      energy: e.energy,
      drop: e.drop,
      silence: e.silence
    }
    if (perf.enabled) perf.markSignalOut(performance.now())
    this.bus.publish(signals)
  }
}
