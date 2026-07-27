import { describe, it, expect } from 'vitest'
import {
  macroToMapping, sanitizeMacroKnobs, DEFAULT_MACRO_KNOBS,
  styleBaseline, roleOf, MACRO_STYLES, type MacroStyle, type RuleKey,
} from './macro'
import { defaultRhythmPreset, makeReaction, sanitizeMappingValues, GAIN_MAX, SMOOTHING_MAX_MS } from './spec'
import { BODY_PROPERTIES, type MappingValues, type Reaction } from './types'

const allRules = (m: MappingValues): Reaction[] => m.reactions

describe('macroToMapping（宏旋钮→专业表投影）', () => {
  it('中点不变量：均衡档 + 两旋钮 0.5 → 深度等于 defaultRhythmPreset', () => {
    expect(macroToMapping({ style: 'balanced', strength: 0.5, response: 0.5 }))
      .toEqual(defaultRhythmPreset())
  })

  it('DEFAULT_MACRO_KNOBS 是均衡档 + 两个 0.5，且投影等于默认预设', () => {
    expect(DEFAULT_MACRO_KNOBS).toEqual({ style: 'balanced', strength: 0.5, response: 0.5 })
    expect(macroToMapping(DEFAULT_MACRO_KNOBS)).toEqual(defaultRhythmPreset())
  })

  it('劲儿靠对比度可感：狂放端主导/背景 gain 比 ≥ 5，克制端主导明显低于中点', () => {
    const mid = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    const wild = macroToMapping({ style: 'rhythmic', strength: 1, response: 0.5 })
    const calm = macroToMapping({ style: 'rhythmic', strength: 0, response: 0.5 })
    // 节奏档：space.primary=主导，space.secondary=背景
    expect(ruleOf(wild, 'body.space.primary')!.gain / ruleOf(wild, 'body.space.secondary')!.gain)
      .toBeGreaterThanOrEqual(5)
    expect(ruleOf(mid, 'body.space.primary')!.gain).toBe(ruleOf(mid, 'body.space.secondary')!.gain) // 中点无对比
    expect(ruleOf(calm, 'body.space.primary')!.gain).toBeLessThan(ruleOf(mid, 'body.space.primary')!.gain * 0.8)
  })

  it('劲儿不压中立规则：density 的 gain 在两端都不变', () => {
    const wild = macroToMapping({ style: 'rhythmic', strength: 1, response: 0.5 })
    const calm = macroToMapping({ style: 'rhythmic', strength: 0, response: 0.5 })
    const base = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    expect(ruleOf(wild, 'body.density.primary')!.gain).toBe(ruleOf(base, 'body.density.primary')!.gain)
    expect(ruleOf(calm, 'body.density.primary')!.gain).toBe(ruleOf(base, 'body.density.primary')!.gain)
  })

  it('跟手只缩放主导：主导 smoothing 两端跨度 ≥ 10 倍，背景两端相等', () => {
    const lo = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0 })
    const hi = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 1 })
    expect(ruleOf(hi, 'body.space.primary')!.smoothingMs / ruleOf(lo, 'body.space.primary')!.smoothingMs)
      .toBeGreaterThanOrEqual(10)
    // 背景规则的响应不随跟手变（保持稳定底，避免整体一起变慢＝换风格看不出差别）
    expect(ruleOf(hi, 'body.space.secondary')!.smoothingMs).toBe(ruleOf(lo, 'body.space.secondary')!.smoothingMs)
  })

  it('正交-劲儿：只动劲儿，所有 smoothing 不变', () => {
    const base = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    const moved = macroToMapping({ style: 'rhythmic', strength: 0.9, response: 0.5 })
    for (const key of ALL_RULE_KEYS) {
      expect(ruleOf(moved, key)!.smoothingMs, key).toBe(ruleOf(base, key)!.smoothingMs)
    }
  })

  it('正交-跟手：只动跟手，所有 gain 不变', () => {
    const base = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    const moved = macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.9 })
    for (const key of ALL_RULE_KEYS) {
      expect(ruleOf(moved, key)!.gain, key).toBe(ruleOf(base, key)!.gain)
    }
  })

  // —— id 认领：反应可增删之后，「全量重铺」会删掉用户写的东西，这几条是防线 ——

  it('传入当前 mapping 时，用户手加的反应原样保留（拖旋钮不许删用户的反应）', () => {
    const current = defaultRhythmPreset()
    const mine = makeReaction({ element: 'body', property: 'thickness' })
    mine.gain = 1.9
    mine.smoothingMs = 777
    current.reactions.push(mine)

    const out = macroToMapping({ style: 'bass', strength: 1, response: 0 }, current)
    const kept = out.reactions.find((r) => r.id === mine.id)
    expect(kept, '用户反应必须还在').toBeDefined()
    expect(kept).toEqual(mine) // 且一个字段都没被旋钮改
  })

  it('传入当前 mapping 时，用户删掉的官方反应不会被旋钮复活', () => {
    const current = defaultRhythmPreset()
    current.reactions = current.reactions.filter((r) => r.id !== 'body.brightness.secondary')
    const out = macroToMapping({ style: 'ambient', strength: 0.8, response: 0.2 }, current)
    expect(ruleOf(out, 'body.brightness.secondary')).toBeNull()
  })

  it('官方基线反应仍被完整重铺（认领不是「什么都不改」）', () => {
    const current = defaultRhythmPreset()
    current.reactions.push(makeReaction({ element: 'body', property: 'density' }))
    const out = macroToMapping({ style: 'bass', strength: 0.5, response: 0.5 }, current)
    // 低音档把 space 主源换成 low —— 用户反应在场不影响官方反应被换掉
    expect(ruleOf(out, 'body.space.primary')!.source).toBe('low')
  })

  it('背景显影不受宏旋钮影响（三旋钮的语义都是主体律动）', () => {
    const base = ruleOf(macroToMapping(DEFAULT_MACRO_KNOBS), 'backdrop.develop.primary')!
    for (const style of MACRO_STYLES.map((s) => s.id)) {
      for (const strength of [0, 1]) {
        for (const response of [0, 1]) {
          expect(ruleOf(macroToMapping({ style, strength, response }), 'backdrop.develop.primary'),
            `${style}/${strength}/${response}`).toEqual(base)
        }
      }
    }
  })

  it('不传当前 mapping 时返回完整基线——「专业表是否被手改」的判定要靠它', () => {
    const out = macroToMapping(DEFAULT_MACRO_KNOBS)
    expect(out.reactions.map((r) => r.id)).toEqual(defaultRhythmPreset().reactions.map((r) => r.id))
  })

  it('合法域：四档 × 两旋钮极值全组合，产出过 sanitizeMappingValues 原样且不越界', () => {
    for (const style of MACRO_STYLES.map((s) => s.id)) {
      for (const strength of [0, 0.5, 1]) {
        for (const response of [0, 0.5, 1]) {
          const m = macroToMapping({ style, strength, response })
          expect(sanitizeMappingValues(m), `${style}/${strength}/${response}`).toEqual(m)
          for (const r of allRules(m)) {
            expect(r.gain).toBeGreaterThanOrEqual(0)
            expect(r.gain).toBeLessThanOrEqual(GAIN_MAX)
            expect(r.smoothingMs).toBeGreaterThanOrEqual(0)
            expect(r.smoothingMs).toBeLessThanOrEqual(SMOOTHING_MAX_MS)
          }
        }
      }
    }
  })
})

