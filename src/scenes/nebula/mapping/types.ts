// 音频→视觉映射的类型与约束常量。本文件对「形状」完全无知（spec §5.1 留路铁律）。

export type VisualTarget = 'speed' | 'density' | 'space' | 'brightness' | 'thickness'
export type AudioFeature =
  | 'beat' | 'downbeat' | 'low' | 'mid' | 'high'
  | 'energy' | 'drop' | 'loudness' | 'silence' | 'tempo'
export type MappingCurve = 'linear' | 'ease' | 'punch' | 'softClip'

export const VISUAL_TARGETS: VisualTarget[] = ['speed', 'density', 'space', 'brightness', 'thickness']
export const AUDIO_FEATURES: AudioFeature[] = [
  'beat', 'downbeat', 'low', 'mid', 'high', 'energy', 'drop', 'loudness', 'silence', 'tempo',
]

/** 单条映射规则：一个 source 如何驱动一个 target。 */
export interface MappingRule {
  enabled: boolean
  source: AudioFeature
  gain: number
  curve: MappingCurve
  smoothingMs: number
  inputMin: number
  inputMax: number
  outputMin: number
  outputMax: number
  invert?: boolean
}

/** 一个视觉目标的映射：主来源 + 可选次来源（叠加）。 */
export interface TargetMapping {
  primary: MappingRule
  secondary?: MappingRule
}

/** 用户持久化存档：只存实际选择与值，不含 spec 元数据（spec §5.5）。 */
export interface MappingValues {
  version: 1
  targets: Record<VisualTarget, TargetMapping>
}

/** mapper 每帧输出的五类通用视觉控制量。对形状无知。
 * 值域：常规 0..1；gain/叠加超驱经软限幅渐近 1.25（curves.SOFT_LIMIT_CAP），
 * space/brightness 的弹簧过冲可再略超——下游系数按此头部空间标定。 */
export interface VisualControls {
  speed: number
  density: number
  space: number
  brightness: number
  thickness: number
}

/** 每个目标的允许来源白名单（spec §5.4）：受约束的可配置。 */
export const ALLOWED_SOURCES: Record<VisualTarget, AudioFeature[]> = {
  speed: ['tempo', 'loudness', 'energy', 'beat', 'drop'],
  density: ['energy', 'loudness', 'silence', 'drop'],
  space: ['beat', 'downbeat', 'energy', 'drop', 'low'],
  brightness: ['high', 'beat', 'drop', 'energy', 'loudness'],
  thickness: ['low', 'energy', 'drop', 'tempo'],
}
