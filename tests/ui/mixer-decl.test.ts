import { describe, it, expect } from 'vitest'
import { validateSections } from '../../src/ui/mixer-schema'
import { CAMERA_SECTIONS } from '../../src/ui/mixer-decl/camera-tab'
import { TITLE_SECTIONS, LYRICS_SECTIONS } from '../../src/ui/mixer-decl/lyrics-tab'
import { BACKGROUND_SECTIONS } from '../../src/ui/mixer-decl/background-tab'
import { shapeSectionsFor } from '../../src/ui/mixer-decl/shape-tab'

describe('调音台声明表完备性（契约说谎在此被抓）', () => {
  it('镜头 tab 声明合法且控件齐全（活跃度+默认距离）', () => {
    expect(validateSections(CAMERA_SECTIONS)).toEqual([])
    const labels = CAMERA_SECTIONS.flatMap((s) => s.controls.map((c) => c.label))
    expect(labels).toEqual(['运镜活跃度', '默认距离'])
  })

  it('歌词歌名 tab 声明合法：粒子歌名 4 控件 + 歌词 6 控件', () => {
    expect(validateSections(TITLE_SECTIONS)).toEqual([])
    expect(validateSections(LYRICS_SECTIONS)).toEqual([])
    expect(TITLE_SECTIONS.flatMap((s) => s.controls).length).toBe(4)
    expect(LYRICS_SECTIONS.flatMap((s) => s.controls).length).toBe(6)
  })

  it('背景 tab 声明合法：三组（深空水镜/自定义背景/尘埃），互斥组带 lockWhen 与 note 锚点', () => {
    expect(validateSections(BACKGROUND_SECTIONS)).toEqual([])
    expect(BACKGROUND_SECTIONS.map((s) => s.title)).toEqual(['深空水镜', '自定义背景', '尘埃'])
    expect(BACKGROUND_SECTIONS[0].noteRole).toBe('bg-locked-note')
    expect(BACKGROUND_SECTIONS[1].noteRole).toBe('bg-custom-note')
    expect(BACKGROUND_SECTIONS[2].lockWhen).toBeUndefined()
  })

  it('主体 tab 适配声明合法：六 body 各产出非空组，粒子组含频闪 toggle（commitOnly）', () => {
    for (const b of ['particles', 'spectrum', 'waveform', 'eclipse', 'ledmatrix', 'laser'] as const) {
      const sections = shapeSectionsFor(b)
      expect(validateSections(sections)).toEqual([])
      expect(sections.length).toBeGreaterThan(0)
    }
    const strobe = shapeSectionsFor('particles')
      .flatMap((s) => s.controls).find((c) => c.label === '频闪')
    expect(strobe && strobe.kind === 'toggle' && strobe.commitOnly).toBe(true)
  })
})
