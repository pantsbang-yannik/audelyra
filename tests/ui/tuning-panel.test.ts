import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TuningPanel, type TuningPanelDeps } from '../../src/ui/tuning-panel'
import { PanelCoordinator, type PanelLike, type UiStageLike } from '../../src/ui/panel-coordinator'
import type { UiFocusProfile } from '../../src/scenes/types'
import { defaultRhythmPreset, sanitizeMappingValues } from '../../src/scenes/nebula/mapping/spec'
import type { MappingValues } from '../../src/scenes/nebula/mapping/types'
import { DEFAULT_MACRO_KNOBS, macroToMapping, type MacroKnobs } from '../../src/scenes/nebula/mapping/macro'
import type { ShapeSettings } from '../../src/scenes/nebula/shapes/types'
import { DEFAULT_MOTION_SETTINGS } from '../../src/scenes/nebula/motion/types'
import { DEFAULT_CAMERA_SETTINGS } from '../../src/scenes/nebula/camera-types'
import { DEFAULT_TITLE_SETTINGS } from '../../src/scenes/nebula/title-fx'
import { DEFAULT_LYRICS_SETTINGS } from '../../src/scenes/nebula/lyrics/lyrics-fx'
import { DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from '../../src/scenes/nebula/background-types'

/** 轻量假「设置」面板——只为验证互斥，不需要真实 DOM（同 panel-coordinator.test.ts 的 FakePanel） */
class FakeSettingsPanel implements PanelLike {
  onOpenChange: ((open: boolean) => void) | null = null
  private open_ = false
  readonly retreatProfile: UiFocusProfile = 'full'
  get isOpen(): boolean { return this.open_ }
  open(): void {
    if (this.open_) return
    this.open_ = true
    this.onOpenChange?.(true)
  }
  close(): void {
    if (!this.open_) return
    this.open_ = false
    this.onOpenChange?.(false)
  }
}

/** 假 UiStage——不做显式返回类型标注，交给调用点按 UiStageLike 结构核对（同 settings-panel.test.ts 的 vi.fn 用法） */
function makeFakeUiStage() {
  return { push: vi.fn(), pop: vi.fn(), setProfile: vi.fn((_p: UiFocusProfile) => {}) }
}

type Handler = (e: unknown) => void
interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }
interface FakeEl {
  style: Record<string, string>
  textContent: string
  type: string
  value: string
  innerHTML: string
  attributes: Record<string, string>
  children: FakeEl[]
  _parent: FakeEl | null
  setAttribute: (k: string, v: string) => void
  appendChild: (c: unknown) => void
  append: (...c: unknown[]) => void
  remove: () => void
  addEventListener: (type: string, cb: Handler) => void
  removeEventListener: (type: string, cb: Handler) => void
  dispatch: (type: string, e?: unknown) => void
  contains: (node: unknown) => boolean
  getBoundingClientRect: () => Rect
}

/** node 环境无 DOM：stub 最小 document/element 表面（同 control-dock.test.ts 模式）。
 * children 追踪 + contains——点外部关闭要靠 container.contains(e.target) 判定；
 * 另补 setAttribute/_parent/remove/getBoundingClientRect——info 图标 hover 时 attachTooltip 会造节点、打 data-tooltip、读定位 */
function fakeElement(): FakeEl {
  const listeners: Record<string, Handler[]> = {}
  const children: FakeEl[] = []
  const el: FakeEl = {
    style: {},
    textContent: '',
    type: '',
    value: '',
    innerHTML: '',
    attributes: {},
    children,
    _parent: null,
    setAttribute: (k, v) => { el.attributes[k] = v },
    appendChild: (c) => { (c as FakeEl)._parent = el; children.push(c as FakeEl) },
    append: (...cs) => { for (const c of cs) { (c as FakeEl)._parent = el; children.push(c as FakeEl) } },
    remove: () => {
      const p = el._parent
      if (p) { p.children.splice(p.children.indexOf(el), 1); el._parent = null }
    },
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb)
    },
    dispatch: (type, e) => { for (const cb of listeners[type] ?? []) cb(e) },
    contains: (node) => node === el || children.some((c) => c.contains(node)),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  }
  // 真实 DOM 语义：赋值 innerHTML 会清空既有子节点——buildRuleRows/buildShapeSection 重建（B1 T10 起
  // 形状区可被 onShapeChanged 反复重绘）靠这个来防止旧节点残留污染 findByText 一类的树遍历断言
  let innerHTMLValue = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHTMLValue,
    set: (v: string) => {
      innerHTMLValue = v
      for (const c of children) c._parent = null
      children.length = 0
    },
  })
  return el
}

/** 等一个宏任务——用于 flush 掉实现里用 setTimeout(0) 延迟注册的 pointerdown 监听器 */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let created: FakeEl[]
let docListeners: Record<string, Handler[]>
let docBody: FakeEl

beforeEach(() => {
  created = []
  docListeners = {}
  docBody = fakeElement()
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const el = fakeElement()
      created.push(el)
      return el
    },
    // info 图标 hover 时 attachTooltip 把 tooltip 节点挂到 document.body
    body: docBody,
    addEventListener: (type: string, cb: Handler) => { (docListeners[type] ??= []).push(cb) },
    removeEventListener: (type: string, cb: Handler) => {
      docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== cb)
    }
  }
})

/** 从 document.body 子节点里找出 tooltip 节点（带 data-tooltip 标记） */
function tooltipsInBody(): FakeEl[] {
  return docBody.children.filter((c) => 'data-tooltip' in c.attributes)
}

/** 在当前活树里按 data-role 找第一个匹配节点（宏旋钮行/按钮定位） */
function findByRole(root: FakeEl, role: string): FakeEl | null {
  if (root.attributes['data-role'] === role) return root
  for (const c of root.children) {
    const hit = findByRole(c, role)
    if (hit) return hit
  }
  return null
}
/** 取某行子树里的 range input */
function findRange(root: FakeEl): FakeEl | null {
  if (root.type === 'range') return root
  for (const c of root.children) {
    const hit = findRange(c)
    if (hit) return hit
  }
  return null
}
function rangeIn(row: FakeEl): FakeEl {
  const hit = findRange(row)
  if (!hit) throw new Error('该行无 range input')
  return hit
}

/** 取某行子树里全部 range input，按 DOM 顺序（专业表规则行依次为 强度/平滑/输出下限/输出上限） */
function rangesIn(row: FakeEl): FakeEl[] {
  const out: FakeEl[] = []
  const walk = (el: FakeEl): void => {
    if (el.type === 'range') out.push(el)
    for (const c of el.children) walk(c)
  }
  walk(row)
  return out
}

/** 沿当前活树按文档序收集信息图标（innerHTML 含 <svg> 的节点）——比扫 created 数组更稳：
 * 镜头分组（Phase D）getCamera 播种可能与 getMapping 同轮触发 buildRuleRows 二次重建，created
 * 数组会累积首轮已被清空重建的孤儿节点，且创建时序会与 shapeBody 的图标交错，扫创建序会错位；
 * 按文档序（body 先于 shapeBody 挂载）走当前树，才能稳定拿到「组标题图标排最前」这条语义 */
function collectIcons(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = []
  if (root.innerHTML.includes('<svg')) out.push(root)
  for (const c of root.children) out.push(...collectIcons(c))
  return out
}

function makeDeps(mapping: MappingValues, background: BackgroundSettings = structuredClone(DEFAULT_BACKGROUND_SETTINGS)): TuningPanelDeps & {
  getMapping: ReturnType<typeof vi.fn>
  previewMapping: ReturnType<typeof vi.fn>
  commitMapping: ReturnType<typeof vi.fn>
  commitMacroKnobs: ReturnType<typeof vi.fn>
  getAdvancedExpanded: ReturnType<typeof vi.fn>
  commitAdvancedExpanded: ReturnType<typeof vi.fn>
} {
  return {
    getMapping: vi.fn(async () => mapping),
    previewMapping: vi.fn((_m: MappingValues) => {}),
    commitMapping: vi.fn((_m: MappingValues) => {}),
    getMacroKnobs: vi.fn(async () => ({ ...DEFAULT_MACRO_KNOBS })),
    commitMacroKnobs: vi.fn((_k: MacroKnobs) => {}),
    getAdvancedExpanded: vi.fn(async () => false),
    commitAdvancedExpanded: vi.fn((_v: boolean) => {}),
    getShape: vi.fn(async () => ({ current: 'nebula' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true })),
    setShape: vi.fn(),
    onShapeChanged: vi.fn(),
    getMotion: vi.fn(async () => structuredClone(DEFAULT_MOTION_SETTINGS)),
    previewMotion: vi.fn(),
    commitMotion: vi.fn(),
    getCamera: vi.fn(async () => structuredClone(DEFAULT_CAMERA_SETTINGS)),
    previewCamera: vi.fn(),
    commitCamera: vi.fn(),
    getTitleFx: vi.fn(async () => structuredClone(DEFAULT_TITLE_SETTINGS)),
    previewTitleFx: vi.fn(),
    commitTitleFx: vi.fn(),
    getLyricsFx: vi.fn(async () => structuredClone(DEFAULT_LYRICS_SETTINGS)),
    previewLyricsFx: vi.fn(),
    commitLyricsFx: vi.fn(),
    getBackgroundFx: vi.fn(async () => background),
    previewBackgroundFx: vi.fn(),
    commitBackgroundFx: vi.fn(),
    // 回流回调本身不捕获——测试要触发回流时从 mock.calls 里取出注册的 cb 再调用（同 vi.fn 记录调用参数的惯例）
    onBackgroundChanged: vi.fn((_cb: (b: BackgroundSettings) => void) => {}),
  }
}

