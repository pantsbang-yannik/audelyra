export class EnvelopeFollower {
  value = 0
  // public：mapper 等消费方需运行中热更时间常数（调音台拖动实时生效）
  constructor(public attackSec: number, public releaseSec: number) {}
  update(target: number, dt: number): number {
    const tau = target > this.value ? this.attackSec : this.releaseSec
    const a = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau)
    this.value += a * (target - this.value)
    return this.value
  }
}

export class Pulse {
  value = 0
  constructor(private halfLifeSec = 0.15) {}
  trigger(strength = 1): void {
    this.value = Math.max(this.value, strength)
  }
  update(dt: number): number {
    this.value *= Math.pow(0.5, dt / this.halfLifeSec)
    return this.value
  }
}

/**
 * AR 包络（attack-release）：trigger 后经有限 attack 上冲到峰值（attack 段用 easeImpact 出力），
 * 再按半衰期指数回落。与 Pulse 的区别：attack 有限（默认 40ms ≈ 2-3 帧的可见运动）——
 * 驱动**位移**时保证粒子是"运动过去"而非"瞬移"（产品铁律：粒子是持续存在的物质，
 * 位置必须连续；设计 4.5：禁止生硬的属性插值）。
 */
export class ArPulse {
  value = 0
  private t = Infinity
  private peak = 0
  constructor(private attackSec = 0.04, private halfLifeSec = 0.11) {}
  trigger(strength = 1): void {
    if (strength >= this.value) {
      this.peak = strength
      this.t = 0
    }
  }
  update(dt: number): number {
    this.t += dt
    if (this.t <= this.attackSec) {
      this.value = this.peak * easeImpact(this.t / this.attackSec)
    } else {
      this.value = this.peak * Math.pow(0.5, (this.t - this.attackSec) / this.halfLifeSec)
    }
    return this.value
  }
}

export class Spring {
  value = 0
  velocity = 0
  // freqHz public：mapper 由「平滑」滑块派生刚度，需运行中热更
  constructor(public freqHz = 2, private damping = 0.7) {}
  update(target: number, dt: number): number {
    const w = 2 * Math.PI * this.freqHz
    // 显式积分稳定条件 w·h<2；freqHz 可达 12（mapper 平滑滑块）、dt 可达 0.1（host 卡顿钳），
    // 单步 w·dt 会破稳发散。把大 dt 拆成 ≤MAX_STEP 的子步积分，保证任意帧率下不爆炸。
    const MAX_STEP = 0.02 // w·MAX_STEP ≤ 2π·12·0.02 ≈ 1.5 < 2
    let remaining = dt
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MAX_STEP)
      this.velocity += (w * w * (target - this.value) - 2 * this.damping * w * this.velocity) * h
      this.value += this.velocity * h
      remaining -= h
    }
    return this.value
  }
}

// Motion 宪法：全场只用以下 3 条曲线，禁止线性插值
export const easeStandard = (t: number): number => {
  const tc = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - tc, 3)
}
export const easeImpact = (t: number): number => {
  const tc = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(2, -10 * tc)
}
export const easeDrift = (t: number): number => {
  const tc = Math.max(0, Math.min(1, t))
  return tc * tc * (3 - 2 * tc)
}

export class Tween {
  value = 0
  private from = 0
  private to = 0
  private dur = 0
  private t = Infinity
  private ease: (t: number) => number = easeStandard

  start(from: number, to: number, durSec: number, ease: (t: number) => number): void {
    this.from = from
    this.to = to
    this.dur = Math.max(durSec, 1e-6)
    this.t = 0
    this.ease = ease
    this.value = from
  }
  update(dt: number): number {
    if (this.t >= this.dur) return this.value
    this.t = Math.min(this.t + dt, this.dur)
    this.value = this.from + (this.to - this.from) * this.ease(this.t / this.dur)
    return this.value
  }
  get active(): boolean {
    return this.t < this.dur
  }
}

/** 动画时值量化到 BPM 网格（默认允许 半拍/1拍/4拍） */
export function quantizeToBeatGrid(durSec: number, bpm: number | null, beatsAllowed = [0.5, 1, 4]): number {
  if (!bpm) return durSec
  const beatSec = 60 / bpm
  let best = durSec
  let bestDist = Infinity
  for (const beats of beatsAllowed) {
    const candidate = beats * beatSec
    const dist = Math.abs(candidate - durSec)
    if (dist < bestDist) { best = candidate; bestDist = dist }
  }
  return best
}
