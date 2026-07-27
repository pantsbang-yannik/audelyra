// 形状选择器（Phase B2）：底部卡片层——点操作坞「形状」图标 → 镜头拉远（camera 退台，协调器驱动）
// → 底部错峰浮现形状卡片。非右侧停靠面板故不继承 BasePanel，但实现 PanelCoordinator 的
// PanelLike 结构契约（retreatProfile/onOpenChange/ignoreOutsideClickWithin[]/close），
// 交互三件套（Esc capture / 点外部关 / 淡出）自担——镜像 base-panel.ts 的既有实现语义。
import type { UiFocusProfile } from '../scenes/types'
import type { ShapeSettings } from '../scenes/nebula/shapes/types'
import { SHAPES } from '../scenes/nebula/shapes'
import type { ShapeId } from '../scenes/nebula/shapes/types'
import { CUSTOM_SHAPES_MAX, type CustomShapeMeta } from '../scenes/nebula/shapes/types'
import type { BackgroundSettings, CustomBackgroundMeta } from '../scenes/nebula/background-types'
import { CUSTOM_BACKGROUNDS_MAX } from '../scenes/nebula/background-types'
import { ToggleSwitch } from './toggle-switch'

type PickerTab = 'shape' | 'background'

export interface ShapePickerDeps {
  getShape: () => Promise<ShapeSettings>
  setShape: (s: ShapeSettings) => void
  onShapeChanged: (cb: (s: ShapeSettings) => void) => void
  /** 开合视觉副作用通道（协调器占用 onOpenChange，压制角标/提示走这里） */
  onOpenStateChanged?: (open: boolean) => void
  /** 收藏卡缩略图取原始字节（image 卡异步填充 src；text 卡不调用）——idea #12 */
  readCustomShapeImage?: (id: string) => Promise<Uint8Array>
  /** 删卡时清对应文件，fire-and-forget（settings 才是权威，孤儿文件无害）——idea #12 */
  deleteCustomShapeFile?: (id: string) => void
  /** "+"卡点击且未满员 → main.ts 打开创建面板（Task 7 接真身，本任务占位） */
  onCreateRequest?: () => void
  /** "+"卡点击且已满员 → 提示态（Task 7 接真身，本任务占位） */
  showHint?: (text: string) => void
  // ===== 自定义背景 v1（背景 tab）=====
  getBackground: () => Promise<BackgroundSettings>
  setBackground: (b: BackgroundSettings) => void
  onBackgroundChanged: (cb: (b: BackgroundSettings) => void) => void
  /** 背景收藏卡缩略图取原始字节（异步填充 src）——镜像 readCustomShapeImage；图片卡专用通道 */
  readCustomBackgroundImage?: (id: string) => Promise<Uint8Array>
  /** 视频背景卡缩略图取原始字节（v2）：视频主文件是视频字节，<img> 显示不了，走独立缩略图通道 */
  readCustomBackgroundThumb?: (id: string) => Promise<Uint8Array>
  /** 删背景卡时清对应文件，fire-and-forget（settings 才是权威，孤儿文件无害） */
  deleteCustomBackgroundFile?: (id: string) => void
  /** 背景"+"卡点击且未满员 → main.ts 弹系统文件选择 */
  onBackgroundCreateRequest?: () => void
  /** 卡片编辑钮（v2 亲验反馈②）：先选中该卡再回调，main.ts 打开调音台直落对应页 */
  onEditRequest?: (tab: 'shape' | 'background') => void
}

const CLOSE_TRANSITION_MS = 500
const FONT = `-apple-system, "SF Pro Display", sans-serif`

/** 形状剪影（viewBox 0 0 38 38，stroke 虚线=粒子暗示；与操作坞图标同视觉语言）。
 * Partial：序幕专属形体（demoOnly）不进卡片列，无需剪影 */