/** 播种是异步的（getMapping 走一次 microtask）——flush 两轮足够让 .then 回调落地 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TuningPanel（右侧调音台——拖动预览/松手保存，本地乐观 draft）', () => {
  it('播种：深拷贝 getMapping 结果，不污染源对象', async () => {
    const mapping = defaultRhythmPreset()
    const originalGain = mapping.targets.speed.primary.gain
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    // buildRuleRows 按 VISUAL_TARGETS 顺序（speed 打头，无 secondary）渲染，
    // 第一个 type==='range' 的元素即 speed·primary 的 gain 滑块
    const gainSlider = created.find((el) => el.type === 'range')!
    expect(gainSlider).toBeTruthy()
    gainSlider.value = '3'
    gainSlider.dispatch('change')

    expect(deps.commitMapping).toHaveBeenCalledTimes(1)
    const committed = deps.commitMapping.mock.calls[0][0] as MappingValues
    expect(committed.targets.speed.primary.gain).toBe(3)
    // 源对象必须保持原值——证明播种时做了深拷贝，而非持有引用原地改
    expect(mapping.targets.speed.primary.gain).toBe(originalGain)
  })

  it('拖动预览（input）只 preview 不 commit；松手（change）才 commit 落盘', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    const gainSlider = created.find((el) => el.type === 'range')!
    gainSlider.value = '2.5'
    gainSlider.dispatch('input')

    expect(deps.previewMapping).toHaveBeenCalledTimes(1)
    expect(deps.commitMapping).not.toHaveBeenCalled()
    expect((deps.previewMapping.mock.calls[0][0] as MappingValues).targets.speed.primary.gain).toBe(2.5)

    gainSlider.dispatch('change')
    expect(deps.commitMapping).toHaveBeenCalledTimes(1)
    expect((deps.commitMapping.mock.calls[0][0] as MappingValues).targets.speed.primary.gain).toBe(2.5)
  })

  it('不再渲染「导出当前值」按钮（item 1：砍导出）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    const exportBtn = created.find((el) => el.textContent.includes('导出'))
    expect(exportBtn).toBeUndefined()
  })

  it('点面板外部区域关闭面板', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    panel.toggle() // 打开
    expect(panel.isOpen).toBe(true)
    // 实现里 pointerdown 监听延迟到下一宏任务才注册（防触发开关那次点击自关的保险）
    await flushMacrotask()

    const outside = fakeElement()
    for (const cb of docListeners['pointerdown'] ?? []) cb({ target: outside })
    expect(panel.isOpen).toBe(false)
  })

  // 点 dock 图标关面板的 race 守护 + 点内部不关闭，收敛到 BasePanel 后已在
  // tests/ui/base-panel.test.ts 通用覆盖（TestPanel 场景与此处逐字同构）；这里只留
  // 上面「点外部关闭」一条冒烟，证明 TuningPanel 接的确实是 BasePanel 这套交互。

  it('toggle()：deps 只含映射三项 + 宏旋钮两项 + 高级折叠两项 + 形状三项 + 运动三项 + 镜头三项 + 歌名三项 + 歌词三项 + 背景三项（不含 uiStage/setModal——退台已交给协调器，面板本身不直接碰）', () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    expect(Object.keys(deps).sort()).toEqual([
      'commitAdvancedExpanded', 'commitBackgroundFx', 'commitCamera', 'commitLyricsFx', 'commitMacroKnobs', 'commitMapping', 'commitMotion', 'commitTitleFx',
      'getAdvancedExpanded', 'getBackgroundFx', 'getCamera', 'getLyricsFx', 'getMacroKnobs', 'getMapping', 'getMotion', 'getShape', 'getTitleFx',
      'onBackgroundChanged', 'onShapeChanged', 'previewBackgroundFx', 'previewCamera', 'previewLyricsFx', 'previewMapping', 'previewMotion',
      'previewTitleFx', 'setShape',
    ])
    panel.toggle()
    expect(panel.isOpen).toBe(true)
    panel.toggle()
    expect(panel.isOpen).toBe(false)
  })

  it('退台 profile 为 camera（仅镜头后拉），经协调器 open 时正确路由到 uiStage', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    expect(panel.retreatProfile).toBe('camera')

    const uiStage = makeFakeUiStage()
    const coordinator = new PanelCoordinator({ uiStage, setModal: vi.fn() })
    coordinator.register(panel, 'camera')

    panel.toggle() // 打开
    expect(uiStage.setProfile).toHaveBeenCalledWith('camera')
    expect(uiStage.push).toHaveBeenCalledTimes(1)
  })

  it('来源选项显示中文（SOURCE_LABELS），但选择后 preview/commit 收到的仍是英文 AudioFeature 枚举（item 5.1：中文只在显示层）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    // speed·primary 默认 source='tempo'（英文枚举）；allowedSources 含 'loudness'（中文'响度'）
    // 来源选项渲染的是中文文案，底层值仍是英文——点击中文选项应落回英文 source
    const loudnessOption = created.find((el) => el.textContent === '响度')
    expect(loudnessOption).toBeTruthy()
    // 不应出现英文原文 'loudness' 作为可点选项的裸文案
    expect(created.some((el) => el.textContent === 'loudness')).toBe(false)

    loudnessOption!.dispatch('click')

    expect(deps.commitMapping).toHaveBeenCalledTimes(1)
    const committed = deps.commitMapping.mock.calls[0][0] as MappingValues
    expect(committed.targets.speed.primary.source).toBe('loudness') // 英文枚举，不是 '响度'
  })

  it('不再渲染独立的规则解释文字行（spec.label 只留在信息图标 tooltip 里，item 亲验：删文字行）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    // speed·primary 的 spec.label 是「速度·全场速度感」——旧版会渲染成独立文字行的 textContent，
    // 新版只应作为 makeInfoIcon 的 tooltip 文案传入，不再出现在任何节点的可见 textContent 上
    const labelLine = created.find((el) => el.textContent === '速度·全场速度感')
    expect(labelLine).toBeUndefined()
  })

  it('组标题旁与每个滑块旁都渲染信息图标（内含 svg，hover 出 spec.label / 参数解释）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const parent = fakeElement()
    new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()

    // makeInfoIcon 内部把 feather info svg 字符串写进 innerHTML——用它反查图标节点数量（按文档序，见 collectIcons 注释）。
    // 搜索根收窄到 rule-rows（专业表容器，data-role 见 tuning-panel.ts）而非整个面板——宏旋钮区的风格行
    // 也带一个 ⓘ 图标（走独立的 macroDisposers 桶），若不收窄，「第一个图标」会被风格行顶到最前面，
    // 与本测试要断言的对象（专业表组标题图标）错位（本测试只关心专业表区，非按文档序扫全面板）
    const icons = collectIcons(findByRole(parent, 'rule-rows')!)
    // 5 个 VisualTarget 组标题各 1 个 + speed 只有 primary（4 个滑块）+ 其余组还有更多滑块——
    // 只断言下限：至少组标题图标（5）+ 单组 4 个滑块图标 > 5，证明滑块也接上了图标
    expect(icons.length).toBeGreaterThan(5)

    // 更具体：第一个图标是 speed 组标题的信息图标（VISUAL_TARGETS[0]=speed，buildRuleRows 先建组标题图标）——
    // hover 它出的 tooltip 文字应是该目标的简述（TARGET_DESC），不再是 primary spec.label（item 6：组标题 ⓘ 不重复组名/规则名）
    const firstIcon = icons[0]
    firstIcon.dispatch('mouseenter')
    const tips = tooltipsInBody()
    expect(tips.length).toBe(1)
    expect(tips[0].textContent).toBe('整体运动的快慢')
  })

  it('增益滑块 label 改为「强度」（item 4）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    expect(created.some((el) => el.textContent === '增益')).toBe(false)
    expect(created.some((el) => el.textContent === '强度')).toBe(true)
  })

  it('信息 tooltip 不重复入口名字，只留解释（item 5）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const parent = fakeElement()
    new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()

    // 搜索根收窄到 rule-rows（理由同上一测试：本测试只关心专业表区的 tooltip 文案，不含宏旋钮区风格行）
    const icons = collectIcons(findByRole(parent, 'rule-rows')!)
    const tipTextOf = (icon: FakeEl): string => {
      icon.dispatch('mouseenter')
      const tips = tooltipsInBody()
      const text = tips[tips.length - 1].textContent
      icon.dispatch('mouseleave')
      return text
    }
    const tipTexts = icons.map(tipTextOf)
    expect(tipTexts).toContain('驱动这个目标的强弱倍数')
    expect(tipTexts).toContain('越大，响应越缓越柔')
    expect(tipTexts).toContain('输出的最小值')
    expect(tipTexts).toContain('输出的最大值')
    expect(tipTexts).toContain('关掉后这条不参与驱动')
    expect(tipTexts).toContain('选择由哪个音频特征来驱动')
    // 都不应以对应入口名字开头（不赘述标题）
    expect(tipTexts.some((t) => t.startsWith('强度：') || t.startsWith('强度:'))).toBe(false)
    expect(tipTexts.some((t) => t.startsWith('平滑时间'))).toBe(false)
    expect(tipTexts.some((t) => t.startsWith('输出下限'))).toBe(false)
    expect(tipTexts.some((t) => t.startsWith('输出上限'))).toBe(false)
  })

  it('「启用」「来源」行各带信息图标（item 3）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const parent = fakeElement()
    new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()

    // 搜索根收窄到 rule-rows（理由同上：本测试断言的是「启用」「来源」两行的图标，都在专业表区）
    const icons = collectIcons(findByRole(parent, 'rule-rows')!)
    const tipTexts = icons.map((icon) => {
      icon.dispatch('mouseenter')
      const t = tooltipsInBody()
      const text = t[t.length - 1].textContent
      icon.dispatch('mouseleave')
      return text
    })
    expect(tipTexts).toContain('关掉后这条不参与驱动')
    expect(tipTexts).toContain('选择由哪个音频特征来驱动')
  })

  it('多规则组（space/brightness）每条规则都有文字子标题，不再是孤零零的信息图标子头（item 6）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    // MAPPING_SPEC space: primary='空间·脉冲锚' secondary='空间·段落收放'；brightness: primary='亮度·脉冲提亮' secondary='亮度·高频碎光'
    for (const subName of ['脉冲锚', '段落收放', '脉冲提亮', '高频碎光']) {
      const subHeader = created.find((el) => el.textContent === subName)
      expect(subHeader, `缺少子标题：${subName}`).toBeTruthy()
      // 子标题本身不挂 ⓘ（子名即标题，不需要再解释）
      expect(subHeader!.innerHTML.includes('<svg')).toBe(false)
    }
  })

  it('单规则组（speed/density/thickness）不渲染子标题，控件直接跟在组标题下（item 6，保持既有认可样式不动）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    // speed·primary 唯一规则名「全场速度感」不应作为独立子标题节点出现
    const subHeader = created.find((el) => el.textContent === '全场速度感')
    expect(subHeader).toBeUndefined()
  })

  it('注册协调器后，设置开着时 open 调音台 → 设置自动 close（互斥）', async () => {
    const mapping = defaultRhythmPreset()
    const deps = makeDeps(mapping)
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    const uiStage = makeFakeUiStage()
    const coordinator = new PanelCoordinator({ uiStage, setModal: vi.fn() })
    const settings = new FakeSettingsPanel()
    coordinator.register(settings, 'full')
    coordinator.register(panel, 'camera')

    settings.open()
    expect(settings.isOpen).toBe(true)

    panel.toggle() // 打开调音台
    expect(panel.isOpen).toBe(true)
    expect(settings.isOpen).toBe(false) // 互斥：设置被自动关闭
  })
})

describe('主体分区（Phase B1 T10）', () => {
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** 沿当前活树找第一个 type==='range' 的节点——比 created.find 更稳：镜头分组（Phase D）
   * getCamera 播种可能触发 buildRuleRows 二次重建，created 数组会累积首轮已被清空重建的孤儿节点 */
  function findFirstRange(root: FakeEl): FakeEl | null {
    if (root.type === 'range') return root
    for (const c of root.children) {
      const hit = findFirstRange(c)
      if (hit) return hit
    }
    return null
  }

  async function makeShapePanel(overrides: Partial<TuningPanelDeps> = {}) {
    const parent = fakeElement()
    let shapeCb: ((s: ShapeSettings) => void) | null = null
    const deps: TuningPanelDeps = {
      getMapping: async () => defaultRhythmPreset(),
      previewMapping: vi.fn(),
      commitMapping: vi.fn(),
      getMacroKnobs: vi.fn(async () => ({ ...DEFAULT_MACRO_KNOBS })),
      commitMacroKnobs: vi.fn(),
      getAdvancedExpanded: vi.fn(async () => false),
      commitAdvancedExpanded: vi.fn(),
      getShape: async () => ({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: true, showBody: true }),
      setShape: vi.fn(),
      onShapeChanged: (cb) => { shapeCb = cb },
      getMotion: async () => structuredClone(DEFAULT_MOTION_SETTINGS),
      previewMotion: vi.fn(),
      commitMotion: vi.fn(),
      getCamera: async () => structuredClone(DEFAULT_CAMERA_SETTINGS),
      previewCamera: vi.fn(),
      commitCamera: vi.fn(),
      getTitleFx: vi.fn(async () => structuredClone(DEFAULT_TITLE_SETTINGS)),
      previewTitleFx: vi.fn(),
      commitTitleFx: vi.fn(),
      getLyricsFx: vi.fn(async () => structuredClone(DEFAULT_LYRICS_SETTINGS)),
      previewLyricsFx: vi.fn(),
      commitLyricsFx: vi.fn(),
      getBackgroundFx: vi.fn(async () => structuredClone(DEFAULT_BACKGROUND_SETTINGS)),
      previewBackgroundFx: vi.fn(),
      commitBackgroundFx: vi.fn(),
      onBackgroundChanged: vi.fn(),
      ...overrides,
    }
    const panel = new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush() // ← 沿用本文件既有的微任务冲刷 helper
    return { parent, deps, panel, fireShapeChanged: (s: unknown) => shapeCb?.(s as never) }
  }

  /** shapeBody/body 两容器 style.display 断言——tab 切换只做显隐，两容器全程都在 DOM 里 */
  function displayOf(el: FakeEl): string {
    return el.style.display ?? ''
  }

  it('fb3 自适应分组：粒子形状无线条组；切到频谱环线条组出现、运动组改题；切回粒子组还原', async () => {
    const { parent, fireShapeChanged } = await makeShapePanel()
    expect(findByText(parent, '线条（频谱环）')).toBeNull()
    expect(findByText(parent, '运动（封面/星云）')).not.toBeNull()
    fireShapeChanged({ current: 'spectrum', customCurrent: null, customShapes: [], coverPriority: true })
    expect(findByText(parent, '线条（频谱环）')).not.toBeNull()
    expect(findByText(parent, '运动（封面接管时生效）')).not.toBeNull()
    fireShapeChanged({ current: 'heart', customCurrent: null, customShapes: [], coverPriority: true })
    expect(findByText(parent, '线条（频谱环）')).toBeNull()
    expect(findByText(parent, '运动（封面/星云）')).not.toBeNull()
  })

  it('渲染 tab 栏：律动 / 主体 两个 tab 节点（不再是眉题）', async () => {
    const { parent } = await makeShapePanel()
    expect(findByText(parent, '律动')).not.toBeNull()
    expect(findByText(parent, '主体')).not.toBeNull()
  })

  it('默认激活「律动」tab：通用内容可见，形状分区隐藏', async () => {
    const { parent } = await makeShapePanel()
    // 通用区第一个滑块（type==='range'）必须在可见容器内——找不到隐藏的祖先容器
    const anyRangeVisible = created.some((el) => el.type === 'range')
    expect(anyRangeVisible).toBe(true)
    const currentShapeLabel = findByText(parent, '当前形状')
    // 主体分区的容器（只读行的祖先）应被标记 display:none
    let node: FakeEl | null = currentShapeLabel
    let hiddenAncestorFound = false
    while (node) {
      if (displayOf(node) === 'none') { hiddenAncestorFound = true; break }
      node = node._parent
    }
    expect(hiddenAncestorFound).toBe(true)
  })

  it('点击「主体」tab → 形状分区显示、通用分区隐藏；再点「律动」反转', async () => {
    const { parent } = await makeShapePanel()
    const shapeTab = findByText(parent, '主体')!
    shapeTab.dispatch('click')

    const shapeDropdownLabel = findByText(parent, '形状')!
    let node: FakeEl | null = shapeDropdownLabel
    let shapeHidden = false
    while (node) { if (displayOf(node) === 'none') { shapeHidden = true; break }; node = node._parent }
    expect(shapeHidden).toBe(false)

    const generalSlider = findFirstRange(parent)!
    node = generalSlider
    let generalHidden = false
    while (node) { if (displayOf(node) === 'none') { generalHidden = true; break }; node = node._parent }
    expect(generalHidden).toBe(true)

    const generalTab = findByText(parent, '律动')!
    generalTab.dispatch('click')
    node = generalSlider
    generalHidden = false
    while (node) { if (displayOf(node) === 'none') { generalHidden = true; break }; node = node._parent }
    expect(generalHidden).toBe(false)
  })

  it('形状 tab 下渲染沉睡态提示：含"展示片刻"', async () => {
    const { parent } = await makeShapePanel()
    // 注意：buildShapeSection 现在会在 getShape/getMotion 两个播种时机各重建一次（motionDraft 就绪较晚），
    // 用 created.find 会命中第一次重建后已被清空重建、脱离当前树的孤儿节点——改用 findByText 沿当前树查找，
    // 保证拿到的是最终留在 parent 里的那个节点
    const hint = findByText(parent, '切换即时生效；无音乐时展示片刻后休眠')
    expect(hint).not.toBeNull()
    expect(parent.contains(hint!)).toBe(true)
  })

  it('封面优先开关切换 → setShape 收到 coverPriority 翻转', async () => {
    const { parent, deps } = await makeShapePanel()
    // makeToggleRow 结构：row = [labelGroup, toggleHost]，ToggleSwitch 根节点是 toggleHost.children[0]
    // 且根节点挂 click 监听（见 toggle-switch.ts / toggle-switch.test.ts 的触发手法）
    const label = findByText(parent, '封面优先')!
    const row = label._parent!._parent! // label span → labelGroup → row
    const toggleHost = row.children[row.children.length - 1]
    toggleHost.children[0].dispatch('click')
    expect(deps.setShape).toHaveBeenCalledWith({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: false, showBody: true })
  })
  it('只读当前形状行：回流送 heart → 文本更新为「心脏」（双入口显示同步）', async () => {
    const { parent, fireShapeChanged } = await makeShapePanel()
    fireShapeChanged({ current: 'heart', coverPriority: false })
    expect(findByText(parent, '心脏')).not.toBeNull()
    expect(findByText(parent, '星云')).toBeNull() // 旧值不残留
  })
  it('形状 tab 不再渲染可点击的形状选项（下拉已退役，入口=操作坞选择器）', async () => {
    const { parent } = await makeShapePanel()
    expect(findByText(parent, '心脏')).toBeNull() // 形状选项行不存在（只读行只显示当前值「星云」）
  })
  it('行为不变量：通用 tab 激活时经历 onShapeChanged 回流重绘，形状分区仍保持隐藏', async () => {
    const { parent, fireShapeChanged } = await makeShapePanel()
    // 默认就在通用 tab，不需要额外点击。当前实现里重建只清 shapeBody 子节点、不触碰其 display
    // （显隐由 showTab 独立掌管），本用例锁定的是可观察行为——若未来重建方式改成整体替换元素等，
    // 它会拦住「回流把隐藏的形状区意外打开」的回归
    fireShapeChanged({ current: 'heart', coverPriority: false })
    const currentShapeLabel = findByText(parent, '当前形状')!
    let node: FakeEl | null = currentShapeLabel
    let shapeHidden = false
    while (node) { if (displayOf(node) === 'none') { shapeHidden = true; break }; node = node._parent }
    expect(shapeHidden).toBe(true)
  })
})

