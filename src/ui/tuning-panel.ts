// 调音台面板——收敛到 BasePanel（Phase A2 T3）：外壳/显影/开合/Esc/点外部关/固定标题均由基座提供，
// 本文件只留内容（五类 VisualTarget 分组 + rule 编辑器）与 preview/commit/draft 逻辑。
// 与 settings-panel 的严格单向环不同：这里刻意维护本地乐观 draft（拖动实时反馈），
// 播种只发生一次（getMapping），此后控件事件直接改 draft + preview(拖动中)/commit(松手落盘)。
// 退台 profile='camera'（仅镜头后拉，不像设置那样接管整场景，spec §9）——是否触发/如何与设置
// 互斥交给 PanelCoordinator（Task 2），本文件不接 uiStage。
import { BasePanel } from './base-panel'
import { ToggleSwitch } from './toggle-switch'
import { makeInfoIcon } from './info-icon'
import {
  VISUAL_TARGETS,
  type AudioFeature,
  type MappingRule,
  type MappingValues,
  type VisualTarget,
} from '../scenes/nebula/mapping/types'
import { macroToMapping, DEFAULT_MACRO_KNOBS, MACRO_STYLES, type MacroKnobs, type MacroStyle } from '../scenes/nebula/mapping/macro'
import { GAIN_MAX, MAPPING_SPEC, SMOOTHING_MAX_MS, sanitizeMappingValues, type MappingSlotSpec } from '../scenes/nebula/mapping/spec'
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

/** 目标（英文枚举）→ 中文显示。仅用于渲染，底层 patch/白名单一律走英文枚举（item 5.1 铁律）。 */
const TARGET_LABELS: Record<VisualTarget, string> = {
  space: '空间', brightness: '亮度', density: '密度', thickness: '厚度', speed: '速度',
}

/** 组标题 ⓘ 的简述文案——只讲这个目标是什么，不重复组名/规则名（item 6：组标题 ⓘ 不再借用 primary spec.label） */
const TARGET_DESC: Record<VisualTarget, string> = {
  speed: '整体运动的快慢',
  density: '看到的粒子多少（不等于真实总数）',
  space: '扩张、收缩、朝相机的纵深',
  brightness: '明暗与闪光',
  thickness: '粒径与光丝的厚重',
}

/** 来源（AudioFeature 英文枚举）→ 中文显示。同上，只在显示层生效。 */
const SOURCE_LABELS: Record<AudioFeature, string> = {
  beat: '鼓点', downbeat: '重拍', low: '低频', mid: '中频', high: '高频',
  energy: '能量', drop: '爆点', loudness: '响度', silence: '静默', tempo: '节奏速度',
}

