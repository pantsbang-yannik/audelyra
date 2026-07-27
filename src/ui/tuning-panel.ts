// 调音台面板——收敛到 BasePanel（Phase A2 T3）：外壳/显影/开合/Esc/点外部关/固定标题均由基座提供，
// 本文件只留内容（元素 × 属性的反应列表 + rule 编辑器）与 preview/commit/draft 逻辑。
// 与 settings-panel 的严格单向环不同：这里刻意维护本地乐观 draft（拖动实时反馈），
// 播种只发生一次（getMapping），此后控件事件直接改 draft + preview(拖动中)/commit(松手落盘)。
// 退台 profile='camera'（仅镜头后拉，不像设置那样接管整场景，spec §9）——是否触发/如何与设置
// 互斥交给 PanelCoordinator（Task 2），本文件不接 uiStage。
import { BasePanel } from './base-panel'
import { EditHistory, type HistorySnapshot } from '../scenes/nebula/mapping/edit-history'
import { ToggleSwitch } from './toggle-switch'
import { makeInfoIcon } from './info-icon'
import {
  ELEMENT_IDS, ELEMENT_LABELS, PROPERTY_CATALOG, addressKey, propertiesOf,
  type AudioFeature,
  type ElementId,
  type MappingValues,
  type Reaction,
  type TargetAddress,
} from '../scenes/nebula/mapping/types'
import { macroToMapping, DEFAULT_MACRO_KNOBS, MACRO_STYLES, type MacroKnobs, type MacroStyle } from '../scenes/nebula/mapping/macro'
import { GAIN_MAX, SMOOTHING_MAX_MS, makeReaction, newUserReactionId, sanitizeMappingValues } from '../scenes/nebula/mapping/spec'
import { CUSTOM_BG_ID_RE } from '../scenes/nebula/background-types'
import { shapeById } from '../scenes/nebula/shapes'
import { rhythmTargetsFor } from '../scenes/nebula/shapes/rhythm-capability'
import type { BodyKind, ShapeId, ShapeSettings } from '../scenes/nebula/shapes/types'
import type { MotionSettings } from '../scenes/nebula/motion/types'
import { type CameraSettings } from '../scenes/nebula/camera-types'
import type { TitleSettings } from '../scenes/nebula/title-fx'
import type { LyricsSettings } from '../scenes/nebula/lyrics/lyrics-fx'
import type { BackgroundSettings } from '../scenes/nebula/background-types'
import type { MixerSectionDef } from './mixer-schema'
import { CAMERA_SECTIONS } from './mixer-decl/camera-tab'
import { TITLE_SECTIONS, LYRICS_SECTIONS } from './mixer-decl/lyrics-tab'
import { BACKGROUND_SECTIONS } from './mixer-decl/background-tab'
import { shapeSectionsFor } from './mixer-decl/shape-tab'
import { SOURCE_LABELS, summarizeReaction, summarySegments, type SummaryBaseline } from './reaction-summary'

/** 整行点击委托的共用判定：这次点击是不是落在某个内部节点上。
 * 用途有二——①该子节点自己已有监听器，外层不能再代劳（同一次点击处理两次）；
 * ②该子节点是纯信息元件（ⓘ），点它是想看说明，外层的行为必须放行。
 * 只读 e.target，不依赖 currentTarget：两处调用方都把监听挂在容器上，语义一致。 */
function clickedInside(e: unknown, host: HTMLElement): boolean {
  const target = (e as MouseEvent | undefined)?.target as Node | null
  return !!target && host.contains(target)
}

export interface TuningPanelDeps {
  getMapping: () => Promise<MappingValues>
  previewMapping: (m: MappingValues) => void
  commitMapping: (m: MappingValues) => void
  /** 宏旋钮标量（二期标准层）：get 播种旋钮位置；commit 落盘（走 setSettings({macroKnobs}) 通道） */
  getMacroKnobs: () => Promise<MacroKnobs>
  commitMacroKnobs: (k: MacroKnobs) => void
  /** 高级调整折叠态：get 播种，commit 落盘（走 setSettings({tuningAdvancedExpanded}) 通道） */
  getAdvancedExpanded: () => Promise<boolean>
  commitAdvancedExpanded: (v: boolean) => void
  getShape: () => Promise<ShapeSettings>
  setShape: (s: ShapeSettings) => void
  onShapeChanged: (cb: (s: ShapeSettings) => void) => void
  getMotion: () => Promise<MotionSettings>
  previewMotion: (m: MotionSettings) => void
  commitMotion: (m: MotionSettings) => void
  getCamera: () => Promise<CameraSettings>
  previewCamera: (c: CameraSettings) => void
  commitCamera: (c: CameraSettings) => void
  // 歌词歌名 tab（批2）：preview=直调场景 apply 不落盘，commit=setSettings 落盘
  getTitleFx: () => Promise<TitleSettings>
  previewTitleFx: (t: TitleSettings) => void
  commitTitleFx: (t: TitleSettings) => void
  getLyricsFx: () => Promise<LyricsSettings>
  previewLyricsFx: (s: LyricsSettings) => void
  commitLyricsFx: (s: LyricsSettings) => void
  // 背景 tab（虚空之镜）：preview=直调场景 apply 不落盘，commit=setSettings 落盘
  getBackgroundFx: () => Promise<BackgroundSettings>
  previewBackgroundFx: (b: BackgroundSettings) => void
  commitBackgroundFx: (b: BackgroundSettings) => void
  /** 背景设置回流（自定义背景 v1）：shape-picker 也会改 background（选卡/入藏/删卡），
   * draft 不吃回流会在下次 commit 把过期 customBackgrounds/current 整包写回（静默撤销选择） */
  onBackgroundChanged: (cb: (b: BackgroundSettings) => void) => void
}

// 属性的中文名/简述已收敛进 mapping/types.ts 的属性目录（ELEMENT_PROPERTIES），此处不再重复声明。
// 来源中文名/摘要文案计算已收敛进 reaction-summary.ts（零 DOM 纯逻辑，供本文件与其单测共用）。

// 透明度层级——与 settings-panel 完全同源（label/未选/hover/选中）
const LABEL_OPACITY = '0.5'
const SELECTED_OPACITY = '0.85'
const UNSELECTED_OPACITY = '0.35'
const HOVER_OPACITY = '0.6'
const DISABLED_OPACITY = '0.18' // 退路按钮的不可点态：比 UNSELECTED 再暗一档，明确「现在没得退」

// 层级规范：反应名比属性名更亮——属性是分类（框架），反应是用户真正配置的内容。
// 「重内容轻框架」在字重上的字面落实；若属性更亮，视线会先落在分类上，用户又得二次解析。
const REACTION_OPACITY = '0.75'
const PROPERTY_OPACITY = '0.55'
// 摘要行里的偏离参数段——比来源名淡一档：它是注解，不是主角
const SUMMARY_NOTE_OPACITY = '0.45'
// 展开区字号：比属性名/摘要行（13px）小一档，让最深那层在字号上也退下去
const DETAIL_FONT_SIZE = '12px'

// 设计规范：模块分隔线 + 标题层级（item 4）——数值集中在此，供面板系统内其它分组场景复用
const GROUP_TITLE_FONT_SIZE = '15px'
const GROUP_TITLE_OPACITY = '0.7'
const GROUP_DIVIDER = '1px solid rgba(255, 255, 255, 0.07)'

// tab 栏（Phase B1 亲验反馈①：两分区堆叠太长，改 tab 切换，titlebar 下方常驻）
const TAB_FONT_SIZE = '13px'
const TAB_LETTER_SPACING = '1px'
const TAB_ACTIVE_BORDER = '2px solid rgba(255, 255, 255, 0.4)'
const TAB_INACTIVE_BORDER = '2px solid transparent'

// 沉睡态提示（Phase B1 亲验反馈②反转，spec §4.6：切形状=临时唤醒展示，无音乐自动回睡）
const SHAPE_SLEEP_HINT_STYLE = 'font-size: 11px; color: rgba(255, 255, 255, 0.35); margin: 8px 0 4px;'

// 标准层宏旋钮卡片：淡白底把「一键调感觉」圈成整体，与下方高级调整拉开层次（与 GROUP_DIVIDER 同族，不刺眼）
// 内边距上 8px（叠首行 header 的 margin-top 6px = 实际 14px，与左右持平）、左右 14px、下 12px
const MACRO_CARD_STYLE = 'background: rgba(255, 255, 255, 0.04); border-radius: 8px; padding: 8px 14px 12px; margin-top: 6px;'
// 「高级调整」折叠头：整行可点（只点箭头命中区太小）
const ADVANCED_TOGGLE_STYLE = `cursor: pointer; user-select: none; margin-top: 12px; padding: 2px 0; font-size: ${GROUP_TITLE_FONT_SIZE}; color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});`

/** tab 标识——四处联合类型重复处（activeTab 声明/makeTab/paint/showTab）收拢到此（mixer v2：通用改律动） */
type TabId = 'rhythm' | 'camera' | 'shape' | 'lyrics' | 'background'

interface RangeSpec {
  label: string
  /** 参数解释——有值时在 label 旁渲染信息图标，hover 出 tooltip（朝左，防面板贴右边缘出屏） */
  help?: string
  min: number
  max: number
  step: number
  value: number
  format?: (v: number) => string
  /** 轻吸附（歌词位置滑块）：input/change 的原始值先过此函数再显示与回调（如 snapToNodes） */
  snap?: (v: number) => number
  /** 轨道刻度点（歌词位置滑块）：在滑杆下方按量程百分比画小点标出吸附节点位置 */
  ticks?: readonly number[]
  /** 回传「回写 thumb + 同步显示值」的 setter（宏旋钮重置：不重建行也能把钮拨到新位置） */
  ref?: (setValue: (v: number) => void) => void
  onInput: (v: number) => void
  onCommit: (v: number) => void
}

