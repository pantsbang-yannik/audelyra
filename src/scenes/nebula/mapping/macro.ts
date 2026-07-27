// 标准层宏旋钮 → 专业表投影。对「形状」完全无知（同 mapper.ts 分层铁律）：只吞吐 MappingValues。
// 三控件正交——风格换「跟什么信号」（source/curve/响应基线），劲儿拉主导与背景的对比度，
// 跟手只缩放主导的响应快慢。均衡档 + 两旋钮居中恒等于默认预设。
// 劲儿走对比度而非全体放大：curves.softLimit 的 CAP=1.25 会把放大吃掉大半（gain 1→2 仅涨 25%），
// 而压低背景不受任何天花板限制，动态范围才是观感差异的真正来源。
import { defaultRhythmPreset, isPresetReaction, GAIN_MAX, SMOOTHING_MAX_MS } from './spec'
import type { AudioFeature, BodyProperty, MappingCurve, MappingValues, Reaction } from './types'

export type MacroStyle = 'balanced' | 'rhythmic' | 'ambient' | 'bass'
export type RuleSlot = 'primary' | 'secondary'
/** 宏旋钮只认领**主体**的官方基线反应 id。背景显影等其余反应一律中立、不受旋钮影响——
 * 三个旋钮（风格/劲儿/跟手）的语义都是「主体律动」，扩到背景会让「劲儿」变成看不懂的全局开关。 */
export type RuleKey = `body.${BodyProperty}.${RuleSlot}`
/** 规则在某风格里承担的角色：主导承载风格特征、背景被压以突出主导、中立不受劲儿缩放 */
export type RuleRole = 'lead' | 'background' | 'neutral'

/** 风格按钮的显示顺序与文案（UI 直接消费） */
export const MACRO_STYLES: ReadonlyArray<{ id: MacroStyle; label: string }> = [
  { id: 'balanced', label: '均衡' },
  { id: 'rhythmic', label: '节奏' },
  { id: 'ambient', label: '氛围' },
  { id: 'bass', label: '低音' },
]

/** 风格只覆盖「跟什么信号、什么曲线、多快响应」三项；gain 与输出区间一律沿用默认预设 */
type RuleOverride = { source?: AudioFeature; curve?: MappingCurve; smoothingMs?: number }
interface StyleDef {
  overrides: Partial<Record<RuleKey, RuleOverride>>
  lead: readonly RuleKey[]
  background: readonly RuleKey[]
}

// 未列入 lead/background 的规则即中立。density.primary 恒中立：它决定画面「有多少东西」，
// 压到背景倍数会让画面空掉，属会被误判为「坏了」的退化。
const STYLE_DEFS: Record<MacroStyle, StyleDef> = {
  // 均衡＝现行默认预设，一字不改；老用户升级后观感不变
  balanced: {
    overrides: {},
    lead: ['body.space.primary', 'body.brightness.primary'],
    background: ['body.space.secondary', 'body.brightness.secondary'],
  },
  // 节奏：空间/亮度靠 primary 的 beat 冲量咬拍，其余规则用「连续量 + 快响应 + punch」逼近顿挫感。
  // 脉冲源（beat/downbeat/drop）只在 space.primary / brightness.primary 有效——其余槽位走
  // EnvelopeFollower，单帧脉冲的响应系数仅 1-exp(-dt/tau)（tau=200ms 时 0.08），会被吃干净。
  rhythmic: {
    overrides: {
      'body.space.secondary': { curve: 'punch', smoothingMs: 200 },
      'body.density.primary': { curve: 'punch', smoothingMs: 200 },
      'body.speed.primary': { source: 'energy', curve: 'punch', smoothingMs: 200 },
    },
    lead: ['body.space.primary', 'body.brightness.primary', 'body.speed.primary', 'body.thickness.primary'],
    background: ['body.space.secondary', 'body.brightness.secondary'],
  },
  // 氛围：全身跟响度与能量的连续起伏，无脉冲尖峰 → 连绵呼吸
  ambient: {
    overrides: {
      'body.space.primary': { source: 'energy', curve: 'ease', smoothingMs: 300 },
      'body.space.secondary': { smoothingMs: 800 },
      'body.brightness.primary': { source: 'loudness', curve: 'ease', smoothingMs: 250 },
      'body.brightness.secondary': { smoothingMs: 150 },
      'body.density.primary': { smoothingMs: 700 },
      'body.thickness.primary': { source: 'energy', curve: 'ease', smoothingMs: 300 },
      'body.speed.primary': { source: 'loudness', curve: 'linear', smoothingMs: 600 },
    },
    lead: ['body.space.primary', 'body.brightness.primary', 'body.speed.primary', 'body.thickness.primary'],
    background: ['body.space.secondary', 'body.brightness.secondary'],
  },
  // 低音：空间与厚度跟低频泵动，其余跟能量（亮度/密度/速度的白名单里没有 low）
  bass: {
    overrides: {
      'body.space.primary': { source: 'low', curve: 'punch', smoothingMs: 120 },
      'body.brightness.primary': { source: 'energy', curve: 'ease', smoothingMs: 200 },
      'body.thickness.primary': { curve: 'punch' },
      'body.speed.primary': { source: 'energy', curve: 'linear', smoothingMs: 600 },
    },
    lead: ['body.space.primary', 'body.thickness.primary', 'body.brightness.primary', 'body.speed.primary'],
    background: ['body.space.secondary', 'body.brightness.secondary'],
  },
}

