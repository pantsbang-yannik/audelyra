// 主体 tab 声明适配（mixer v2 契约化收口）：既有 mixer-contract（body→分组）翻译成统一
// SectionDef——契约表仍是唯一事实源，此处只换渲染载体；toggle 沿用「只 commit 不 preview」现状语义。
import { MOTION_LIMITS, type MotionSettings } from '../../scenes/nebula/motion/types'
import { mixerGroupsFor } from '../../scenes/nebula/shapes/mixer-contract'
import type { BodyKind } from '../../scenes/nebula/shapes/types'
import type { MixerControlDef, MixerSectionDef } from '../mixer-schema'

export function shapeSectionsFor(body: BodyKind): Array<MixerSectionDef<MotionSettings>> {
  return mixerGroupsFor(body).map((g) => ({
    title: g.title,
    desc: '', // 契约组标题无 ⓘ（现状如此）——makeGroupHeader 对空 desc 跳过图标
    controls: [
      ...g.knobs.map((k): MixerControlDef<MotionSettings> => ({
        kind: 'range', label: k.label, help: k.help,
        min: MOTION_LIMITS[k.key].min, max: MOTION_LIMITS[k.key].max, step: MOTION_LIMITS[k.key].step,
        get: (d) => d[k.key], set: (d, v) => { d[k.key] = v },
      })),
      ...(g.toggles ?? []).map((t): MixerControlDef<MotionSettings> => ({
        kind: 'toggle', label: t.label, help: t.help, commitOnly: true,
        get: (d) => d[t.key], set: (d, v) => { d[t.key] = v },
      })),
    ],
  }))
}
