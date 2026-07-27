// 律动能力矩阵（mixer v2 spec §能力矩阵）：body 类 → 消费的律动目标，唯一事实源。
// 律动 tab 按此显隐规则组；新 body 类必须在此声明（完备性单测与契约表对齐键集）。
// 各 body 消费的目标：speed=rateMul/uWaveSpeed、density/thickness=全 body 已接活（调音台规范化），
// space 仅粒子系与频谱环/波形线/日食消费（点阵/激光无半径可膨胀）。
import type { VisualTarget } from '../mapping/types'
import type { BodyKind } from './types'

const ALL: readonly VisualTarget[] = ['speed', 'density', 'space', 'brightness', 'thickness']
const NO_SPACE: readonly VisualTarget[] = ['speed', 'density', 'brightness', 'thickness']

export const RHYTHM_CAPABILITY: Record<BodyKind, readonly VisualTarget[]> = {
  particles: ALL,
  spectrum: ALL,
  waveform: ALL,
  eclipse: ALL,
  ledmatrix: NO_SPACE,
  laser: NO_SPACE,
}

export function rhythmTargetsFor(body: BodyKind): readonly VisualTarget[] {
  return RHYTHM_CAPABILITY[body]
}
