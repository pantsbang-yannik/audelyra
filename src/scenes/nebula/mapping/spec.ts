// 默认预设 + sanitize + 老存档迁移。spec §5.5/§5.6。
// 属性元数据（label/desc/白名单/平滑性格）已收敛进 types.ts 的 ELEMENT_PROPERTIES 目录，本文件不再重复声明。
import {
  AUDIO_FEATURES, ELEMENT_PROPERTIES, addressKey, isValidAddress, propertySpecAt,
  type AudioFeature, type MappingCurve, type MappingRule,
  type MappingValues, type Reaction, type TargetAddress,
} from './types'

export const GAIN_MAX = 2 // 收窄自 4：配合软限幅（CAP 1.25），保证滑块全行程都有可感增量；旧存档超界值由 sanitize 自动夹回
export const SMOOTHING_MAX_MS = 2000
const CURVES: MappingCurve[] = ['linear', 'ease', 'punch', 'softClip']
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** 用户手加反应的 id 前缀。官方基线反应不带此前缀——宏旋钮据此区分该不该重铺（见 macro.ts）。 */
export const USER_REACTION_PREFIX = 'u-'

export const isPresetReaction = (id: string): boolean => !id.startsWith(USER_REACTION_PREFIX)

let userIdSeq = 0

/** 发一个不在 taken 里的号。计数器只活在进程内，发出的 id 却会随存档持久化——
 * 重开应用后它从头再发一遍，必须对已有 id 查重才不会与旧存档撞号。 */
function nextUserReactionId(taken: Set<string>): string {
  let id: string
  do { id = `${USER_REACTION_PREFIX}${(++userIdSeq).toString(36)}` } while (taken.has(id))
  return id
}

/** 生成用户反应 id，跳过 `existing` 里已占用的号（不传即不查重，仅用于不涉及既有列表的场合）。
 * 不用 crypto.randomUUID：本 id 只需在**一份存档内**唯一，纯自增加查重即足够，
 * 且让纯逻辑模块保持零环境依赖、测试可确定性断言。 */
export function newUserReactionId(existing?: Iterable<{ id: string }>): string {
  const taken = new Set<string>()
  if (existing) for (const r of existing) taken.add(r.id)
  return nextUserReactionId(taken)
}

const DEFAULT_RULE: MappingRule = {
  enabled: true, source: 'energy', gain: 1, curve: 'linear', smoothingMs: 120,
  inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1,
}

const reaction = (
  id: string, target: TargetAddress, source: AudioFeature, over: Partial<MappingRule> = {},
): Reaction => ({ ...DEFAULT_RULE, id, target, source, ...over })

const body = (property: string): TargetAddress => ({ element: 'body', property })
const backdrop = (property: string): TargetAddress => ({ element: 'backdrop', property })

// spec §5.6 DefaultRhythmPreset：pulse/dynamics 审美判断落成默认值。
// id 形如 `body.space.primary`——沿用早期 `VisualTarget.slot` 的形状并补上元素前缀
// （补前缀是必须的：backdrop 也有 brightness，不带元素前缀会撞名）。
// 顺序即调音台渲染顺序：先 body 五属性（目录顺序），再 backdrop。
export const PRESET_REACTIONS: readonly Reaction[] = [
  reaction('body.speed.primary', body('speed'), 'tempo', { curve: 'linear', smoothingMs: 1000 }),
  reaction('body.density.primary', body('density'), 'energy', { curve: 'ease', smoothingMs: 500 }),
  reaction('body.space.primary', body('space'), 'beat', { curve: 'punch', smoothingMs: 60 }),
  reaction('body.space.secondary', body('space'), 'energy', { curve: 'ease', smoothingMs: 400 }),
  reaction('body.brightness.primary', body('brightness'), 'beat', { curve: 'punch', smoothingMs: 60 }),
  reaction('body.brightness.secondary', body('brightness'), 'high', { curve: 'linear', smoothingMs: 100 }),
  reaction('body.thickness.primary', body('thickness'), 'low', { curve: 'linear', smoothingMs: 100 }),
  // 背景显影（B1，设计稿 §十一）：默认开启但**幅度克制**——outputMin 0.45 而非 0。
  // 依据设计稿 §九红线「零配置路径的观感不得因创作功能变差」：老用户升级后背景仍须一眼认得出，
  // 只是安静段略去色压暗、副歌回到完整画面。想要更强的「从无到有」由用户自己把下限拉到 0。
  reaction('backdrop.develop.primary', backdrop('develop'), 'energy',
    { curve: 'ease', smoothingMs: 600, outputMin: 0.45 }),
]

export function defaultRhythmPreset(): MappingValues {
  return { version: 2, reactions: PRESET_REACTIONS.map((r) => ({ ...r, target: { ...r.target } })) }
}

/** 老存档（version 1）的目标名 → 现 body 属性名。两者同名，此处只做存在性校验。 */
const V1_TARGETS = ['speed', 'density', 'space', 'brightness', 'thickness'] as const

function sanitizeRule(raw: Record<string, unknown>, allowed: readonly AudioFeature[], def: MappingRule): MappingRule {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  // 非法 source → 回落白名单首项（而非整条丢弃）：保住用户在这条反应上调过的其余参数
  const source = allowed.includes(raw.source as AudioFeature)
    ? (raw.source as AudioFeature)
    : (allowed.includes(def.source) ? def.source : allowed[0])
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : def.enabled,
    source,
    curve: CURVES.includes(raw.curve as MappingCurve) ? (raw.curve as MappingCurve) : def.curve,
    gain: clamp(num(raw.gain, def.gain), 0, GAIN_MAX),
    smoothingMs: clamp(num(raw.smoothingMs, def.smoothingMs), 0, SMOOTHING_MAX_MS),
    inputMin: clamp(num(raw.inputMin, def.inputMin), 0, 1),
    inputMax: clamp(num(raw.inputMax, def.inputMax), 0, 1),
    outputMin: clamp(num(raw.outputMin, def.outputMin), 0, 1),
    outputMax: clamp(num(raw.outputMax, def.outputMax), 0, 1),
    ...(typeof raw.invert === 'boolean' ? { invert: raw.invert } : {}),
  }
}