// 7 条规则的全集（space/brightness 有 secondary，其余只有 primary）
const ALL_RULE_KEYS: RuleKey[] = [
  'body.space.primary', 'body.space.secondary',
  'body.brightness.primary', 'body.brightness.secondary',
  'body.density.primary', 'body.thickness.primary', 'body.speed.primary',
]

/** 取某官方基线 id 对应的反应（不存在返回 null）。参数放宽为 string：
 * 断言「背景反应不受宏旋钮影响」时要查 backdrop 的 id，那不在 RuleKey 域里。 */
function ruleOf(m: MappingValues, key: string): Reaction | null {
  return m.reactions.find((r) => r.id === key) ?? null
}

/** 两档之间「三元组不同」的规则条数 */
function diffCount(a: MacroStyle, b: MacroStyle): { rules: number; sources: number } {
  const ma = styleBaseline(a), mb = styleBaseline(b)
  let rules = 0, sources = 0
  for (const key of ALL_RULE_KEYS) {
    const ra = ruleOf(ma, key)!, rb = ruleOf(mb, key)!
    if (ra.source !== rb.source) sources++
    if (ra.source !== rb.source || ra.curve !== rb.curve || ra.smoothingMs !== rb.smoothingMs) rules++
  }
  return { rules, sources }
}

