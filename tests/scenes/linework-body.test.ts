import { describe, it, expect } from 'vitest'
import * as THREE from 'three/webgpu'
import { LineworkBody } from '../../src/scenes/nebula/linework/linework-body'
import { BIN_COUNT } from '../../src/scenes/nebula/linework/spectrum-bins'

const inp = (over: Partial<Parameters<LineworkBody['update']>[1]> = {}) => ({
  bins: new Float32Array(BIN_COUNT), kickEnv: 0, drop: 0, sleep: 0, energy: 0.5,
  opacity: 1, colorA: new THREE.Color(0.3, 0.5, 1), colorC: new THREE.Color(0.9, 0.95, 1),
  brightness: 1, barHeight: 1, waveWidth: 1, pulseSpace: 0, pulseBright: 0,
  mapDensity: 0, mapThick: 0, ...over,
})

describe('LineworkBody CPU 契约', () => {
  it('构造挂一块画板；update 搬运 opacity；setMode 翻模式', () => {
    const b = new LineworkBody()
    expect(b.group.children.length).toBe(1)
    b.update(1 / 60, inp({ opacity: 0.4 }))
    expect(b.opacityForTest).toBeCloseTo(0.4, 5)
    expect(b.modeForTest).toBe(0)
    b.setMode('waveform')
    expect(b.modeForTest).toBe(1)
    b.dispose()
  })
  it('faceCamera 缓跟随：一步后朝向偏向镜头（四元数变化）', () => {
    const b = new LineworkBody()
    const before = b.group.quaternion.clone()
    b.faceCamera(new THREE.Vector3(3, 2, 1), 1 / 60)
    expect(b.group.quaternion.equals(before)).toBe(false)
    b.dispose()
  })
  it('死线接活（调音台规范化）：update 搬运映射密度/厚度到 uniform，缺省 0=中性', () => {
    const b = new LineworkBody()
    b.update(1 / 60, inp())
    expect(b.mapDensityForTest).toBe(0)
    expect(b.mapThickForTest).toBe(0)
    b.update(1 / 60, inp({ mapDensity: 0.7, mapThick: 0.4 }))
    expect(b.mapDensityForTest).toBeCloseTo(0.7, 5)
    expect(b.mapThickForTest).toBeCloseTo(0.4, 5)
    b.dispose()
  })
})