describe('运动旋钮（Phase C2 T6：主体 tab 的第一批真参数）', () => {
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  async function makeShapePanel(overrides: Partial<TuningPanelDeps> = {}) {
    const parent = fakeElement()
    let shapeCb: ((s: ShapeSettings) => void) | null = null
    const deps: TuningPanelDeps = {
      getMapping: async () => defaultRhythmPreset(),
      previewMapping: vi.fn(),
      commitMapping: vi.fn(),
      getMacroKnobs: vi.fn(async () => ({ ...DEFAULT_MACRO_KNOBS })),
      commitMacroKnobs: vi.fn(),
      getAdvancedExpanded: vi.fn(async () => false),
      commitAdvancedExpanded: vi.fn(),
      getShape: async () => ({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: true, showBody: true }),
      setShape: vi.fn(),
      onShapeChanged: (cb) => { shapeCb = cb },
      getMotion: async () => structuredClone(DEFAULT_MOTION_SETTINGS),
      previewMotion: vi.fn(),
      commitMotion: vi.fn(),
      getCamera: async () => structuredClone(DEFAULT_CAMERA_SETTINGS),
      previewCamera: vi.fn(),
      commitCamera: vi.fn(),
      getTitleFx: vi.fn(async () => structuredClone(DEFAULT_TITLE_SETTINGS)),
      previewTitleFx: vi.fn(),
      commitTitleFx: vi.fn(),
      getLyricsFx: vi.fn(async () => structuredClone(DEFAULT_LYRICS_SETTINGS)),
      previewLyricsFx: vi.fn(),
      commitLyricsFx: vi.fn(),
      getBackgroundFx: vi.fn(async () => structuredClone(DEFAULT_BACKGROUND_SETTINGS)),
      previewBackgroundFx: vi.fn(),
      commitBackgroundFx: vi.fn(),
      onBackgroundChanged: vi.fn(),
      ...overrides,
    }
    const panel = new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()
    return { parent, deps, panel, fireShapeChanged: (s: unknown) => shapeCb?.(s as never) }
  }

  /** makeRange 结构：row=[labelRow, input]，labelRow=[labelGroup, valueEl]，labelGroup=[labelEl(文字), 可选 help 图标]。
   * 从 label 文字节点向上摸 3 层拿到 row，再从 row 的子节点里找 type==='range' 的 input。 */
  function findRangeInputFor(parent: FakeEl, labelText: string): FakeEl {
    const label = findByText(parent, labelText)!
    const row = label._parent!._parent!._parent!
    return row.children.find((c) => c.type === 'range')!
  }

  /** makeToggleRow 结构：row=[labelGroup, toggleHost]，toggleHost.children[0] 是 ToggleSwitch 的 track 根节点 */
  function findToggleTrackFor(parent: FakeEl, labelText: string): FakeEl {
    const label = findByText(parent, labelText)!
    const row = label._parent!._parent!
    const toggleHost = row.children[row.children.length - 1]
    return toggleHost.children[0]
  }

  it('形状 tab 渲染 6 个运动旋钮行', async () => {
    const { parent } = await makeShapePanel()
    for (const label of ['轰炸强度', '细节密度', '波前速度', '蓄力深度', '高潮亮度', '频闪']) {
      expect(findByText(parent, label), `缺少旋钮：${label}`).not.toBeNull()
    }
  })

  it('滑块拖动走 preview、松手走 commit', async () => {
    const { parent, deps } = await makeShapePanel()
    const input = findRangeInputFor(parent, '轰炸强度')

    input.value = '1.5'
    input.dispatch('input')
    expect(deps.previewMotion).toHaveBeenCalledTimes(1)
    expect((deps.previewMotion as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ bombIntensity: 1.5 })
    expect(deps.commitMotion).not.toHaveBeenCalled()

    input.dispatch('change')
    expect(deps.commitMotion).toHaveBeenCalledTimes(1)
    expect((deps.commitMotion as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ bombIntensity: 1.5 })
  })

  it('高潮亮度滑块：量程 0.3–1.5、拖动 preview、松手 commit（#高潮亮度）', async () => {
    const { parent, deps } = await makeShapePanel()
    const input = findRangeInputFor(parent, '高潮亮度') as unknown as { min: string; max: string; value: string; dispatch: (type: string) => void }
    expect(input.min).toBe('0.3')
    expect(input.max).toBe('1.5')
    expect(input.value).toBe('1') // 默认舒服档

    input.value = '1.5'
    input.dispatch('input')
    expect((deps.previewMotion as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ climaxBrightness: 1.5 })
    expect(deps.commitMotion).not.toHaveBeenCalled()

    input.dispatch('change')
    expect((deps.commitMotion as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ climaxBrightness: 1.5 })
  })

  it('频闪开关切换直接 commit', async () => {
    const { parent, deps } = await makeShapePanel()
    const track = findToggleTrackFor(parent, '频闪')
    track.dispatch('click')
    expect(deps.commitMotion).toHaveBeenCalledTimes(1)
    expect((deps.commitMotion as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ strobeEnabled: false })
  })

  it('onShapeChanged 回流重绘后旋钮值来自本地 draft（不被回流冲掉）', async () => {
    const { parent, fireShapeChanged } = await makeShapePanel()
    const input = findRangeInputFor(parent, '轰炸强度')
    input.value = '1.5'
    input.dispatch('input') // 仅 preview，未 commit

    fireShapeChanged({ current: 'heart', coverPriority: false }) // 触发 buildShapeSection 整体重建

    const rebuiltInput = findRangeInputFor(parent, '轰炸强度')
    expect(rebuiltInput.value).toBe('1.5')
  })
})

