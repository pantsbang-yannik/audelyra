// 主体显隐的联动判定：背景/形状变化时是否要改写「显示主体」开关。零依赖纯函数——
// 所有背景与形状的写入都汇聚到 SettingsStore.set()，那里做唯一接线（见设计稿 §5）。
// 判定与副作用分离，故本模块可直测，也不必关心谁触发了变化。

/** 唯一内置背景 id。其余 current 值都指向 customBackgrounds 里的条目
 * （sanitizeBackgroundSettings 有回落纪律，不会出现孤儿引用） */
export const BUILTIN_BACKGROUND_ID = 'aurora'

/** 判定所需的三个标量——刻意不收整个 settings，保持零依赖易测 */
export interface BodyVisibilityInputs {
  backgroundCurrent: string
  shapeCurrent: string
  shapeCustomCurrent: string | null
}

/**
 * 返回需要写入的「显示主体」值；`null` = 本次变化不影响主体显隐，保持用户当前选择。
 *
 * 规则 B（换形状 ⇒ 开）优先于规则 A（切到自定义背景 ⇒ 关）：用户刚选了形状，
 * 是比「换了张背景」更直接的「我要看主体」信号。现实中两者不会同时发生
 * （选背景卡只写 background、选形状卡只写 shape），此处定序只为消除歧义。
 */
export function bodyVisibilityLink(prev: BodyVisibilityInputs, next: BodyVisibilityInputs): boolean | null {
  // 规则 B：任一形状 id 变化即视为「用户重新选了形状」。封面接管不写 settings、启动读盘不走 set()、
  // 拨封面优先不动这两个 id，故不会误触发（核实结果见设计稿 §5）
  if (next.shapeCurrent !== prev.shapeCurrent || next.shapeCustomCurrent !== prev.shapeCustomCurrent) return true

  // 规则 A：只在内置↔自定义之间跨越时动；自定义换自定义不动，保住用户手动开的主体
  const prevCustom = prev.backgroundCurrent !== BUILTIN_BACKGROUND_ID
  const nextCustom = next.backgroundCurrent !== BUILTIN_BACKGROUND_ID
  if (prevCustom === nextCustom) return null
  return !nextCustom
}

/**
 * 引擎判据：当前帧是否该隐藏五路主体。
 *
 * `skyPresent` = 内置极光天空实体是否还在。它有两种成因，必须区分对待：
 * 用的是内置背景（天经地义），或自定义背景**尚未真正上屏**（加载中 / 加载失败后自愈保留）。
 * 后者若还隐藏主体，会出现「主体没了、背景还没上来」的黑屏——加载失败时更是永久黑屏。
 * 这正是通用化之前那条 `!sky` 判据承担的自愈职责，改写后必须显式保留。
 */
export function isBodyConcealed(showBody: boolean, backgroundCurrent: string, skyPresent: boolean): boolean {
  if (showBody) return false
  const customBgPending = backgroundCurrent !== BUILTIN_BACKGROUND_ID && skyPresent
  return !customBgPending
}
