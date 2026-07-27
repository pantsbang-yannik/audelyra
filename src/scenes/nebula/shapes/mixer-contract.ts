// 调音台契约（调音台规范化 spec §契约）：主体类 → 主体 tab 分组声明的单一事实源。
// 面板照表渲染（tuning-panel.buildShapeSection）——新形状属现有 body 类零改动，
// 新 body 类在此加一条声明即可，不碰面板代码。量程不在此重复：key 引用 MOTION_LIMITS。
import type { MotionSettings } from '../motion/types'
import { MOTION_LIMITS } from '../motion/types'
import type { BodyKind } from './types'

/** 归属层级（三层模型，spec §三层归属）：class=主体类共享（粒子类一套/线条类一套）；
 * shape=单形状独有——本期无真实用例仅类型占位，存储路径等首个用例出现再落地（防再造死线） */
export type MixerScope = 'class' | 'shape'

export interface MixerKnobDef {
  key: keyof typeof MOTION_LIMITS
  label: string
  help: string
}

/** MotionSettings 里的 boolean 键（类型窄化防误绑数值键；当前仅 strobeEnabled） */
type MotionBoolKey = { [K in keyof MotionSettings]: MotionSettings[K] extends boolean ? K : never }[keyof MotionSettings]

export interface MixerToggleDef {
  key: MotionBoolKey
  label: string
  help: string
}

export interface MixerGroupDef {
  title: string
  scope: MixerScope
  knobs: MixerKnobDef[]
  toggles?: MixerToggleDef[]
}

// 运动组：全部主体类常驻（封面优先开着时封面随时可能接管，封面=粒子体）；标题随 body 变文案
const MOTION_KNOBS: MixerKnobDef[] = [
  { key: 'bombIntensity', label: '轰炸强度', help: '全场持续律动的总幅度（鼓包/波纹/波前）' },
  { key: 'detailDensity', label: '细节密度', help: '碎光闪烁的多少' },
  { key: 'waveSpeed', label: '波前速度', help: '鼓点涟漪扫过全场的快慢' },
  { key: 'buildDepth', label: '蓄力深度', help: '爆发前全场收缩屏息的深度' },
  { key: 'climaxBrightness', label: '高潮亮度', help: '高潮时辉光/闪白/整体提亮的总量：左=柔和，拉满≈旧版强烈' },
]
const STROBE_TOGGLE: MixerToggleDef = {
  key: 'strobeEnabled', label: '频闪', help: '爆发与重拍的闪白脉冲；频率与幅度有安全上限，对光敏感请关闭',
}
const motionGroup = (title: string): MixerGroupDef =>
  ({ title, scope: 'class', knobs: MOTION_KNOBS, toggles: [STROBE_TOGGLE] })

const LINE_BRIGHT_KNOB: MixerKnobDef = { key: 'lineBrightness', label: '线条亮度', help: '环线/波形线与频谱条的整体亮度' }
const LINE_BARH_KNOB: MixerKnobDef = { key: 'lineBarHeight', label: '柱高范围', help: '频谱条的最大长度（环上外伸与波形上下摆幅同调）' }

// 频谱环：亮度 + 柱高（环形无「整体宽度」概念，不含 waveWidth）
const SPECTRUM_GROUP: MixerGroupDef = {
  title: '线条（频谱环）', scope: 'class',
  knobs: [LINE_BRIGHT_KNOB, LINE_BARH_KNOB],
}
// 波形线：亮度 + 柱高 + 横向宽度（波形线专属——左右铺展幅度）
const WAVEFORM_GROUP: MixerGroupDef = {
  title: '线条（波形线）', scope: 'class',
  knobs: [
    LINE_BRIGHT_KNOB, LINE_BARH_KNOB,
    { key: 'waveWidth', label: '整体宽度', help: '波形线左右铺展的幅度：小=集中在中间，大=铺满整个画面宽' },
  ],
}

/** 三连图形类专属组(fb1):lineBrightness 仍五类共享一个存储值,其余为各类独有键 */
const ECLIPSE_GROUP: MixerGroupDef = {
  title: '线条（日食）', scope: 'class',
  knobs: [
    { key: 'lineBrightness', label: '线条亮度', help: '图形整体亮度（线条系各卡共用一个值）' },
    { key: 'eclipseWaveLen', label: '线条长度', help: '锯齿波形向两端铺展的距离' },
    { key: 'eclipseWaveGap', label: '波段间隙', help: '频段条之间的缝隙宽度（0=贴紧）' },
    { key: 'eclipseCorona', label: '日冕浓度', help: '黑盘外光晕的厚度与亮度' },
  ],
}
const LEDMATRIX_GROUP: MixerGroupDef = {
  title: '线条（点阵）', scope: 'class',
  knobs: [
    { key: 'ledWaveBright', label: '环波亮度', help: '只调鼓点环波的亮度（不影响其他方块；整墙底色固定）' },
    { key: 'ledDensity', label: '格子密度', help: '越大格子越小越密' },
    { key: 'ledWaveSpeed', label: '环波速度', help: '鼓点环波扩散的快慢' },
    { key: 'ledCross', label: '十字亮度', help: '中心十字光束强度（0=关闭十字）' },
    { key: 'ledWaveThick', label: '环波粗细', help: '鼓点扩散环波光带的厚度：小=细亮圈，大=粗晕' },
  ],
}
const LASER_GROUP: MixerGroupDef = {
  title: '线条（激光）', scope: 'class',
  knobs: [
    { key: 'lineBrightness', label: '线条亮度', help: '图形整体亮度（线条系各卡共用一个值）' },
    { key: 'laserMaxCount', label: '光束数量', help: '光束总数上限：安静稀疏、高潮逼近上限；左=极简，右=狂欢' },
    { key: 'laserSpread', label: '扇面开角', help: '激光扇张开的最大角度' },
    { key: 'laserSpeed', label: '扫动速度', help: '光束扫动的快慢' },
    { key: 'laserChaos', label: '乱度', help: '0=规律扫动，1=无序漂移与随机跳位' },
  ],
}

/** body → 分组清单；渲染序=数组序 */
export const BODY_MIXER_GROUPS: Record<BodyKind, MixerGroupDef[]> = {
  particles: [motionGroup('运动（封面/星云）')],
  spectrum: [motionGroup('运动（封面接管时生效）'), SPECTRUM_GROUP],
  waveform: [motionGroup('运动（封面接管时生效）'), WAVEFORM_GROUP],
  eclipse: [motionGroup('运动（封面接管时生效）'), ECLIPSE_GROUP],
  ledmatrix: [motionGroup('运动（封面接管时生效）'), LEDMATRIX_GROUP],
  laser: [motionGroup('运动（封面接管时生效）'), LASER_GROUP],
}

export function mixerGroupsFor(body: BodyKind): MixerGroupDef[] {
  return BODY_MIXER_GROUPS[body]
}
