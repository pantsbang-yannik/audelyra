// 律动能力矩阵（mixer v2 spec §能力矩阵）：body 类 → 消费的**主体属性**，唯一事实源。
// 律动 tab 按此显隐主体组的反应；新 body 类必须在此声明（完备性单测与契约表对齐键集）。
// 各 body 消费的属性：speed=rateMul/uWaveSpeed、density/thickness=全 body 已接活（调音台规范化），
// space 仅粒子系与频谱环/波形线/日食消费（点阵/激光无半径可膨胀）。
// 背景元素（backdrop）的属性不在此表——背景与主体形状无关，任何形状下都在场。
import { BODY_PROPERTIES, type BodyProperty } from '../mapping/types'
import type { BodyKind } from './types'

const ALL: readonly BodyProperty[] = BODY_PROPERTIES
const NO_SPACE: readonly BodyProperty[] = BODY_PROPERTIES.filter((p) => p !== 'space')

export const RHYTHM_CAPABILITY: Record<BodyKind, readonly BodyProperty[]> = {
  particles: ALL,
  spectrum: ALL,
  waveform: ALL,
  eclipse: ALL,
  ledmatrix: NO_SPACE,
  laser: NO_SPACE,
}

export function rhythmTargetsFor(body: BodyKind): readonly BodyProperty[] {
  return RHYTHM_CAPABILITY[body]
}