export class TuningPanel extends BasePanel {
  private body: HTMLElement
  /** 宏旋钮子树容器（律动页顶部）：macroDraft 播种后填一次就不动——重建会销毁正在操作的滑块，
   * 键盘用户每按一次方向键都会丢焦点（Chromium 下方向键连发 input + change） */
  private macroSlot: HTMLElement
  /** 专业表容器（律动页规则行）：能力矩阵变化/宏旋钮重铺时只重建这一层（同 shapeBody/cameraBody 纪律） */
  private ruleRows: HTMLElement
  /** 本地乐观 draft——由 getMapping 播种一次，此后控件事件直接原地改（已深拷贝，不污染播种源） */
  private draft: MappingValues | null = null
  /** 每条反应的摘要行重绘钩子 + 展开区/箭头节点引用，随 buildRuleRows 重建而清空。
   * 按 id 索引：改来源/改参数后只重画自己那一行，不整块重建（重建会打断拖动中的滑块）。 */
  private reactionParts = new Map<string, { detail: HTMLElement; caret: HTMLElement; paint: () => void; paintMore: () => void }>()
  /** 手风琴：当前展开的反应 id（null=全收）。**跨 buildRuleRows 存活**——
   * 添加/复制反应后要自动展开新条目，全靠这个字段跨重建保持有效。 */
  private expandedReactionId: string | null = null
  /** 展开区里「更多」子折叠已打开的反应 id 集合。同样**跨 buildRuleRows 存活**：
   * 外层手风琴靠 expandedReactionId 跨重建保持展开，里层若不跟着存活，
   * 切形状一类的重建会让已展开的那条反应里「更多」自己合上。 */
  private moreOpenIds = new Set<string>()
  /** 当前宏旋钮投影出的官方基线，按 id 索引——摘要行判定「改过」的基准。
   * 每次 buildRuleRows 重算一次：macroToMapping 是整套投影，逐行调用会退化成 O(n²)。 */
  private baselineById: Map<string, Reaction> | null = null
  /** 宏旋钮本地乐观态（二期标准层）：getMacroKnobs 播种一次，此后拖动改此值 + 投影到 draft */
  private macroDraft: MacroKnobs | null = null
  /** 专业表被手动改过、宏旋钮位置已陈旧（遥控器模型：宏旋钮单向覆盖专业表，下次动旋钮会抹掉手调）
   * ——控制陈旧提示显隐。播种时由 syncMacroStale 从「存档 mapping vs 旋钮位置的投影」推导，此后会话内记账维护 */
  private macroStale = false
  /** 陈旧提示节点引用——markMacroStale/applyMacro 直接改 display，不重建，避免打断专业表拖动 draft */
  private macroStaleNote: HTMLElement | null = null
  /** 高级调整（专业表）是否展开——播种一次，此后点击折叠头翻转并落盘 */
  private advancedExpanded = false
  /** 折叠头的文案节点——文案与按钮分两层，改文案不会清掉同行按钮 */
  private advancedLabel!: HTMLElement
  /** 律动页编辑历史（反应列表 + 宏旋钮）。面板全会话只 new 一次，故它天然「关面板不清、退出应用才清」 */
  private readonly history = new EditHistory()
  /** 恢复中标志：撤销/重做走的也是 commit 路径，不挡住就会把自己推回栈里 */
  private applying = false
  /** 撤销快捷键。作用域刻意收窄到「面板开着 + 停在律动页」——撤销只管律动页，
   * 在别的页按下去若也生效，用户会看不见自己改动了什么。ctrlKey 一并接住是为 Windows 留路 */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen || this.activeTab !== 'rhythm') return
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    e.preventDefault()
    if (e.shiftKey) this.redoStep()
    else this.undoStep()
  }
  private undoBtn: { el: HTMLElement; setEnabled: (on: boolean) => void } | null = null
  private redoBtn: { el: HTMLElement; setEnabled: (on: boolean) => void } | null = null
  /** 宏旋钮区绕过控件改 macroDraft 后的回写钩子（两滑块 thumb + 风格行选中态）——子树只建一次，
   * 故重置一类绕过控件本身改值的路径需要这些钩子显式把 UI 拨回新值 */
  private macroKnobSyncs: Array<() => void> = []
  /** 宏旋钮区专属信息图标 disposer 桶——风格行带 help 文案会造 ⓘ 图标，不能落进 infoDisposers：
   * 那个桶随 buildRuleRows 重建前 drain（律动区 getShape 播种也会触发一次 buildRuleRows，构造期即会
   * drain），会把不重建的宏旋钮区图标误杀。本桶与 shapeDisposers/cameraDisposers/lyricsDisposers/
   * backgroundDisposers 同款「不重建区」模式：只在面板 dispose() 时清 + buildMacroKnobs 头部按惯例
   * 防御性 drain 一次（该函数全仓目前只有播种回调这一处调用点，建一次后不重建，故当前不会真的累积，
   * 但与紧邻的 slot.innerHTML='' / macroKnobSyncs=[] 保持同一份「按重建安全写」的局部不变量） */
  private macroDisposers: Array<() => void> = []
  /** 每个信息图标的 dispose（摘 tooltip 节点 + 卸监听）——buildRuleRows 重建前 drain，防孤儿 tooltip（Phase B 重建铺路） */
  private infoDisposers: Array<() => void> = []
  /** makeLabelWithHelp 造图标时该 push 进哪个 disposer 桶——默认通用区的 infoDisposers，
   * buildShapeSection 造行期间临时指向 shapeDisposers，使两区各自 drain 互不牵连（见下方定案实现说明） */
  private helpSink: Array<() => void> | null = null

  /** 形状区状态：getShape 播种 + onShapeChanged 持续回流（离散设置语义同 settings-panel，
   * 区别于映射区的乐观 draft——评审 I5：与 B2 选择器双入口同步全靠回流重绘） */
  private shape: ShapeSettings | null = null
  private shapeBody: HTMLElement
  private shapeDisposers: Array<() => void> = []

  /** 运动旋钮的本地乐观 draft（Phase C2）：与映射区同款——播种一次，此后拖动改 draft + preview/commit，
   * onShapeChanged 回流只重绘 DOM，值恒取自本地 draft，不被 settings 回声冲掉 */
  private motionDraft: MotionSettings | null = null

  /** 镜头旋钮的本地乐观 draft（Phase D；fb3 拆出独立「镜头」tab）：与 motion 同款——播种一次，此后拖动改 draft + preview/commit */
  private cameraDraft: CameraSettings | null = null
  private cameraBody!: HTMLElement
  private cameraDisposers: Array<() => void> = []

  /** 歌词歌名 tab 的乐观 draft（批2）：与 motion/camera 同款——播种一次，此后控件改 draft + preview/commit */
  private titleDraft: TitleSettings | null = null
  private lyricsDraft: LyricsSettings | null = null
  private lyricsBody: HTMLElement
  private lyricsDisposers: Array<() => void> = []

  /** 背景 tab（虚空之镜）的乐观 draft：与 lyrics 同款——播种一次，此后控件改 draft + preview/commit */
  private backgroundDraft: BackgroundSettings | null = null
  private backgroundBody: HTMLElement
  private backgroundDisposers: Array<() => void> = []

  /** tab 栏状态：切 tab 只做 display 显隐，body/cameraBody/shapeBody/lyricsBody/backgroundBody 全程留在 DOM——映射区乐观 draft 与
   * 形状区 onShapeChanged 回流环都不许被切换打断。 */
  private activeTab: TabId = 'rhythm'
  private rhythmTabEl!: HTMLElement
  private cameraTabEl!: HTMLElement
  private shapeTabEl!: HTMLElement
  private lyricsTabEl!: HTMLElement
  private backgroundTabEl!: HTMLElement

  constructor(parent: HTMLElement, private deps: TuningPanelDeps) {
    super(parent, { id: 'tuning-panel', title: '调音台', retreatProfile: 'camera' })

    // 细轨滑块——inline style 够不到 ::-webkit-slider-* 伪元素，用一枚 <style> 补足；
    // 全局样式表（非 shadow scoped），靠 .tp-slider 唯一类名避免碰撞。
    // <style> 作为普通子节点挂在内容区内也生效（HTML 规范允许，非仅限 head）
    const sliderStyle = document.createElement('style')
    sliderStyle.textContent = `
      .tp-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 14px; background: transparent; cursor: pointer; margin: 2px 0; }
      .tp-slider::-webkit-slider-runnable-track { height: 2px; background: rgba(255, 255, 255, 0.15); border-radius: 1px; }
      .tp-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 10px; height: 10px; margin-top: -4px; border-radius: 50%; background: rgba(255, 255, 255, 0.55); }
      .tp-slider::-moz-range-track { height: 2px; background: rgba(255, 255, 255, 0.15); border-radius: 1px; }
      .tp-slider::-moz-range-thumb { width: 10px; height: 10px; border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.55); }
    `
    this.appendRow(sliderStyle)

    this.appendFixed(this.buildTabBar()) // tab 栏进固定区：随标题固定，不随内容滚动

    // 律动页骨架——页首说明 / 宏旋钮槽 / 专业表容器三段在构造期定好，此后各自独立重建：
    // 宏旋钮子树建一次不动，规则行随能力矩阵与宏旋钮重铺刷新（同 shapeBody/cameraBody 容器纪律）
    this.body = document.createElement('div')
    this.appendRow(this.body)

    // 页首全局说明（mixer v2：根治「律动=总开关」误解）——样式沿用形状区沉睡提示
    const hint = document.createElement('div')
    hint.setAttribute('data-role', 'rhythm-global-hint')
    hint.textContent = '全局生效——切换任何形状都延续这套律动；只显示当前形状会响应的目标'
    hint.style.cssText = SHAPE_SLEEP_HINT_STYLE
    this.body.appendChild(hint)

    this.macroSlot = document.createElement('div')
    this.macroSlot.setAttribute('data-role', 'macro-knobs-slot')
    this.macroSlot.style.cssText = MACRO_CARD_STYLE // 卡片化：与下方高级调整拉开主次
    this.body.appendChild(this.macroSlot)

    this.body.appendChild(this.buildAdvancedToggle())

    this.ruleRows = document.createElement('div')
    this.ruleRows.setAttribute('data-role', 'rule-rows') // 测试锚点：与 macro-knobs-slot 对称，供收窄搜索根用
    const loading = document.createElement('div')
    loading.textContent = '加载中…'
    loading.style.cssText = `color: rgba(255, 255, 255, ${LABEL_OPACITY});`
    this.ruleRows.appendChild(loading)
    this.body.appendChild(this.ruleRows)
    this.refreshAdvanced() // 初始按 advancedExpanded 收起；播种回来若为展开会再刷一次

    // 唯一播种点：面板构造时读一次初始 mapping，深拷贝成本地 draft，此后不再回流覆盖
    // （区别于 settings-panel 的 onSettingsChanged 持续回流——拖动语义要求乐观本地态）
    void deps.getMapping().then((m) => {
      this.draft = structuredClone(m)
      this.syncMacroStale()
      this.buildRuleRows()
      this.seedHistory()
    })

    // 宏旋钮播种（二期标准层）：读一次旋钮位置，把两滑块画进 macroSlot（此后不再重建）
    void deps.getMacroKnobs().then((k) => {
      this.macroDraft = { ...k }
      this.syncMacroStale()
      this.buildMacroKnobs()
      // 摘要行的偏离基准取自宏旋钮投影，旋钮位置晚到时必须重铺一次，
      // 否则 baselineById 永久停在 null、「只浮出改过的参数」静默失效。
      // 三个播种是三次独立 IPC，解析先后无保证——不能依赖别的播种回调顺手重铺。
      this.buildRuleRows() // draft 未到时内部早退，成本为零
      this.seedHistory()
    })

    // 折叠态播种：读一次上次的展开状态（默认收起，故播种前后都不会闪）
    void deps.getAdvancedExpanded().then((v) => {
      this.advancedExpanded = v
      this.refreshAdvanced()
    })

    this.shapeBody = document.createElement('div')
    this.shapeBody.style.display = 'none' // 默认激活「律动」tab，形状分区初始隐藏；此后显隐只由 showTab 改动
    this.appendRow(this.shapeBody)
    void deps.getShape().then((s) => {
      this.shape = s
      this.buildShapeSection()
      this.buildRuleRows() // 律动页按能力矩阵过滤，播种形状后需重渲（对 !this.draft 已有早退，早于 mapping 到达时是空转）
    })
    deps.onShapeChanged((s) => {
      this.shape = s
      this.buildShapeSection() // 回流全量重绘：双入口（B2 选择器/本区）状态必然一致
      this.buildRuleRows() // 律动页跟随形状切换重渲能力矩阵过滤结果
    })

    // 运动旋钮与映射区同款乐观 draft：播种一次，此后拖动改 draft + preview/commit——
    // onShapeChanged 回流只重绘 DOM，值恒取自本地 draft，不被 settings 回声冲掉
    void deps.getMotion().then((m) => {
      this.motionDraft = structuredClone(m)
      this.buildShapeSection()
    })

    this.cameraBody = document.createElement('div')
    this.cameraBody.style.display = 'none' // 显隐只由 showTab 改动（同 shapeBody 纪律）
    this.appendRow(this.cameraBody)
    // 镜头旋钮播种（Phase D；fb3 搬入独立「镜头」tab）：draft 纪律与 motion 同款
    void deps.getCamera().then((c) => {
      this.cameraDraft = structuredClone(c)
      this.buildCameraSection()
    })

    this.lyricsBody = document.createElement('div')
    this.lyricsBody.style.display = 'none' // 显隐只由 showTab 改动（同 shapeBody 纪律）
    this.appendRow(this.lyricsBody)
    void deps.getTitleFx().then((t) => {
      this.titleDraft = structuredClone(t)
      this.buildLyricsSection()
    })
    void deps.getLyricsFx().then((s) => {
      this.lyricsDraft = structuredClone(s)
      this.buildLyricsSection()
    })

    this.backgroundBody = document.createElement('div')
    this.backgroundBody.style.display = 'none' // 显隐只由 showTab 改动（同 shapeBody 纪律）
    this.appendRow(this.backgroundBody)
    void deps.getBackgroundFx().then((b) => {
      this.backgroundDraft = structuredClone(b)
      this.buildBackgroundSection()
      this.buildRuleRows() // 见下方回流处的同款理由（播种早于 getMapping 时这次是空转，无害）
    })
    deps.onBackgroundChanged((b) => {
      // 同 channel 多订阅者共享同一广播对象，draft 就地突变会污染 shape-picker/场景的快照，须 clone 隔离
      this.backgroundDraft = structuredClone(b)
      this.buildBackgroundSection() // 全量重建：置灰态跟随 current 翻转（拖动中 commit 才触发回流，无中断风险）
      // 律动页也要跟着重建：背景组的「上传背景图后生效」提示挂在 current 上，
      // 不重建的话用户传完图提示还赖着不走（同 onShapeChanged 跟随能力矩阵重渲的先例）
      this.buildRuleRows()
    })

    document.addEventListener('keydown', this.onKeyDown as EventListener)
  }

  /** 拖动中：只 preview，不落盘 */
  private preview(): void {
    if (this.draft) this.deps.previewMapping(this.draft)
  }

  /** 松手/离散选择：preview 收尾 + 落盘 + 入栈。
   * @param coalesceKey 控件身份，同 key 的连续调整在 2s 内合并成一步；离散/结构性操作不传
   *
   * **入栈点只此一处**：applyMacro 内部也调本方法（是调用链不是并列路径），
   * 那边再挂一次会让宏旋钮一次操作入栈两次，且先落的那份旋钮位置还是旧值 */
  private commit(coalesceKey?: string): void {
    if (!this.draft) return
    this.deps.previewMapping(this.draft)
    this.deps.commitMapping(this.draft)
    this.pushHistory(coalesceKey)
  }

  /** 入栈：快照取 draft + macroDraft，两者进到这里时都已是本次操作后的新值。
   * draft 是就地突变的，必须深拷贝——否则栈里全是指向同一个对象的引用，撤销拿回来的还是当前值 */
  private pushHistory(coalesceKey?: string): void {
    if (this.applying) return
    if (!this.draft || !this.macroDraft) return // 两个播种未齐：还没有完整状态可存
    this.history.push(
      { mapping: structuredClone(this.draft), macroKnobs: { ...this.macroDraft } },
      { coalesceKey, now: Date.now() },
    )
    this.refreshHistoryButtons()
  }

  /** 基线快照：两个播种（mapping / 旋钮位置）是独立 IPC，谁后到不定，故各调一次，
   * 内部按「栈还空着且两者都到齐」判定，只真正入栈一次 */
  private seedHistory(): void {
    if (this.history.size > 0) return
    this.pushHistory()
  }

  /** 把快照写回并让整页跟上——撤销/重做共用。
   * 落 mapping 这步特意走 commit() 而非直连 deps.previewMapping/commitMapping：
   * 一是省两行重复，二是让 applying 守卫真正处在调用链上——直连的话 pushHistory 永远不会
   * 被这条路径调用，applying 守卫形同虚设（改坏它也不会有测试红） */
  private applySnapshot(snap: HistorySnapshot | null): void {
    if (!snap) return
    this.applying = true
    try {
      this.draft = structuredClone(snap.mapping)
      this.macroDraft = { ...snap.macroKnobs }
      this.commit() // 落 mapping；pushHistory 会被 applying 守卫挡下，不会把恢复动作自己推回栈里
      this.deps.commitMacroKnobs({ ...this.macroDraft })
      this.macroKnobSyncs.forEach((sync) => sync()) // 旋钮 thumb 与风格选中态跟着回去
      this.syncMacroStale() // 陈旧提示按快照重算：从数据推导，不沿用撤销前的状态
      this.buildRuleRows()  // 重刷专业表；展开态由 refreshExpanded 按存活 id 恢复
    } finally {
      this.applying = false
    }
    this.refreshHistoryButtons()
  }

  private undoStep(): void { this.applySnapshot(this.history.undo()) }
  private redoStep(): void { this.applySnapshot(this.history.redo()) }

  /** 两个按钮的可点态跟着栈走——退无可退时置灰，不留一个点了没反应的入口 */
  private refreshHistoryButtons(): void {
    this.undoBtn?.setEnabled(this.history.canUndo())
    this.redoBtn?.setEnabled(this.history.canRedo())
  }

  /** 当前形状的主体类（能力矩阵/契约表共用键）：自定义形状=粒子体；未播种时按粒子兜底 */
  private currentBody(): BodyKind {
    if (!this.shape) return 'particles'
    return this.shape.customCurrent ? 'particles' : shapeById(this.shape.current).body ?? 'particles'
  }

  /** 当前是否有自定义背景在用——决定背景组要不要显示「上传背景图后生效」的提示。
   * 内置极光/穹顶没有图面可显影，此时背景反应写了也看不见。 */
  private hasUserBackdrop(): boolean {
    return !!this.backgroundDraft && CUSTOM_BG_ID_RE.test(this.backgroundDraft.current)
  }

  /** 某地址下当前的反应（按 draft 列表顺序） */
  private reactionsAt(addr: TargetAddress): Reaction[] {
    const key = addressKey(addr)
    return this.draft!.reactions.filter((r) => addressKey(r.target) === key)
  }

  /** 本元素下要渲染哪些属性。
   * 主体走能力矩阵过滤（mixer v2）：只渲染当前形状消费的属性；被隐属性的反应在 draft/存档原样保留。
   * 只按当前形状能力判断——真正的粒子接管判据是 coverPriority && coverCloud（resolve.ts），
   * coverCloud 是运行时状态面板拿不到；宁可封面接管瞬间暂缺有效组，也不对激光/点阵显示无效死件（零死件优先）。
   * 背景不受形状影响，全量渲染。 */
  private visiblePropertiesOf(element: ElementId): string[] {
    if (element !== 'body') return propertiesOf(element)
    const capable = rhythmTargetsFor(this.currentBody())
    return propertiesOf('body').filter((p) => capable.includes(p))
  }

  /** 重算摘要基线。只在整块重铺时调用——拖动中不必刷（折叠着的摘要行看不见），
   * 每帧多跑一次整套投影不值当。 */
  private refreshBaseline(): void {
    // 不传 current：要的是「完整官方基线」而非「保留用户反应的投影」（见 macroToMapping 注释）
    this.baselineById = this.macroDraft
      ? new Map(macroToMapping(this.macroDraft).reactions.map((r) => [r.id, r]))
      : null
  }

  /** 某条反应的摘要基准：宏旋钮未播种=pending（安静）；基线里查无此 id=用户手加 */
  private baselineFor(id: string): SummaryBaseline {
    if (!this.baselineById) return { kind: 'pending' }
    const hit = this.baselineById.get(id)
    return hit ? { kind: 'official', reaction: hit } : { kind: 'user' }
  }

  /** 展开态刷新：只切 display 与箭头文案，**绝不重建**（同 refreshAdvanced 纪律）。
   * 收起上方条目会让页面内容上移，故按锚点补偿滚动——手风琴最常见的体验塌陷点。 */
  private refreshExpanded(anchor?: HTMLElement): void {
    const before = anchor?.getBoundingClientRect().top
    for (const [id, parts] of this.reactionParts) {
      const on = this.expandedReactionId === id
      parts.detail.style.display = on ? '' : 'none'
      parts.caret.textContent = on ? '▾' : '▸'
      parts.paintMore() // 里层「更多」的显隐同源于 moreOpenIds，一并按当前集合刷新
    }
    if (anchor && before !== undefined) {
      const after = anchor.getBoundingClientRect().top
      if (after !== before) this.content.scrollTop = (this.content.scrollTop ?? 0) + (after - before)
    }
  }

  /** 专业表反应列表：只重建 ruleRows 这一层——宏旋钮子树与页首说明不受影响。
   * 按「元素 → 属性 → 该属性上的反应列表」三层渲染，每个属性可增删复制反应（R1-1 寻址改造）。 */
  private buildRuleRows(): void {
    if (!this.draft) return
    // 重建前先 drain 上一批信息图标（摘 tooltip 节点 + 卸监听），防 ruleRows.innerHTML='' 后孤儿化 <div data-tooltip>
    // （宏旋钮区的风格行带 help 会造图标，但走 macroDisposers 专属桶，不落进这里，drain 不会牵连 macroSlot）
    this.infoDisposers.forEach((d) => d())
    this.infoDisposers = []
    this.reactionParts.clear()
    this.refreshBaseline()
    this.ruleRows.innerHTML = ''

    let groupIndex = 0
    for (const element of ELEMENT_IDS) {
      const properties = this.visiblePropertiesOf(element)
      if (properties.length === 0) continue
      this.ruleRows.appendChild(this.buildElementHeader(element, groupIndex++))
      for (const property of properties) {
        this.ruleRows.appendChild(this.buildPropertyBlock({ element, property }))
      }
    }
    this.refreshExpanded() // 按存活的 expandedReactionId 恢复展开态
  }

  /** 元素分组标题（主体 / 背景）——按用户目的分组：「我要让谁对声音有反应」 */
  private buildElementHeader(element: ElementId, index: number): HTMLElement {
    const header = document.createElement('div')
    header.setAttribute('data-role', `element-header-${element}`)
    header.style.cssText = `
      display: flex;
      align-items: center;
      font-size: ${GROUP_TITLE_FONT_SIZE};
      color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});
      margin-top: 18px;
      padding-top: ${index === 0 ? '0' : '14px'};
      border-top: ${index === 0 ? 'none' : GROUP_DIVIDER};
    `
    const title = document.createElement('span')
    title.textContent = ELEMENT_LABELS[element]
    header.appendChild(title)
    // 没有自定义背景时明说「写了也看不见」——不隐藏该组：它同时是引导用户去上传背景的入口
    if (element === 'backdrop' && !this.hasUserBackdrop()) {
      const note = document.createElement('span')
      note.setAttribute('data-role', 'backdrop-needs-image')
      note.textContent = '上传背景图后生效'
      note.style.cssText = `margin-left: 8px; font-size: 11px; color: rgba(255, 255, 255, ${LABEL_OPACITY});`
      header.appendChild(note)
    }
    return header
  }

  /** 一个属性块：属性名 + ⓘ +（hover 才出的）「添加」，下挂该地址上的全部反应。
   * 空属性不铺空态文案——属性名本身变淡且整行可点即添加，少一行噪声也少一次点击。 */
  private buildPropertyBlock(addr: TargetAddress): HTMLElement {
    const spec = PROPERTY_CATALOG[addr.element][addr.property]
    const list = this.reactionsAt(addr)
    const empty = list.length === 0

    const block = document.createElement('div')
    block.setAttribute('data-role', `property-${addr.element}-${addr.property}`)
    block.style.cssText = 'margin-top: 14px;'

    const header = document.createElement('div')
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between;'

    const nameGroup = document.createElement('span')
    // 默认锚点：属性名组本身（承载 L2 层的字号与透明度）。空属性分支下整行即按钮，
    // 届时改挂 empty-add-* 以名副其实——两个锚点互斥，按该行当下是「标题」还是「按钮」取其一
    nameGroup.setAttribute('data-role', `property-name-${addr.element}-${addr.property}`)
    nameGroup.style.cssText = `display: inline-flex; align-items: center; font-size: 13px; color: rgba(255, 255, 255, ${empty ? UNSELECTED_OPACITY : PROPERTY_OPACITY});`
    nameGroup.style.color = `rgba(255, 255, 255, ${empty ? UNSELECTED_OPACITY : PROPERTY_OPACITY})` // 显式属性写：FakeEl 不解析 cssText
    const name = document.createElement('span')
    name.textContent = spec.label
    nameGroup.appendChild(name)
    // 空属性也保留 ⓘ：用户正是在不了解这个属性是什么的情况下决定要不要加，此处信息需求最强
    const icon = makeInfoIcon(spec.desc)
    nameGroup.appendChild(icon.el)
    this.infoDisposers.push(icon.dispose)
    header.appendChild(nameGroup)

    const addOne = (): void => {
      const r = makeReaction(addr, this.draft!.reactions)
      this.draft!.reactions.push(r)
      this.expandedReactionId = r.id // 直接展开：否则点「添加」只多出一行灰字，看起来像没生效
      this.afterReactionListChanged()
    }

    if (empty) {
      // 整行即按钮——省掉「添加」两个字与那行空态文案。
      // flex: 1 是命中区的关键：nameGroup 是 inline-flex，不撑开的话只有属性名那几十像素可点，
      // 右侧留白全是死区，与「整行可点」的设计不符（hover 变色的范围同样靠它撑满）
      nameGroup.setAttribute('data-role', `empty-add-${addr.element}-${addr.property}`)
      nameGroup.style.cursor = 'pointer'
      nameGroup.style.flex = '1'
      nameGroup.addEventListener('click', (e) => {
        // ⓘ 图标嵌在整行可点区域内：点它是想看 tooltip，不是想新增反应，命中图标就放行不加。
        // 判定放在这一层而非直接给图标加 stopPropagation——makeInfoIcon 是共享工厂，
        // makeLabelWithHelp/makeGroupHeader 也在用它，图标本身加 stopPropagation 会一并
        // 影响那两处，波及面比这里更大；在消费方按 target 判定只影响这一条监听。
        if (clickedInside(e, icon.el)) return
        addOne()
      })
      nameGroup.addEventListener('mouseenter', () => { nameGroup.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})` })
      nameGroup.addEventListener('mouseleave', () => { nameGroup.style.color = `rgba(255, 255, 255, ${UNSELECTED_OPACITY})` })
    } else {
      // 「添加」常驻 DOM 但默认不可见，hover 本属性块才浮出——默认屏上一个按钮都没有。
      // 用 visibility 而非 display：占位不变，浮出时右侧文字不会把布局挤动
      const add = this.makeTextButton('添加', `add-reaction-${addr.element}-${addr.property}`, addOne)
      add.style.visibility = 'hidden'
      block.addEventListener('mouseenter', () => { add.style.visibility = 'visible' })
      block.addEventListener('mouseleave', () => { add.style.visibility = 'hidden' })
      header.appendChild(add)
    }

    block.appendChild(header)
    for (const r of list) block.appendChild(this.buildRuleEditor(r.id))
    return block
  }

  /** 增删复制后的统一收尾：落盘 + 置陈旧位 + 重建列表（条数变了，必须整块重铺） */
  private afterReactionListChanged(): void {
    this.commit()
    this.markMacroStale()
    this.buildRuleRows()
  }

  /** 可点文字按钮（添加/复制/删除共用）——沿用宏旋钮「重置」的样式惯例，不引入新的视觉元素 */
  private makeTextButton(text: string, role: string, onClick: () => void): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-role', role)
    el.textContent = text
    el.style.cssText = `cursor: pointer; font-size: 11px; color: rgba(255, 255, 255, ${UNSELECTED_OPACITY});`
    el.addEventListener('mouseenter', () => { el.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})` })
    el.addEventListener('mouseleave', () => { el.style.color = `rgba(255, 255, 255, ${UNSELECTED_OPACITY})` })
    el.addEventListener('click', onClick)
    return el
  }

  /** 「高级调整」折叠头：整行可点翻转展开态 + 落盘；右侧挂撤销/重做/回出厂三个入口。
   * 文案必须由独立的 label 节点承载——真实 DOM 下给整行赋 textContent 会连按钮子节点一起清空
   * （同 buildRuleEditor 里 summaryRow/summary 拆两层的先例）。只建一次，此后靠 refreshAdvanced 改文案 */
  private buildAdvancedToggle(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-role', 'advanced-toggle')
    el.style.cssText = ADVANCED_TOGGLE_STYLE
    el.style.display = 'flex'
    el.style.alignItems = 'center'
    el.style.justifyContent = 'space-between'
    el.addEventListener('click', () => {
      this.advancedExpanded = !this.advancedExpanded
      this.refreshAdvanced()
      this.deps.commitAdvancedExpanded(this.advancedExpanded)
    })
    el.addEventListener('mouseenter', () => { el.style.color = `rgba(255, 255, 255, ${SELECTED_OPACITY})` })
    el.addEventListener('mouseleave', () => { el.style.color = `rgba(255, 255, 255, ${GROUP_TITLE_OPACITY})` })

    this.advancedLabel = document.createElement('span')
    this.advancedLabel.setAttribute('data-role', 'advanced-toggle-label')
    el.appendChild(this.advancedLabel)

    // 退路入口区：与折叠文案同行右对齐。视觉纪律——沿用文字按钮，不加边框/底色。
    // 撤销/重做排在「回出厂」之前——顺序即使用频次
    const advancedActions = document.createElement('div')
    advancedActions.setAttribute('data-role', 'advanced-actions')
    advancedActions.style.cssText = 'display: flex; align-items: center; gap: 10px;'
    this.undoBtn = this.makeHistoryButton('↶ 撤销', 'undo', () => this.undoStep())
    this.redoBtn = this.makeHistoryButton('↷ 重做', 'redo', () => this.redoStep())
    advancedActions.append(this.undoBtn.el, this.redoBtn.el)
    const factory = this.makeHistoryButton('回出厂', 'factory-reset', () => this.resetToFactory())
    advancedActions.appendChild(factory.el)
    el.appendChild(advancedActions)
    this.refreshHistoryButtons() // 开局栈里只有基线（尚未 seed 时两者也该是灰的）——两个按钮起手都不可点

    return el
  }

  /** 折叠只切 display 与箭头文案——绝不碰 ruleRows 的内容（那是 buildRuleRows 的职责）。
   * 两条路径互不干涉：buildRuleRows 只重建内容不动样式，故重建不会把折叠掀开；
   * 折叠也不跳过重建，故收起态下的值仍是最新的，展开后不会看到过期数据。 */
  private refreshAdvanced(): void {
    this.advancedLabel.textContent = `${this.advancedExpanded ? '▾' : '▸'} 高级调整`
    this.ruleRows.style.display = this.advancedExpanded ? '' : 'none'
  }

  /** 退路按钮：可置灰的文字按钮。置灰时既不响应点击也不 hover 提亮——
   * 直接复用 makeTextButton 的话，灰着还会跟手，用户以为能点 */
  private makeHistoryButton(text: string, role: string, onClick: () => void): { el: HTMLElement; setEnabled: (on: boolean) => void } {
    const el = document.createElement('span')
    el.setAttribute('data-role', role)
    el.textContent = text
    el.style.cssText = `font-size: 11px;`
    let enabled = true
    const paint = (): void => {
      el.style.color = `rgba(255, 255, 255, ${enabled ? UNSELECTED_OPACITY : DISABLED_OPACITY})`
      el.style.cursor = enabled ? 'pointer' : 'default'
    }
    paint()
    el.addEventListener('mouseenter', () => { if (enabled) el.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})` })
    el.addEventListener('mouseleave', paint)
    el.addEventListener('click', (e) => {
      // 折叠头整行可点：不拦住冒泡的话，点撤销会顺带把高级区折叠掉
      ;(e as (Event & { stopPropagation?: () => void }) | undefined)?.stopPropagation?.()
      if (!enabled) return
      onClick()
    })
    return {
      el,
      setEnabled: (on: boolean) => { enabled = on; paint() },
    }
  }

  /** 回出厂：旋钮归位 + 反应列表回完整官方基线。
   * **不传 current 给 macroToMapping**——传了就是「保留用户反应的投影」，那是拖旋钮的语义；
   * 回出厂要的正是连用户自加的反应一起清掉（丢了也能一次撤销拿回来，见设计稿决策 6） */
  private resetToFactory(): void {
    this.macroDraft = { ...DEFAULT_MACRO_KNOBS }
    this.draft = macroToMapping(this.macroDraft)
    this.macroKnobSyncs.forEach((sync) => sync()) // 绕过控件改的 macroDraft：两个 thumb 拨回中点 + 风格行选中态回退均衡
    this.commit()
    this.deps.commitMacroKnobs({ ...this.macroDraft })
    this.macroStale = false // draft 就是基线本身，与旋钮位置必然一致 → 陈旧清除
    this.refreshMacroStaleNote()
    this.buildRuleRows()
  }

  /** 标准层宏旋钮：律动页顶部风格单选 + 两滑块（劲儿/跟手）。macroDraft 播种后建一次，此后不重建
   * （重建会销毁正在操作的滑块，键盘方向键连发 input + change 时会丢焦点）。
   * 拖动 = macroToMapping 投影到 draft 后 preview；松手 = commit 落 mapping + 落 macroKnobs + 重刷专业表。
   * 均衡档 + 两旋钮居中 = 官方默认预设（macroToMapping 不变量）。
   * 注意投影是「全量重铺」：从风格基线（styleBaseline）出发算整套 MappingValues，故连 enabled/source/curve/
   * 输出上下限、以及当前能力矩阵下没渲染出来的目标一并复位——遥控器模型本就如此，
   * 这是 buildRuleRows 那条「被隐目标的规则值原样保留」在宏旋钮路径上的明示例外。 */
  private buildMacroKnobs(): void {
    const slot = this.macroSlot
    slot.innerHTML = ''
    this.macroKnobSyncs = []
    this.macroDisposers.forEach((d) => d()) // 与紧邻两行同款「按重建安全写」——当前唯一调用点不会真的重入，纯防御
    this.macroDisposers = []
    this.macroStaleNote = null // 先清引用：早退路径也不许留着指向已 detach 节点的引用（下方建好后重新赋值）
    if (!this.macroDraft) return // 旋钮位置未播种：留空，播种回调会再调一次（当前不可达，纯防御）

    // 标题行——旧「重置」已挪到高级调整折叠头，与「回出厂」合并（一个语义不留两个近义按钮）
    const header = document.createElement('div')
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 6px;'
    const title = document.createElement('span')
    title.textContent = '一键调感觉'
    title.style.cssText = `font-size: ${GROUP_TITLE_FONT_SIZE}; color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});`
    header.append(title)
    slot.appendChild(header)

    // 风格单选：换整套信号源与曲线基线（劲儿/跟手在选定风格内继续调「多狠」和「多快」）
    // help 文案会经 makeLabelWithHelp 造 ⓘ 图标——借道 helpSink 指向 macroDisposers，与 buildShapeSection
    // 等四区同款手法，使这个图标只在面板 dispose() 时清，不落进随 buildRuleRows 重建而 drain 的 infoDisposers
    let styleRow: HTMLElement
    try {
      this.helpSink = this.macroDisposers
      styleRow = this.makeChoiceRow<MacroStyle>(
        '风格', '换整套跟随信号：均衡=默认，脉冲与段落各半；节奏咬鼓点、氛围跟响度起伏、低音跟贝斯泵动',
        MACRO_STYLES.map((s) => ({ text: s.label, value: s.id })),
        () => this.macroDraft!.style,
        (v) => { this.macroDraft!.style = v; this.applyMacro() },
        {
          ref: (repaint) => { this.macroKnobSyncs.push(repaint) },
          roleFor: (v) => `macro-style-${v}`,
        },
      )
    } finally {
      this.helpSink = null
    }
    styleRow.setAttribute('data-role', 'macro-style-row')
    slot.appendChild(styleRow)

    // 两滑块——复用 makeRange，中点 0.5 刻度，两端文字锚点靠 label 承载
    const knob = (
      role: string, label: string, loWord: string, hiWord: string,
      get: () => number, set: (v: number) => void,
    ): void => {
      const row = this.makeRange({
        label: `${label}　${loWord} → ${hiWord}`,
        min: 0, max: 1, step: 0.01, value: get(), ticks: [0.5],
        format: () => '', // 宏旋钮不显示裸数值（0..1 对普通用户无意义），靠两端词表达
        ref: (set) => { this.macroKnobSyncs.push(() => set(get())) },
        onInput: (v) => { set(v); this.preview() },
        onCommit: (v) => { set(v); this.applyMacro(`macro:${role}`) },
      })
      row.setAttribute('data-role', role)
      slot.appendChild(row)
    }

    knob('macro-knob-strength', '劲儿', '克制', '狂放',
      () => this.macroDraft!.strength, (v) => { this.macroDraft!.strength = v; this.projectMacro() })
    knob('macro-knob-response', '跟手', '脆', '柔',
      () => this.macroDraft!.response, (v) => { this.macroDraft!.response = v; this.projectMacro() })

    // 陈旧提示（遥控器模型：宏旋钮单向覆盖专业表）：专业表手调后点亮，动宏旋钮后熄灭
    const staleNote = document.createElement('div')
    staleNote.setAttribute('data-role', 'macro-stale-note')
    staleNote.textContent = '下方高级调整里有手动改动——动上面的「一键调感觉」会覆盖'
    staleNote.style.cssText = SHAPE_SLEEP_HINT_STYLE
    staleNote.style.display = this.macroStale ? '' : 'none'
    slot.appendChild(staleNote)
    this.macroStaleNote = staleNote
  }

  /** 把当前 macroDraft 投影进 this.draft（拖动中每帧调，供 preview 读）。
   * 「mapping 播种前拖动是 no-op」的旧不变量：getMacroKnobs 可能先于 getMapping 落地
   * （buildMacroKnobs 不等 draft），此时若不早退会凭空造出 draft 并被后到的 getMapping 覆盖——
   * 生产上两者同源于一次 getSettings()，窗口亚毫秒级人手够不着，纯防御性收口。 */
  private projectMacro(): void {
    if (!this.draft) return
    // 传当前 draft：只重铺官方基线反应，用户手加的反应原样保留（见 macroToMapping 注释）——
    // 不传的话拖一下旋钮就把用户写的反应全删了
    if (this.macroDraft) this.draft = macroToMapping(this.macroDraft, this.draft)
  }

  /** 重置/离散一次性应用：投影 + 落 mapping + 落 macroKnobs + 清陈旧位（提示熄灭）+ 重刷专业表 */
  private applyMacro(coalesceKey?: string): void {
    this.projectMacro()
    this.commit(coalesceKey)
    // 传副本：macroDraft 此后仍会被拖动原地改，留了引用的接收方（如单测 mock 的调用记录）会被追溯篡改
    if (this.macroDraft) this.deps.commitMacroKnobs({ ...this.macroDraft })
    this.macroStale = false // draft 刚被投影整套覆盖，与旋钮位置必然一致 → 陈旧清除
    this.refreshMacroStaleNote()
    this.buildRuleRows() // 重刷专业表：让用户看见底下滑块跟着一起动（设计稿受控例外）
  }

  /** 专业表手调 → 置陈旧位并点亮提示（不重建，直接改 display，避免打断专业表拖动 draft） */
  private markMacroStale(): void {
    this.macroStale = true
    this.refreshMacroStaleNote()
  }

  /** 播种期从数据推导陈旧位：存档 mapping ≠ 旋钮位置的投影 ⇒ 专业表被手调过（或老存档没有旋钮字段）
   * → 开局就点亮提示。两个播种回调各调一次，谁后到谁生效；比记账式初值多覆盖跨重启与绕过 UI 改 mapping 两种路径。
   * 两边都必须过 sanitizeMappingValues——defaultRhythmPreset 与 sanitizeRule 的字段声明序不同，
   * 直接 stringify 两个来源必然假阳性。 */
  private syncMacroStale(): void {
    if (!this.draft || !this.macroDraft) return
    this.macroStale = JSON.stringify(sanitizeMappingValues(this.draft))
      !== JSON.stringify(sanitizeMappingValues(macroToMapping(this.macroDraft)))
    this.refreshMacroStaleNote()
  }

  private refreshMacroStaleNote(): void {
    if (this.macroStaleNote) this.macroStaleNote.style.display = this.macroStale ? '' : 'none'
  }

  /** 镜头 tab：声明表渲染（mixer v2 契约化）；draft/preview/commit 链路不变 */
  private buildCameraSection(): void {
    if (!this.cameraDraft) return
    this.cameraDisposers.forEach((d) => d())
    this.cameraDisposers = []
    this.cameraBody.innerHTML = ''
    try {
      this.helpSink = this.cameraDisposers
      this.renderSections(this.cameraBody, CAMERA_SECTIONS, this.cameraDraft,
        (d) => this.deps.previewCamera(d), (d) => this.deps.commitCamera(d))
    } finally {
      this.helpSink = null
    }
  }

  /** 主体分区（B1：区结构 + 临时下拉 + 封面优先。真形状专属参数 Phase C 产生；
   * 临时下拉在 B2 选择器上线后连测试一起删，分区结构保留） */
  private buildShapeSection(): void {
    if (!this.shape) return
    this.shapeDisposers.forEach((d) => d())
    this.shapeDisposers = []
    this.shapeBody.innerHTML = ''

    // 沉睡态提示（亲验反馈②反转）：无音乐时切形状会临时唤醒展示片刻，之后自动回睡——常驻小字说明
    const sleepHint = document.createElement('div')
    sleepHint.textContent = '切换即时生效；无音乐时展示片刻后休眠'
    sleepHint.style.cssText = SHAPE_SLEEP_HINT_STYLE
    this.shapeBody.appendChild(sleepHint)

    // makeLabelWithHelp/makeToggleRow 内部经 makeLabelWithHelp 造 ⓘ 时把 dispose 推进 helpSink——
    // 重建期间借道指向 shapeDisposers，使本区重绘只 drain 自己的图标，不动通用区（评审 I5）
    try {
      this.helpSink = this.shapeDisposers

      // 主体总开关（放页首说明之后、当前形状之前）：选中自定义背景会联动关闭，此处可随时打开
      const showBodyRow = this.makeToggleRow(
        '显示主体', '关闭后隐藏主体粒子形状；星尘、歌词与歌名不受影响。选中自定义背景时会自动关闭',
        () => this.shape!.showBody,
        (v) => { this.deps.setShape({ ...this.shape!, showBody: v }) },
      )
      showBodyRow.setAttribute('data-role', 'shape-show-body')
      this.shapeBody.appendChild(showBodyRow)

      // 只读当前形状（B2：临时下拉退役，切换入口=操作坞形状选择器；此处仅展示，回流更新）
      const currentRow = document.createElement('div')
      currentRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;'
      currentRow.setAttribute('data-role', 'shape-current-row')
      const currentLabel = this.makeLabelWithHelp('当前形状', '切换请用操作坞的形状选择器')
      const currentValue = document.createElement('span')
      currentValue.textContent = shapeById(this.shape!.current).label
      currentValue.style.cssText = `color: rgba(255, 255, 255, ${SELECTED_OPACITY});`
      currentRow.append(currentLabel, currentValue)
      this.shapeBody.appendChild(currentRow)

      this.shapeBody.appendChild(this.makeToggleRow(
        '封面优先', '打开后，歌曲有封面时优先吸成封面粒子；关闭则永远保持所选形状',
        () => this.shape!.coverPriority,
        (v) => { this.deps.setShape({ ...this.shape!, coverPriority: v }) },
      ))

      // fb3 自适应分组：分区随当前形状显隐——粒子运动组常驻（封面优先开着时封面随时可能接管，
      // 封面=粒子体），线条组只在选中频谱环/波形线时出现；自定义形状也是粒子体
      const body = this.currentBody()

      // —— 契约驱动分组（mixer v2：经 shape-tab 适配走统一渲染引擎）——
      // continued=true：本区首组前已有 sleep 提示/当前形状/封面优先/显示主体四行，首组也要分隔线（现状样式）
      if (this.motionDraft) {
        this.renderSections(this.shapeBody, shapeSectionsFor(body), this.motionDraft,
          (d) => this.deps.previewMotion(d), (d) => this.deps.commitMotion(d), { continued: true })
      }
    } finally {
      this.helpSink = null
    }
    // 显隐不在这里管：innerHTML='' 只清子节点，shapeBody 自身的 style.display 不受重建影响，
    // 全程由 showTab 独立掌管（行为不变量「通用 tab 激活时回流重绘后形状区仍隐藏」有测试压阵）
  }

  /** tab 栏：titlebar 下方常驻，切 tab 只做 body/cameraBody/shapeBody/backgroundBody/lyricsBody 的 display 显隐——五容器全程留在 DOM，
   * 映射区乐观 draft 与形状区回流环都不因切换重建（亲验反馈①：两分区堆叠太长） */
  private buildTabBar(): HTMLElement {
    const bar = document.createElement('div')
    // 上下留白对称：tab 夹在标题栏底线与本行底线之间，上 14px 对齐下方的 6px（文字→选中下划线）+ 8px（下划线→底线）
    bar.style.cssText = `display: flex; gap: 20px; margin-top: 14px; padding-bottom: 8px; border-bottom: ${GROUP_DIVIDER};`

    const makeTab = (text: string, tab: TabId): HTMLElement => {
      const el = document.createElement('span')
      el.textContent = text
      el.style.cssText = `
        cursor: pointer;
        font-size: ${TAB_FONT_SIZE};
        letter-spacing: ${TAB_LETTER_SPACING};
        padding-bottom: 6px;
      `
      el.addEventListener('click', () => this.showTab(tab))
      el.addEventListener('mouseenter', () => {
        if (this.activeTab !== tab) el.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})`
      })
      el.addEventListener('mouseleave', () => this.paintTabBar())
      return el
    }

    this.rhythmTabEl = makeTab('律动', 'rhythm')
    this.shapeTabEl = makeTab('主体', 'shape')
    this.cameraTabEl = makeTab('镜头', 'camera')
    this.lyricsTabEl = makeTab('歌词歌名', 'lyrics')
    this.backgroundTabEl = makeTab('背景', 'background')
    bar.append(this.rhythmTabEl, this.shapeTabEl, this.cameraTabEl, this.lyricsTabEl, this.backgroundTabEl) // 定稿序：律动/主体/镜头/歌词歌名/背景
    this.paintTabBar()
    return bar
  }

  private paintTabBar(): void {
    const paint = (el: HTMLElement, tab: TabId): void => {
      const active = this.activeTab === tab
      el.style.color = `rgba(255, 255, 255, ${active ? SELECTED_OPACITY : UNSELECTED_OPACITY})`
      el.style.borderBottom = active ? TAB_ACTIVE_BORDER : TAB_INACTIVE_BORDER
    }
    paint(this.rhythmTabEl, 'rhythm')
    paint(this.cameraTabEl, 'camera')
    paint(this.shapeTabEl, 'shape')
    paint(this.lyricsTabEl, 'lyrics')
    paint(this.backgroundTabEl, 'background')
  }

  /** 打开面板：律动页的反应折叠态**不记忆**，每次开都全收，给用户一个干净起手。
   * 里层「更多」同理——它是外层展开后才看得见的下一级，留着开会让重新打开的第一屏就臃肿。
   * 「高级调整」那一层的展开态是明确要记忆并落盘的（getAdvancedExpanded），此处不碰。 */
  override open(): void {
    // 只在真正「从关到开」时收——openToTab 对已打开的面板等效只切页，不该顺手把用户展开的那条合上
    if (!this.isOpen) {
      this.expandedReactionId = null
      this.moreOpenIds.clear()
      this.refreshExpanded() // 只切 display 与箭头，不重建——重建会打断正在进行的 draft 操作
    }
    super.open()
  }

  /** 对外「打开并直落指定 tab」（卡片层编辑钮入口，v2 亲验反馈②）：先切页再开面板——
   * 开着时等效只切页；互斥退台由 PanelCoordinator 经 onOpenChange 仲裁，无需在此处理 */
  openToTab(tab: TabId): void {
    this.showTab(tab)
    this.open()
  }

  private showTab(tab: TabId): void {
    if (this.activeTab === tab) return
    this.activeTab = tab
    this.body.style.display = tab === 'rhythm' ? '' : 'none'
    this.cameraBody.style.display = tab === 'camera' ? '' : 'none'
    this.shapeBody.style.display = tab === 'shape' ? '' : 'none'
    this.lyricsBody.style.display = tab === 'lyrics' ? '' : 'none'
    this.backgroundBody.style.display = tab === 'background' ? '' : 'none'
    this.paintTabBar()
  }

  /** 一条反应 = 摘要行（常显）+ 展开区（默认折叠）。
   * @param id 反应 id——**不缓存 Reaction 引用**：多个控件共享同一份最新对象，
   *           且增删后 draft 里的数组会重排，缓存引用会写到已被丢弃的对象上
   */
  private buildRuleEditor(id: string): HTMLElement {
    const rule = (): Reaction => this.draft!.reactions.find((r) => r.id === id)!

    const wrap = document.createElement('div')
    wrap.setAttribute('data-role', `rule-${id}`)
    wrap.style.cssText = 'margin-top: 6px;'

    // —— 摘要行：整行可点，展开/收起本条 ——
    // summaryRow 只管布局；文案节点 summary 才是文案的唯一写入点——两者不可合一：
    // 若把文案直接写在 summaryRow 上，summary.textContent 赋值会连 <caret> 这个子节点一起清空
    // （真实 DOM 下 textContent 赋值会清空全部子节点），故 caret 只能是并列的兄弟节点。
    // 点击委托同理：summary 自己有监听（照顾单独点文字），但 caret 与 padding 留白都不在
    // summary 内，得由外层 summaryRow 代为兜底。
    const summaryRow = document.createElement('div')
    summaryRow.setAttribute('data-role', `summary-row-${id}`)
    summaryRow.style.cssText = `
      display: flex;
      align-items: center;
      cursor: pointer;
      padding-left: 14px;
    `
    // 缩进唯一源头：14px 只挂在 summaryRow 上。若同时挂在子节点 summary 上，
    // 真实 DOM 下两层 padding 会叠加成 28px，且与同层的 caret 对不齐（caret 只吃 summaryRow 那份）
    summaryRow.style.paddingLeft = '14px' // 显式属性写：FakeEl 不解析 cssText，断言抓不到
    // 文案分两段渲染：主段（来源名/已关）是主角，注解段（偏离参数）淡一档——注解不该跟主角一样亮。
    // summary 自己保留 REACTION_OPACITY，主段继承它，只有注解段单独压暗
    const summary = document.createElement('span')
    summary.setAttribute('data-role', `summary-${id}`)
    summary.style.cssText = `flex: 1; font-size: 13px; color: rgba(255, 255, 255, ${REACTION_OPACITY});`
    summary.style.color = `rgba(255, 255, 255, ${REACTION_OPACITY})`
    const summaryLead = document.createElement('span')
    const summaryNote = document.createElement('span')
    summaryNote.setAttribute('data-role', `summary-note-${id}`)
    summaryNote.style.cssText = `color: rgba(255, 255, 255, ${SUMMARY_NOTE_OPACITY});`
    summaryNote.style.color = `rgba(255, 255, 255, ${SUMMARY_NOTE_OPACITY})`
    summary.append(summaryLead, summaryNote)
    const caret = document.createElement('span')
    caret.setAttribute('data-role', `caret-${id}`)
    caret.style.cssText = `font-size: 11px; color: rgba(255, 255, 255, ${UNSELECTED_OPACITY});`
    caret.textContent = '▸'
    summaryRow.append(summary, caret)

    // 摘要文案的唯一写入点：来源名 + 偏离注解；已关则整行降透明度
    const paint = (): void => {
      const s = summarizeReaction(rule(), this.baselineFor(id))
      const seg = summarySegments(s)
      summaryLead.textContent = seg.lead
      summaryNote.textContent = seg.note
      summaryRow.style.opacity = s.disabled ? '0.5' : '1'
    }
    paint()

    const toggleExpanded = (): void => {
      this.expandedReactionId = this.expandedReactionId === id ? null : id
      this.refreshExpanded(summary)
    }
    summary.addEventListener('click', toggleExpanded)
    summaryRow.addEventListener('click', (e) => {
      // 点在 summary 自身（或其内部）：summary 的监听器已经处理，冒泡上来不再重复触发
      if (clickedInside(e, summary)) return
      toggleExpanded()
    })
    wrap.appendChild(summaryRow)

    // —— 展开区：默认折叠，但 DOM 始终建好（切 display 而非懒建） ——
    const detail = document.createElement('div')
    detail.setAttribute('data-role', `detail-${id}`)
    // 12px：展开区是层级最深的一层，字号也要比属性名/摘要行（13px）小一档，
    // 否则层级只靠透明度撑，字号维度是平的
    detail.style.cssText = `padding-left: 28px; margin: 8px 0; font-size: ${DETAIL_FONT_SIZE};`
    detail.style.display = 'none' // 显式属性写：FakeEl 不解析 cssText
    detail.style.paddingLeft = '28px'
    detail.style.fontSize = DETAIL_FONT_SIZE

    const enableRow = this.makeToggleRow(
      '启用', '关掉后这条不参与驱动',
      () => rule().enabled,
      (v) => { rule().enabled = v; this.commit(); this.markMacroStale(); paint() },
    )
    enableRow.setAttribute('data-role', `rule-enabled-${id}`)
    detail.appendChild(enableRow)

    detail.appendChild(this.makeChoiceRow<AudioFeature>(
      '来源', '选择由哪个音频特征来驱动',
      PROPERTY_CATALOG[rule().target.element][rule().target.property].allowedSources
        .map((s) => ({ text: SOURCE_LABELS[s], value: s })),
      () => rule().source,
      (v) => { rule().source = v; this.commit(); this.markMacroStale(); paint() },
    ))

    detail.appendChild(this.makeRange({
      label: '强度', help: '驱动这个目标的强弱倍数', min: 0, max: GAIN_MAX, step: 0.05, value: rule().gain,
      onInput: (v) => { rule().gain = v; this.preview(); paint() },
      onCommit: (v) => { rule().gain = v; this.commit(`gain:${id}`); this.markMacroStale(); paint() },
    }))
    detail.appendChild(this.makeRange({
      label: '平滑', help: '越大，响应越缓越柔', min: 0, max: SMOOTHING_MAX_MS, step: 10, value: rule().smoothingMs,
      format: (v) => `${Math.round(v)}ms`,
      onInput: (v) => { rule().smoothingMs = v; this.preview(); paint() },
      onCommit: (v) => { rule().smoothingMs = v; this.commit(`smoothing:${id}`); this.markMacroStale(); paint() },
    }))
    // 「更多」子折叠：下限/上限几乎从不动（官方基线只有背景显影用到），
    // 常驻会让一条反应吃掉整屏。DOM 始终建好，只切 display。
    const moreBox = document.createElement('div')
    moreBox.setAttribute('data-role', `more-${id}`)

    // 展开态存 moreOpenIds（实例字段）而非闭包局部量——与 expandedReactionId 同款纪律：
    // 重建后按 id 恢复，否则外层手风琴还开着、里层「更多」却自己合上了（切形状会走到这条路径）
    const moreToggle = this.makeTextButton('▸ 更多', `more-toggle-${id}`, () => {
      if (this.moreOpenIds.has(id)) this.moreOpenIds.delete(id)
      else this.moreOpenIds.add(id)
      paintMore()
    })
    // makeTextButton 造的是 span：独占一行 + 吃得下 margin-top，都得靠 display: block 补回来
    // （行内元素的垂直外边距不生效）
    moreToggle.style.display = 'block'
    moreToggle.style.userSelect = 'none'
    moreToggle.style.marginTop = '4px'
    const paintMore = (): void => {
      const on = this.moreOpenIds.has(id)
      moreBox.style.display = on ? '' : 'none'
      moreToggle.textContent = `${on ? '▾' : '▸'} 更多`
    }
    paintMore()
    // 登记放在 paintMore 就绪之后：refreshExpanded 要靠它把里层折叠一并刷到位
    this.reactionParts.set(id, { detail, caret, paint, paintMore })

    detail.appendChild(moreToggle)
    moreBox.appendChild(this.makeRange({
      label: '下限', help: '输出的最小值', min: 0, max: 1, step: 0.01, value: rule().outputMin,
      onInput: (v) => { rule().outputMin = v; this.preview(); paint() },
      onCommit: (v) => { rule().outputMin = v; this.commit(`outputMin:${id}`); this.markMacroStale(); paint() },
    }))
    moreBox.appendChild(this.makeRange({
      label: '上限', help: '输出的最大值', min: 0, max: 1, step: 0.01, value: rule().outputMax,
      onInput: (v) => { rule().outputMax = v; this.preview(); paint() },
      onCommit: (v) => { rule().outputMax = v; this.commit(`outputMax:${id}`); this.markMacroStale(); paint() },
    }))
    detail.appendChild(moreBox)

    // 复制/删除移到展开区末尾——与属性级的「添加」拉开层级，不再并排在同一视觉重量上
    const actions = document.createElement('div')
    actions.setAttribute('data-role', `reaction-actions-${id}`)
    actions.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px;'
    actions.appendChild(this.makeTextButton('复制', `copy-reaction-${id}`, () => {
      const src = rule()
      const at = this.draft!.reactions.indexOf(src)
      // 传当前列表查重：id 会随存档持久化，而发号计数器每次重开应用都归零，
      // 不查重就可能与存档里的旧号相同——两条同 id 的反应会被编辑器当成同一条改
      const copy = { ...src, id: newUserReactionId(this.draft!.reactions), target: { ...src.target } }
      this.draft!.reactions.splice(at + 1, 0, copy)
      this.expandedReactionId = copy.id // 展开副本：否则看不出发生了什么
      this.afterReactionListChanged()
    }))
    actions.appendChild(this.makeTextButton('删除', `delete-reaction-${id}`, () => {
      const at = this.draft!.reactions.indexOf(rule())
      this.draft!.reactions.splice(at, 1)
      if (this.expandedReactionId === id) this.expandedReactionId = null
      this.moreOpenIds.delete(id) // 反应没了，它的子折叠态也不该留在集合里
      this.afterReactionListChanged()
    }))
    detail.appendChild(actions)

    wrap.appendChild(detail)
    return wrap
  }

  /** label + 可选信息图标——choice/toggle/range 三种行共用，help 有值时在文字右侧挂一个 ⓘ（hover 出解释） */
  private makeLabelWithHelp(label: string, help?: string): HTMLElement {
    const labelGroup = document.createElement('span')
    labelGroup.style.cssText = `display: inline-flex; align-items: center; color: rgba(255, 255, 255, ${LABEL_OPACITY});`
    const labelEl = document.createElement('span')
    labelEl.textContent = label
    labelGroup.appendChild(labelEl)
    if (help) {
      const helpIcon = makeInfoIcon(help)
      labelGroup.appendChild(helpIcon.el)
      ;(this.helpSink ?? this.infoDisposers).push(helpIcon.dispose)
    }
    return labelGroup
  }

  /** 离散可点选项行（启用/来源共用）——文字 span 风格，透明度层级仿 settings-panel：
   * 未选 UNSELECTED_OPACITY / hover HOVER_OPACITY / 选中 SELECTED_OPACITY。
   * 点击直接改 draft 后本地重绘——tuning-panel 的乐观本地环，非 settings-panel 的单向回流 */
  private makeChoiceRow<T>(
    label: string,
    help: string | undefined,
    options: Array<{ text: string; value: T }>,
    get: () => T,
    set: (v: T) => void,
    opts?: {
      /** 回传重绘钩子——调用方绕过点击改了值时（如重置）用它刷新选中态 */
      ref?: (repaint: () => void) => void
      /** 给每个选项 span 打测试锚点 */
      roleFor?: (v: T) => string
    },
  ): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; flex-direction: column; gap: 2px; margin-top: 2px;'

    const labelEl = this.makeLabelWithHelp(label, help)

    const valuesEl = document.createElement('span')
    valuesEl.style.cssText = 'display: flex; flex-wrap: wrap; gap: 2px 14px;'

    const spans: HTMLElement[] = []
    const paint = (): void => {
      const current = get()
      options.forEach((opt, i) => {
        spans[i].style.color = `rgba(255, 255, 255, ${opt.value === current ? SELECTED_OPACITY : UNSELECTED_OPACITY})`
      })
    }
    for (const opt of options) {
      const span = document.createElement('span')
      span.textContent = opt.text
      span.style.cssText = 'cursor: pointer;'
      if (opts?.roleFor) span.setAttribute('data-role', opts.roleFor(opt.value))
      span.addEventListener('click', () => { set(opt.value); paint() })
      span.addEventListener('mouseenter', () => {
        if (opt.value !== get()) span.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})`
      })
      span.addEventListener('mouseleave', paint)
      spans.push(span)
      valuesEl.appendChild(span)
    }
    paint()
    opts?.ref?.(paint)

    row.append(labelEl, valuesEl)
    return row
  }

  /** 「启用」行——iOS 风格透明白开关，取代原文字开/关选项。
   * **命中区只有开关自身**：本行被五个 tab 共用（律动/主体/镜头/歌词歌名/背景），
   * 若整行可点，标签与 ⓘ 也会成为命中区，「点一下看解释」就变成了静默改设置并落盘。 */
  private makeToggleRow(label: string, help: string | undefined, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;'

    row.appendChild(this.makeLabelWithHelp(label, help))

    const toggleHost = document.createElement('span')
    row.appendChild(toggleHost)
    const toggle = new ToggleSwitch(toggleHost, { checked: get(), onChange: set })
    // 测试锚点：开关是本行唯一命中区，供用例直接定位，不必靠子节点位置摸索
    toggle.el.setAttribute('data-role', 'toggle-track')

    return row
  }

  private makeRange(opts: RangeSpec): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; flex-direction: column; gap: 1px; margin-top: 2px;'

    const labelRow = document.createElement('div')
    labelRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;'
    const labelGroup = this.makeLabelWithHelp(opts.label, opts.help)
    const valueEl = document.createElement('span')
    valueEl.style.cssText = `color: rgba(255, 255, 255, ${LABEL_OPACITY});`
    const fmt = opts.format ?? ((v: number) => opts.step % 1 === 0 ? String(Math.round(v)) : v.toFixed(2))
    valueEl.textContent = fmt(opts.value)
    labelRow.append(labelGroup, valueEl)

    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'tp-slider'
    input.min = String(opts.min)
    input.max = String(opts.max)
    input.step = String(opts.step)
    input.value = String(opts.value)
    input.style.cssText = 'pointer-events: auto;'
    // 回写 thumb 同时同步显示值，锁死「thumb 动了、右侧数值跟着动」这条不变量——
    // 调用方（宏旋钮重置）不必自己记得同步 valueEl
    const setValue = (v: number): void => { input.value = String(v); valueEl.textContent = fmt(v) }
    opts.ref?.(setValue)
    // 拖动中：input 事件（每帧触发）→ 只 preview，不落盘；snap 前置——显示值=回调值=吸附后值。
    // 吸附命中时回写 thumb（亲验 fb1：只吸数值不吸钮感知不到——磁吸手感的视觉主体是钮跳到节点）
    input.addEventListener('input', () => {
      const raw = Number(input.value)
      const v = opts.snap ? opts.snap(raw) : raw
      if (v !== raw) input.value = String(v)
      valueEl.textContent = fmt(v)
      opts.onInput(v)
    })
    // 松手：change 事件（release/blur 触发一次）→ preview + commit 落盘；同款回写让钮停在节点上
    input.addEventListener('change', () => {
      const raw = Number(input.value)
      const v = opts.snap ? opts.snap(raw) : raw
      if (v !== raw) input.value = String(v)
      opts.onCommit(v)
    })

    // 节点刻度条：吸附节点的视觉锚（挂在轨道下方 1px，点足够淡不抢层级）
    if (opts.ticks && opts.ticks.length > 0) {
      const strip = document.createElement('div')
      strip.setAttribute('data-role', 'tick-strip')
      strip.style.position = 'relative'
      strip.style.height = '3px'
      strip.style.marginTop = '-4px' // 贴回轨道正下方（slider 自带 14px 高度含留白）
      for (const t of opts.ticks) {
        const dot = document.createElement('span')
        dot.setAttribute('data-role', 'tick')
        dot.style.position = 'absolute'
        dot.style.left = `${(((t - opts.min) / (opts.max - opts.min)) * 100).toFixed(1)}%`
        dot.style.width = '2px'
        dot.style.height = '2px'
        dot.style.borderRadius = '50%'
        dot.style.background = 'rgba(255, 255, 255, 0.28)'
        strip.appendChild(dot)
      }
      row.append(labelRow, input, strip)
      return row
    }
    row.append(labelRow, input)
    return row
  }

  /** 组标题行（歌词/背景/镜头/主体 tab 共用）：组名 + 可选 ⓘ（desc 为空则不造图标，主体 tab 契约组标题无说明文案）；
   * first=组间分隔线有无 */
  private makeGroupHeader(label: string, desc: string, first: boolean): HTMLElement {
    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      align-items: center;
      font-size: ${GROUP_TITLE_FONT_SIZE};
      color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});
      margin-top: ${first ? '4px' : '18px'};
      padding-top: ${first ? '0' : '14px'};
      border-top: ${first ? 'none' : GROUP_DIVIDER};
    `
    const title = document.createElement('span')
    title.textContent = label
    header.appendChild(title)
    if (desc) {
      const icon = makeInfoIcon(desc)
      header.appendChild(icon.el)
      ;(this.helpSink ?? this.infoDisposers).push(icon.dispose)
    }
    return header
  }

  /** 声明式渲染引擎（mixer v2 契约化）：SectionDef[] → 组标题 + range/toggle/choice 行。
   * 值流沿用各 tab 既有语义：拖动 preview、松手/离散 preview+commit（toggle 可声明 commitOnly）。
   * opts.continued=true 表示接在同容器前一批 sections 之后（首组也要分隔线，歌词 tab 双 draft 用） */
  private renderSections<D>(
    container: HTMLElement,
    sections: Array<MixerSectionDef<D>>,
    draft: D,
    preview: (d: D) => void,
    commit: (d: D) => void,
    opts?: { continued?: boolean },
  ): void {
    sections.forEach((s, i) => {
      const locked = s.lockWhen?.(draft) ?? false
      container.appendChild(this.makeGroupHeader(s.title, s.desc, i === 0 && !opts?.continued))
      const lockRow = (row: HTMLElement): HTMLElement => {
        if (s.rowRole) row.setAttribute('data-role', s.rowRole)
        if (locked) {
          row.style.opacity = '0.45'
          row.style.pointerEvents = 'none'
        }
        return row
      }
      for (const c of s.controls) {
        if (c.kind === 'range') {
          container.appendChild(lockRow(this.makeRange({
            label: c.label, help: c.help, min: c.min, max: c.max, step: c.step,
            format: c.format, snap: c.snap, ticks: c.ticks, value: c.get(draft),
            onInput: (v) => { c.set(draft, v); preview(draft) },
            onCommit: (v) => { c.set(draft, v); preview(draft); commit(draft) },
          })))
        } else if (c.kind === 'toggle') {
          container.appendChild(lockRow(this.makeToggleRow(
            c.label, c.help,
            () => c.get(draft),
            (v) => { c.set(draft, v); if (!c.commitOnly) preview(draft); commit(draft) },
          )))
        } else {
          container.appendChild(lockRow(this.makeChoiceRow(
            c.label, c.help, c.options,
            () => c.get(draft),
            (v) => { c.set(draft, v); preview(draft); commit(draft) },
          )))
        }
      }
      if (locked && s.lockedNote) {
        const note = document.createElement('div')
        note.setAttribute('data-role', s.noteRole ?? 'locked-note')
        note.textContent = s.lockedNote
        note.style.cssText = 'font-size: 11px; color: rgba(255, 255, 255, 0.45); margin-top: 6px;'
        container.appendChild(note)
      }
    })
  }

  /** 歌词歌名 tab：声明表渲染（mixer v2 契约化）；两 draft 齐了才建，内容静态只建一次 */
  private buildLyricsSection(): void {
    if (!this.titleDraft || !this.lyricsDraft) return
    this.lyricsDisposers.forEach((d) => d())
    this.lyricsDisposers = []
    this.lyricsBody.innerHTML = ''
    try {
      this.helpSink = this.lyricsDisposers
      this.renderSections(this.lyricsBody, TITLE_SECTIONS, this.titleDraft,
        (d) => this.deps.previewTitleFx(d), (d) => this.deps.commitTitleFx(d))
      this.renderSections(this.lyricsBody, LYRICS_SECTIONS, this.lyricsDraft,
        (d) => this.deps.previewLyricsFx(d), (d) => this.deps.commitLyricsFx(d), { continued: true })
    } finally {
      this.helpSink = null
    }
  }

  /** 背景 tab：声明表渲染（mixer v2 契约化）；互斥置灰由声明的 lockWhen 表达，
   * onBackgroundChanged 回流全量重建时 lock 态随 current 翻转（既有语义不变） */
  private buildBackgroundSection(): void {
    if (!this.backgroundDraft) return
    this.backgroundDisposers.forEach((d) => d())
    this.backgroundDisposers = []
    this.backgroundBody.innerHTML = ''
    try {
      this.helpSink = this.backgroundDisposers
      this.renderSections(this.backgroundBody, BACKGROUND_SECTIONS, this.backgroundDraft,
        (d) => this.deps.previewBackgroundFx(d), (d) => this.deps.commitBackgroundFx(d))
    } finally {
      this.helpSink = null
    }
  }

  // 五分区容器只读测试口——fake DOM 按创建序扒容器脆，显隐断言走这里
  /** 律动区容器（getter 名字保留不改：测试大量引用） */
  get generalBodyForTest(): HTMLElement { return this.body }
  get cameraBodyForTest(): HTMLElement { return this.cameraBody }
  get shapeBodyForTest(): HTMLElement { return this.shapeBody }
  get lyricsBodyForTest(): HTMLElement { return this.lyricsBody }
  get backgroundBodyForTest(): HTMLElement { return this.backgroundBody }

  override dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown as EventListener)
    // 先 drain 六区各自的信息图标（摘各自 tooltip 节点 + 卸监听），再走基座 dispose——防面板销毁后残留孤儿 tooltip
    this.infoDisposers.forEach((d) => d())
    this.infoDisposers = []
    this.macroDisposers.forEach((d) => d())
    this.macroDisposers = []
    this.cameraDisposers.forEach((d) => d())
    this.cameraDisposers = []
    this.shapeDisposers.forEach((d) => d())
    this.shapeDisposers = []
    this.lyricsDisposers.forEach((d) => d())
    this.lyricsDisposers = []
    this.backgroundDisposers.forEach((d) => d())
    this.backgroundDisposers = []
    super.dispose()
  }
}
