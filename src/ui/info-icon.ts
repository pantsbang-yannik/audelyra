import { attachTooltip } from './tooltip'

/** feather "info" 图标——低调小 ⓘ，只用来挂解释 tooltip，不参与任何交互/状态 */
const INFO_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'

const IDLE_OPACITY = 0.28
const HOVER_OPACITY = 0.6

export interface InfoIcon {
  el: HTMLElement
  /** 摘除 tooltip 节点（attachTooltip 的 cleanup）+ 卸掉自挂的提亮监听——
   * 面板重建（buildRuleRows 前 drain）/ dispose 时调用，防 document.body 孤儿化 tooltip 节点 */
  dispose: () => void
}

/**
 * 面板内联信息图标——取代原先直白铺开的解释文字行，hover 才显影 tooltip。
 * tooltip 固定朝上弹（'top' placement，行内 ⓘ 上方留白足够，朝上不易被相邻行遮挡）。
 * 图标气质低调：默认 0.28 透明度，hover 提亮到 0.6，跟面板既有弱存在感的标签风格协调。
 * 返回 { el, dispose }——同 corner-cluster/control-dock 的 tooltip cleanup 约定，调用方负责在重建/销毁时 drain。
 */
export function makeInfoIcon(text: string): InfoIcon {
  const el = document.createElement('span')
  el.innerHTML = INFO_SVG
  el.style.cssText = `
    pointer-events: auto;
    cursor: help;
    display: inline-flex;
    align-items: center;
    margin-left: 6px;
    transition: color 200ms;
  `
  // 颜色单独赋值（不走 cssText 字符串块）——同 control-dock.ts 的 hover 换色惯例，
  // 便于测试桩直接读取 style.color，浏览器里效果与写进 cssText 等价
  el.style.color = `rgba(255, 255, 255, ${IDLE_OPACITY})`
  const onEnter = (): void => { el.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})` }
  const onLeave = (): void => { el.style.color = `rgba(255, 255, 255, ${IDLE_OPACITY})` }
  el.addEventListener('mouseenter', onEnter)
  el.addEventListener('mouseleave', onLeave)
  const tooltipCleanup = attachTooltip(el, text, 'top')
  const dispose = (): void => {
    tooltipCleanup()
    el.removeEventListener('mouseenter', onEnter)
    el.removeEventListener('mouseleave', onLeave)
  }
  return { el, dispose }
}
