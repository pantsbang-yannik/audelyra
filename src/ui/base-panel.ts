// 面板基座（Phase A2 T2）：设置/调音台共用的外壳与交互——右侧停靠 + 顶部固定标题栏（不随内容
// 滚动消失）+ 可滚动内容区，从上往下排列。交互三件套：document pointerdown capture 点外部关
// （延迟一个宏任务挂监听，防触发开关那次点击自关）、Esc capture 关、ignoreOutsideClickWithin（数组）
// 排除触发源（操作坞图标落在忽略区内的 pointerdown 不关面板，图标自身 toggle() 独立干净处理
// 开关——Task A-toggle-fix：原先靠 suppressNextToggle 标志 + setTimeout(0) 抑制 pointerdown→click
// 竞态，但真实浏览器里两者常跨宏任务，标志会被抢先清除导致面板关不掉，故改为从源头排除触发区）。
// 开合只对外广播 onOpenChange——是否互斥/是否驱动退台，一律交给 PanelCoordinator 决定，
// BasePanel 自己不知道协调器的存在（关注点分离）。
import type { UiFocusProfile } from '../scenes/types'

export interface BasePanelOptions {
  id: string
  title: string
  retreatProfile: UiFocusProfile
}

const CLOSE_TRANSITION_MS = 500
const FONT = `-apple-system, "SF Pro Display", sans-serif`

export class BasePanel {
  /** 面板退台画风——协调器 register 时默认读取本值，驱动共享的 UiStage */
  readonly retreatProfile: UiFocusProfile
  /** 内容挂载点：子类/消费者往这里加行，容器另有独立的 sticky 标题栏 */
  protected readonly content: HTMLElement
  /** 固定区：标题栏与滚动内容之间的不滚动段（tab 栏等常驻控件挂这里，随标题一起固定） */
  private readonly fixedRegion: HTMLElement

  private readonly container: HTMLElement
  /** 场景暗幕（亲验反馈轮②）：面板开启时窗口右侧从左往右渐入黑，可读性来自舞台侧幕布——
   * 面板本身保持素净（用户明确不要卡片式容器）；pointer-events:none 不挡舞台交互 */
  private readonly scrim: HTMLElement
  private open_ = false
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  /** 延迟到下一宏任务才挂 pointerdown 监听——触发开关的那次 dock 点击，其 pointerdown
   * 早于 click（面板在 click 里才 open），理论上不会自关；这里再加一层保险防边缘情况（同 A3） */
  private outsideClickTimer: ReturnType<typeof setTimeout> | null = null

  /** 开合回调——协调器 register 时接管，驱动互斥与退台路由；未注册时为 no-op */
  onOpenChange: ((open: boolean) => void) | null = null
  /** 忽略区：点在此容器内视为「点了触发源」，不算点外部——排除操作坞图标本身，
   * 让图标自己的 click→toggle() 独立干净处理开关（PanelCoordinator.setTriggerContainers 注入） */
  ignoreOutsideClickWithin: HTMLElement[] = []

  private onKey = (e: KeyboardEvent): void => {
    if (!this.open_) return
    if (e.key === 'Escape') {
      // stopPropagation 只拦渲染层内部其它 keydown 监听器，不跨进程；真正仲裁靠主进程 uiModalOpen 门控
      e.stopPropagation()
      this.close()
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.open_) return
    const target = e.target as Node | null
    if (this.container.contains(target) || this.ignoreOutsideClickWithin.some((c) => c.contains(target))) return
    this.close()
  }

  constructor(parent: HTMLElement, opts: BasePanelOptions) {
    this.retreatProfile = opts.retreatProfile

    this.container = document.createElement('div')
    this.container.id = opts.id
    this.container.style.cssText = `
      position: fixed;
      right: 2vw;
      top: 8vh;
      max-height: 84vh;
      width: 320px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      opacity: 0;
      filter: blur(6px);
      visibility: hidden;
      transition: opacity 500ms cubic-bezier(0.33, 1, 0.68, 1),
                  filter 500ms cubic-bezier(0.33, 1, 0.68, 1);
      font-family: ${FONT};
      font-weight: 300;
      letter-spacing: 0.06em;
      font-size: 13px;
    `

    this.scrim = document.createElement('div')
    this.scrim.style.cssText = `
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(44vw, 560px);
      background: linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.38) 45%, rgba(0, 0, 0, 0.66) 78%, rgba(0, 0, 0, 0.74) 100%);
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 500ms cubic-bezier(0.33, 1, 0.68, 1);
    `

    // sticky 标题栏：字号略大于正文、更亮，底部一条极浅白线，随容器固定不随内容滚动消失
    const header = document.createElement('div')
    header.textContent = opts.title
    header.style.cssText = `
      position: sticky;
      top: 0;
      flex: none;
      padding: 0 4px 10px;
      font-size: 15px;
      color: rgba(255, 255, 255, 0.7);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    `

    // 固定区：紧贴标题栏下方、滚动内容之上的不滚动段（flex:none 与标题栏同为固定段，非 overflow 区）
    this.fixedRegion = document.createElement('div')
    this.fixedRegion.style.cssText = 'flex: none; padding: 0 4px;' // 水平内边距对齐标题栏/内容区

    this.content = document.createElement('div')
    this.content.style.cssText = `
      overflow-y: auto;
      padding: 10px 4px 4px;
      line-height: 2.6;
    `

    this.container.appendChild(header)
    this.container.appendChild(this.fixedRegion)
    this.container.appendChild(this.content)
    parent.appendChild(this.scrim) // 先挂先画：幕布垫在面板之下
    parent.appendChild(this.container)
  }

  /** 供子类往内容区加行（标题栏之外，从上往下排列） */
  protected appendRow(el: HTMLElement): void {
    this.content.appendChild(el)
  }

  /** 供子类往固定区加控件（tab 栏等）：随标题栏固定，不随内容滚动 */
  protected appendFixed(el: HTMLElement): void {
    this.fixedRegion.appendChild(el)
  }

  get isOpen(): boolean {
    return this.open_
  }

  toggle(): void {
    if (this.open_) this.close()
    else this.open()
  }

  open(): void {
    if (this.open_) return
    this.open_ = true
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.container.style.visibility = 'visible'
    this.container.style.opacity = '1'
    this.container.style.filter = 'blur(0)'
    this.container.style.pointerEvents = 'auto'
    this.scrim.style.visibility = 'visible'
    this.scrim.style.opacity = '1'
    document.addEventListener('keydown', this.onKey, true) // capture 阶段登记，理由见 onKey 内注释
    if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer)
    this.outsideClickTimer = setTimeout(() => {
      this.outsideClickTimer = null
      if (this.open_) document.addEventListener('pointerdown', this.onPointerDown, true)
    }, 0)
    this.onOpenChange?.(true)
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    this.container.style.opacity = '0'
    this.container.style.filter = 'blur(6px)'
    this.container.style.pointerEvents = 'none' // 淡出期不挡舞台交互，与 opacity 同刻收，不等 hideTimer
    this.scrim.style.opacity = '0'
    this.hideTimer = setTimeout(() => {
      this.container.style.visibility = 'hidden'
      this.scrim.style.visibility = 'hidden'
      this.hideTimer = null
    }, CLOSE_TRANSITION_MS)
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    if (this.outsideClickTimer) {
      clearTimeout(this.outsideClickTimer)
      this.outsideClickTimer = null
    }
    this.onOpenChange?.(false)
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer)
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    this.onOpenChange = null
    this.scrim.remove()
    this.container.remove()
  }
}