const SILHOUETTES: Partial<Record<ShapeId, string>> = {
  nebula:
    '<circle cx="16" cy="14" r="2.6" fill="currentColor" stroke="none" opacity=".9"/>' +
    '<circle cx="24" cy="20" r="2" fill="currentColor" stroke="none" opacity=".7"/>' +
    '<circle cx="10" cy="22" r="1.8" fill="currentColor" stroke="none" opacity=".6"/>' +
    '<circle cx="20" cy="9" r="1.5" fill="currentColor" stroke="none" opacity=".5"/>' +
    '<circle cx="30" cy="13" r="1.4" fill="currentColor" stroke="none" opacity=".45"/>' +
    '<circle cx="27" cy="26" r="1.3" fill="currentColor" stroke="none" opacity=".4"/>',
  heart:
    '<path d="M19 9 C 16 6, 11 7, 10 12 C 9 18, 12 26, 18 31 C 24 27, 29 20, 28 13 C 27.5 8, 22 6, 20 10 Z" stroke-dasharray="2.5 2.5"/>' +
    '<path d="M16 6 L 16 10 M 21 5 L 20.5 9 M 25 7 L 23.5 10" stroke-dasharray="1.5 2" opacity=".6"/>',
  spectrum:
    '<circle cx="19" cy="19" r="9" stroke-dasharray="2.5 3"/>' +
    '<path d="M19 7 L19 4 M27.5 10.5 L29.6 8.4 M31 19 L34 19 M27.5 27.5 L29.6 29.6 M19 31 L19 34 M10.5 27.5 L8.4 29.6 M7 19 L4 19 M10.5 10.5 L8.4 8.4" stroke-dasharray="none" opacity=".65"/>',
  waveform:
    '<path d="M6 16.5 L6 21.5 M9 14 L9 24 M12 17 L12 21 M15 10 L15 28 M18 13.5 L18 24.5 M21 7.5 L21 30.5 M24 15 L24 23 M27 11.5 L27 26.5 M30 16 L30 22 M33 17.5 L33 20.5" stroke-dasharray="none"/>',
  eclipse:
    '<circle cx="19" cy="19" r="6.5" fill="currentColor" stroke="none" opacity=".85"/>' +
    '<circle cx="19" cy="19" r="9.5" stroke-dasharray="1.5 2.5" opacity=".7"/>' +
    '<path d="M3 19 L6.5 16 L9 21.5 L11.5 17 L13 19 M25 19 L26.5 16.5 L29 21.5 L31.5 15.5 L35 19" stroke-dasharray="none" opacity=".8"/>',
  ledmatrix:
    '<path d="M7 7h4v4H7z M17 7h4v4h-4z M27 7h4v4h-4z M7 17h4v4H7z M27 17h4v4h-4z M7 27h4v4H7z M17 27h4v4h-4z M27 27h4v4h-4z" stroke-dasharray="none" opacity=".75"/>' +
    '<path d="M19 3 L19 35 M3 19 L35 19" stroke-dasharray="1.5 2.5" opacity=".6"/>',
  laser:
    '<path d="M19 4 L8 34 M19 4 L15 34 M19 4 L23 34 M19 4 L30 34" stroke-dasharray="none" opacity=".85"/>' +
    '<path d="M4 28 L15 34 M34 28 L23 34" stroke-dasharray="none" opacity=".5"/>',
}

const CARD_STAGGER_MS = 70 // 错峰浮现间隔（spec 拍板 60–80ms 取中值）
/** 头排两枚胶囊（tab 组 / 封面开关）的统一视觉规范（亲验②拍板：同行同规范）：深底/细边/全圆角/毛玻璃/12px */
const PILL_CSS = `
  display: flex;
  align-items: center;
  padding: 6px 16px;
  border-radius: 20px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
  font-size: 12px;
`
const ACTIVE_BORDER = '1px solid rgba(160, 200, 255, 0.85)'
const ACTIVE_GLOW = '0 0 14px rgba(120, 170, 255, 0.35)'
const IDLE_BORDER = '1px solid rgba(255, 255, 255, 0.12)'

/** 星空极光默认卡剪影（viewBox 0 0 38 38，同视觉语言：虚线弧=极光带，圆点=星野） */
const AURORA_SILHOUETTE =
  '<path d="M5 24 C 11 14, 15 26, 21 16 C 26 8, 30 18, 34 12" stroke-dasharray="2.5 2.5"/>' +
  '<path d="M4 30 C 10 22, 16 32, 22 24 C 27 17, 31 26, 35 21" stroke-dasharray="1.5 3" opacity=".5"/>' +
  '<circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" opacity=".7"/>' +
  '<circle cx="17" cy="6" r=".8" fill="currentColor" stroke="none" opacity=".5"/>' +
  '<circle cx="28" cy="8" r=".9" fill="currentColor" stroke="none" opacity=".6"/>'

export class ShapePicker {
  readonly retreatProfile: UiFocusProfile = 'camera'
  onOpenChange: ((open: boolean) => void) | null = null
  ignoreOutsideClickWithin: HTMLElement[] = []

  private readonly container: HTMLElement
  private readonly scrim: HTMLElement // 底部黑渐变暗幕（亲验反馈：保菜单可读性），开合随 open/close
  /** 形状状态：getShape 播种 + onShapeChanged 回流（Task 3 起消费） */
  protected shape: ShapeSettings | null = null
  private open_ = false
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private outsideClickTimer: ReturnType<typeof setTimeout> | null = null
  private headerRow: HTMLElement | null = null
  private pillRow: HTMLElement | null = null
  private coverToggle: ToggleSwitch | null = null
  private cardRow: HTMLElement | null = null
  /** 内置卡键=ShapeId，收藏卡键=uuid，"+"卡键='__plus'——统一 string 键，open/close 的错峰遍历自动覆盖新卡 */
  private cards = new Map<string, HTMLElement>()
  /** 收藏卡（image 种类）异步填充的缩略图 objectURL：卡移除/dispose 时 revoke，防内存泄漏 */
  private thumbUrls = new Map<string, string>()

