import { describe, it, expect } from 'vitest'
import { RHYTHM_CAPABILITY, rhythmTargetsFor } from '../../src/scenes/nebula/shapes/rhythm-capability'
import { BODY_PROPERTIES } from '../../src/scenes/nebula/mapping/types'
import { BODY_MIXER_GROUPS } from '../../src/scenes/nebula/shapes/mixer-contract'

describe('律动能力矩阵（mixer v2：body → 消费的律动目标）', () => {
  it('覆盖全部 body 类（与调音台契约表同键集）', () => {
    expect(Object.keys(RHYTHM_CAPABILITY).sort()).toEqual(Object.keys(BODY_MIXER_GROUPS).sort())
  })
  it('每类至少消费一个目标，且全部落在 BODY_PROPERTIES 白名单内、无重复', () => {
    for (const targets of Object.values(RHYTHM_CAPABILITY)) {
      expect(targets.length).toBeGreaterThan(0)
      expect(new Set(targets).size).toBe(targets.length)
      for (const t of targets) expect(BODY_PROPERTIES).toContain(t)
    }
  })
  it('实测校准（2026-07-24）：粒子/频谱环/波形线/日食全吃五项；点阵与激光不吃空间', () => {
    for (const b of ['particles', 'spectrum', 'waveform', 'eclipse'] as const)
      expect(rhythmTargetsFor(b)).toHaveLength(5)
    expect(rhythmTargetsFor('ledmatrix')).not.toContain('space')
    expect(rhythmTargetsFor('laser')).not.toContain('space')
    expect(rhythmTargetsFor('laser')).toContain('brightness')
  })
})