describe('镜头 tab 的运镜旋钮', () => {
  it('镜头分组（Phase D）：运镜活跃度拖动只 preview、松手 commit，值改在 camera draft 上', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    await flushMacrotask() // getCamera 播种后 buildCameraSection 重跑一轮

    // 滑杆现住 cameraBody（默认隐藏）：先点「镜头」tab
    created.find((el) => el.textContent === '镜头')!.dispatch('click')

    // 经 label 文本定位滑块：labelEl → labelGroup → labelRow → row，row.children[1] 即 input
    const labelEl = created.find((el) => el.textContent === '运镜活跃度')!
    expect(labelEl).toBeTruthy()
    const row = labelEl._parent!._parent!._parent!
    const slider = row.children.find((c) => c.type === 'range')!
    expect(slider.value).toBe(String(DEFAULT_CAMERA_SETTINGS.liveliness))

    slider.value = '1.6'
    slider.dispatch('input')
    expect(deps.previewCamera).toHaveBeenCalledTimes(1)
    expect((deps.previewCamera as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ liveliness: 1.6, distScale: DEFAULT_CAMERA_SETTINGS.distScale })
    expect(deps.commitCamera).not.toHaveBeenCalled()

    slider.dispatch('change')
    expect(deps.commitCamera).toHaveBeenCalledTimes(1)
    expect((deps.commitCamera as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ liveliness: 1.6, distScale: DEFAULT_CAMERA_SETTINGS.distScale })
  })

  it('默认距离滑块：拖动 preview、松手 commit，与活跃度共用同一 camera draft', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    await flushMacrotask()

    // 滑杆现住 cameraBody（默认隐藏）：先点「镜头」tab
    created.find((el) => el.textContent === '镜头')!.dispatch('click')

    const labelEl = created.find((el) => el.textContent === '默认距离')!
    expect(labelEl).toBeTruthy()
    const row = labelEl._parent!._parent!._parent!
    const slider = row.children.find((c) => c.type === 'range')!
    expect(slider.value).toBe(String(DEFAULT_CAMERA_SETTINGS.distScale))

    slider.value = '0.8'
    slider.dispatch('input')
    expect(deps.previewCamera).toHaveBeenCalledTimes(1)
    expect((deps.previewCamera as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ liveliness: DEFAULT_CAMERA_SETTINGS.liveliness, distScale: 0.8 })
    expect(deps.commitCamera).not.toHaveBeenCalled()

    slider.dispatch('change')
    expect(deps.commitCamera).toHaveBeenCalledTimes(1)
    expect((deps.commitCamera as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ liveliness: DEFAULT_CAMERA_SETTINGS.liveliness, distScale: 0.8 })
  })
})

