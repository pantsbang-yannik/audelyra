// 试音模式的按键引导条：画面下方居中的一条，不属于任何面板——
// 试音是个**独立模式**（同星系图鉴：有自己的进出），调音台开着就是边调边试，关着就是纯感受画面反应。
//
// 为什么不放调音台里：验证反应时眼睛要盯着画面，按钮却在右侧面板最底下，视线得来回跳；
// 律动页本身也已经挤（页首说明 + 宏旋钮卡片 + 高级折叠 + 规则行）。放画面下方 = 手在键盘、眼在画面、提示在旁边。
//
// 信号合成在 audition/audition-pad.ts，音效在 audition/pad-sound.ts，本文件只管样子与手势。
//
// 视觉纪律：容器规格照搬 PlayerBar（同为底部浮层），内部只有「浅色文字 + 更浅的键位后缀」，
// 无边框无底色无动效——克制到退回背景里，与「放歌就好看、不用按键」的产品气质一致。
import { AUDITION_PADS, type PadId } from '../audition/audition-pad'

export interface AuditionBarDeps {
  onTrigger: (id: PadId) => void
  /** 点「退出」或按 Esc——接线侧据此退出试音模式（交还信号流、恢复 PlayerBar 等） */
  onExit: () => void
}

const FONT = `-apple-system, "PingFang SC", sans-serif`
const EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'
// 容器规格照搬 PlayerBar（同为底部浮层）：同款底色/边框/毛玻璃/字重字距，两者不该长得像两个产品。
// bottom 64px 抬到操作坞（bottom 24px + 图标 18px）之上，两者不叠；
// z-index 与 PlayerBar 同层（9995）——试音期间 PlayerBar 被压制，不会同时在场
const BAR_STYLE = `position: fixed; bottom: 64px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: baseline; gap: 16px; max-width: min(88vw, 680px); flex-wrap: wrap;
  justify-content: center; padding: 9px 16px; border-radius: 8px; background: rgba(20, 26, 36, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.08); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  font: 300 13px ${FONT}; letter-spacing: 0.04em;
  opacity: 0; filter: blur(6px); pointer-events: none; z-index: 9995;
  transition: opacity 400ms ${EASE}, filter 400ms ${EASE};`

const COLOR_IDLE = 'rgba(255, 255, 255, 0.45)' // 操作坞图标同款常态
const COLOR_HOVER = 'rgba(255, 255, 255, 0.85)' // 操作坞图标同款 hover

// 视觉一律走「白 + 透明度」层级（全仓设计语言：装饰性彩色一处都没有，
// 淡蓝 rgba(160,200,255) 是「激活/选中」的专用语义色，不可挪作装饰）。
// 亦无任何 @keyframes——全仓显隐统一是 opacity + filter 的 transition，
// 引导条只在试音时在场，它的存在本身就是状态指示，不需要动效去强调。
const LABEL_STYLE = 'flex: none; font-size: 12px; color: rgba(255, 255, 255, 0.35);' // 0.35=提示语气（同沉睡提示）
/** pad = 纯文字，无边框无底色。交互语言与操作坞图标同款：0.45 常态 → 0.85 hover */
const PAD_STYLE = `flex: none; cursor: pointer; user-select: none; font-size: 12px;
  color: ${COLOR_IDLE}; transition: color 150ms ease;`
/** 键位后缀：opacity 而非独立 color，父元素提亮时跟着走（照搬 tooltip 的 shortcut 后缀样式） */
const KEY_STYLE = 'opacity: 0.55; margin-left: 6px; font-size: 11px; letter-spacing: 0.08em;'
const EXIT_STYLE = `flex: none; margin-left: 4px; cursor: pointer; user-select: none;
  font-size: 12px; color: ${COLOR_IDLE}; transition: color 150ms ease;`

/** 按下反馈走文字提亮而非背景块——与全仓「图标 hover 提亮」同一套手法，不引入新的视觉元素 */
const COLOR_FLASH = 'rgba(255, 255, 255, 0.95)'
/** 提亮回落时长——与 transition 同量级，手感是「敲一下」而非「亮着」 */
const FLASH_MS = 150

