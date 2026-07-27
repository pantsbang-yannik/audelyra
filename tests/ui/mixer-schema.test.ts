import { describe, it, expect } from 'vitest'
import { validateSections, type MixerSectionDef } from '../../src/ui/mixer-schema'

interface Draft { a: number; b: boolean }

describe('mixer-schema 声明校验器（契约说谎在测试层被抓）', () => {
  const good: Array<MixerSectionDef<Draft>> = [{
    title: '组', desc: '说明',
    controls: [
      { kind: 'range', label: '滑块', min: 0, max: 1, step: 0.05, get: (d) => d.a, set: (d, v) => { d.a = v } },
      { kind: 'toggle', label: '开关', get: (d) => d.b, set: (d, v) => { d.b = v } },
      { kind: 'choice', label: '选择', options: [{ text: '甲', value: 'x' }], get: () => 'x', set: () => {} },
    ],
  }]
  it('合法声明返回空清单', () => {
    expect(validateSections(good)).toEqual([])
  })
  it('量程非法（min≥max / step≤0）、组标题空、choice 无选项、控件 label 空均被点名', () => {
    const bad: Array<MixerSectionDef<Draft>> = [{
      title: '', desc: '',
      controls: [
        { kind: 'range', label: '', min: 1, max: 1, step: 0, get: (d) => d.a, set: () => {} },
        { kind: 'choice', label: '空选', options: [], get: () => '', set: () => {} },
      ],
    }]
    const errs = validateSections(bad)
    expect(errs.length).toBeGreaterThanOrEqual(4)
  })
})