describe('歌词歌名 tab（批2：两组自设置面板迁入）', () => {
  /** 沿树找 textContent 恰为 text 的节点 */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** 沿树收集所有 type==='range' 的节点 */
  function collectSliders(root: FakeEl): FakeEl[] {
    const out: FakeEl[] = []
    if (root.type === 'range') out.push(root)
    for (const c of root.children) out.push(...collectSliders(c))
    return out
  }

  /** 沿树收集 data-role 命中的节点（先例 player-bar.test.ts byRole） */
  function collectByRole(root: FakeEl, role: string): FakeEl[] {
    const out: FakeEl[] = []
    if (root.attributes['data-role'] === role) out.push(root)
    for (const c of root.children) out.push(...collectByRole(c, role))
    return out
  }

  it('tab 栏渲染三个 tab：律动 / 主体 / 歌词歌名', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    expect(findByText(docBody, '律动')).toBeTruthy()
    expect(findByText(docBody, '主体')).toBeTruthy()
    expect(findByText(docBody, '歌词歌名')).toBeTruthy()
    panel.dispose()
  })

  it('三向显隐互斥：点「歌词歌名」→ 歌词区显示、通用/形状区隐藏；点回「律动」反转', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const lyricsTab = findByText(docBody, '歌词歌名')!
    const generalTab = findByText(docBody, '律动')!
    // body/shapeBody/lyricsBody 是 appendRow 进容器的三个分区容器——按 display 断言
    lyricsTab.dispatch('click')
    expect(panel.lyricsBodyForTest.style.display).toBe('')
    expect(panel.generalBodyForTest.style.display).toBe('none')
    expect(panel.shapeBodyForTest.style.display).toBe('none')
    generalTab.dispatch('click')
    expect(panel.lyricsBodyForTest.style.display).toBe('none')
    expect(panel.generalBodyForTest.style.display).toBe('')
    panel.dispose()
  })

  it('播种：getTitleFx/getLyricsFx 各调一次且深拷贝（不污染源）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    expect(deps.getTitleFx).toHaveBeenCalledTimes(1)
    expect(deps.getLyricsFx).toHaveBeenCalledTimes(1)
    panel.dispose()
  })

  it('渲染两组标题与十行：粒子歌名4行 + 歌词6行（7 条滑杆含两条位置，按文档序）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const body = panel.lyricsBodyForTest as unknown as FakeEl
    expect(findByText(body, '粒子歌名')).toBeTruthy()
    expect(findByText(body, '歌词')).toBeTruthy()
    for (const label of ['展示', '位置', '显示', '节奏动态', '动态强度']) {
      expect(findByText(body, label)).toBeTruthy()
    }
    expect(collectSliders(body)).toHaveLength(7)
    panel.dispose()
  })

  it('展示行点「常驻」→ previewTitleFx+commitTitleFx 收到 mode=always 且保留 scale', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(panel.lyricsBodyForTest as unknown as FakeEl, '常驻')!.dispatch('click')
    expect(deps.previewTitleFx).toHaveBeenCalledWith(expect.objectContaining({ mode: 'always', scale: 1 }))
    expect(deps.commitTitleFx).toHaveBeenCalledWith(expect.objectContaining({ mode: 'always' }))
    expect(deps.commitLyricsFx).not.toHaveBeenCalled()
    panel.dispose()
  })

  it('歌词大小滑杆（文档序第3条）：input 只 preview，change 才 commit；歌名 draft 不被殃及', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const slider = collectSliders(panel.lyricsBodyForTest as unknown as FakeEl)[4]
    slider.value = '1.4'
    slider.dispatch('input')
    expect(deps.previewLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.4 }))
    expect(deps.commitLyricsFx).not.toHaveBeenCalled()
    slider.dispatch('change')
    expect(deps.commitLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.4 }))
    expect(deps.commitTitleFx).not.toHaveBeenCalled()
    panel.dispose()
  })

  it('滑杆量程=sanitize 钳位区间（歌名大小 [0.5,2]、动态强度 [0,2]、歌词亮度 [0.3,2]）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    // fake element 的 min/max 是运行时动态挂上的字段（input.min = String(opts.min)），走 cast 读取
    const sliders = collectSliders(panel.lyricsBodyForTest as unknown as FakeEl) as unknown as Array<{ min: string; max: string }>
    expect(sliders[1].min).toBe('0.5') // 歌名大小（[0]位置(歌名) [1]大小(歌名)）
    expect(sliders[1].max).toBe('2')
    expect(sliders[5].min).toBe('0') // 动态强度（[3]位置(歌词) [4]大小(歌词) [5]动态强度）
    expect(sliders[5].max).toBe('2')
    expect(sliders[6].min).toBe('0.3') // 亮度顺延一位（[6]）
    expect(sliders[6].max).toBe('2')
    panel.dispose()
  })

  it('动态强度滑杆（亲验fb1-D，文档序第4条）：input 只 preview，change 才 commit；默认值随 DEFAULT_LYRICS_SETTINGS', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const slider = collectSliders(panel.lyricsBodyForTest as unknown as FakeEl)[5]
    expect(slider.value).toBe(String(DEFAULT_LYRICS_SETTINGS.dynamicsGain))
    slider.value = '0'
    slider.dispatch('input')
    expect(deps.previewLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ dynamicsGain: 0 }))
    expect(deps.commitLyricsFx).not.toHaveBeenCalled()
    slider.dispatch('change')
    expect(deps.commitLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ dynamicsGain: 0 }))
    panel.dispose()
  })

  it('节奏动态开关切到关 → commitLyricsFx 收到 dynamics=false（enabled 不动）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    // ToggleSwitch 定位=既有 findToggleTrackFor 写法：label → labelGroup → row → 末子(toggleHost) → children[0](track)
    const label = findByText(panel.lyricsBodyForTest as unknown as FakeEl, '节奏动态')!
    const row = label._parent!._parent!
    const track = row.children[row.children.length - 1].children[0]
    track.dispatch('click')
    expect(deps.commitLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ dynamics: false, enabled: true }))
    panel.dispose()
  })

  it('位置滑杆（歌词位置滑块）：量程±2、默认=旧档迁移值、轻吸附、input 只 preview change 才 commit', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const sliders = collectSliders(panel.lyricsBodyForTest as unknown as FakeEl)
    const titlePos = sliders[0] as unknown as { min: string; max: string; value: string }
    expect(titlePos.min).toBe('-2')
    expect(titlePos.max).toBe('2')
    expect(titlePos.value).toBe('1.35')  // DEFAULT_TITLE_SETTINGS.position（原 top 档迁移值）
    sliders[0].value = '1.3'             // 距节点 1.35 差 0.05 < EPS 0.08 → 吸附
    sliders[0].dispatch('input')
    expect(deps.previewTitleFx).toHaveBeenCalledWith(expect.objectContaining({ position: 1.35 }))
    expect(deps.commitTitleFx).not.toHaveBeenCalled()
    sliders[0].dispatch('change')
    expect(deps.commitTitleFx).toHaveBeenCalledWith(expect.objectContaining({ position: 1.35 }))
    // 歌词位置滑杆独立：节点间的值原样通过（不吸附），且只动 lyrics draft
    sliders[3].value = '-1.6'
    sliders[3].dispatch('input')
    expect(deps.previewLyricsFx).toHaveBeenCalledWith(expect.objectContaining({ position: -1.6 }))
    expect(deps.commitLyricsFx).not.toHaveBeenCalled()
    panel.dispose()
  })

  it('位置滑杆带节点刻度：两条位置行各 7 个 tick，按量程百分比定位（歌词位置滑块）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const body = panel.lyricsBodyForTest as unknown as FakeEl
    const strips = collectByRole(body, 'tick-strip')
    expect(strips).toHaveLength(2)          // 歌名位置 + 歌词位置；其余滑杆不带刻度
    const ticks = collectByRole(strips[0], 'tick')
    expect(ticks).toHaveLength(7)
    expect(ticks[0].style.left).toBe('0.0%')    // −2 → 量程左端
    expect(ticks[3].style.left).toBe('50.0%')   // 0 → 中点
    expect(ticks[6].style.left).toBe('100.0%')  // +2 → 右端
    panel.dispose()
  })
})

describe('背景 tab（虚空之镜：极光/涟漪/尘埃三滑杆）', () => {
  /** 沿树找 textContent 恰为 text 的节点（同「歌词歌名 tab」用例写法） */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** 沿树收集所有 type==='range' 的节点（同「歌词歌名 tab」用例写法） */
  function collectSliders(root: FakeEl): FakeEl[] {
    const out: FakeEl[] = []
    if (root.type === 'range') out.push(root)
    for (const c of root.children) out.push(...collectSliders(c))
    return out
  }

  /** makeToggleRow 结构：row=[labelGroup, toggleHost]，toggleHost.children[0] 是 ToggleSwitch 的 track 根节点
   * （同「运动旋钮」describe 块内 findToggleTrackFor 写法） */
  function findToggleTrackFor(parent: FakeEl, labelText: string): FakeEl {
    const label = findByText(parent, labelText)!
    const row = label._parent!._parent!
    const toggleHost = row.children[row.children.length - 1]
    return toggleHost.children[0]
  }

  it('背景 tab：五滑杆渲染（倒影已退役修订①，尘埃密度新增修订④，尘埃大小/亮度新增修订⑤），拖动 preview、松手 commit', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()

    const bgTab = findByText(docBody, '背景')!
    bgTab.dispatch('click')
    expect(panel.backgroundBodyForTest.style.display).toBe('')

    const sliders = collectSliders(panel.backgroundBodyForTest as unknown as FakeEl)
    // 7 = 极光/涟漪(虚空之镜) + 透明度/饱和度(自定义背景 v2，与前者互为置灰镜像) + 尘埃密度/大小/亮度
    expect(sliders).toHaveLength(7)

    sliders[0].value = '0.4'
    sliders[0].dispatch('input')
    expect(deps.previewBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ aurora: 0.4 }))
    expect(deps.commitBackgroundFx).not.toHaveBeenCalled()

    sliders[0].dispatch('change')
    expect(deps.commitBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ aurora: 0.4 }))
    panel.dispose()
  })

  it('背景 tab 两分组（亲验 fb7）：「深空水镜」（极光/涟漪）与「尘埃」（密度/大小/亮度）各有组标题', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')
    const body = panel.backgroundBodyForTest as unknown as FakeEl
    expect(findByText(body, '深空水镜')).toBeTruthy()
    expect(findByText(body, '尘埃')).toBeTruthy() // 组标题精确匹配（'尘埃密度'等是不同节点）
    panel.dispose()
  })

  it('尘埃大小/亮度滑杆（亲验 fb3，文档序第4/5条）：input 只 preview，change 才 commit，载荷带新字段', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')
    const sliders = collectSliders(panel.backgroundBodyForTest as unknown as FakeEl)

    // 文档序：极光/涟漪(虚空之镜) / 透明度/饱和度(自定义背景 v2) / 密度/大小/亮度(尘埃)
    sliders[5].value = '2'
    sliders[5].dispatch('input')
    expect(deps.previewBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ dustSize: 2 }))
    expect(deps.commitBackgroundFx).not.toHaveBeenCalled()
    sliders[5].dispatch('change')
    expect(deps.commitBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ dustSize: 2 }))

    sliders[6].value = '0.5'
    sliders[6].dispatch('input')
    expect(deps.previewBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ dustBright: 0.5 }))
    sliders[6].dispatch('change')
    expect(deps.commitBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ dustBright: 0.5 }))
    panel.dispose()
  })

  it('尘埃大小/亮度滑杆量程=sanitize 钳位区间 [0.5,2.5]', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    const sliders = collectSliders(panel.backgroundBodyForTest as unknown as FakeEl) as unknown as Array<{ min: string; max: string }>
    expect(sliders[5].min).toBe('0.5')
    expect(sliders[5].max).toBe('2.5')
    expect(sliders[6].min).toBe('0.5')
    expect(sliders[6].max).toBe('2.5')
    panel.dispose()
  })

  it('背景 tab：镜面开关拨动即 preview+commit（#镜面开关）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const track = findToggleTrackFor(panel.backgroundBodyForTest as unknown as FakeEl, '镜面')
    track.dispatch('click')
    expect((deps.previewBackgroundFx as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ mirror: false })
    expect((deps.commitBackgroundFx as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ mirror: false })
    panel.dispose()
  })
})