export class AuditionBar {
  readonly el: HTMLElement
  private readonly buttons = new Map<PadId, HTMLElement>()
  private readonly flashTimers = new Map<PadId, ReturnType<typeof setTimeout>>()
  private shown = false
  private keyHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(parent: HTMLElement, private deps: AuditionBarDeps) {
    this.el = document.createElement('div')
    this.el.setAttribute('data-role', 'audition-bar')
    this.el.style.cssText = BAR_STYLE

    const label = document.createElement('span')
    label.setAttribute('data-role', 'audition-label')
    label.textContent = '试音'
    label.style.cssText = LABEL_STYLE
    this.el.appendChild(label)

    for (const p of AUDITION_PADS) {
      const b = document.createElement('span')
      b.setAttribute('data-role', `audition-pad-${p.id}`)
      b.style.cssText = PAD_STYLE
      const name = document.createElement('span')
      name.textContent = p.label
      const key = document.createElement('span')
      key.textContent = p.key
      key.style.cssText = KEY_STYLE
      b.append(name, key)
      // 键盘是加速器，但按钮必须可点——不能强迫习惯鼠标的人改用键盘
      b.addEventListener('click', () => this.fire(p.id))
      b.addEventListener('mouseenter', () => { if (!this.flashTimers.has(p.id)) b.style.color = COLOR_HOVER })
      b.addEventListener('mouseleave', () => { if (!this.flashTimers.has(p.id)) b.style.color = COLOR_IDLE })
      this.buttons.set(p.id, b)
      this.el.appendChild(b)
    }

    // 「退出 Esc」与 pad 的「鼓点 A」完全同构——条内只有一种语法（名称 + 键位后缀），
    // 顺带把快捷键教给用户。不用 PlayerBar 的 SVG ✕：那会在纯文字条里插进唯一一个图标元素
    const exit = document.createElement('span')
    exit.setAttribute('data-role', 'audition-exit')
    exit.style.cssText = EXIT_STYLE
    const exitLabel = document.createElement('span')
    exitLabel.textContent = '退出'
    const exitKey = document.createElement('span')
    exitKey.textContent = 'Esc'
    exitKey.style.cssText = KEY_STYLE
    exit.append(exitLabel, exitKey)
    exit.addEventListener('click', () => this.deps.onExit())
    exit.addEventListener('mouseenter', () => { exit.style.color = COLOR_HOVER })
    exit.addEventListener('mouseleave', () => { exit.style.color = COLOR_IDLE })
    this.el.appendChild(exit)

    this.applyVisibility() // 初始隐去态也走显式属性写，不只依赖 cssText 里的初值
    parent.appendChild(this.el)
  }

  get isShown(): boolean {
    return this.shown
  }

  /** 进入试音模式：显形并挂键盘加速键 */
  show(): void {
    if (this.shown) return
    this.shown = true
    this.applyVisibility()
    this.keyHandler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return // 让路给全局快捷键（⌘⇧S 海报 / ⌘⇧R Drop / ⌘⇧T 调音台）
      // Esc 退出（同星系图鉴惯例）。面板开着时收不到此事件——base-panel 在 capture 阶段
      // stopPropagation 后自己关闭，于是 Esc 天然是「先关面板，面板都关了才退试音」，无需额外仲裁。
      // ⚠️ 该行为依赖 base-panel.onKey 的 stopPropagation，改那里前先想清楚这条
      if (e.key === 'Escape') { e.preventDefault(); this.deps.onExit(); return }
      // 文本输入里不劫持单键（为反应命名等后续输入留的防线）；range 滑块**不**排除——
      // 「在调音台拖完滑块、焦点还在它身上，立刻按 A 验」是本模式最常见的路径
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (t?.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') return
      const pad = AUDITION_PADS.find((p) => p.key === e.key.toUpperCase())
      if (!pad) return
      e.preventDefault()
      this.fire(pad.id)
    }
    window.addEventListener('keydown', this.keyHandler)
  }

  /** 退出试音模式：隐去并卸键盘加速键（不卸的话别的界面上 A/S/D 还在打鼓） */
  hide(): void {
    if (!this.shown) return
    this.shown = false
    this.applyVisibility()
    this.detachKeys()
    for (const [id, t] of this.flashTimers) {
      clearTimeout(t)
      const b = this.buttons.get(id)
      if (b) b.style.color = COLOR_IDLE // 退出时收干净，下次进来不残留提亮
    }
    this.flashTimers.clear()
  }

  private applyVisibility(): void {
    this.el.style.opacity = this.shown ? '1' : '0'
    this.el.style.filter = this.shown ? 'blur(0)' : 'blur(6px)'
    this.el.style.pointerEvents = this.shown ? 'auto' : 'none'
  }

  private detachKeys(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler)
    this.keyHandler = null
  }

  private fire(id: PadId): void {
    if (!this.shown) return // 隐去期（淡出 400ms）pointerEvents 已收，此为逻辑防线
    this.deps.onTrigger(id)
    const b = this.buttons.get(id)
    if (!b) return
    b.style.color = COLOR_FLASH
    const prev = this.flashTimers.get(id)
    if (prev) clearTimeout(prev) // 连击重置计时，否则前一次的回落会把提亮提前掐掉
    this.flashTimers.set(id, setTimeout(() => {
      b.style.color = COLOR_IDLE
      this.flashTimers.delete(id)
    }, FLASH_MS))
  }

  dispose(): void {
    this.detachKeys()
    for (const t of this.flashTimers.values()) clearTimeout(t)
    this.flashTimers.clear()
    this.el.remove()
  }
}
