import { describe, it, expect } from 'vitest'
import { NebulaMotionProgram, type MotionUniforms, type MotionInputs } from '../../src/scenes/nebula/motion/nebula-program'
import { DEFAULT_MOTION_SETTINGS, type MotionSettings } from '../../src/scenes/nebula/motion/types'

const DT = 1 / 60
function mkU(): MotionUniforms {
  return {
    uSwellAmp: { value: 0 }, uRippleAmp: { value: 0 }, uJitterAmp: { value: 0 },
    uWaveSpeed: { value: 1 }, uWavefrontAmp: { value: 1 }, uBuildSqueeze: { value: 0 },
    uNarrDim: { value: 1 }, uFlash: { value: 0 }, uTwinkleAmp: { value: 1 },
  }
}
function mkInp(over: Partial<MotionInputs> = {}): MotionInputs {
  return {
    narrative: { phase: 'steady', progress: 0 },
    low: 0.5, mid: 0.4, high: 0.3, kickEnv: 0, dropPulse: 0, kickStrength: 0, energy: 0,
    mapSpeed: 0, mapDensity: 0, ...over,
  }
}
const S = (over: Partial<MotionSettings> = {}): MotionSettings => ({ ...DEFAULT_MOTION_SETTINGS, ...over })

describe('NebulaMotionProgram（封面/星云方言：幅度合成/三幕/光敏安全）', () => {
  it('持续层幅度 = band 包络 × 旋钮：轰炸强度=0 时鼓包/波纹/波前全静音，细节独立', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp(), S({ bombIntensity: 0, detailDensity: 2 }))
    expect(u.uSwellAmp.value).toBe(0)
    expect(u.uRippleAmp.value).toBe(0)
    expect(u.uWavefrontAmp.value).toBe(0)
    expect(u.uJitterAmp.value).toBeGreaterThan(0) // 细节密度走独立旋钮
    expect(u.uTwinkleAmp.value).toBe(2)
  })
  it('蓄力三幕：build 相收缩随 progress 加深且变暗；离开 build 快速松手', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    for (let i = 0; i < 90; i++) p.update(DT, mkInp({ narrative: { phase: 'build', progress: 0.8 } }), S())
    expect(u.uBuildSqueeze.value).toBeGreaterThan(0.3) // 0.8×0.6=0.48 目标，1.5s 后接近
    expect(u.uNarrDim.value).toBeLessThan(0.95) // 蓄力变暗
    for (let i = 0; i < 30; i++) p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S())
    expect(u.uBuildSqueeze.value).toBeLessThan(0.1) // 爆发瞬间松手（release 0.15s，0.5s 后≈0）
  })
  it('burst 进入边沿触发闪白（≤FLASH_AMP_MAX），并给出色散乐器值', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp(), S())
    const inst = p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S())
    expect(u.uFlash.value).toBeGreaterThan(0.13)
    expect(u.uFlash.value).toBeLessThanOrEqual(0.35 * 0.65)
    expect(inst.chroma).toBeGreaterThan(0.5)
  })
  it('闪光缓入（#光效精修 ③）：触发后前几帧值上涨（attack 涌起），而非瞬时跳峰再衰减', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp(), S()) // steady
    p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S()) // burst 边沿触发，第 1 帧
    const f1 = u.uFlash.value
    p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S()) // 第 2 帧（不再重触发）
    p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S()) // 第 3 帧，仍在 50ms attack 内
    const f3 = u.uFlash.value
    expect(f3).toBeGreaterThan(f1) // ArPulse 缓入涌起（瞬时 Pulse 会立刻衰减导致 f3<f1）
  })
  it('光敏安全：0.5s 内第二次触发被吞（强拍连击不连闪）', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp({ kickStrength: 0.9 }), S())
    const afterFirst = u.uFlash.value
    expect(afterFirst).toBeGreaterThan(0.06)
    for (let i = 0; i < 12; i++) p.update(DT, mkInp(), S()) // 0.2s 衰减
    p.update(DT, mkInp({ kickStrength: 0.9 }), S()) // 间隔仅 ~0.22s——必须被安全门吞掉
    expect(u.uFlash.value).toBeLessThan(afterFirst * 0.5) // 只剩衰减尾，没有新触发
  })
  it('频闪开关=关：任何触发都不闪白，但色散/径向模糊（非亮度频闪）照常', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    const inst = p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 }, dropPulse: 0.9 }), S({ strobeEnabled: false }))
    expect(u.uFlash.value).toBe(0)
    expect(inst.chroma).toBeGreaterThan(0.5)
    expect(inst.radialBlur).toBeCloseTo(0.9, 5)
    expect(inst.climaxGlow).toBeCloseTo(0.65, 5) // bloom 压档不受频闪总闸辖制
  })
  it('后期乐器：kickGlow 透传 kickEnv；radialBlur 跟 dropPulse 钳 0..1', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    const inst = p.update(DT, mkInp({ kickEnv: 0.7, dropPulse: 1.4 }), S())
    expect(inst.kickGlow).toBeCloseTo(0.7, 5)
    expect(inst.radialBlur).toBe(1)
  })
  it('死线接活（调音台规范化）：mapSpeed/mapDensity=0 中性——uWaveSpeed/uTwinkleAmp 等于旋钮基线；=1 时按跨度放大（乘法叠加不覆写旋钮）', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp(), S({ waveSpeed: 1.5, detailDensity: 0.5 }))
    expect(u.uWaveSpeed.value).toBeCloseTo(1.5, 5)   // 中性：与静态旋钮值一致
    expect(u.uTwinkleAmp.value).toBeCloseTo(0.5, 5)
    p.update(DT, mkInp({ mapSpeed: 1, mapDensity: 1 }), S({ waveSpeed: 1.5, detailDensity: 0.5 }))
    expect(u.uWaveSpeed.value).toBeGreaterThan(1.5)  // 放大且保留旋钮基线（乘法）
    expect(u.uTwinkleAmp.value).toBeGreaterThan(0.5)
  })
  it('高潮亮度统一缩放：闪白随旋钮线性（拉满/默认=1.5×），climaxGlow=0.65×旋钮', () => {
    const u = mkU()
    const p = new NebulaMotionProgram(u)
    p.update(DT, mkInp(), S())
    const instDefault = p.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S())
    const flashDefault = u.uFlash.value
    expect(flashDefault).toBeGreaterThan(0.1)
    expect(instDefault.climaxGlow).toBeCloseTo(0.65, 5)

    const u2 = mkU()
    const p2 = new NebulaMotionProgram(u2)
    p2.update(DT, mkInp(), S({ climaxBrightness: 1.5 }))
    const instMax = p2.update(DT, mkInp({ narrative: { phase: 'burst', progress: 1 } }), S({ climaxBrightness: 1.5 }))
    expect(u2.uFlash.value / flashDefault).toBeCloseTo(1.5, 3) // 拉满≈旧强度：0.35×0.975 仍在 0.35 封顶之下
    expect(instMax.climaxGlow).toBeCloseTo(0.975, 5)

    const u3 = mkU()
    const p3 = new NebulaMotionProgram(u3)
    const instMin = p3.update(DT, mkInp({ kickStrength: 0.9 }), S({ climaxBrightness: 0.3 }))
    expect(u3.uFlash.value).toBeLessThan(0.05) // 最柔档绝对阈值：0.18×0.195≈0.035+衰减
    expect(instMin.climaxGlow).toBeCloseTo(0.195, 5)
  })
})
