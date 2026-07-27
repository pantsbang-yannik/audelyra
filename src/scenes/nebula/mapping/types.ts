// 音频→视觉映射的类型与约束常量。本文件对「形状」完全无知（spec §5.1 留路铁律）。
//
// 寻址模型（R1-1）：一条反应打向「元素 × 属性」二元组，而非早期的五枚举 VisualTarget。
// 二元组不可压成扁平字符串——扁平串以后加不了维度（实例序号 / 图层），
// 这是设计期定死的约束，改动前先想清楚寻址还要不要长第三维。

export type AudioFeature =
  | 'beat' | 'downbeat' | 'low' | 'mid' | 'high'
  | 'energy' | 'drop' | 'loudness' | 'silence' | 'tempo'
export type MappingCurve = 'linear' | 'ease' | 'punch' | 'softClip'

export const AUDIO_FEATURES: AudioFeature[] = [
  'beat', 'downbeat', 'low', 'mid', 'high', 'energy', 'drop', 'loudness', 'silence', 'tempo',
]

/** 属性的平滑性格：pulse 走弹簧（冲量+过冲），continuous 走包络跟随。
 * 这不是用户选项——它是属性自身的物理性格，由目录写定。 */
export type SmoothingKind = 'pulse' | 'continuous'

export interface PropertySpec {
  /** 中文显示名（UI 直接消费；底层一律走英文枚举，spec §5.1 铁律） */
  label: string
  /** ⓘ 简述：只讲这个属性是什么 */
  desc: string
  smoothing: SmoothingKind
  /** 允许接的音频源白名单（spec §5.4：受约束的可配置） */
  allowedSources: readonly AudioFeature[]
  /** 静止值：该地址上一条 enabled 反应都没有时的输出。
   * 主体属性是「加性冲量」，无驱动即 0；背景属性是「乘性调制」，无驱动必须是 1——
   * 否则用户没写背景反应时整张图会被乘成全黑。这个差别只能由目录声明，mapper 无从猜测。 */
  idle: number
}

/** 元素 → 属性目录：本模块唯一的事实源。
 * 「有哪些元素/属性、叫什么、能接什么信号、用弹簧还是包络」全在这里——
 * 新增元素或属性只改这张表，mapper / spec / 调音台 / 能力矩阵均从此派生。 */
export const ELEMENT_PROPERTIES = {
  body: {
    // 顺序即调音台渲染顺序，勿随意调整
    speed: {
      label: '速度', desc: '整体运动的快慢', smoothing: 'continuous',
      allowedSources: ['tempo', 'loudness', 'energy', 'beat', 'drop'],
      idle: 0,
    },
    density: {
      label: '密度', desc: '看到的粒子多少（不等于真实总数）', smoothing: 'continuous',
      allowedSources: ['energy', 'loudness', 'silence', 'drop'],
      idle: 0,
    },
    space: {
      label: '空间', desc: '扩张、收缩、朝相机的纵深', smoothing: 'pulse',
      allowedSources: ['beat', 'downbeat', 'energy', 'drop', 'low'],
      idle: 0,
    },
    brightness: {
      label: '亮度', desc: '明暗与闪光', smoothing: 'pulse',
      allowedSources: ['high', 'beat', 'drop', 'energy', 'loudness'],
      idle: 0,
    },
    thickness: {
      label: '厚度', desc: '粒径与光丝的厚重', smoothing: 'continuous',
      allowedSources: ['low', 'energy', 'drop', 'tempo'],
      idle: 0,
    },
  },
  // 背景三属性一律 continuous：pulse 的弹簧过冲是给主体的冲量手感用的，
  // 背景走冲量会变成闪烁，违反设计稿 §十一「背景只能被调制、不得被解构」的克制要求。
  // 三者 idle 均为 1（乘性中性）：没写背景反应的用户，背景必须与改造前一模一样。
  backdrop: {
    develop: {
      label: '显影', desc: '从去色压暗的未显影态，随音乐显现成完整画面', smoothing: 'continuous',
      allowedSources: ['energy', 'loudness', 'drop', 'beat', 'silence'],
      idle: 1,
    },
    brightness: {
      label: '明暗', desc: '背景图的亮度起伏', smoothing: 'continuous',
      allowedSources: ['energy', 'loudness', 'beat', 'drop', 'high'],
      idle: 1,
    },
    saturation: {
      label: '饱和', desc: '背景图的色彩浓淡', smoothing: 'continuous',
      allowedSources: ['energy', 'loudness', 'drop', 'low', 'high'],
      idle: 1,
    },
  },
} as const satisfies Record<string, Record<string, PropertySpec>>

