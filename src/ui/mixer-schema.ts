// 调音台统一控件声明模型（mixer v2 spec §全面契约化）：TabDef 层即「各 tab 的 SectionDef[]」，
// 面板照声明渲染（tuning-panel.renderSections），声明表落 src/ui/mixer-decl/。
// 泛型 D=该 tab 的 draft 类型——get/set 编译期绑定 settings 字段，比字符串键更强的完备性保障；
// 运行期兜底交给 validateSections（量程/标题/选项），完备性单测逐表跑一遍。
export interface RangeControlDef<D> {
  kind: 'range'
  label: string
  help?: string
  min: number
  max: number
  step: number
  format?: (v: number) => string
  snap?: (v: number) => number
  ticks?: readonly number[]
  get: (d: D) => number
  set: (d: D, v: number) => void
}

export interface ToggleControlDef<D> {
  kind: 'toggle'
  label: string
  help?: string
  get: (d: D) => boolean
  set: (d: D, v: boolean) => void
  /** true=只 commit 不 preview（频闪开关先例）；缺省 preview+commit */
  commitOnly?: boolean
}

export interface ChoiceControlDef<D> {
  kind: 'choice'
  label: string
  help?: string
  options: Array<{ text: string; value: string }>
  get: (d: D) => string
  set: (d: D, v: string) => void
}

export type MixerControlDef<D> = RangeControlDef<D> | ToggleControlDef<D> | ChoiceControlDef<D>

export interface MixerSectionDef<D> {
  title: string
  desc: string
  /** 行 data-role（测试锚点/置灰定位）；缺省不加属性 */
  rowRole?: string
  /** 返回 true 时整组置灰（行级 opacity+pointerEvents）并渲染 lockedNote 小字（背景互斥先例） */
  lockWhen?: (d: D) => boolean
  lockedNote?: string
  noteRole?: string
  controls: Array<MixerControlDef<D>>
}

/** 声明完备性校验：返回问题清单（空=合法）。完备性单测对每张声明表调用。 */
export function validateSections<D>(sections: Array<MixerSectionDef<D>>): string[] {
  const errs: string[] = []
  for (const s of sections) {
    if (!s.title) errs.push('组标题为空')
    for (const c of s.controls) {
      const at = `${s.title || '(无题组)'}/${c.label || '(无名控件)'}`
      if (!c.label) errs.push(`${at}: 控件 label 为空`)
      if (c.kind === 'range') {
        if (!(c.min < c.max)) errs.push(`${at}: 量程 min≥max`)
        if (!(c.step > 0)) errs.push(`${at}: step≤0`)
      }
      if (c.kind === 'choice' && c.options.length === 0) errs.push(`${at}: choice 选项为空`)
    }
  }
  return errs
}