describe('五 Tab 重组（fb3：通用调试拆为律动+镜头）', () => {
  /** 沿树找 textContent 恰为 text 的节点（同「背景 tab」用例写法） */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** 沿树收集所有 type==='range' 的节点（同「背景 tab」用例写法） */
  function collectSliders(root: FakeEl): FakeEl[] {
    const out: FakeEl[] = []
    if (root.type === 'range') out.push(root)
    for (const c of root.children) out.push(...collectSliders(c))
    return out
  }

  it('tab 栏渲染五个 tab：律动/镜头/主体/歌词歌名/背景', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    for (const t of ['律动', '镜头', '主体', '歌词歌名', '背景']) {
      expect(findByText(docBody, t)).toBeTruthy()
    }
    panel.dispose()
  })

  it('点击「镜头」tab → 镜头区显示、其余四区隐藏；运镜旋钮住镜头区', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '镜头')!.dispatch('click')
    expect(panel.cameraBodyForTest.style.display).toBe('')
    expect(panel.generalBodyForTest.style.display).toBe('none')
    expect(panel.shapeBodyForTest.style.display).toBe('none')
    expect(panel.lyricsBodyForTest.style.display).toBe('none')
    expect(panel.backgroundBodyForTest.style.display).toBe('none')
    expect(findByText(panel.cameraBodyForTest as unknown as FakeEl, '运镜活跃度')).toBeTruthy()
    expect(findByText(panel.cameraBodyForTest as unknown as FakeEl, '默认距离')).toBeTruthy()
    expect(collectSliders(panel.cameraBodyForTest as unknown as FakeEl)).toHaveLength(2)
    panel.dispose()
  })
})

describe('背景 tab 联动（自定义背景 v1）', () => {
  const BG_ID = '11111111-2222-3333-4444-555555555555'

  /** 沿树找 textContent 恰为 text 的节点（同「背景 tab」describe 用例写法） */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** 沿树收集所有 type==='range' 的节点（同「背景 tab」describe 用例写法） */
  function collectSliders(root: FakeEl): FakeEl[] {
    const out: FakeEl[] = []
    if (root.type === 'range') out.push(root)
    for (const c of root.children) out.push(...collectSliders(c))
    return out
  }

  /** 沿树收集 data-role 命中的节点（惯例见「歌词歌名 tab」describe 的 collectByRole） */
  function collectByRole(root: FakeEl, role: string): FakeEl[] {
    const out: FakeEl[] = []
    if (root.attributes['data-role'] === role) out.push(root)
    for (const c of root.children) out.push(...collectByRole(c, role))
    return out
  }

  /** 播了 onBackgroundChanged 后取出注册的回流回调（deps.onBackgroundChanged 是 vi.fn，
   * 调用参数即回调本身——不用额外的捕获变量，与「toggle() deps 只含...」用例的纯工厂惯例保持一致 */
  function bgChangedCbOf(deps: TuningPanelDeps): (b: BackgroundSettings) => void {
    const mockFn = deps.onBackgroundChanged as ReturnType<typeof vi.fn>
    return mockFn.mock.calls[0][0] as (b: BackgroundSettings) => void
  }

  it('current=aurora：无锁定小字，滑杆行不透明', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    expect(collectByRole(body, 'bg-locked-note')).toHaveLength(0)
    const fxRows = collectByRole(body, 'bg-fx-row')
    expect(fxRows).toHaveLength(3) // 极光行 + 涟漪行 + 镜面开关行
    for (const row of fxRows) {
      expect(row.style.opacity).toBeUndefined()
      expect(row.style.pointerEvents).toBeUndefined()
    }
    panel.dispose()
  })

  it('current=上传背景：极光/涟漪/镜面行置灰(opacity 0.45 + pointerEvents none)，尘埃三行不受影响，出现锁定小字', async () => {
    const background: BackgroundSettings = {
      ...structuredClone(DEFAULT_BACKGROUND_SETTINGS),
      current: BG_ID,
      customBackgrounds: [{ id: BG_ID, kind: 'image' }],
    }
    const deps = makeDeps(defaultRhythmPreset(), background)
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    expect(collectByRole(body, 'bg-locked-note')).toHaveLength(1)
    const fxRows = collectByRole(body, 'bg-fx-row')
    expect(fxRows).toHaveLength(3)
    for (const row of fxRows) {
      expect(row.style.opacity).toBe('0.45')
      expect(row.style.pointerEvents).toBe('none')
    }

    // 尘埃三行不受影响：尘埃密度所在行沿祖先链不应带 bg-fx-row 标记
    const dustLabel = findByText(body, '尘埃密度')!
    let node: FakeEl | null = dustLabel
    let dustRowLocked = false
    while (node) {
      if (node.attributes['data-role'] === 'bg-fx-row') { dustRowLocked = true; break }
      node = node._parent
    }
    expect(dustRowLocked).toBe(false)
    panel.dispose()
  })

  it('背景回流（onBackgroundChanged）后 draft 换新：先播种 aurora，回流成上传背景 → 锁定小字出现；且此后滑块 commit 带上新 current（不回写旧值）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    let body = panel.backgroundBodyForTest as unknown as FakeEl
    expect(collectByRole(body, 'bg-locked-note')).toHaveLength(0)

    const newBg: BackgroundSettings = {
      ...structuredClone(DEFAULT_BACKGROUND_SETTINGS),
      current: BG_ID,
      customBackgrounds: [{ id: BG_ID, kind: 'image' }],
    }
    bgChangedCbOf(deps)(newBg)

    // 回流后突变广播对象本身（模拟同 channel 其他订阅者就地改传入对象）：draft 必须是 clone，
    // 不能被这次突变污染——否则后续 commit 会带上污染值，跨模块打架
    newBg.current = 'polluted-should-not-leak'

    // 全量重建后仍是同一容器引用（buildBackgroundSection 只清子节点，backgroundBody 本体不换）
    body = panel.backgroundBodyForTest as unknown as FakeEl
    expect(collectByRole(body, 'bg-locked-note')).toHaveLength(1)

    // 未锁定的尘埃密度滑杆（文档序：极光/涟漪(虚空之镜)/透明度/饱和度(自定义背景v2)/
    // 尘埃密度/尘埃大小/尘埃亮度，index 4）仍可操作——尘埃组不受任一置灰镜像影响，恒可调；
    // 这是本任务存在的根本理由：commit 载荷必须带上回流后的新 current，不能整包回写过期播种快照
    const sliders = collectSliders(body)
    sliders[4].value = '0.9'
    sliders[4].dispatch('change')
    expect(deps.commitBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ current: BG_ID }))
    panel.dispose()
  })

  it('背景回流对象事后被外部突变，不污染已落盘的 draft（回流赋值必须 clone，惯例同种子路径）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const newBg: BackgroundSettings = {
      ...structuredClone(DEFAULT_BACKGROUND_SETTINGS),
      current: BG_ID,
      customBackgrounds: [{ id: BG_ID, kind: 'image' }],
    }
    bgChangedCbOf(deps)(newBg)
    newBg.current = 'polluted-should-not-leak' // 广播源事后被别处突变

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    const sliders = collectSliders(body)
    // index 4 = 尘埃密度滑杆（文档序见上一条用例注释）
    sliders[4].value = '0.9'
    sliders[4].dispatch('change')
    // draft 若是引用而非 clone，此处会读到 'polluted-should-not-leak'
    expect(deps.commitBackgroundFx).toHaveBeenCalledWith(expect.objectContaining({ current: BG_ID }))
    panel.dispose()
  })
})

describe('调音台·自定义背景控件组（视频背景 v2：与虚空之镜组互为置灰镜像）', () => {
  const BG_ID = '11111111-2222-3333-4444-555555555555'

  /** 沿树收集 data-role 命中的节点（惯例同上方「背景 tab 联动」describe 的 collectByRole） */
  function collectByRole(root: FakeEl, role: string): FakeEl[] {
    const out: FakeEl[] = []
    if (root.attributes['data-role'] === role) out.push(root)
    for (const c of root.children) out.push(...collectByRole(c, role))
    return out
  }

  /** 沿树找 textContent 恰为 text 的节点（惯例同「背景 tab」describe 用例写法） */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  it('current=aurora：bg-custom-row 全部置灰(opacity 0.45+pointerEvents none)，bg-fx-row 可用', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    const customRows = collectByRole(body, 'bg-custom-row')
    expect(customRows.length).toBeGreaterThan(0)
    for (const row of customRows) {
      expect(row.style.opacity).toBe('0.45')
      expect(row.style.pointerEvents).toBe('none')
    }
    const fxRows = collectByRole(body, 'bg-fx-row')
    for (const row of fxRows) {
      expect(row.style.opacity).toBeUndefined()
      expect(row.style.pointerEvents).toBeUndefined()
    }
    panel.dispose()
  })

  it('current=<uuid>：镜像翻转——bg-custom-row 可用，bg-fx-row 置灰', async () => {
    const background: BackgroundSettings = {
      ...structuredClone(DEFAULT_BACKGROUND_SETTINGS),
      current: BG_ID,
      customBackgrounds: [{ id: BG_ID, kind: 'image' }],
    }
    const deps = makeDeps(defaultRhythmPreset(), background)
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    const customRows = collectByRole(body, 'bg-custom-row')
    expect(customRows.length).toBeGreaterThan(0)
    for (const row of customRows) {
      expect(row.style.opacity).toBeUndefined()
      expect(row.style.pointerEvents).toBeUndefined()
    }
    const fxRows = collectByRole(body, 'bg-fx-row')
    expect(fxRows.length).toBeGreaterThan(0)
    for (const row of fxRows) {
      expect(row.style.opacity).toBe('0.45')
      expect(row.style.pointerEvents).toBe('none')
    }
    panel.dispose()
  })

  it('控件齐全：透明度/饱和度两滑块 + 呼吸开关落在 backgroundBody（显示主体已迁至主体 tab，通用化）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(docBody as unknown as HTMLElement, deps)
    await flush()
    findByText(docBody, '背景')!.dispatch('click')

    const body = panel.backgroundBodyForTest as unknown as FakeEl
    const customRows = collectByRole(body, 'bg-custom-row')
    expect(customRows).toHaveLength(3)
    panel.dispose()
  })
})

