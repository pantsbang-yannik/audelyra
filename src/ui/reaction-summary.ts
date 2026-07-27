// 反应摘要行的文案计算——零 DOM 纯逻辑（仓库惯例：纯逻辑抽离 + 薄壳接线）。
//
// 「只浮出改过的参数」的判定基准是**当前宏旋钮投影出的官方基线**，不是出厂默认值：
// 宏旋钮本就会重铺所有官方反应的 gain 与 smoothingMs，若拿出厂默认当基准，
// 用户拖一下「劲儿」会让满屏反应同时浮出数字，折叠就白做了。取宏旋钮基线，
// 语义才是用户真正想知道的「我逐条手动动过哪些」。
import type { AudioFeature, Reaction } from '../scenes/nebula/mapping/types'

/** 来源（AudioFeature 英文枚举）→ 中文显示。只在显示层生效，底层一律走英文枚举。 */
export const SOURCE_LABELS: Record<AudioFeature, string> = {
  beat: '鼓点', downbeat: '重拍', low: '低频', mid: '中频', high: '高频',
  energy: '能量', drop: '爆点', loudness: '响度', silence: '静默', tempo: '节奏速度',
}

/** 摘要行的判定基准。
 * official=官方反应，与投影基线逐字段比；user=用户手加（基线里没有），常驻显示关键项；
 * pending=宏旋钮尚未播种，无从判定 ⇒ 保持安静（播种是亚毫秒级，用户够不着）。 */
export type SummaryBaseline =
  | { kind: 'official'; reaction: Reaction }
  | { kind: 'user' }
  | { kind: 'pending' }

export interface ReactionSummary {
  /** 来源中文名——恒显示。来源被改过时此处自然就变了，不必另计偏离 */
  source: string
  /** 该条被关掉：整行降透明度，并在摘要行标「已关」。
   * 「已关」与偏离项是两段独立信息——关掉不吞掉用户手调过的强度/平滑/上下限，
   * 否则折叠态会丢信息：重新打开这条之前，用户无从知道自己在里面动过什么 */
  disabled: boolean
  /** 偏离项文案，按 强/滑/下限/上限 定序；无偏离为空数组 */
  deltas: string[]
}

const fmtGain = (v: number): string => `强 ${v.toFixed(2)}`
const fmtSmooth = (v: number): string => `滑 ${Math.round(v)}ms`
const fmtMin = (v: number): string => `下限 ${v.toFixed(2)}`
const fmtMax = (v: number): string => `上限 ${v.toFixed(2)}`

/** 用户手加反应的下限/上限参照值——与 spec.ts 的 DEFAULT_RULE 同值。
 * 不 import 是刻意的：这里要的是「显示层认为什么算平凡」，与规则层默认值同源但不耦合，
 * 将来 DEFAULT_RULE 若因引擎需要而变，摘要行的取舍应独立复核。 */
const PLAIN_OUTPUT_MIN = 0
const PLAIN_OUTPUT_MAX = 1

/** 比格式化结果而非数值：宏旋钮投影出的是任意浮点，用户拖出的是 step 对齐值，
 * 直接比数值必然被浮点尾差污染；且偏离若小于显示精度，浮出来的数字与基线看起来一样，纯属噪声。 */
const differs = (a: number, b: number, fmt: (v: number) => string): boolean => fmt(a) !== fmt(b)

export function summarizeReaction(r: Reaction, baseline: SummaryBaseline): ReactionSummary {
  const source = SOURCE_LABELS[r.source]
  const deltas: string[] = []
  if (baseline.kind === 'official') {
    const b = baseline.reaction
    if (differs(r.gain, b.gain, fmtGain)) deltas.push(fmtGain(r.gain))
    if (differs(r.smoothingMs, b.smoothingMs, fmtSmooth)) deltas.push(fmtSmooth(r.smoothingMs))
    if (differs(r.outputMin, b.outputMin, fmtMin)) deltas.push(fmtMin(r.outputMin))
    if (differs(r.outputMax, b.outputMax, fmtMax)) deltas.push(fmtMax(r.outputMax))
  } else if (baseline.kind === 'user') {
    // 基线里没有对应项，无从比较 ⇒ 关键两项常驻，下限/上限仍按「是否平凡」决定显隐
    deltas.push(fmtGain(r.gain), fmtSmooth(r.smoothingMs))
    if (differs(r.outputMin, PLAIN_OUTPUT_MIN, fmtMin)) deltas.push(fmtMin(r.outputMin))
    if (differs(r.outputMax, PLAIN_OUTPUT_MAX, fmtMax)) deltas.push(fmtMax(r.outputMax))
  }
  // kind === 'pending'：保持安静
  return { source, disabled: !r.enabled, deltas }
}

/** 摘要行的两段文案。
 * lead=主段（来源名；已关时并上「已关」，那是这条反应的状态而非参数注解）；
 * note=注解段（偏离项串，项间用 ` · ` 分隔），无偏离为空串。
 * 分两段是为了让 UI 把注解渲染得比主段淡一档——注解不是主角。 */
export function summarySegments(s: ReactionSummary): { lead: string; note: string } {
  const lead = s.disabled ? `${s.source}  已关` : s.source
  if (s.deltas.length === 0) return { lead, note: '' }
  // 已关时「已关」已在主段末尾，注解接着它同列一串（` · `）；未关时用双空格与来源名拉开
  return { lead, note: `${s.disabled ? ' · ' : '  '}${s.deltas.join(' · ')}` }
}
