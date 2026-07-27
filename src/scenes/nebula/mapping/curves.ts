import type { MappingCurve } from './types'

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** 把归一输入 t∈[0,1] 经曲线整形，返回 [0,1]。 */
export function applyCurve(curve: MappingCurve, t: number): number {
  const x = clamp01(t)
  switch (curve) {
    case 'linear':
      return x
    case 'ease': // smoothstep：平滑起步/收尾
      return x * x * (3 - 2 * x)
    case 'punch': // 幂次压中段，拉开强弱（与 signal-rig KICK_GAMMA=1.5 同族）
      return Math.pow(x, 1.5)
    case 'softClip': // 快起、软收顶，避免爆表硬切
      return clamp01(1 - Math.pow(1 - x, 2))
    default:
      return x
  }
}

// 叠加/增益软限幅：膝点以下恒等（默认预设手感不变），以上 tanh 软压渐近到 CAP。
// 消灭「gain 拖到底一半行程是死区」：越过 1 后输出仍单调递增，下游按 0..CAP 留头部空间。
export const SOFT_LIMIT_KNEE = 0.9
export const SOFT_LIMIT_CAP = 1.25
export function softLimit(x: number): number {
  if (x <= 0) return 0
  if (x <= SOFT_LIMIT_KNEE) return x
  const span = SOFT_LIMIT_CAP - SOFT_LIMIT_KNEE
  return SOFT_LIMIT_KNEE + span * Math.tanh((x - SOFT_LIMIT_KNEE) / span)
}
