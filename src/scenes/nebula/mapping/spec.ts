// 代码内置的映射元数据（不落盘）+ 默认预设 + sanitize。spec §5.5/§5.6。
import {
  ALLOWED_SOURCES, VISUAL_TARGETS,
  type AudioFeature, type MappingCurve, type MappingRule,
  type MappingValues, type TargetMapping, type VisualTarget,
} from './types'

export const GAIN_MAX = 2 // 收窄自 4：配合软限幅（CAP 1.25），保证滑块全行程都有可感增量；旧存档超界值由 sanitize 自动夹回
export const SMOOTHING_MAX_MS = 2000
const CURVES: MappingCurve[] = ['linear', 'ease', 'punch', 'softClip']
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

export interface MappingSlotSpec {
  label: string
  allowedSources: AudioFeature[]
  default: MappingRule
}
export type MappingSpec = Record<VisualTarget, { primary: MappingSlotSpec; secondary?: MappingSlotSpec }>

const rule = (source: AudioFeature, over: Partial<MappingRule> = {}): MappingRule => ({
  enabled: true, source, gain: 1, curve: 'linear', smoothingMs: 120,
  inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1, ...over,
})

// spec §5.6 DefaultRhythmPreset：pulse/dynamics 审美判断落成默认值
export const MAPPING_SPEC: MappingSpec = {
  space: {
    primary: { label: '空间·脉冲锚', allowedSources: ALLOWED_SOURCES.space,
      default: rule('beat', { curve: 'punch', smoothingMs: 60, outputMax: 1 }) },
    secondary: { label: '空间·段落收放', allowedSources: ALLOWED_SOURCES.space,
      default: rule('energy', { curve: 'ease', smoothingMs: 400 }) },
  },
  brightness: {
    primary: { label: '亮度·脉冲提亮', allowedSources: ALLOWED_SOURCES.brightness,
      default: rule('beat', { curve: 'punch', smoothingMs: 60 }) },
    secondary: { label: '亮度·高频碎光', allowedSources: ALLOWED_SOURCES.brightness,
      default: rule('high', { curve: 'linear', smoothingMs: 100 }) },
  },
  density: {
    primary: { label: '密度·段落收放', allowedSources: ALLOWED_SOURCES.density,
      default: rule('energy', { curve: 'ease', smoothingMs: 500 }) },
  },
  thickness: {
    primary: { label: '厚度·低频重量', allowedSources: ALLOWED_SOURCES.thickness,
      default: rule('low', { curve: 'linear', smoothingMs: 100 }) },
  },
  speed: {
    primary: { label: '速度·全场速度感', allowedSources: ALLOWED_SOURCES.speed,
      default: rule('tempo', { curve: 'linear', smoothingMs: 1000 }) },
  },
}

export function defaultRhythmPreset(): MappingValues {
  const targets = {} as Record<VisualTarget, TargetMapping>
  for (const t of VISUAL_TARGETS) {
    const slot = MAPPING_SPEC[t]
    targets[t] = {
      primary: { ...slot.primary.default },
      ...(slot.secondary ? { secondary: { ...slot.secondary.default } } : {}),
    }
  }
  return { version: 1, targets }
}

function sanitizeRule(raw: unknown, spec: MappingSlotSpec): MappingRule {
  const def = spec.default
  if (typeof raw !== 'object' || raw === null) return { ...def }
  const r = raw as Record<string, unknown>
  const source = spec.allowedSources.includes(r.source as AudioFeature)
    ? (r.source as AudioFeature) : def.source // 非法 source → 回退默认
  const curve = CURVES.includes(r.curve as MappingCurve) ? (r.curve as MappingCurve) : def.curve
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
    source, curve,
    gain: clamp(num(r.gain, def.gain), 0, GAIN_MAX),
    smoothingMs: clamp(num(r.smoothingMs, def.smoothingMs), 0, SMOOTHING_MAX_MS),
    inputMin: clamp(num(r.inputMin, def.inputMin), 0, 1),
    inputMax: clamp(num(r.inputMax, def.inputMax), 0, 1),
    outputMin: clamp(num(r.outputMin, def.outputMin), 0, 1),
    outputMax: clamp(num(r.outputMax, def.outputMax), 0, 1),
    ...(typeof r.invert === 'boolean' ? { invert: r.invert } : {}),
  }
}

export function sanitizeMappingValues(raw: unknown): MappingValues {
  if (typeof raw !== 'object' || raw === null) return defaultRhythmPreset()
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1 || typeof obj.targets !== 'object' || obj.targets === null)
    return defaultRhythmPreset()
  const rawTargets = obj.targets as Record<string, unknown>
  const targets = {} as Record<VisualTarget, TargetMapping>
  for (const t of VISUAL_TARGETS) {
    const slot = MAPPING_SPEC[t]
    const rawT = (typeof rawTargets[t] === 'object' && rawTargets[t] !== null
      ? rawTargets[t] : {}) as Record<string, unknown>
    targets[t] = {
      primary: sanitizeRule(rawT.primary, slot.primary),
      ...(slot.secondary ? { secondary: sanitizeRule(rawT.secondary, slot.secondary) } : {}),
    }
  }
  return { version: 1, targets }
}