/** 单条反应：地址非法 → 丢弃（返回 null）。
 * 不整套回落默认——一条坏数据不该毁掉用户其余全部反应；这与 version 头本身损坏是两种严重程度。 */
function sanitizeReaction(raw: unknown, seenIds: Set<string>): Reaction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const t = r.target as Record<string, unknown> | undefined
  if (typeof t !== 'object' || t === null) return null
  const target: TargetAddress = { element: String(t.element ?? ''), property: String(t.property ?? '') }
  if (!isValidAddress(target)) return null
  const spec = propertySpecAt(target)!

  // id 去重：两条同 id 会让宏旋钮的「按 id 认领」错乱。后来者改判为用户反应，保住其内容不丢。
  // 改判用的号同样要避开本轮已见的 id，与 UI 侧新增反应共用一套去重语义。
  let id = typeof r.id === 'string' && r.id.length > 0 ? r.id : nextUserReactionId(seenIds)
  if (seenIds.has(id)) id = nextUserReactionId(seenIds)
  seenIds.add(id)

  const preset = PRESET_REACTIONS.find((p) => p.id === id)
  const def = preset ?? { ...DEFAULT_RULE, source: spec.allowedSources[0] }
  return { id, target, ...sanitizeRule(r, spec.allowedSources, def) }
}

/** version 1（targets 字典）→ version 2（reactions 列表）。
 * ⚠️ 单向门：写过新存档后回退到老版本，老版本见 version !== 1 会整体回落默认预设。
 * 0.x 未发版阶段可接受，不另做双写。 */
function migrateV1(obj: Record<string, unknown>): MappingValues {
  const rawTargets = (typeof obj.targets === 'object' && obj.targets !== null ? obj.targets : {}) as Record<string, unknown>
  const reactions: Reaction[] = []
  const seen = new Set<string>()
  for (const t of V1_TARGETS) {
    const rawT = (typeof rawTargets[t] === 'object' && rawTargets[t] !== null ? rawTargets[t] : {}) as Record<string, unknown>
    for (const slot of ['primary', 'secondary'] as const) {
      const id = `body.${t}.${slot}`
      // 老存档没有的槽位（如 density.secondary）不凭空造：老版本压根不存在这条反应
      if (!PRESET_REACTIONS.some((p) => p.id === id)) continue
      // spread 一个非对象（缺失槽位）安全退化为空对象，缺的字段由 sanitizeReaction 按 preset 默认补齐
      const cleaned = sanitizeReaction({ ...(rawT[slot] as object), id, target: body(t) }, seen)
      if (cleaned) reactions.push(cleaned)
    }
  }
  // 背景反应在 v1 里不存在，按默认补齐——老用户升级后直接拿到 B1 显影
  for (const p of PRESET_REACTIONS) {
    if (p.target.element !== 'body' && !seen.has(p.id)) reactions.push({ ...p, target: { ...p.target } })
  }
  return { version: 2, reactions }
}

export function sanitizeMappingValues(raw: unknown): MappingValues {
  if (typeof raw !== 'object' || raw === null) return defaultRhythmPreset()
  const obj = raw as Record<string, unknown>
  if (obj.version === 1) return migrateV1(obj)
  if (obj.version !== 2 || !Array.isArray(obj.reactions)) return defaultRhythmPreset()
  const seen = new Set<string>()
  const reactions = obj.reactions
    .map((r) => sanitizeReaction(r, seen))
    .filter((r): r is Reaction => r !== null)
  // 允许空列表：用户有权删光所有反应（画面变静态是他的选择，不是坏数据）
  return { version: 2, reactions }
}

/** 某地址上已有的反应（按列表顺序）。调音台分组渲染与 mapper 合成都用它。 */
export function reactionsAt(m: MappingValues, target: TargetAddress): Reaction[] {
  const key = addressKey(target)
  return m.reactions.filter((r) => addressKey(r.target) === key)
}

/** 新建一条打向指定地址的用户反应：源取该属性白名单首项，其余走通用默认。
 * `existing` 传当前反应列表，新号即与列表内已有 id 查重（见 newUserReactionId）。 */
export function makeReaction(target: TargetAddress, existing?: Iterable<{ id: string }>): Reaction {
  const spec = propertySpecAt(target)
  if (!spec) throw new Error(`非法地址：${addressKey(target)}`)
  return { ...DEFAULT_RULE, id: newUserReactionId(existing), target: { ...target }, source: spec.allowedSources[0] }
}

// 目录完备性自检（模块加载即执行，成本可忽略）：白名单里若出现不存在的 AudioFeature，
// 会在调音台上表现为「选了没反应」的死件，比抛错难查得多。
for (const [element, props] of Object.entries(ELEMENT_PROPERTIES)) {
  for (const [property, spec] of Object.entries(props)) {
    for (const f of spec.allowedSources) {
      if (!AUDIO_FEATURES.includes(f)) throw new Error(`属性目录 ${element}.${property} 的白名单含未知信号：${f}`)
    }
  }
}