/** 按 id 取官方基线反应；不存在（如 density.secondary，或被用户删掉了）返回 null */
function ruleAt(m: MappingValues, key: RuleKey): Reaction | null {
  return m.reactions.find((r) => r.id === key) ?? null
}

/** 风格基线：默认预设套上该档的 source/curve/smoothing 覆盖。均衡档返回值深度等于 defaultRhythmPreset() */
export function styleBaseline(style: MacroStyle): MappingValues {
  const out = defaultRhythmPreset()
  for (const [key, over] of Object.entries(STYLE_DEFS[style].overrides) as Array<[RuleKey, RuleOverride]>) {
    const rule = ruleAt(out, key)
    if (!rule) continue
    if (over.source !== undefined) rule.source = over.source
    if (over.curve !== undefined) rule.curve = over.curve
    if (over.smoothingMs !== undefined) rule.smoothingMs = over.smoothingMs
  }
  return out
}

export function roleOf(style: MacroStyle, key: RuleKey): RuleRole {
  const def = STYLE_DEFS[style]
  if (def.lead.includes(key)) return 'lead'
  if (def.background.includes(key)) return 'background'
  return 'neutral'
}

export interface MacroKnobs {
  style: MacroStyle // 风格：换整套信号源与曲线基线
  strength: number  // 劲儿：主导/背景对比度 0..1
  response: number  // 跟手：主导规则的响应快慢 0..1（小=脆快、大=柔慢）
}

export const DEFAULT_MACRO_KNOBS: MacroKnobs = { style: 'balanced', strength: 0.5, response: 0.5 }

const STYLE_IDS: ReadonlySet<string> = new Set(MACRO_STYLES.map((s) => s.id))

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** 旧存档（三旋钮版）没有 style，按 character 的位置换算成风格，不丢用户设置。
 * 非法 style 也回落到 character 推断，覆盖「升级途中写坏了 style」的边缘情况。
 * 仅覆盖开发期存档——三旋钮版从未发布，生产环境走不到 character 分支，但开发分支上的本地存档要救，故保留。 */
function migrateStyle(r: Record<string, unknown>): MacroStyle {
  if (typeof r.style === 'string' && STYLE_IDS.has(r.style)) return r.style as MacroStyle
  if (typeof r.character === 'number' && Number.isFinite(r.character)) {
    if (r.character < 0.35) return 'ambient'
    if (r.character > 0.65) return 'rhythmic'
  }
  return 'balanced'
}