describe('风格表 styleBaseline / roleOf', () => {
  it('均衡档基线一字不差等于默认预设', () => {
    expect(styleBaseline('balanced')).toEqual(defaultRhythmPreset())
  })

  it('MACRO_STYLES 是四档，顺序为 均衡/节奏/氛围/低音', () => {
    expect(MACRO_STYLES.map((s) => s.id)).toEqual(['balanced', 'rhythmic', 'ambient', 'bass'])
    expect(MACRO_STYLES.map((s) => s.label)).toEqual(['均衡', '节奏', '氛围', '低音'])
  })

  it('风格差异自证：任意两档至少 3 条规则三元组不同、至少 1 条 source 不同', () => {
    const ids = MACRO_STYLES.map((s) => s.id)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = diffCount(ids[i], ids[j])
        expect(d.rules, `${ids[i]} vs ${ids[j]} 三元组差异条数`).toBeGreaterThanOrEqual(3)
        expect(d.sources, `${ids[i]} vs ${ids[j]} source 差异条数`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('speed 在三个非均衡档都换掉了 tempo（tempo 是常数，改它无画面反应）', () => {
    expect(ruleOf(styleBaseline('balanced'), 'body.speed.primary')!.source).toBe('tempo')
    for (const id of ['rhythmic', 'ambient', 'bass'] as MacroStyle[]) {
      expect(ruleOf(styleBaseline(id), 'body.speed.primary')!.source, id).not.toBe('tempo')
    }
  })

  it('风格表只改 source/curve/smoothingMs，不动 gain 与输出区间', () => {
    const base = defaultRhythmPreset()
    for (const id of MACRO_STYLES.map((s) => s.id)) {
      const m = styleBaseline(id)
      for (const key of ALL_RULE_KEYS) {
        const r = ruleOf(m, key)!, b = ruleOf(base, key)!
        expect(r.gain, `${id}/${key} gain`).toBe(b.gain)
        expect(r.enabled, `${id}/${key} enabled`).toBe(b.enabled)
        expect(r.outputMin, `${id}/${key} outputMin`).toBe(b.outputMin)
        expect(r.outputMax, `${id}/${key} outputMax`).toBe(b.outputMax)
        expect(r.inputMin, `${id}/${key} inputMin`).toBe(b.inputMin)
        expect(r.inputMax, `${id}/${key} inputMax`).toBe(b.inputMax)
      }
    }
  })

  it('角色划分覆盖全部 7 条规则，且 density 恒为中立（压低会让画面空掉）', () => {
    for (const id of MACRO_STYLES.map((s) => s.id)) {
      for (const key of ALL_RULE_KEYS) {
        expect(['lead', 'background', 'neutral']).toContain(roleOf(id, key))
      }
      expect(roleOf(id, 'body.density.primary'), id).toBe('neutral')
      // 每档都必须有主导和背景，否则劲儿退化成「全体放大」的老路
      expect(ALL_RULE_KEYS.some((k) => roleOf(id, k) === 'lead'), `${id} 需有主导`).toBe(true)
      expect(ALL_RULE_KEYS.some((k) => roleOf(id, k) === 'background'), `${id} 需有背景`).toBe(true)
    }
  })

  it('脉冲源只能落在 space.primary / brightness.primary（§5.1 架构约束的结构性守卫）：'
    + '其余槽位走 EnvelopeFollower，单帧脉冲会被吃掉', () => {
    const PULSE_SOURCES = new Set(['beat', 'downbeat', 'drop'])
    const PULSE_SAFE_KEYS = new Set<RuleKey>(['body.space.primary', 'body.brightness.primary'])
    for (const id of MACRO_STYLES.map((s) => s.id)) {
      const m = styleBaseline(id)
      for (const key of ALL_RULE_KEYS) {
        const source = ruleOf(m, key)!.source
        if (PULSE_SOURCES.has(source)) {
          expect(PULSE_SAFE_KEYS.has(key), `${id}/${key} source=${source}`).toBe(true)
        }
      }
    }
  })

  it('主导规则的 smoothing 基线 ≤ 666ms（保证跟手柔端 3× 不撞 2000ms 上限）', () => {
    for (const id of MACRO_STYLES.map((s) => s.id)) {
      const m = styleBaseline(id)
      for (const key of ALL_RULE_KEYS) {
        if (roleOf(id, key) !== 'lead') continue
        expect(ruleOf(m, key)!.smoothingMs, `${id}/${key}`).toBeLessThanOrEqual(666)
      }
    }
  })
})

describe('sanitizeMacroKnobs（含旧存档迁移）', () => {
  it('非对象/缺字段回退默认', () => {
    expect(sanitizeMacroKnobs(null)).toEqual(DEFAULT_MACRO_KNOBS)
    expect(sanitizeMacroKnobs({})).toEqual(DEFAULT_MACRO_KNOBS)
  })

  it('合法 style 原样采用，两标量夹 0..1', () => {
    expect(sanitizeMacroKnobs({ style: 'ambient', strength: 2, response: -1 }))
      .toEqual({ style: 'ambient', strength: 1, response: 0 })
  })

  it('旧存档无 style：按 character 位置换算成风格，不丢用户设置', () => {
    expect(sanitizeMacroKnobs({ character: 0.1, strength: 0.7, response: 0.3 }))
      .toEqual({ style: 'ambient', strength: 0.7, response: 0.3 })
    expect(sanitizeMacroKnobs({ character: 0.9, strength: 0.5, response: 0.5 }))
      .toEqual({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    expect(sanitizeMacroKnobs({ character: 0.5, strength: 0.5, response: 0.5 }))
      .toEqual({ style: 'balanced', strength: 0.5, response: 0.5 })
  })

  it('非法 style 仍回落到 character 推断（升级边缘情况也不丢设置）', () => {
    expect(sanitizeMacroKnobs({ style: 'nope', character: 0.9, strength: 0.5, response: 0.5 }).style)
      .toBe('rhythmic')
    expect(sanitizeMacroKnobs({ style: 'nope', strength: 0.5, response: 0.5 }).style)
      .toBe('balanced')
  })
})