describe('TuningPanel：主体显隐开关', () => {
  /** 沿当前活树按文本精确匹配查找第一个节点（同「运动旋钮」describe 块内写法） */
  function findByText(root: FakeEl, text: string): FakeEl | null {
    if (root.textContent === text) return root
    for (const c of root.children) {
      const hit = findByText(c, text)
      if (hit) return hit
    }
    return null
  }

  /** makeToggleRow 结构：row=[labelGroup, toggleHost]，toggleHost.children[0] 是 ToggleSwitch 的 track 根节点
   * （同「运动旋钮」describe 块内 findToggleTrackFor 写法） */
  function findToggleTrackFor(parent: FakeEl, labelText: string): FakeEl {
    const label = findByText(parent, labelText)!
    const row = label._parent!._parent!
    const toggleHost = row.children[row.children.length - 1]
    return toggleHost.children[0]
  }

  it('主体 tab 渲染「显示主体」开关，位置在页首说明之后、当前形状之前', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const shapeBody = panel.shapeBodyForTest as unknown as FakeEl
    const row = findByRole(shapeBody, 'shape-show-body')
    expect(row).toBeTruthy()
    // 顺序：直接子节点里，说明行 < 本开关 < 当前形状行
    const idx = (role: string): number => shapeBody.children.findIndex((c) => findByRole(c, role) !== null)
    expect(idx('shape-show-body')).toBeLessThan(idx('shape-current-row'))
  })

  it('拨开关 → 走 setShape 落盘', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const parent = panel.shapeBodyForTest as unknown as FakeEl
    // 定位沿用该文件既有的「封面优先开关」写法：findByText 拿 label → findToggleTrackFor 拿 track
    findToggleTrackFor(parent, '显示主体').dispatch('click')
    expect(deps.setShape).toHaveBeenCalled()
    // deps.setShape 静态类型是 TuningPanelDeps 声明的裸函数签名（非 Mock），故借道 ReturnType<typeof vi.fn>
    // 取 .mock（同文件 onShapeChanged 的既有取用手法，见「切回星云」用例）
    expect((deps.setShape as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].showBody).toBe(false) // 默认 true → 拨后 false
  })
})

describe('openToTab（v2 亲验反馈②：卡片编辑钮打开调音台直落对应页）', () => {
  it('关着时调用：面板打开且直落形状页，其余分区隐藏', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    panel.openToTab('shape')
    expect(panel.isOpen).toBe(true)
    expect((panel.shapeBodyForTest as unknown as FakeEl).style.display).toBe('')
    expect((panel.generalBodyForTest as unknown as FakeEl).style.display).toBe('none')
    panel.dispose()
  })
  it('开着时调用：等效只切页（背景页），面板保持打开', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    panel.toggle()
    panel.openToTab('background')
    expect(panel.isOpen).toBe(true)
    expect((panel.backgroundBodyForTest as unknown as FakeEl).style.display).toBe('')
    panel.dispose()
  })
})

describe('律动 tab 能力自适应（mixer v2）', () => {
  const treeTexts = (root: FakeEl): string[] => [root.textContent, ...root.children.flatMap((c) => treeTexts(c))]

  it('激光在台：律动页无「空间」组，其余四组在；页首有全局说明与宏旋钮占位锚', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    deps.getShape = vi.fn(async () => ({ current: 'laser' as const, customCurrent: null, customShapes: [], coverPriority: false, showBody: true }))
    const parent = fakeElement()
    const panel = new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const texts = treeTexts(body)
    expect(texts).not.toContain('空间')
    for (const label of ['速度', '密度', '亮度', '厚度']) expect(texts).toContain(label)
    const roles = (root: FakeEl): string[] => [root.attributes['data-role'] ?? '', ...root.children.flatMap((c) => roles(c))]
    expect(roles(body)).toContain('rhythm-global-hint')
    expect(roles(body)).toContain('macro-knobs-slot')
  })

  it('切回星云（onShapeChanged 回流）：五组齐全，被隐目标的规则值未丢', async () => {
    const mapping = defaultRhythmPreset()
    mapping.targets.space.primary.gain = 1.7 // 哨兵值：隐藏期间不许被改（GAIN_MAX=2 内合法）
    const deps = makeDeps(mapping)
    deps.getShape = vi.fn(async () => ({ current: 'laser' as const, customCurrent: null, customShapes: [], coverPriority: false, showBody: true }))
    const parent = fakeElement()
    const panel = new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush() // 播种完成：激光在台，空间组未渲染
    const cb = (deps.onShapeChanged as ReturnType<typeof vi.fn>).mock.calls[0][0] as (s: ShapeSettings) => void
    cb({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: true, showBody: true })
    const body = panel.generalBodyForTest as unknown as FakeEl
    expect(treeTexts(body)).toContain('空间')
    // 值不丢：空间组重新渲染后，强度滑块初值=哨兵值（滑块 value 由 draft 播种，见 makeRange）
    expect(created.some((el) => el.type === 'range' && el.value === '1.7')).toBe(true)
  })

  it('tab 栏五标签：律动 / 主体 / 镜头 / 歌词歌名 / 背景', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const parent = fakeElement()
    new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()
    const all = created.map((el) => el.textContent)
    for (const label of ['律动', '主体', '镜头', '歌词歌名', '背景']) expect(all).toContain(label)
    expect(all).not.toContain('音画映射')
    expect(all).not.toContain('形状专属')
    // 顺序须与定稿一致（律动/主体/镜头/歌词歌名/背景）——只查存在会漏掉镜头/主体对调。
    // 用首次出现位置断言（「镜头」还会作为镜头页组标题再现，indexOf 取 tab 那次）
    const order = ['律动', '主体', '镜头', '歌词歌名', '背景'].map((l) => all.indexOf(l))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('激光形状律动页无「空间」组：即便封面优先开着也不显示（封面优先≠封面正在接管，无封面时台上仍是激光，不显示无效组）', async () => {
    // 真正的粒子接管判据是 coverPriority && coverCloud（resolve.ts），面板层拿不到 coverCloud 运行时状态，
    // 故只按当前形状能力显隐——宁可封面接管瞬间暂缺有效组，也不显示对激光无效的死件（spec 零死件优先）
    const deps = makeDeps(defaultRhythmPreset())
    deps.getShape = vi.fn(async () => ({ current: 'laser' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true }))
    const parent = fakeElement()
    const panel = new TuningPanel(parent as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    expect(treeTexts(body)).not.toContain('空间')
  })
})

describe('TuningPanel：标准层宏旋钮', () => {
  it('律动 tab 顶部渲染劲儿/跟手两滑块，含中点 0.5 刻度', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    for (const role of ['macro-knob-strength', 'macro-knob-response']) {
      const row = findByRole(body, role)
      expect(row, role).toBeTruthy()
      expect(rangeIn(row!).value).toBe('0.5') // 默认播种在中点
    }
    // 中点刻度：tick-strip 存在（makeRange 的 ticks 渲染）
    expect(findByRole(findByRole(body, 'macro-knob-strength')!, 'tick-strip')).toBeTruthy()
  })

  it('拖动劲儿（input）只 preview，产出=macroToMapping；松手（change）落 mapping + macroKnobs 并重刷专业表', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const slider = rangeIn(findByRole(body, 'macro-knob-strength')!)

    slider.value = '1'
    slider.dispatch('input')
    expect(deps.previewMapping).toHaveBeenCalledTimes(1)
    expect(deps.commitMapping).not.toHaveBeenCalled()
    const previewed = deps.previewMapping.mock.calls[0][0] as MappingValues
    expect(previewed).toEqual(macroToMapping({ style: 'balanced', strength: 1, response: 0.5 }))

    slider.dispatch('change')
    expect(deps.commitMapping).toHaveBeenCalledTimes(1)
    expect(deps.commitMacroKnobs).toHaveBeenCalledTimes(1)
    expect(deps.commitMacroKnobs.mock.calls[0][0]).toEqual({ style: 'balanced', strength: 1, response: 0.5 })
    const projected = macroToMapping({ style: 'balanced', strength: 1, response: 0.5 })
    const committed = deps.commitMapping.mock.calls.at(-1)![0] as MappingValues
    // 均衡档下 brightness.primary 是 lead（speed.primary 是 neutral，strength=1 时 gain 恒等于播种值 1，
    // 探针没有区分度，测不出重刷回归），strength=1 → gain 1×1.5=1.5，与播种值 1 有区分度
    expect(committed.targets.brightness.primary.gain).toBeCloseTo(projected.targets.brightness.primary.gain, 5)
    // 重刷专业表：松手后底下 brightness·primary 的「强度」滑块（行内第一个 range）跳到投影后的值——
    // 只断言 commit 入参会漏掉这条链路（去掉重刷仍全绿），故直接读 DOM
    expect(rangeIn(findByRole(body, 'rule-brightness-primary')!).value)
      .toBe(String(projected.targets.brightness.primary.gain))
  })

  it('重置按钮：两旋钮回中点 = 默认预设', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    // 先把劲儿拖离中点
    const slider = rangeIn(findByRole(body, 'macro-knob-strength')!)
    slider.value = '1'; slider.dispatch('change')
    // 点重置
    findByRole(panel.generalBodyForTest as unknown as FakeEl, 'macro-reset')!.dispatch('click')
    expect(deps.commitMacroKnobs.mock.calls.at(-1)![0]).toEqual(DEFAULT_MACRO_KNOBS)
    const committed = deps.commitMapping.mock.calls.at(-1)![0] as MappingValues
    expect(committed).toEqual(defaultRhythmPreset())
  })

  it('落盘旋钮位置传副本：连拖两个旋钮，第一条调用记录不被追溯篡改', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl

    const strength = rangeIn(findByRole(body, 'macro-knob-strength')!)
    strength.value = '1'; strength.dispatch('change')
    const response = rangeIn(findByRole(body, 'macro-knob-response')!)
    response.value = '0'; response.dispatch('change')

    expect(deps.commitMacroKnobs.mock.calls[0][0]).toEqual({ style: 'balanced', strength: 1, response: 0.5 })
    expect(deps.commitMacroKnobs.mock.calls[1][0]).toEqual({ style: 'balanced', strength: 1, response: 0 })
  })

  it('重置：两滑块 thumb 一起回中点（宏旋钮子树不重建，须显式回写）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const strength = rangeIn(findByRole(body, 'macro-knob-strength')!)
    strength.value = '1'; strength.dispatch('change')

    findByRole(body, 'macro-reset')!.dispatch('click')
    for (const role of ['macro-knob-strength', 'macro-knob-response']) {
      expect(rangeIn(findByRole(body, role)!).value, role).toBe('0.5')
    }
  })

  it('松手只重刷专业表，不重建宏旋钮子树——滑块仍是同一个节点（键盘方向键连发 input+change 时不丢焦点）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const before = rangeIn(findByRole(body, 'macro-knob-strength')!)
    const resetBefore = findByRole(body, 'macro-reset')!

    before.value = '0.7'; before.dispatch('change')
    expect(rangeIn(findByRole(body, 'macro-knob-strength')!)).toBe(before)

    // 重置按钮同理：不再在自己的 click 回调里被销毁
    resetBefore.dispatch('click')
    expect(findByRole(body, 'macro-reset')).toBe(resetBefore)
    expect(rangeIn(findByRole(body, 'macro-knob-strength')!)).toBe(before)
  })
})

