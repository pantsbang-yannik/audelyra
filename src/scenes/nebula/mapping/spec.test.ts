import { describe, it, expect } from 'vitest'
import {
  PRESET_REACTIONS, USER_REACTION_PREFIX, defaultRhythmPreset, isPresetReaction, makeReaction,
  newUserReactionId, sanitizeMappingValues, GAIN_MAX, SMOOTHING_MAX_MS,
} from './spec'
import { PROPERTY_CATALOG, isValidAddress, type MappingValues, type Reaction } from './types'

const ruleOf = (v: MappingValues, id: string): Reaction | undefined => v.reactions.find((r) => r.id === id)

describe('属性目录与默认预设', () => {
  it('每条官方基线反应的地址合法，且其来源在该属性白名单内', () => {
    for (const r of PRESET_REACTIONS) {
      expect(isValidAddress(r.target), r.id).toBe(true)
      const spec = PROPERTY_CATALOG[r.target.element][r.target.property]
      expect(spec.allowedSources, `${r.id} 的来源`).toContain(r.source)
    }
  })
  it('官方基线反应 id 唯一——宏旋钮按 id 认领，撞 id 会让重铺错乱', () => {
    const ids = PRESET_REACTIONS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('version=2 且承接 spec §5.6 默认接线', () => {
    const p = defaultRhythmPreset()
    expect(p.version).toBe(2)
    expect(ruleOf(p, 'body.space.primary')!.source).toBe('beat')
    expect(ruleOf(p, 'body.brightness.primary')!.source).toBe('beat')
    expect(ruleOf(p, 'body.density.primary')!.source).toBe('energy')
    expect(ruleOf(p, 'body.thickness.primary')!.source).toBe('low')
    expect(ruleOf(p, 'body.speed.primary')!.source).toBe('tempo')
  })
  it('默认含一条背景显影反应，且下限克制（红线：零配置下背景仍须认得出）', () => {
    const dev = ruleOf(defaultRhythmPreset(), 'backdrop.develop.primary')!
    expect(dev.target).toEqual({ element: 'backdrop', property: 'develop' })
    expect(dev.enabled).toBe(true)
    expect(dev.outputMin).toBeGreaterThanOrEqual(0.4)
  })
  it('defaultRhythmPreset 每次返回独立副本（改一份不污染另一份）', () => {
    const a = defaultRhythmPreset(); const b = defaultRhythmPreset()
    ruleOf(a, 'body.space.primary')!.gain = 0.123
    a.reactions[0].target.property = 'density'
    expect(ruleOf(b, 'body.space.primary')!.gain).toBe(1)
    expect(b.reactions[0].target.property).toBe('speed')
  })
  it('官方基线 id 与用户 id 可区分（宏旋钮据此决定碰不碰）', () => {
    expect(isPresetReaction('body.space.primary')).toBe(true)
    expect(isPresetReaction(newUserReactionId())).toBe(false)
  })
})

describe('用户反应发号', () => {
  /** 计数器接下来本会发出的那个 id——先消耗一次再推算，断言便与计数器当前值无关 */
  const peekNextId = (): string => {
    const seq = parseInt(newUserReactionId().slice(USER_REACTION_PREFIX.length), 36)
    return `${USER_REACTION_PREFIX}${(seq + 1).toString(36)}`
  }

  it('发号避开已占用的 id——重开应用后计数器归零，不得与存档里留下的用户反应撞号', () => {
    const archived = [{ id: peekNextId() }] // 上次会话落盘的那条，正好占着本次将发的号
    const fresh = newUserReactionId(archived)
    expect(archived.some((r) => r.id === fresh)).toBe(false)
  })

  it('makeReaction 同样避开已占用的 id——「复制/添加」两条路径共用一套去重语义', () => {
    const archived = [{ id: peekNextId() }]
    const made = makeReaction({ element: 'body', property: 'density' }, archived)
    expect(archived.some((r) => r.id === made.id)).toBe(false)
  })
})

describe('sanitizeMappingValues', () => {
  it('null/垃圾输入回退默认预设', () => {
    expect(sanitizeMappingValues(null)).toEqual(defaultRhythmPreset())
    expect(sanitizeMappingValues('nope')).toEqual(defaultRhythmPreset())
  })
  it('非法 source（不在白名单）回退该反应的默认源', () => {
    const bad = defaultRhythmPreset()
    ruleOf(bad, 'body.thickness.primary')!.source = 'high' // high 不在 thickness 白名单
    const clean = sanitizeMappingValues(bad)
    expect(ruleOf(clean, 'body.thickness.primary')!.source).toBe('low')
  })
  it('gain / smoothingMs 被 clamp 到安全范围', () => {
    const bad = defaultRhythmPreset()
    Object.assign(ruleOf(bad, 'body.space.primary')!, { gain: 9999, smoothingMs: -50 })
    const clean = sanitizeMappingValues(bad)
    const r = ruleOf(clean, 'body.space.primary')!
    expect(r.gain).toBeLessThanOrEqual(GAIN_MAX)
    expect(r.smoothingMs).toBeGreaterThanOrEqual(0)
    expect(r.smoothingMs).toBeLessThanOrEqual(SMOOTHING_MAX_MS)
  })
  it('地址非法的反应被丢弃，其余原样保留——一条坏数据不该毁掉用户全部反应', () => {
    const bad = defaultRhythmPreset()
    bad.reactions.push({ ...bad.reactions[0], id: 'u-bogus', target: { element: 'nope', property: 'zzz' } })
    const clean = sanitizeMappingValues(bad)
    expect(ruleOf(clean, 'u-bogus')).toBeUndefined()
    expect(clean.reactions).toHaveLength(PRESET_REACTIONS.length)
  })
  it('撞 id 的第二条被改判为用户反应，内容不丢', () => {
    const bad = defaultRhythmPreset()
    bad.reactions.push({ ...ruleOf(bad, 'body.space.primary')!, gain: 1.75 })
    const clean = sanitizeMappingValues(bad)
    expect(clean.reactions).toHaveLength(PRESET_REACTIONS.length + 1)
    expect(clean.reactions.filter((r) => r.id === 'body.space.primary')).toHaveLength(1)
    expect(clean.reactions.some((r) => !isPresetReaction(r.id) && r.gain === 1.75)).toBe(true)
  })
  it('允许空反应列表——用户有权删光，画面变静态是他的选择而非坏数据', () => {
    expect(sanitizeMappingValues({ version: 2, reactions: [] })).toEqual({ version: 2, reactions: [] })
  })
  it('只保留已知字段（不夹带目录元数据 label）', () => {
    const clean = sanitizeMappingValues(defaultRhythmPreset())
    expect((clean.reactions[0] as unknown as Record<string, unknown>).label).toBeUndefined()
  })
  it('sanitize 对默认预设是幂等的（往返不腐蚀任何字段）', () => {
    expect(sanitizeMappingValues(defaultRhythmPreset())).toEqual(defaultRhythmPreset())
  })
  it('用户手加的反应能原样往返', () => {
    const v = defaultRhythmPreset()
    const extra = makeReaction({ element: 'body', property: 'density' })
    extra.gain = 1.4
    v.reactions.push(extra)
    expect(ruleOf(sanitizeMappingValues(v), extra.id)).toEqual(extra)
  })
})

describe('version 1 → 2 迁移', () => {
  /** 改造前的存档形状（targets 字典，每目标 1-2 槽） */
  const v1 = (over: Record<string, unknown> = {}): unknown => ({
    version: 1,
    targets: {
      speed: { primary: { enabled: true, source: 'tempo', gain: 1, curve: 'linear', smoothingMs: 1000, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 } },
      density: { primary: { enabled: true, source: 'energy', gain: 1, curve: 'ease', smoothingMs: 500, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 } },
      space: {
        primary: { enabled: true, source: 'beat', gain: 1.6, curve: 'punch', smoothingMs: 60, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 },
        secondary: { enabled: false, source: 'energy', gain: 1, curve: 'ease', smoothingMs: 400, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 },
      },
      brightness: {
        primary: { enabled: true, source: 'beat', gain: 1, curve: 'punch', smoothingMs: 60, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 },
        secondary: { enabled: true, source: 'high', gain: 1, curve: 'linear', smoothingMs: 100, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 },
      },
      thickness: { primary: { enabled: true, source: 'low', gain: 1, curve: 'linear', smoothingMs: 100, inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 } },
      ...over,
    },
  })

  it('老存档的用户调整逐条搬过来，不丢值', () => {
    const clean = sanitizeMappingValues(v1())
    expect(clean.version).toBe(2)
    expect(ruleOf(clean, 'body.space.primary')!.gain).toBe(1.6)      // 用户调过的强度
    expect(ruleOf(clean, 'body.space.secondary')!.enabled).toBe(false) // 用户关过的次源
  })
  it('迁移出的反应 id 与官方基线一致——否则宏旋钮认领不到老用户的反应', () => {
    const clean = sanitizeMappingValues(v1())
    for (const p of PRESET_REACTIONS) {
      if (p.target.element === 'body') expect(ruleOf(clean, p.id), p.id).toBeDefined()
    }
  })
  it('老存档没有的背景反应按默认补齐——老用户升级即拿到 B1 显影', () => {
    const clean = sanitizeMappingValues(v1())
    expect(ruleOf(clean, 'backdrop.develop.primary')).toBeDefined()
  })
  it('老存档缺失的目标按默认补齐', () => {
    const clean = sanitizeMappingValues({ version: 1, targets: {} })
    expect(ruleOf(clean, 'body.thickness.primary')!.source).toBe('low')
  })
  it('老存档里无 secondary 槽的目标即使塞了 secondary 也不会凭空多出反应', () => {
    const clean = sanitizeMappingValues(v1({
      density: { primary: { source: 'energy' }, secondary: { source: 'energy' } },
    }))
    expect(ruleOf(clean, 'body.density.secondary')).toBeUndefined()
  })
  it('迁移结果本身是 sanitize 幂等的', () => {
    const once = sanitizeMappingValues(v1())
    expect(sanitizeMappingValues(once)).toEqual(once)
  })
})