/** 目录的字符串索引视图：遍历元素/属性时不需要字面量类型，
 * 有它才不必在每个遍历点写 `as Record<string, …>` 的类型体操。 */
export const PROPERTY_CATALOG: Record<string, Record<string, PropertySpec>> = ELEMENT_PROPERTIES

export type ElementId = keyof typeof ELEMENT_PROPERTIES
export type PropertyOf<E extends ElementId> = keyof (typeof ELEMENT_PROPERTIES)[E] & string
export type BodyProperty = PropertyOf<'body'>
export type BackdropProperty = PropertyOf<'backdrop'>

export const ELEMENT_IDS = Object.keys(ELEMENT_PROPERTIES) as ElementId[]

/** 元素中文名（UI 直接消费） */
export const ELEMENT_LABELS: Record<ElementId, string> = {
  body: '主体',
  backdrop: '背景',
}

export const BODY_PROPERTIES = Object.keys(ELEMENT_PROPERTIES.body) as BodyProperty[]

export function propertiesOf<E extends ElementId>(element: E): PropertyOf<E>[] {
  return Object.keys(ELEMENT_PROPERTIES[element]) as PropertyOf<E>[]
}

/** 反应的落点：元素 × 属性。element 未来可扩出 '@stage' / '@camera' 伪元素。 */
export interface TargetAddress {
  element: string
  property: string
}

export function isValidAddress(a: TargetAddress): boolean {
  return !!PROPERTY_CATALOG[a.element]?.[a.property]
}

/** 地址 → 稳定字符串键（仅用于 mapper 内部的包络/弹簧索引与去重，不落盘、不进格式） */
export function addressKey(a: TargetAddress): string {
  return `${a.element}.${a.property}`
}

/** 取属性元数据；地址非法返回 null（调用侧据此丢弃坏反应，而非整套回落默认） */
export function propertySpecAt(a: TargetAddress): PropertySpec | null {
  return PROPERTY_CATALOG[a.element]?.[a.property] ?? null
}

/** 单条映射规则的可调参数（不含落点）：宏旋钮与 sanitize 只吞吐这一层。 */
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

/** 一条反应 = 规则 + 落点 + 身份。
 * `id` 不是装饰：官方基线反应带固定 id（形如 `space.primary`），宏旋钮据此认领并只重铺自己那几条，
 * 用户手加的反应（`u-` 前缀）不受宏旋钮影响——否则拖一下旋钮就把用户写的反应删了。 */
export interface Reaction extends MappingRule {
  id: string
  target: TargetAddress
}

/** 用户持久化存档：只存实际选择与值，不含目录元数据（spec §5.5）。
 * version 2 起由「每目标固定 1-2 槽的字典」改为「任意条数的反应列表」。 */
export interface MappingValues {
  version: 2
  reactions: Reaction[]
}

/** mapper 每帧输出的分元素视觉控制量。对形状无知。
 * 值域：常规 0..1；gain/叠加超驱经软限幅渐近 1.25（curves.SOFT_LIMIT_CAP），
 * pulse 属性的弹簧过冲可再略超——下游系数按此头部空间标定。 */
export type VisualControls = {
  [E in ElementId]: Record<PropertyOf<E>, number>
}

/** 全部属性取静止值（idle）的一帧控制量：mapper 每帧的起点，也是下游在 mapper 未运行时的安全默认。 */
export function idleControls(): VisualControls {
  const out: Record<string, Record<string, number>> = {}
  for (const [el, props] of Object.entries(PROPERTY_CATALOG)) {
    const vals: Record<string, number> = {}
    for (const [p, spec] of Object.entries(props)) vals[p] = spec.idle
    out[el] = vals
  }
  return out as VisualControls
}