export function sanitizeMacroKnobs(raw: unknown): MacroKnobs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_MACRO_KNOBS }
  const r = raw as Record<string, unknown>
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : d
  return {
    style: migrateStyle(r),
    strength: num(r.strength, DEFAULT_MACRO_KNOBS.strength),
    response: num(r.response, DEFAULT_MACRO_KNOBS.response),
  }
}

// —— 投影标定常量：中点=1，两端按「两端可辨、避免饱和」标定 ——
// 主导 gain 倍数：0→0.25×，0.5→1×，1→1.5×（1.5 < GAIN_MAX=2，不饱和）。
// 下限取 0.25 而非 0.6：主导+背景的和在 0.6 处仍深陷 softLimit 压缩区（KNEE=0.9），
// 克制端与中点的画面差异只有 1.5%＝左半程死滑块。rangeFactor(0.5,·) 对任意 min 恒为 1，中点不变量不受影响。
const LEAD_GAIN_MIN = 0.25, LEAD_GAIN_MAX = 1.5
const BG_GAIN_MIN = 0.25                        // 背景 gain 倍数：前半段恒 1×，后半段降到 0.25×
const RESPONSE_MIN = 0.2, RESPONSE_MAX = 3.0    // 主导 smoothing 倍数：0→0.2×，0.5→1×，1→3×

// 中点 0.5 → 1，两端线性到 [min, max]
const rangeFactor = (v: number, min: number, max: number): number =>
  v <= 0.5 ? min + (1 - min) * (v / 0.5) : 1 + (max - 1) * ((v - 0.5) / 0.5)

/** 背景 gain 倍数：前半段恒 1（克制端的语义是「主导变弱」，不是「背景变强」），后半段线性降到 BG_GAIN_MIN */
const bgFactor = (s: number): number =>
  s <= 0.5 ? 1 : 1 + (BG_GAIN_MIN - 1) * ((s - 0.5) / 0.5)

/** 宏旋钮投影。
 *
 * `current` 决定「重铺哪些反应」——反应可增删之后，这个参数不是可选优化而是防数据丢失的必需品：
 * - 传了 current（调音台实际应用旋钮时）：**只重铺 current 里仍存在的官方基线反应**，
 *   用户手加的反应（`u-` 前缀）原样保留、位置不变；用户删掉的官方反应也不复活。
 *   没有这一条，拖一下旋钮就会把用户写的反应全删了。
 * - 不传 current（判定「专业表是否已被手改」时）：返回完整基线，
 *   于是「加了一条反应」「删了一条基线反应」都会被判为已手改——这是诚实的，
 *   旋钮位置确实不再能完整描述当前画面。
 */
export function macroToMapping(k: MacroKnobs, current?: MappingValues): MappingValues {
  const baseline = styleBaseline(k.style)
  const leadGain = rangeFactor(k.strength, LEAD_GAIN_MIN, LEAD_GAIN_MAX)
  const backGain = bgFactor(k.strength)
  const leadSmooth = rangeFactor(k.response, RESPONSE_MIN, RESPONSE_MAX)

  const projected = (r: Reaction): Reaction => {
    const role = roleOf(k.style, r.id as RuleKey)
    // 中立规则（如 density、背景显影）两项都不缩放：density 决定画面「有多少东西」，压低会让画面空掉
    const g = role === 'lead' ? leadGain : role === 'background' ? backGain : 1
    const s = role === 'lead' ? leadSmooth : 1
    return {
      ...r,
      gain: clamp(r.gain * g, 0, GAIN_MAX),
      smoothingMs: clamp(r.smoothingMs * s, 0, SMOOTHING_MAX_MS),
    }
  }

  if (!current) return { version: 2, reactions: baseline.reactions.map(projected) }

  return {
    version: 2,
    reactions: current.reactions.map((r) => {
      if (!isPresetReaction(r.id)) return r // 用户手加的：原样保留，旋钮不碰
      const base = ruleAt(baseline, r.id as RuleKey)
      return base ? projected(base) : r // 基线里没有这个 id（不该发生）：保守保留原值
    }),
  }
}