  // ===== 背景 tab（自定义背景 v1）=====
  private pickerTab: PickerTab = 'shape'
  private tabRow: HTMLElement | null = null
  private shapeTabEl: HTMLElement | null = null
  private bgTabEl: HTMLElement | null = null
  private bgCardRow: HTMLElement | null = null
  private bg: BackgroundSettings | null = null
  /** 背景卡键：'aurora' / uuid / '__bg_plus'（与形状 cards 分开两张 map，错峰遍历两边都走） */
  private bgCards = new Map<string, HTMLElement>()
  private bgThumbUrls = new Map<string, string>()

  private onKey = (e: KeyboardEvent): void => {
    if (!this.open_) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      this.close()
    }
  }

  /** 滚轮纵滚→横滚：现服务两行（形状/背景卡行）——读 currentTarget 而非固定 this.cardRow */
  private onWheel = (e: WheelEvent): void => {
    const row = e.currentTarget as HTMLElement | null
    if (!row) return
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    row.scrollLeft += d
    e.preventDefault()
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.open_) return
    const target = e.target as Node | null
    if (this.container.contains(target) || this.ignoreOutsideClickWithin.some((c) => c.contains(target))) return
    this.close()
  }

  constructor(parent: HTMLElement, private deps: ShapePickerDeps) {
    // 底部暗幕（亲验反馈：保菜单可读性）：自下而上黑渐变垫在卡片层之下，开合随 open/close 淡入淡出
    // ——语义对齐 BasePanel 的右侧暗幕（调音台同款体验），方向改竖向、先挂先画垫底
    this.scrim = document.createElement('div')
    this.scrim.setAttribute('data-role', 'picker-scrim')
    this.scrim.style.cssText = `
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: min(46vh, 420px);
      background: linear-gradient(to top, rgba(0, 0, 0, 0.78) 0%, rgba(0, 0, 0, 0.55) 42%, rgba(0, 0, 0, 0.22) 72%, rgba(0, 0, 0, 0) 100%);
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 500ms cubic-bezier(0.33, 1, 0.68, 1);
    `
    // 初始隐藏态显式属性写（FakeEl 不解析 cssText，容器同款纪律）
    this.scrim.style.visibility = 'hidden'
    this.scrim.style.opacity = '0'
    this.scrim.style.pointerEvents = 'none'
    parent.appendChild(this.scrim)

    this.container = document.createElement('div')
    this.container.id = 'shape-picker'
    this.container.style.cssText = `
      position: fixed;
      left: 0;
      right: 0;
      bottom: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 500ms cubic-bezier(0.33, 1, 0.68, 1);
      font-family: ${FONT};
      font-weight: 300;
      letter-spacing: 0.06em;
    `
    // 初始隐藏态用显式属性写入（不只靠 cssText）——真实 DOM 语义相同，
    // 且 tests/ui 的 fakeElement stub 不解析 cssText，只认属性写（既有测试基建约束）
    this.container.style.visibility = 'hidden'
    this.container.style.pointerEvents = 'none'
    this.container.style.opacity = '0'
    parent.appendChild(this.container)

    void deps.getShape().then((s) => {
      this.shape = s
      this.rebuild()
    })
    deps.onShapeChanged((s) => {
      this.shape = s
      this.rebuild() // 回流兜底：双入口（调音台/本选择器）状态必然一致
    })

    void deps.getBackground().then((b) => {
      this.bg = b
      this.rebuildBg()
    })
    deps.onBackgroundChanged((b) => {
      this.bg = b
      this.rebuildBg() // 回流兜底：拖放入藏/删除的状态与卡片列必然一致
    })
  }

  /** 重建内容（播种/回流时调用）。头排（tab 靠左 + 封面胶囊靠右，亲验②拍板同行同视觉）+ 卡片行 + 高亮态跟随 this.shape */
  protected rebuild(): void {
    if (!this.shape) return
    if (!this.headerRow) {
      // 头排与卡片行同宽对齐：tab 落在卡片列左缘、胶囊落在右缘（space-between）
      this.headerRow = document.createElement('div')
      this.headerRow.setAttribute('data-role', 'picker-header')
      this.headerRow.style.cssText = `
        box-sizing: border-box;
        width: min(92vw, 1040px);
        padding: 0 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      `
      this.root.appendChild(this.headerRow)
    }
    if (!this.tabRow) {
      this.tabRow = this.buildTabRow()
      this.headerRow.appendChild(this.tabRow)
    }
    if (!this.pillRow) {
      this.pillRow = document.createElement('div')
      this.pillRow.style.cssText = PILL_CSS + `
        gap: 10px;
        color: rgba(255, 255, 255, 0.75);
      `
      const label = document.createElement('span')
      label.textContent = '有封面时优先显示封面粒子'
      this.pillRow.appendChild(label)
      const toggleHost = document.createElement('span')
      this.pillRow.appendChild(toggleHost)
      this.coverToggle = new ToggleSwitch(toggleHost, {
        checked: this.shape.coverPriority,
        onChange: (v) => {
          if (!this.shape) return
          this.shape = { ...this.shape, coverPriority: v }
          this.deps.setShape(this.shape)
        },
      })
      this.headerRow.appendChild(this.pillRow)
    }
    if (!this.cardRow) {
      this.cardRow = document.createElement('div')
      this.cardRow.style.cssText = `
        display: flex;
        gap: 14px;
        justify-content: flex-start;
        overflow-x: auto;
        overflow-y: hidden;
        max-width: min(92vw, 1040px);
        padding: 4px 20px;
        scrollbar-width: none;
        -webkit-mask-image: linear-gradient(90deg, transparent 0, black 28px, black calc(100% - 28px), transparent 100%);
        mask-image: linear-gradient(90deg, transparent 0, black 28px, black calc(100% - 28px), transparent 100%);
      `
      // 被测样式显式属性写（fakeElement 不解析 cssText，shape-picker.ts:98-101 同款约束）
      this.cardRow.style.overflowX = 'auto'
      // 滚轮纵滚→横滚：卡片行是页面上唯一横向滚动域，无嵌套滚动冲突
      this.cardRow.addEventListener('wheel', this.onWheel)
      this.root.appendChild(this.cardRow)
      for (const def of SHAPES) {
        if (def.demoOnly) continue // 序幕专属形体不进卡片列（发布准备③）
        this.cardRow.appendChild(this.makeCard(def.id, def.label))
      }
    }
    this.rebuildCustomCards()
    this.paintActive()
    this.coverToggle?.setChecked(this.shape.coverPriority)
    this.applyTabVisibility()
    // 背景区首次建造需要复制 cardRow 的布局 cssText，故等形状区先建好；若背景已播种但背景区尚未
    // 建过（两条 seed 各自异步、到达顺序不定），这里顺带补建——避免两条 seed 互相踩全量重建
    // （形状/背景卡各自的收藏卡churn与图片二次拉取相互独立，是本设计的关键正确性点）
    if (this.bg && !this.bgCardRow) this.rebuildBg()
  }

  /** 背景区重建入口（bg 播种/回流触发）：只碰背景卡行，不重跑形状区（避免无关事件互相churn 收藏卡） */
  private rebuildBg(): void {
    // 背景卡行复制形状卡行布局需等其建好；cardRow 存在即意味着 rebuild() 已跑过，tabRow 必已建好
    if (!this.bg || !this.cardRow) return
    if (!this.bgCardRow) {
      this.bgCardRow = document.createElement('div')
      this.bgCardRow.style.cssText = this.cardRow.style.cssText // 与形状卡行同款横滚布局
      this.bgCardRow.style.overflowX = 'auto'
      this.bgCardRow.addEventListener('wheel', this.onWheel)
      this.root.appendChild(this.bgCardRow)
    }
    this.rebuildBgCards()
    this.applyTabVisibility()
    this.paintBgActive()
  }

  /** 收藏区（收藏卡 + "+"卡）每次 rebuild 全量重建——内置 10 卡与 pillRow 维持首次建造不动 */
  private rebuildCustomCards(): void {
    if (!this.shape || !this.cardRow) return
    // 先清旧收藏卡/"+"卡：从 cards 摘除 + DOM 移除 + revoke 其缩略图 objectURL（内置 10 卡键不动）
    const builtinIds = new Set<string>(SHAPES.map((d) => d.id))
    for (const [key, card] of [...this.cards]) {
      if (builtinIds.has(key)) continue
      card.remove()
      this.cards.delete(key)
      const url = this.thumbUrls.get(key)
      if (url) {
        URL.revokeObjectURL(url)
        this.thumbUrls.delete(key)
      }
    }
    // 既有回流测试送半量 ShapeSettings（无 customShapes 字段）：按空数组兜底，不炸
    for (const meta of this.shape.customShapes ?? []) this.cardRow.appendChild(this.makeCustomCard(meta))
    this.cardRow.appendChild(this.makePlusCard())
  }

  /** 编辑铅笔钮（v2 亲验反馈②：所有内容卡 hover 渐显）：绝对定位右上，带×的卡传 right=32 排在×左侧。
   * 选中语义在调用侧闭包（编辑=先切换该卡再开调音台，用户拍板）；stopPropagation 防触发卡片本体点击 */
  private attachEditBtn(card: HTMLElement, right: number, onClick: () => void): void {
    card.style.position = 'relative' // 内置卡原无定位锚点（自定义卡已有，重复赋值无害）
    const btn = document.createElement('div')
    btn.setAttribute('data-role', 'card-edit')
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 3 l4 4 L8 20 H4 v-4 z"/></svg>`
    btn.style.cssText = `
      position: absolute;
      top: 6px;
      right: ${right}px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      color: rgba(255, 255, 255, 0.85);
      cursor: pointer;
    `
    btn.style.opacity = '0' // 渐显与×同款（显式属性写，FakeEl 断言锚）
    card.addEventListener('mouseenter', () => { btn.style.opacity = '1' })
    card.addEventListener('mouseleave', () => { btn.style.opacity = '0' })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    card.appendChild(btn)
  }

  private makeCard(id: ShapeId, label: string): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-shape-id', id)
    card.style.cssText = `
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: ${IDLE_BORDER};
      backdrop-filter: blur(10px);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      opacity: 0;
      transform: translateY(16px);
      transition: opacity 320ms cubic-bezier(0.33, 1, 0.68, 1),
                  transform 320ms cubic-bezier(0.33, 1, 0.68, 1),
                  border-color 200ms, box-shadow 200ms;
    `
    const preview = document.createElement('div')
    preview.style.cssText = `
      width: 104px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
    `
    preview.innerHTML = `<svg viewBox="0 0 38 38" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.3">${SILHOUETTES[id] ?? ''}</svg>`
    const name = document.createElement('span')
    name.textContent = label
    card.appendChild(preview)
    card.appendChild(name)
    // 乐观选中（B1 终审 B2 注意项）：点卡即高亮，落盘回流到达后 rebuild 再校正（权威源）
    // 点内置卡视为退出自定义选中态：customCurrent 归 null（选中语义 activeKey = customCurrent ?? current）
    const select = (): void => {
      if (!this.shape) return
      this.shape = { ...this.shape, current: id, customCurrent: null }
      this.deps.setShape(this.shape)
      this.paintActive()
    }
    card.addEventListener('click', select)
    this.attachEditBtn(card, 6, () => { select(); this.deps.onEditRequest?.('shape') })
    this.cards.set(id, card)
    return card
  }

  /** 收藏卡：文字卡显示原文（居中两行截断），图片卡异步拉缩略图；点击选中/右上角×删除 */
  private makeCustomCard(meta: CustomShapeMeta): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-shape-id', meta.id)
    card.style.cssText = `
      position: relative;
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: ${IDLE_BORDER};
      backdrop-filter: blur(10px);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      opacity: 1;
      transform: translateY(0);
    `
    const preview = document.createElement('div')
    preview.style.cssText = `
      width: 104px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      overflow: hidden;
    `
    if (meta.kind === 'text') {
      const textEl = document.createElement('div')
      textEl.textContent = meta.text ?? ''
      textEl.style.cssText = `
        font-size: 15px;
        text-align: center;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        padding: 0 8px;
      `
      preview.appendChild(textEl)
    } else {
      const img = document.createElement('img')
      img.style.cssText = `
        width: 104px;
        height: 88px;
        border-radius: 8px;
        object-fit: cover;
      `
      preview.appendChild(img)
      // 异步拉缩略图字节 → objectURL 填 src；失败留占位背景不报错（设计取舍：v1 无重试/无错误态）。
      // dep 显式守卫而非可选链：读法一目了然，dep 缺失时留占位背景（与失败态同一兜底）
      const read = this.deps.readCustomShapeImage
      if (read) {
        void read(meta.id).then((bytes) => {
          // IPC 传回的 Uint8Array 类型标注为 ArrayBufferLike（TS 5.7+ 已知泛型冲突，见
          // custom-shapes.ts 的 decodePngToImageData 同款注释）：裁剪出精确字节范围再断言 ArrayBuffer 是安全的
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const url = URL.createObjectURL(new Blob([buf]))
          // stale 判定：字节读回时本卡已被 rebuild 摘换/删除 → revoke 自己直接退场（不写 map、不碰 img），
          // 防止跨 rebuild 并发的旧回调覆盖新卡状态
          if (this.cards.get(meta.id) !== card) {
            URL.revokeObjectURL(url)
            return
          }
          // 同 key 旧 URL 先 revoke 再落新值：保证任何时刻同 key 至多一个存活 objectURL（防泄漏）
          const prev = this.thumbUrls.get(meta.id)
          if (prev) URL.revokeObjectURL(prev)
          this.thumbUrls.set(meta.id, url)
          img.src = url
        }).catch(() => {
          // 占位背景已由 preview 的默认背景色兜底，无需额外处理
        })
      }
    }
    const name = document.createElement('span')
    name.textContent = meta.kind === 'text' ? '文字' : '图片'
    name.style.cssText = `
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
    `
    card.appendChild(preview)
    card.appendChild(name)

    const deleteBtn = document.createElement('div')
    deleteBtn.textContent = '×'
    deleteBtn.style.cssText = `
      position: absolute;
      top: 6px;
      right: 6px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      color: rgba(255, 255, 255, 0.85);
      font-size: 14px;
      cursor: pointer;
    `
    deleteBtn.style.opacity = '0'
    card.addEventListener('mouseenter', () => { deleteBtn.style.opacity = '1' })
    card.addEventListener('mouseleave', () => { deleteBtn.style.opacity = '0' })
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!this.shape) return
      const next = {
        ...this.shape,
        customShapes: this.shape.customShapes.filter((m) => m.id !== meta.id),
        customCurrent: this.shape.customCurrent === meta.id ? null : this.shape.customCurrent,
      }
      this.shape = next
      this.deps.setShape(next) // 删除当前显示的 → customCurrent=null → 仲裁回内置/free（spec：回落星云由 current 兜底）
      this.deps.deleteCustomShapeFile?.(meta.id) // 文件清理 fire-and-forget：settings 才是权威，孤儿文件无害
      this.rebuild()
    })
    card.appendChild(deleteBtn)

    const select = (): void => {
      if (!this.shape) return
      this.shape = { ...this.shape, customCurrent: meta.id }
      this.deps.setShape(this.shape)
      this.paintActive()
    }
    card.addEventListener('click', select)
    this.attachEditBtn(card, 32, () => { select(); this.deps.onEditRequest?.('shape') }) // ×占右上6px位,编辑排其左
    this.cards.set(meta.id, card)
    return card
  }

  /** "+"卡：满员时提示而非打开创建面板（v1 无重命名/编辑，见 brief 设计取舍） */
  private makePlusCard(): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-shape-id', '__plus')
    card.style.cssText = `
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px dashed rgba(255, 255, 255, 0.25);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.6);
      font-size: 13px;
      opacity: 1;
      transform: translateY(0);
    `
    const plus = document.createElement('span')
    plus.textContent = '+'
    plus.style.cssText = `font-size: 32px; font-weight: 200;`
    const label = document.createElement('span')
    label.textContent = '创建'
    label.style.cssText = `font-size: 12px; color: rgba(255, 255, 255, 0.5);`
    card.appendChild(plus)
    card.appendChild(label)
    card.addEventListener('click', () => {
      if (this.shape && (this.shape.customShapes ?? []).length >= CUSTOM_SHAPES_MAX) this.deps.showHint?.('收藏已满，先删一个')
      else this.deps.onCreateRequest?.()
    })
    this.cards.set('__plus', card)
    return card
  }

  private paintActive(): void {
    if (!this.shape) return
    const activeKey = this.shape.customCurrent ?? this.shape.current
    for (const [id, card] of this.cards) {
      if (id === '__plus') continue // "+"卡永不 active，边框固定虚线，不受选中态影响
      const active = id === activeKey
      card.style.border = active ? ACTIVE_BORDER : IDLE_BORDER
      card.style.boxShadow = active ? ACTIVE_GLOW : ''
    }
  }

  // ===== 背景 tab（自定义背景 v1）=====

  /** tab 行（自定义背景 v1）：形状/背景两枚，高亮=亮字（卡片层更轻，无下划线）；胶囊视觉走 PILL_CSS 统一规范 */
  private buildTabRow(): HTMLElement {
    const row = document.createElement('div')
    row.setAttribute('data-role', 'picker-tabs')
    row.style.cssText = PILL_CSS + `
      gap: 22px;
    `
    const make = (text: string, tab: PickerTab): HTMLElement => {
      const el = document.createElement('span')
      el.textContent = text
      el.setAttribute('data-role', `picker-tab-${tab}`)
      el.style.cursor = 'pointer'
      el.addEventListener('click', () => this.showTab(tab))
      return el
    }
    this.shapeTabEl = make('形状', 'shape')
    this.bgTabEl = make('背景', 'background')
    row.append(this.shapeTabEl, this.bgTabEl)
    return row
  }

  private showTab(tab: PickerTab): void {
    this.pickerTab = tab
    this.applyTabVisibility()
  }

  /** 切 tab 只做显隐（惯例同调音台 showTab）：三行全程留在 DOM，收藏回流环不因切换重建 */
  private applyTabVisibility(): void {
    const shape = this.pickerTab === 'shape'
    // 封面胶囊藏用 visibility 而非 display（亲验反馈：开关胶囊比 tab 胶囊略高，display:none 抽走占位
    // 会让头排行高塌缩、tab 随之轻微位移——visibility 隐形但保留占位，行高恒定 tab 不动）
    if (this.pillRow) this.pillRow.style.visibility = shape ? 'visible' : 'hidden'
    if (this.cardRow) this.cardRow.style.display = shape ? 'flex' : 'none'
    if (this.bgCardRow) this.bgCardRow.style.display = shape ? 'none' : 'flex'
    if (this.shapeTabEl) this.shapeTabEl.style.color = `rgba(255, 255, 255, ${shape ? 0.95 : 0.5})`
    if (this.bgTabEl) this.bgTabEl.style.color = `rgba(255, 255, 255, ${shape ? 0.5 : 0.95})`
  }

  /** 背景卡列全量重建：星空极光默认卡 + 收藏卡 + "+"卡。极光卡键固定 'aurora' 也每次重建（列小，简单优先） */
  private rebuildBgCards(): void {
    if (!this.bg || !this.bgCardRow) return
    for (const [key, card] of [...this.bgCards]) {
      card.remove()
      this.bgCards.delete(key)
      const url = this.bgThumbUrls.get(key)
      if (url) { URL.revokeObjectURL(url); this.bgThumbUrls.delete(key) }
    }
    this.bgCardRow.appendChild(this.makeAuroraCard())
    for (const meta of this.bg.customBackgrounds ?? []) this.bgCardRow.appendChild(this.makeBgCustomCard(meta))
    this.bgCardRow.appendChild(this.makeBgPlusCard())
  }

  /** 星空极光默认卡：永不可删（不是收藏，是内置源），点击选中 current:'aurora' */
  private makeAuroraCard(): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-bg-id', 'aurora')
    card.style.cssText = `
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: ${IDLE_BORDER};
      backdrop-filter: blur(10px);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      opacity: 1;
      transform: translateY(0);
    `
    const preview = document.createElement('div')
    preview.style.cssText = `
      width: 104px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
    `
    preview.innerHTML = `<svg viewBox="0 0 38 38" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.3">${AURORA_SILHOUETTE}</svg>`
    const name = document.createElement('span')
    name.textContent = '星空极光'
    card.appendChild(preview)
    card.appendChild(name)
    const select = (): void => {
      if (!this.bg) return
      this.bg = { ...this.bg, current: 'aurora' } // 乐观选中，落盘回流 rebuild 校正（权威源）
      this.deps.setBackground(this.bg)
      this.paintBgActive()
    }
    card.addEventListener('click', select)
    this.attachEditBtn(card, 6, () => { select(); this.deps.onEditRequest?.('background') })
    this.bgCards.set('aurora', card)
    return card
  }

  /** 背景收藏卡：图片异步拉缩略图；点击选中/右上角×删除——镜像 makeCustomCard 的图片分支 + objectURL 三条纪律 */
  private makeBgCustomCard(meta: CustomBackgroundMeta): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-bg-id', meta.id)
    card.style.cssText = `
      position: relative;
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: ${IDLE_BORDER};
      backdrop-filter: blur(10px);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      opacity: 1;
      transform: translateY(0);
    `
    const preview = document.createElement('div')
    preview.style.cssText = `
      width: 104px;
      height: 88px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      overflow: hidden;
    `
    const img = document.createElement('img')
    img.style.cssText = `
      width: 104px;
      height: 88px;
      border-radius: 8px;
      object-fit: cover;
    `
    preview.appendChild(img)
    // 异步拉缩略图字节 → objectURL 填 src；失败留占位背景不报错（同 makeCustomCard 的取舍）。
    // dep 显式守卫而非可选链：读法一目了然，dep 缺失时留占位背景（与失败态同一兜底）
    // 视频卡走缩略图通道（主文件是视频字节，<img> 显示不了）；图片卡沿用原图字节通道
    const read = meta.kind === 'video' ? this.deps.readCustomBackgroundThumb : this.deps.readCustomBackgroundImage
    if (read) {
      void read(meta.id).then((bytes) => {
        // 裁剪出精确字节范围再断言 ArrayBuffer：同 makeCustomCard 的 TS 5.7+ 泛型冲突兜底
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const url = URL.createObjectURL(new Blob([buf]))
        // stale 判定：字节读回时本卡已被 rebuild 摘换/删除 → revoke 自己直接退场，防跨 rebuild 并发覆盖
        if (this.bgCards.get(meta.id) !== card) {
          URL.revokeObjectURL(url)
          return
        }
        // 同 key 旧 URL 先 revoke 再落新值：保证任何时刻同 key 至多一个存活 objectURL（防泄漏）
        const prev = this.bgThumbUrls.get(meta.id)
        if (prev) URL.revokeObjectURL(prev)
        this.bgThumbUrls.set(meta.id, url)
        img.src = url
      }).catch(() => {
        // 占位背景已由 preview 的默认背景色兜底，无需额外处理
      })
    }
    const name = document.createElement('span')
    // 显示原文件名（亲验反馈：多卡可辨）；v2 前存量无 name 回落类型词，单行截断省略号防撑破卡宽
    name.textContent = meta.name || (meta.kind === 'video' ? '视频' : '图片')
    name.style.cssText = `
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
      max-width: 112px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `
    card.appendChild(preview)
    card.appendChild(name)

    const deleteBtn = document.createElement('div')
    deleteBtn.textContent = '×'
    deleteBtn.style.cssText = `
      position: absolute;
      top: 6px;
      right: 6px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      color: rgba(255, 255, 255, 0.85);
      font-size: 14px;
      cursor: pointer;
    `
    deleteBtn.style.opacity = '0'
    card.addEventListener('mouseenter', () => { deleteBtn.style.opacity = '1' })
    card.addEventListener('mouseleave', () => { deleteBtn.style.opacity = '0' })
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!this.bg) return
      const next = {
        ...this.bg,
        customBackgrounds: this.bg.customBackgrounds.filter((m) => m.id !== meta.id),
        current: this.bg.current === meta.id ? 'aurora' : this.bg.current, // 删当前 → 回落星空极光（spec §二）
      }
      this.bg = next
      this.deps.setBackground(next)
      this.deps.deleteCustomBackgroundFile?.(meta.id) // fire-and-forget：settings 是权威，孤儿文件无害
      this.rebuildBg() // 只重建背景区（rebuild() 已跑过时 bgCardRow 已存在，尾部补建条件恒假，删除不会生效）
    })
    card.appendChild(deleteBtn)

    const select = (): void => {
      if (!this.bg) return
      this.bg = { ...this.bg, current: meta.id } // 乐观选中，落盘回流 rebuild 校正（权威源）
      this.deps.setBackground(this.bg)
      this.paintBgActive()
    }
    card.addEventListener('click', select)
    this.attachEditBtn(card, 32, () => { select(); this.deps.onEditRequest?.('background') }) // ×占右上6px位,编辑排其左
    this.bgCards.set(meta.id, card)
    return card
  }

  /** "+"卡：满员时提示而非弹文件选择（镜像 makePlusCard） */
  private makeBgPlusCard(): HTMLElement {
    const card = document.createElement('div')
    card.setAttribute('data-bg-id', '__bg_plus')
    card.style.cssText = `
      width: 128px;
      height: 150px;
      flex: 0 0 auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px dashed rgba(255, 255, 255, 0.25);
      cursor: pointer;
      color: rgba(255, 255, 255, 0.6);
      font-size: 13px;
      opacity: 1;
      transform: translateY(0);
    `
    const plus = document.createElement('span')
    plus.textContent = '+'
    plus.style.cssText = `font-size: 32px; font-weight: 200;`
    const label = document.createElement('span')
    label.textContent = '上传'
    label.style.cssText = `font-size: 12px; color: rgba(255, 255, 255, 0.5);`
    card.appendChild(plus)
    card.appendChild(label)
    card.addEventListener('click', () => {
      if (this.bg && (this.bg.customBackgrounds ?? []).length >= CUSTOM_BACKGROUNDS_MAX) this.deps.showHint?.('背景已满，先删一个')
      else this.deps.onBackgroundCreateRequest?.()
    })
    this.bgCards.set('__bg_plus', card)
    return card
  }

  private paintBgActive(): void {
    if (!this.bg) return
    for (const [id, card] of this.bgCards) {
      if (id === '__bg_plus') continue
      const active = id === this.bg.current
      card.style.border = active ? ACTIVE_BORDER : IDLE_BORDER
      card.style.boxShadow = active ? ACTIVE_GLOW : ''
    }
  }

  /** 供子内容取容器（Task 3/4 在 rebuild 里往这里挂行） */
  protected get root(): HTMLElement {
    return this.container
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
    this.pickerTab = 'shape' // 每次打开回到形状 tab（spec §二）
    this.applyTabVisibility()
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.container.style.visibility = 'visible'
    this.container.style.opacity = '1'
    this.container.style.pointerEvents = 'auto'
    this.scrim.style.visibility = 'visible'
    this.scrim.style.opacity = '1'
    // 错峰浮现：每卡按注册表序延迟 70ms 依次入场（仪式感拍板）——两套卡（形状/背景）都走
    let i = 0
    for (const card of [...this.cards.values(), ...this.bgCards.values()]) {
      card.style.transitionDelay = `${i * CARD_STAGGER_MS}ms`
      card.style.opacity = '1'
      card.style.transform = 'translateY(0)'
      i++
    }
    document.addEventListener('keydown', this.onKey, true)
    if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer)
    this.outsideClickTimer = setTimeout(() => {
      this.outsideClickTimer = null
      if (this.open_) document.addEventListener('pointerdown', this.onPointerDown, true)
    }, 0)
    this.deps.onOpenStateChanged?.(true)
    this.onOpenChange?.(true)
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    // 关闭统一淡出（不错峰）：delay 归零后收场——两套卡（形状/背景）都走
    for (const card of [...this.cards.values(), ...this.bgCards.values()]) {
      card.style.transitionDelay = '0ms'
      card.style.opacity = '0'
      card.style.transform = 'translateY(16px)'
    }
    this.container.style.opacity = '0'
    this.container.style.pointerEvents = 'none'
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
    this.deps.onOpenStateChanged?.(false)
    this.onOpenChange?.(false)
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    if (this.outsideClickTimer) clearTimeout(this.outsideClickTimer)
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    this.cardRow?.removeEventListener('wheel', this.onWheel)
    this.bgCardRow?.removeEventListener('wheel', this.onWheel)
    for (const url of this.thumbUrls.values()) URL.revokeObjectURL(url)
    this.thumbUrls.clear()
    this.cards.clear() // dispose 后迟到的缩略图回调命中 stale 分支自行 revoke，不会再往 map 写新 URL
    for (const url of this.bgThumbUrls.values()) URL.revokeObjectURL(url)
    this.bgThumbUrls.clear()
    this.bgCards.clear()
    this.onOpenChange = null
    this.container.remove()
    this.scrim.remove()
  }
}