// 透明度层级——与 settings-panel 完全同源（label/未选/hover/选中）
const LABEL_OPACITY = '0.5'
const SELECTED_OPACITY = '0.85'
const UNSELECTED_OPACITY = '0.35'
const HOVER_OPACITY = '0.6'

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
  /** 宏旋钮本地乐观态（二期标准层）：getMacroKnobs 播种一次，此后拖动改此值 + 投影到 draft */
  private macroDraft: MacroKnobs | null = null
  /** 专业表被手动改过、宏旋钮位置已陈旧（遥控器模型：宏旋钮单向覆盖专业表，下次动旋钮会抹掉手调）
   * ——控制陈旧提示显隐。播种时由 syncMacroStale 从「存档 mapping vs 旋钮位置的投影」推导，此后会话内记账维护 */
  private macroStale = false
  /** 陈旧提示节点引用——markMacroStale/applyMacro 直接改 display，不重建，避免打断专业表拖动 draft */
  private macroStaleNote: HTMLElement | null = null
  /** 高级调整（专业表）是否展开——播种一次，此后点击折叠头翻转并落盘 */
  private advancedExpanded = false
  /** 折叠头节点引用：翻转时改箭头文案，不重建 */
  private advancedToggle: HTMLElement | null = null
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
    })

    // 宏旋钮播种（二期标准层）：读一次旋钮位置，把两滑块画进 macroSlot（此后不再重建）
    void deps.getMacroKnobs().then((k) => {
      this.macroDraft = { ...k }
      this.syncMacroStale()
      this.buildMacroKnobs()
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
      this.buildRuleRows() // 律动页按能力矩阵过滤，播种形状后需重渲（buildRuleRows 对 !this.draft 已有早退，时序无关）
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
    })
    deps.onBackgroundChanged((b) => {
      // 同 channel 多订阅者共享同一广播对象，draft 就地突变会污染 shape-picker/场景的快照，须 clone 隔离
      this.backgroundDraft = structuredClone(b)
      this.buildBackgroundSection() // 全量重建：置灰态跟随 current 翻转（拖动中 commit 才触发回流，无中断风险）
    })
  }

  /** 拖动中：只 preview，不落盘 */
  private preview(): void {
    if (this.draft) this.deps.previewMapping(this.draft)
  }

  /** 松手/离散选择：preview 收尾 + 落盘 */
  private commit(): void {
    if (!this.draft) return
    this.deps.previewMapping(this.draft)
    this.deps.commitMapping(this.draft)
  }

  /** 当前形状的主体类（能力矩阵/契约表共用键）：自定义形状=粒子体；未播种时按粒子兜底 */
  private currentBody(): BodyKind {
    if (!this.shape) return 'particles'
    return this.shape.customCurrent ? 'particles' : shapeById(this.shape.current).body ?? 'particles'
  }

  /** 专业表规则行：只重建 ruleRows 这一层——宏旋钮子树与页首说明不受影响 */
  private buildRuleRows(): void {
    if (!this.draft) return
    // 重建前先 drain 上一批信息图标（摘 tooltip 节点 + 卸监听），防 ruleRows.innerHTML='' 后孤儿化 <div data-tooltip>
    // （宏旋钮区的风格行带 help 会造图标，但走 macroDisposers 专属桶，不落进这里，drain 不会牵连 macroSlot）
    this.infoDisposers.forEach((d) => d())
    this.infoDisposers = []
    this.ruleRows.innerHTML = ''

    // 能力矩阵过滤（mixer v2）：只渲染当前形状消费的目标；被隐目标的规则值在 draft/存档原样保留。
    // 只按当前形状能力判断——真正的粒子接管判据是 coverPriority && coverCloud（resolve.ts），
    // coverCloud 是运行时状态面板拿不到；宁可封面接管瞬间暂缺有效组，也不对激光/点阵显示无效死件（零死件优先）
    const capable = rhythmTargetsFor(this.currentBody())
    VISUAL_TARGETS.filter((t) => capable.includes(t)).forEach((target, i) => {
      const slot = MAPPING_SPEC[target]
      // 组标题——原「组名 + 独立解释文字行」收拢成一行：组名 + 信息图标（hover 出 primary 规则的解释）
      const groupHeader = document.createElement('div')
      groupHeader.style.cssText = `
        display: flex;
        align-items: center;
        font-size: ${GROUP_TITLE_FONT_SIZE};
        color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});
        margin-top: 18px;
        padding-top: ${i === 0 ? '0' : '14px'};
        border-top: ${i === 0 ? 'none' : GROUP_DIVIDER};
      `
      const groupTitle = document.createElement('span')
      groupTitle.textContent = TARGET_LABELS[target]
      groupHeader.appendChild(groupTitle)
      const groupIcon = makeInfoIcon(TARGET_DESC[target])
      groupHeader.appendChild(groupIcon.el)
      this.infoDisposers.push(groupIcon.dispose)
      this.ruleRows.appendChild(groupHeader)
      this.ruleRows.appendChild(this.buildRuleEditor(target, 'primary', slot.primary))
      if (slot.secondary) this.ruleRows.appendChild(this.buildRuleEditor(target, 'secondary', slot.secondary))
    })
  }

  /** 「高级调整」折叠头：整行可点，翻转展开态 + 落盘。只建一次，此后靠 refreshAdvanced 改文案 */
  private buildAdvancedToggle(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-role', 'advanced-toggle')
    el.style.cssText = ADVANCED_TOGGLE_STYLE
    el.addEventListener('click', () => {
      this.advancedExpanded = !this.advancedExpanded
      this.refreshAdvanced()
      this.deps.commitAdvancedExpanded(this.advancedExpanded)
    })
    el.addEventListener('mouseenter', () => { el.style.color = `rgba(255, 255, 255, ${SELECTED_OPACITY})` })
    el.addEventListener('mouseleave', () => { el.style.color = `rgba(255, 255, 255, ${GROUP_TITLE_OPACITY})` })
    this.advancedToggle = el
    return el
  }

  /** 折叠只切 display 与箭头文案——绝不碰 ruleRows 的内容（那是 buildRuleRows 的职责）。
   * 两条路径互不干涉：buildRuleRows 只重建内容不动样式，故重建不会把折叠掀开；
   * 折叠也不跳过重建，故收起态下的值仍是最新的，展开后不会看到过期数据。 */
  private refreshAdvanced(): void {
    if (this.advancedToggle) this.advancedToggle.textContent = `${this.advancedExpanded ? '▾' : '▸'} 高级调整`
    this.ruleRows.style.display = this.advancedExpanded ? '' : 'none'
  }

  /** 标准层宏旋钮：律动页顶部风格单选 + 两滑块（劲儿/跟手）+ 重置。macroDraft 播种后建一次，此后不重建
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

    // 标题行 + 重置
    const header = document.createElement('div')
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 6px;'
    const title = document.createElement('span')
    title.textContent = '一键调感觉'
    title.style.cssText = `font-size: ${GROUP_TITLE_FONT_SIZE}; color: rgba(255, 255, 255, ${GROUP_TITLE_OPACITY});`
    const reset = document.createElement('span')
    reset.setAttribute('data-role', 'macro-reset')
    reset.textContent = '重置'
    reset.style.cssText = `cursor: pointer; font-size: 12px; color: rgba(255, 255, 255, ${UNSELECTED_OPACITY});`
    reset.addEventListener('mouseenter', () => { reset.style.color = `rgba(255, 255, 255, ${HOVER_OPACITY})` })
    reset.addEventListener('mouseleave', () => { reset.style.color = `rgba(255, 255, 255, ${UNSELECTED_OPACITY})` })
    reset.addEventListener('click', () => {
      this.macroDraft = { ...DEFAULT_MACRO_KNOBS }
      this.macroKnobSyncs.forEach((sync) => sync()) // 绕过控件改的 macroDraft：两个 thumb 拨回中点 + 风格行选中态回退均衡
      this.applyMacro()   // 投影 + commit + 重刷
    })
    header.append(title, reset)
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
        onCommit: (v) => { set(v); this.applyMacro() },
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
    if (this.macroDraft) this.draft = macroToMapping(this.macroDraft)
  }

  /** 重置/离散一次性应用：投影 + 落 mapping + 落 macroKnobs + 清陈旧位（提示熄灭）+ 重刷专业表 */
  private applyMacro(): void {
    this.projectMacro()
    this.commit()
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

  private buildRuleEditor(target: VisualTarget, slotKey: 'primary' | 'secondary', spec: MappingSlotSpec): HTMLElement {
    // 每次调用都从 this.draft 重新取——不缓存引用快照，保证多个控件共享同一份最新 rule
    const rule = (): MappingRule => {
      const t = this.draft!.targets[target]
      return (slotKey === 'primary' ? t.primary : t.secondary)!
    }

    const wrap = document.createElement('div')
    wrap.style.cssText = 'margin: 4px 0 8px;'
    wrap.setAttribute('data-role', `rule-${target}-${slotKey}`)

    // 多规则组（有 secondary）：primary/secondary 各给一条文字子标题（规则子名，取 spec.label「·」后半段），
    // 让每条规则有真实标题而不是孤零零的信息图标（item 6）。单规则组不加子标题，控件直接跟组标题走。
    if (MAPPING_SPEC[target].secondary) {
      const subName = spec.label.includes('·') ? spec.label.split('·').pop()! : spec.label
      const subHeader = document.createElement('div')
      subHeader.textContent = subName
      subHeader.style.cssText = `
        font-size: 12px;
        color: rgba(255, 255, 255, 0.5);
        margin-top: 10px;
        padding-top: 6px;
        border-top: 1px solid rgba(255, 255, 255, 0.04);
      `
      wrap.appendChild(subHeader)
    }

    wrap.appendChild(this.makeToggleRow(
      '启用', '关掉后这条不参与驱动',
      () => rule().enabled,
      (v) => { rule().enabled = v; this.commit(); this.markMacroStale() },
    ))

    wrap.appendChild(this.makeChoiceRow<AudioFeature>(
      '来源', '选择由哪个音频特征来驱动',
      spec.allowedSources.map((s) => ({ text: SOURCE_LABELS[s], value: s })),
      () => rule().source,
      (v) => { rule().source = v; this.commit(); this.markMacroStale() },
    ))

    wrap.appendChild(this.makeRange({
      label: '强度', help: '驱动这个目标的强弱倍数', min: 0, max: GAIN_MAX, step: 0.05, value: rule().gain,
      onInput: (v) => { rule().gain = v; this.preview() },
      onCommit: (v) => { rule().gain = v; this.commit(); this.markMacroStale() },
    }))
    wrap.appendChild(this.makeRange({
      label: '平滑', help: '越大，响应越缓越柔', min: 0, max: SMOOTHING_MAX_MS, step: 10, value: rule().smoothingMs,
      format: (v) => `${Math.round(v)}ms`,
      onInput: (v) => { rule().smoothingMs = v; this.preview() },
      onCommit: (v) => { rule().smoothingMs = v; this.commit(); this.markMacroStale() },
    }))
    wrap.appendChild(this.makeRange({
      label: '下限', help: '输出的最小值', min: 0, max: 1, step: 0.01, value: rule().outputMin,
      onInput: (v) => { rule().outputMin = v; this.preview() },
      onCommit: (v) => { rule().outputMin = v; this.commit(); this.markMacroStale() },
    }))
    wrap.appendChild(this.makeRange({
      label: '上限', help: '输出的最大值', min: 0, max: 1, step: 0.01, value: rule().outputMax,
      onInput: (v) => { rule().outputMax = v; this.preview() },
      onCommit: (v) => { rule().outputMax = v; this.commit(); this.markMacroStale() },
    }))

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

  /** 「启用」行——iOS 风格透明白开关（item 5），取代原文字开/关选项 */
  private makeToggleRow(label: string, help: string | undefined, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 4px;'

    row.appendChild(this.makeLabelWithHelp(label, help))

    const toggleHost = document.createElement('span')
    row.appendChild(toggleHost)
    new ToggleSwitch(toggleHost, { checked: get(), onChange: set })

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