describe('TuningPanel：宏旋钮陈旧提示', () => {
  it('初始不显示；专业表手调后显示；再动宏旋钮后消失', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = () => panel.generalBodyForTest as unknown as FakeEl

    // 初始：无提示（或 display:none）
    const initial = findByRole(body(), 'macro-stale-note')
    expect(initial === null || initial.style.display === 'none').toBe(true)

    // 专业表手调一个规则滑块（speed·primary gain，宏旋钮之下第一个非宏 range）——
    // 找 macroSlot 之外的第一个 range：用 buildRuleEditor 的「强度」行
    const proRow = findByRole(body(), 'rule-speed-primary')! // 规则编辑器行锚点
    const proSlider = rangeIn(proRow)
    proSlider.value = '1.5'; proSlider.dispatch('change')

    const stale = findByRole(body(), 'macro-stale-note')
    expect(stale).toBeTruthy()
    expect(stale!.style.display).not.toBe('none')

    // 再动宏旋钮：提示消失
    const knob = rangeIn(findByRole(body(), 'macro-knob-strength')!)
    knob.value = '0.7'; knob.dispatch('change')
    const after = findByRole(body(), 'macro-stale-note')
    expect(after === null || after.style.display === 'none').toBe(true)
  })

  it('老存档：mapping 是手调值 + 旋钮停在中点 → 面板一打开就点亮（陈旧位从数据推导，跨重启有效）', async () => {
    const tweaked = defaultRhythmPreset()
    tweaked.targets.speed.primary.gain = 1.7 // 手调痕迹：与中点旋钮的投影（=默认预设）对不上
    const deps = makeDeps(tweaked) // 旋钮位置=默认均衡档 + 两个 0.5（老存档没有该字段时也是这个回退值）
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    const note = findByRole(panel.generalBodyForTest as unknown as FakeEl, 'macro-stale-note')
    expect(note).toBeTruthy()
    expect(note!.style.display).not.toBe('none')
  })

  it('存档 mapping 恰是旋钮位置的投影（非中点也算）→ 不点亮', async () => {
    const knobs: MacroKnobs = { style: 'balanced', strength: 0.8, response: 0.3 }
    // 种子走存储层同款归一化（sanitizeMappingValues）而非 macroToMapping 直出对象——
    // 否则种子键序恰好与投影侧同源（都是 rule() 序），双侧删 sanitize 的回归会被这套键序巧合悄悄放过
    const deps = makeDeps(sanitizeMappingValues(macroToMapping(knobs)))
    deps.getMacroKnobs = vi.fn(async () => ({ ...knobs }))
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()

    const note = findByRole(panel.generalBodyForTest as unknown as FakeEl, 'macro-stale-note')
    expect(note === null || note.style.display === 'none').toBe(true)
  })
})

describe('TuningPanel：风格按钮', () => {
  it('渲染四档风格，默认选中均衡（选中态用颜色透明度表达）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    expect(findByRole(body, 'macro-style-row')).toBeTruthy()
    for (const id of ['balanced', 'rhythmic', 'ambient', 'bass']) {
      expect(findByRole(body, `macro-style-${id}`), id).toBeTruthy()
    }
    expect(findByRole(body, 'macro-style-balanced')!.textContent).toBe('均衡')
    // 选中态：均衡用选中透明度 0.85，其余用未选 0.35
    expect(findByRole(body, 'macro-style-balanced')!.style.color).toContain('0.85')
    for (const id of ['rhythmic', 'ambient', 'bass']) {
      expect(findByRole(body, `macro-style-${id}`)!.style.color, id).toContain('0.35')
    }
  })

  it('点风格 → 落整套投影 + 落 macroKnobs + 重刷专业表 + 选中态迁移', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl

    findByRole(body, 'macro-style-rhythmic')!.dispatch('click')

    expect(deps.commitMacroKnobs).toHaveBeenCalledTimes(1)
    expect(deps.commitMacroKnobs.mock.calls[0][0])
      .toEqual({ style: 'rhythmic', strength: 0.5, response: 0.5 })
    const committed = deps.commitMapping.mock.calls.at(-1)![0] as MappingValues
    expect(committed).toEqual(macroToMapping({ style: 'rhythmic', strength: 0.5, response: 0.5 }))
    expect(committed.targets.speed.primary.source).toBe('energy')

    // 重刷专业表（DOM 断言，不是 mock 入参）：speed 行的「平滑」滑块从默认 1000ms 变成节奏档的 200ms。
    // 删掉 applyMacro 里的 buildRuleRows 这条会红。
    const proRow = findByRole(panel.generalBodyForTest as unknown as FakeEl, 'rule-speed-primary')!
    expect(rangesIn(proRow)[1].value).toBe('200')

    // 选中态跟着迁移（风格行不重建，靠 makeChoiceRow 内部 paint）
    const after = panel.generalBodyForTest as unknown as FakeEl
    expect(findByRole(after, 'macro-style-rhythmic')!.style.color).toContain('0.85')
    expect(findByRole(after, 'macro-style-balanced')!.style.color).toContain('0.35')
  })

  it('重置 → 风格回均衡且选中态跟着回退', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl

    findByRole(body, 'macro-style-bass')!.dispatch('click')
    findByRole(panel.generalBodyForTest as unknown as FakeEl, 'macro-reset')!.dispatch('click')

    expect(deps.commitMacroKnobs.mock.calls.at(-1)![0]).toEqual(DEFAULT_MACRO_KNOBS)
    const committed = deps.commitMapping.mock.calls.at(-1)![0] as MappingValues
    expect(committed).toEqual(defaultRhythmPreset())
    // 选中态回退：重置绕过点击直接改 macroDraft，靠 macroKnobSyncs 里的 repaint 钩子刷新
    const after = panel.generalBodyForTest as unknown as FakeEl
    expect(findByRole(after, 'macro-style-balanced')!.style.color).toContain('0.85')
    expect(findByRole(after, 'macro-style-bass')!.style.color).toContain('0.35')
  })

  it('风格行 ⓘ 图标不被 buildRuleRows 的 drain 误杀（hover 仍出 tooltip）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const row = findByRole(panel.generalBodyForTest as unknown as FakeEl, 'macro-style-row')!
    const icons = collectIcons(row)
    expect(icons.length).toBe(1)
    icons[0].dispatch('mouseenter')
    const tips = tooltipsInBody()
    expect(tips.length).toBe(1)
    expect(tips[0].textContent).toContain('节奏咬鼓点')
  })
})

describe('TuningPanel：高级调整折叠', () => {
  it('默认收起：折叠头存在，专业表 display 为 none', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const toggle = findByRole(body, 'advanced-toggle')
    expect(toggle).toBeTruthy()
    expect(toggle!.textContent).toContain('高级调整')
    expect(findByRole(body, 'rule-rows')!.style.display).toBe('none')
  })

  it('点折叠头 → 展开并落盘；再点 → 收起并落盘', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    const toggle = findByRole(body, 'advanced-toggle')!

    toggle.dispatch('click')
    expect(findByRole(body, 'rule-rows')!.style.display).toBe('')
    expect(deps.commitAdvancedExpanded).toHaveBeenCalledWith(true)

    toggle.dispatch('click')
    expect(findByRole(body, 'rule-rows')!.style.display).toBe('none')
    expect(deps.commitAdvancedExpanded).toHaveBeenLastCalledWith(false)
  })

  it('播种为展开态 → 构造后直接可见（跨重启记住）', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    deps.getAdvancedExpanded.mockResolvedValue(true)
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    expect(findByRole(body, 'rule-rows')!.style.display).toBe('')
  })

  it('收起不等于停更：收起时动宏旋钮，专业表值仍更新且保持收起', async () => {
    const deps = makeDeps(defaultRhythmPreset())
    const panel = new TuningPanel(fakeElement() as unknown as HTMLElement, deps)
    await flush()
    const body = panel.generalBodyForTest as unknown as FakeEl
    expect(findByRole(body, 'rule-rows')!.style.display).toBe('none') // 前提：收起态

    // 劲儿推到底 → 亮度·主源（均衡档主导）gain 变 1.5
    const knob = rangeIn(findByRole(body, 'macro-knob-strength')!)
    knob.value = '1'
    knob.dispatch('change')

    const rows = findByRole(panel.generalBodyForTest as unknown as FakeEl, 'rule-rows')!
    expect(rows.style.display, '重建不许掀开折叠').toBe('none')
    expect(rangeIn(findByRole(rows, 'rule-brightness-primary')!).value, '收起态下值仍须跟着更新').toBe('1.5')
  })
})
