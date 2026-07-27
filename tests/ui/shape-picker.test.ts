import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShapePicker, type ShapePickerDeps } from '../../src/ui/shape-picker'
import type { BackgroundSettings } from '../../src/scenes/nebula/background-types'

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

/** node 环境无 DOM：stub 最小 document/element 表面（照抄 tuning-panel.test.ts 的 fakeElement 基建） */
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

let docListeners: Record<string, Handler[]>
let docBody: FakeEl

beforeEach(() => {
  docListeners = {}
  docBody = fakeElement()
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => fakeElement(),
    body: docBody,
    addEventListener: (type: string, cb: Handler) => { (docListeners[type] ??= []).push(cb) },
    removeEventListener: (type: string, cb: Handler) => {
      docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== cb)
    }
  }
})

/** 派发一个 document 级事件——本文件 stub 的 helper，供测试直接触发 keydown/pointerdown */
function dispatchDocEvent(type: string, e?: unknown): void {
  for (const cb of docListeners[type] ?? []) cb(e)
}

/** 当前登记在 document 上的某类型监听器数量——用于校验 dispose 摘监听不泄漏 */
function docListenerCount(type: string): number {
  return (docListeners[type] ?? []).length
}

/** 递归收集 el 及其 children 的 textContent（非空）——供卡片文案断言反查 */
function collectText(el: FakeEl): string[] {
  const out: string[] = []
  if (el.textContent) out.push(el.textContent)
  for (const c of el.children) out.push(...collectText(c))
  return out
}

/** 递归按 attributes[key]===value 查找第一个匹配节点（含自身）——供 data-shape-id 反查 */
function findByAttr(el: FakeEl, key: string, value: string): FakeEl | null {
  if (el.attributes[key] === value) return el
  for (const c of el.children) {
    const found = findByAttr(c, key, value)
    if (found) return found
  }
  return null
}

/** 递归按 textContent 精确匹配查找第一个节点——供文案反查 */
function findByText(el: FakeEl, text: string): FakeEl | null {
  if (el.textContent === text) return el
  for (const c of el.children) {
    const found = findByText(c, text)
    if (found) return found
  }
  return null
}

/** 播种是异步的（getShape 走一次 microtask）——flush 两轮足够让 .then 回调落地 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function makeDeps(overrides: Partial<ShapePickerDeps> = {}): ShapePickerDeps {
  return {
    getShape: async () => ({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: true, showBody: true }),
    setShape: vi.fn(),
    onShapeChanged: vi.fn(),
    // 背景三件必填 dep（自定义背景 v1）：既有形状用例不关心背景，给可运行的默认空实现即可
    getBackground: async () => ({
      aurora: 1, ripple: 1, dust: 0.7, dustSize: 1, dustBright: 1, mirror: true,
      customBackgrounds: [], current: 'aurora', bgOpacity: 0.8, bgSaturation: 1, bgBreathe: true,
    }),
    setBackground: vi.fn(),
    onBackgroundChanged: vi.fn(),
    ...overrides,
  }
}

describe('ShapePicker 骨架（B2 T2）', () => {
  it('初始关闭：容器 visibility hidden / pointer-events none', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    const root = parent.children[1] // children[0] 是底部暗幕（亲验反馈新增，先挂垫底）
    expect(root.style.visibility).toBe('hidden')
    expect(root.style.pointerEvents).toBe('none')
  })
  it('open→广播 onOpenChange(true)，close→false；toggle 往返', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    const events: boolean[] = []
    p.onOpenChange = (o) => events.push(o)
    p.toggle()
    expect(p.isOpen).toBe(true)
    p.toggle()
    expect(p.isOpen).toBe(false)
    expect(events).toEqual([true, false])
  })
  it('Esc capture 关闭（open 后 document keydown 捕获监听生效）', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    p.open()
    dispatchDocEvent('keydown', { key: 'Escape', stopPropagation: () => {} })
    expect(p.isOpen).toBe(false)
  })
  it('点外部关；点容器内不关；点忽略区（触发源）不关', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    const trigger = fakeElement()
    p.ignoreOutsideClickWithin = [trigger as unknown as HTMLElement]
    p.open()
    await flushMacrotask() // pointerdown 监听延迟一个宏任务挂载（防触发开关那次点击自关，镜像 BasePanel）
    const inside = parent.children[1] // children[0] 是底部暗幕
    dispatchDocEvent('pointerdown', { target: inside })
    expect(p.isOpen).toBe(true)
    dispatchDocEvent('pointerdown', { target: trigger })
    expect(p.isOpen).toBe(true)
    dispatchDocEvent('pointerdown', { target: fakeElement() })
    expect(p.isOpen).toBe(false)
  })
  it('open→deps.onOpenStateChanged(true)，close→false（B2 亲验反馈①：压制通道独立于 onOpenChange）', async () => {
    const parent = fakeElement()
    const events: boolean[] = []
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      onOpenStateChanged: (open) => events.push(open),
    }))
    await flush()
    p.open()
    p.close()
    expect(events).toEqual([true, false])
  })

  it('未提供 onOpenStateChanged 钩子时 open/close 不炸', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    expect(() => { p.open(); p.close() }).not.toThrow()
  })

  it('dispose：摘 document 监听 + 移除容器（open 态 dispose 不泄漏）', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    p.open()
    p.dispose()
    expect(docListenerCount('keydown')).toBe(0)
    expect(docListenerCount('pointerdown')).toBe(0)
  })
})

describe('卡片渲染与选中（B2 T3）', () => {
  it('按注册表序渲染卡片（statue/星球/晶体 退役后阵容7卡，label 中文仅显示层）', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    const names = ['星云', '心脏', '日食', '点阵', '激光']
    const labels = collectText(parent).filter((t) => names.includes(t))
    expect(labels).toEqual(names)
  })
  it('当前形状卡带激活态（发光描边 box-shadow 非空），其余无', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      getShape: async () => ({ current: 'heart', customCurrent: null, customShapes: [], coverPriority: true, showBody: true }),
    }))
    await flush()
    const heart = findByAttr(parent, 'data-shape-id', 'heart')!
    const nebula = findByAttr(parent, 'data-shape-id', 'nebula')!
    expect(heart.style.boxShadow).not.toBe('')
    expect(nebula.style.boxShadow ?? '').toBe('')
  })
  it('点卡：setShape 收全量英文枚举 + 乐观高亮立即切换（不等回流）', async () => {
    const parent = fakeElement()
    const deps = makeDeps()
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const heart = findByAttr(parent, 'data-shape-id', 'heart')!
    heart.dispatch('click')
    expect(deps.setShape).toHaveBeenCalledWith({ current: 'heart', customCurrent: null, customShapes: [], coverPriority: true, showBody: true })
    expect(heart.style.boxShadow).not.toBe('') // 乐观：点卡即高亮（B1 终审 B2 注意项）
  })
  it('回流兜底：onShapeChanged 送 heart → 高亮校正到心脏卡', async () => {
    const parent = fakeElement()
    let cb: ((s: unknown) => void) | null = null
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      onShapeChanged: (f) => { cb = f as never },
    }))
    await flush()
    cb!({ current: 'heart', coverPriority: true })
    expect(findByAttr(parent, 'data-shape-id', 'heart')!.style.boxShadow).not.toBe('')
  })
  it('错峰浮现：七卡 transition-delay 分别为 0/70/.../420ms（open 时）', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    p.open()
    const delays = ['nebula', 'heart', 'spectrum', 'waveform', 'eclipse', 'ledmatrix', 'laser'].map(
      (id) => findByAttr(parent, 'data-shape-id', id)!.style.transitionDelay
    )
    expect(delays).toEqual(['0ms', '70ms', '140ms', '210ms', '280ms', '350ms', '420ms'])
  })
})

describe('封面优先胶囊开关（B2 T4）', () => {
  it('渲染在卡片行上方：能找到说明文字「有封面时优先显示封面粒子」', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    expect(findByText(parent, '有封面时优先显示封面粒子')).not.toBeNull()
  })

  it('拨动 → setShape 收全量 coverPriority 翻转', async () => {
    const parent = fakeElement()
    const deps = makeDeps()
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const pill = findByText(parent, '有封面时优先显示封面粒子')!._parent!
    const toggleHost = pill.children[pill.children.length - 1]
    toggleHost.children[0].dispatch('click')
    expect(deps.setShape).toHaveBeenCalledWith({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: false, showBody: true })
  })

  it('回流兜底：onShapeChanged 送 coverPriority=false → 开关视觉态跟随（setChecked 被调）', async () => {
    const parent = fakeElement()
    let cb: ((s: unknown) => void) | null = null
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      onShapeChanged: (f) => { cb = f as never },
    }))
    await flush()
    const pill = findByText(parent, '有封面时优先显示封面粒子')!._parent!
    const toggleHost = pill.children[pill.children.length - 1]
    const toggleEl = toggleHost.children[0]
    const onColor = toggleEl.style.backgroundColor
    cb!({ current: 'nebula', coverPriority: false })
    expect(toggleEl.style.backgroundColor).not.toBe(onColor)
  })
})

describe('选择器单行横滑（S1 T6）', () => {
  it('S1 横滑：卡片行 overflowX=auto 且滚轮纵滚映射为横滚（deltaY→scrollLeft，preventDefault）', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    // 卡片行定位：任一卡片（data-shape-id）的父节点
    const card = findByAttr(parent, 'data-shape-id', 'nebula')!
    const cardRow = card._parent! as FakeEl & { scrollLeft: number }
    expect(cardRow.style.overflowX).toBe('auto')
    cardRow.scrollLeft = 0
    let prevented = false
    // onWheel 现服务两行（形状/背景卡行），读 e.currentTarget 定位滚动域——真实 DOM 事件总带 currentTarget，
    // fake dispatch 需显式传（生产实现改动见 shape-picker.ts onWheel）
    cardRow.dispatch('wheel', { deltaY: 120, deltaX: 0, currentTarget: cardRow, preventDefault: () => { prevented = true } })
    expect(cardRow.scrollLeft).toBe(120)
    expect(prevented).toBe(true)
  })
})

const UID1 = '00000001-0000-4000-8000-000000000000'
const textMeta = { id: UID1, kind: 'text' as const, text: '告白' }
const baseShape = { current: 'nebula' as const, customCurrent: null, customShapes: [textMeta], coverPriority: true, showBody: true }

/** custom-shapes 相关 deps 的默认 stub：四个新回调均给可运行的空实现，测试按需覆盖 */
function makeCustomDeps(overrides: Partial<ShapePickerDeps> = {}): ShapePickerDeps {
  return makeDeps({
    readCustomShapeImage: async () => new Uint8Array(),
    deleteCustomShapeFile: vi.fn(),
    onCreateRequest: vi.fn(),
    showHint: vi.fn(),
    ...overrides,
  })
}

describe('shape-picker · 自定义收藏卡（idea #12）', () => {
  it('内置 7 卡之后渲染收藏卡与"+"卡', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeCustomDeps({
      getShape: async () => baseShape,
    }))
    await flush()
    const cardRow = findByAttr(parent, 'data-shape-id', 'nebula')!._parent!
    expect(cardRow.children.length).toBe(7 + 1 + 1)
    expect(collectText(parent)).toContain('告白')
  })

  it('点收藏卡 → setShape 收到 customCurrent=id；点内置卡 → customCurrent 归 null', async () => {
    const parent = fakeElement()
    const deps = makeCustomDeps({ getShape: async () => baseShape })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const customCard = findByAttr(parent, 'data-shape-id', UID1)!
    customCard.dispatch('click')
    expect(deps.setShape).toHaveBeenLastCalledWith(
      expect.objectContaining({ customCurrent: UID1 })
    )
    const heart = findByAttr(parent, 'data-shape-id', 'heart')!
    heart.dispatch('click')
    expect(deps.setShape).toHaveBeenLastCalledWith(
      expect.objectContaining({ current: 'heart', customCurrent: null })
    )
  })

  it('点 × → setShape 移除该条 + customCurrent 归 null + deleteCustomShapeFile 被调', async () => {
    const parent = fakeElement()
    const deps = makeCustomDeps({
      getShape: async () => ({ ...baseShape, customCurrent: UID1 }),
    })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const customCard = findByAttr(parent, 'data-shape-id', UID1)!
    const deleteBtn = findByText(customCard, '×')!
    deleteBtn.dispatch('click', { stopPropagation: () => {} })
    expect(deps.setShape).toHaveBeenLastCalledWith(
      expect.objectContaining({ customShapes: [], customCurrent: null })
    )
    expect(deps.deleteCustomShapeFile).toHaveBeenCalledWith(UID1)
    expect(findByAttr(parent, 'data-shape-id', UID1)).toBeNull() // 卡片确实从 DOM 消失（不止 setShape 参数对）
  })

  it('满 9 个时点"+" → showHint 而非 onCreateRequest', async () => {
    const parent = fakeElement()
    const fullShapes = Array.from({ length: 9 }, (_, i) => ({
      id: `0000000${i}-0000-4000-8000-00000000000${i}`,
      kind: 'text' as const,
      text: `第${i}条`,
    }))
    const deps = makeCustomDeps({
      getShape: async () => ({ current: 'nebula' as const, customCurrent: null, customShapes: fullShapes, coverPriority: true, showBody: true }),
    })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const plusCard = findByAttr(parent, 'data-shape-id', '__plus')!
    plusCard.dispatch('click')
    expect(deps.showHint).toHaveBeenCalledWith('收藏已满，先删一个')
    expect(deps.onCreateRequest).not.toHaveBeenCalled()
  })

  it('图片卡：deps 未提供 readCustomShapeImage 时渲染不抛错，img.src 留空占位', async () => {
    const parent = fakeElement()
    const imgMeta = { id: UID1, kind: 'image' as const }
    new ShapePicker(parent as unknown as HTMLElement, makeCustomDeps({
      getShape: async () => ({ current: 'nebula' as const, customCurrent: null, customShapes: [imgMeta], coverPriority: true, showBody: true }),
      readCustomShapeImage: undefined,
    }))
    await flush()
    const card = findByAttr(parent, 'data-shape-id', UID1)!
    expect(card).not.toBeNull()
    const img = card.children[0].children[0] as FakeEl & { src?: string }
    expect(img.src).toBeUndefined() // 占位背景兜底，src 未被填充
  })

  it('图片卡：缩略图字节异步到达 → objectURL 填入 img.src', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-0')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      const parent = fakeElement()
      const imgMeta = { id: UID1, kind: 'image' as const }
      new ShapePicker(parent as unknown as HTMLElement, makeCustomDeps({
        getShape: async () => ({ current: 'nebula' as const, customCurrent: null, customShapes: [imgMeta], coverPriority: true, showBody: true }),
        readCustomShapeImage: async () => new Uint8Array([1, 2, 3]),
      }))
      await flush()
      const img = findByAttr(parent, 'data-shape-id', UID1)!.children[0].children[0] as FakeEl & { src?: string }
      expect(img.src).toBe('blob:fake-0')
      expect(revokeSpy).not.toHaveBeenCalled() // 无竞态时唯一 URL 存活，不 revoke
    } finally {
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    }
  })

  it('图片卡 rebuild 竞态：旧卡回调迟到 → revoke 自己不碰新卡，任何时刻同 key 至多一个存活 URL', async () => {
    let seq = 0
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fake-${seq++}`)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      const parent = fakeElement()
      const imgMeta = { id: UID1, kind: 'image' as const }
      const shapeWithImg = { current: 'nebula' as const, customCurrent: null, customShapes: [imgMeta], coverPriority: true, showBody: true }
      // 第一次 read 挂起（旧卡回调迟到），第二次立即 resolve（新卡先落位）
      let releaseFirst!: (b: Uint8Array) => void
      let call = 0
      let cb: ((s: unknown) => void) | null = null
      new ShapePicker(parent as unknown as HTMLElement, makeCustomDeps({
        getShape: async () => shapeWithImg,
        onShapeChanged: (f) => { cb = f as never },
        readCustomShapeImage: () => (++call === 1
          ? new Promise<Uint8Array>((res) => { releaseFirst = res })
          : Promise.resolve(new Uint8Array([9]))),
      }))
      await flush() // 旧卡建成，read#1 挂起
      cb!(shapeWithImg) // 回流触发 rebuild：旧卡被摘，新卡建成 + read#2 立即 resolve
      await flush()
      const img = findByAttr(parent, 'data-shape-id', UID1)!.children[0].children[0] as FakeEl & { src?: string }
      expect(img.src).toBe('blob:fake-0') // 新卡的 URL（read#2 先到）
      releaseFirst(new Uint8Array([1])) // 放行旧卡的迟到回调
      await flush()
      expect(revokeSpy).toHaveBeenCalledWith('blob:fake-1') // stale 回调 revoke 自己的 URL
      expect(img.src).toBe('blob:fake-0') // 新卡 src 未被 stale 回调污染
    } finally {
      createSpy.mockRestore()
      revokeSpy.mockRestore()
    }
  })

  it('设置回流（onShapeChanged）新增条目 → 收藏卡行重建出现新卡', async () => {
    const parent = fakeElement()
    let cb: ((s: unknown) => void) | null = null
    const deps = makeCustomDeps({
      getShape: async () => ({ current: 'nebula' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true }),
      onShapeChanged: (f) => { cb = f as never },
    })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    expect(findByAttr(parent, 'data-shape-id', UID1)).toBeNull()
    cb!(baseShape)
    await flush()
    expect(findByAttr(parent, 'data-shape-id', UID1)).not.toBeNull()
    expect(collectText(parent)).toContain('告白')
  })
})

// 生产实现里的私有样式常量在此镜像一份用于断言（ACTIVE_BORDER/IDLE_BORDER 未导出，见 shape-picker.ts）
const BG_ACTIVE_BORDER = '1px solid rgba(160, 200, 255, 0.85)'
const BG_IDLE_BORDER = '1px solid rgba(255, 255, 255, 0.12)'

const BG_ID = '11111111-2222-3333-4444-555555555555'
function makeBg(over: Partial<BackgroundSettings> = {}): BackgroundSettings {
  return {
    aurora: 1, ripple: 1, dust: 0.7, dustSize: 1, dustBright: 1, mirror: true,
    customBackgrounds: [{ id: BG_ID, kind: 'image' }], current: 'aurora', bgOpacity: 0.8, bgSaturation: 1, bgBreathe: true, ...over,
  }
}

describe('背景 tab（自定义背景 v1）', () => {
  it('tab 行存在；默认形状 tab：形状卡行可见、背景卡行隐藏', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({ getBackground: async () => makeBg() }))
    await flush()
    expect(findByAttr(parent, 'data-role', 'picker-tab-shape')).not.toBeNull()
    const bgCardRow = findByAttr(parent, 'data-bg-id', 'aurora')!._parent!
    expect(bgCardRow.style.display).toBe('none')
    const shapeCardRow = findByAttr(parent, 'data-shape-id', 'nebula')!._parent!
    expect(shapeCardRow.style.display).toBe('flex')
  })

  it('点背景 tab：形状行与封面胶囊行隐藏、背景行显示；再 open 时回到形状 tab', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps({ getBackground: async () => makeBg() }))
    await flush()
    const bgTab = findByAttr(parent, 'data-role', 'picker-tab-background')!
    bgTab.dispatch('click')
    const pillRow = findByText(parent, '有封面时优先显示封面粒子')!._parent!
    const shapeCardRow = findByAttr(parent, 'data-shape-id', 'nebula')!._parent!
    const bgCardRow = findByAttr(parent, 'data-bg-id', 'aurora')!._parent!
    // 封面胶囊用 visibility 藏（保留占位防头排行高塌缩、tab 位移——亲验③回归锚），卡片行仍用 display
    expect(pillRow.style.visibility).toBe('hidden')
    expect(shapeCardRow.style.display).toBe('none')
    expect(bgCardRow.style.display).toBe('flex')
    p.close()
    p.open()
    expect(pillRow.style.visibility).toBe('visible')
    expect(shapeCardRow.style.display).toBe('flex')
    expect(bgCardRow.style.display).toBe('none')
  })

  it('背景卡列 = 星空极光卡 + 收藏卡 + "+"卡；current=aurora 时极光卡高亮', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({ getBackground: async () => makeBg() }))
    await flush()
    const auroraCard = findByAttr(parent, 'data-bg-id', 'aurora')!
    const favCard = findByAttr(parent, 'data-bg-id', BG_ID)!
    const plusCard = findByAttr(parent, 'data-bg-id', '__bg_plus')!
    expect(auroraCard).not.toBeNull()
    expect(favCard).not.toBeNull()
    expect(plusCard).not.toBeNull()
    expect(auroraCard.style.border).toBe(BG_ACTIVE_BORDER)
    expect(favCard.style.border).toBe(BG_IDLE_BORDER)
  })

  it('点收藏背景卡 → setBackground(current=id)（乐观高亮）', async () => {
    const parent = fakeElement()
    const bg = makeBg()
    const deps = makeDeps({ getBackground: async () => bg })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const favCard = findByAttr(parent, 'data-bg-id', BG_ID)!
    favCard.dispatch('click')
    expect(deps.setBackground).toHaveBeenCalledWith({ ...bg, current: BG_ID })
    expect(favCard.style.border).toBe(BG_ACTIVE_BORDER)
  })

  it('删除当前使用的背景卡 → current 回落 aurora + 调 deleteCustomBackgroundFile', async () => {
    const parent = fakeElement()
    const deps = makeDeps({
      getBackground: async () => makeBg({ current: BG_ID }),
      setBackground: vi.fn(),
      deleteCustomBackgroundFile: vi.fn(),
    })
    new ShapePicker(parent as unknown as HTMLElement, deps)
    await flush()
    const favCard = findByAttr(parent, 'data-bg-id', BG_ID)!
    const deleteBtn = findByText(favCard, '×')!
    deleteBtn.dispatch('click', { stopPropagation: () => {} })
    expect(deps.setBackground).toHaveBeenCalledWith(
      expect.objectContaining({ customBackgrounds: [], current: 'aurora' })
    )
    expect(deps.deleteCustomBackgroundFile).toHaveBeenCalledWith(BG_ID)
    expect(findByAttr(parent, 'data-bg-id', BG_ID)).toBeNull() // 卡片确实从 DOM 消失（不止 setBackground 参数对）
  })

  it('背景"+"卡：未满调 onBackgroundCreateRequest；满员（6 张）调 showHint("背景已满，先删一个")', async () => {
    const parent1 = fakeElement()
    const deps1 = makeDeps({
      getBackground: async () => makeBg(),
      onBackgroundCreateRequest: vi.fn(),
      showHint: vi.fn(),
    })
    new ShapePicker(parent1 as unknown as HTMLElement, deps1)
    await flush()
    findByAttr(parent1, 'data-bg-id', '__bg_plus')!.dispatch('click')
    expect(deps1.onBackgroundCreateRequest).toHaveBeenCalled()
    expect(deps1.showHint).not.toHaveBeenCalled()

    const parent2 = fakeElement()
    const full = Array.from({ length: 6 }, (_, i) => ({ id: `2222222${i}-0000-4000-8000-00000000000${i}`, kind: 'image' as const }))
    const deps2 = makeDeps({
      getBackground: async () => makeBg({ customBackgrounds: full }),
      onBackgroundCreateRequest: vi.fn(),
      showHint: vi.fn(),
    })
    new ShapePicker(parent2 as unknown as HTMLElement, deps2)
    await flush()
    findByAttr(parent2, 'data-bg-id', '__bg_plus')!.dispatch('click')
    expect(deps2.showHint).toHaveBeenCalledWith('背景已满，先删一个')
    expect(deps2.onBackgroundCreateRequest).not.toHaveBeenCalled()
  })

  it('背景设置回流（onBackgroundChanged）→ 收藏卡列重建', async () => {
    const parent = fakeElement()
    let bgCb: ((b: BackgroundSettings) => void) | null = null
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      getBackground: async () => makeBg(),
      onBackgroundChanged: (cb) => { bgCb = cb },
    }))
    await flush()
    expect(findByAttr(parent, 'data-bg-id', BG_ID)).not.toBeNull()
    bgCb!(makeBg({ customBackgrounds: [] }))
    await flush()
    expect(findByAttr(parent, 'data-bg-id', BG_ID)).toBeNull()
  })
})

describe('视频背景卡（v2）', () => {
  it('kind=video 的收藏卡：名称显示「视频」，缩略图走 readCustomBackgroundThumb', async () => {
    const parent = fakeElement()
    const readCustomBackgroundImage = vi.fn(async () => new Uint8Array())
    const readCustomBackgroundThumb = vi.fn(async () => new Uint8Array())
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      getBackground: async () => makeBg({ customBackgrounds: [{ id: BG_ID, kind: 'video' }] }),
      readCustomBackgroundImage,
      readCustomBackgroundThumb,
    }))
    await flush()
    const card = findByAttr(parent, 'data-bg-id', BG_ID)!
    expect(collectText(card)).toContain('视频')
    expect(readCustomBackgroundThumb).toHaveBeenCalledWith(BG_ID)
    expect(readCustomBackgroundImage).not.toHaveBeenCalled()
  })
})

describe('卡片编辑钮（v2 亲验反馈②：所有内容卡 hover 渐显，点击=选中+跳调音台对应页）', () => {
  const SHAPE_ID = '11111111-2222-3333-4444-555555555555'
  const BG_ID = '11111111-2222-3333-4444-666666666666'
  const seededDeps = (overrides: Partial<ShapePickerDeps> = {}): ShapePickerDeps => makeDeps({
    getShape: async () => ({
      current: 'nebula', customCurrent: null, coverPriority: true, showBody: true,
      customShapes: [{ id: SHAPE_ID, kind: 'text', text: '编' }],
    }),
    getBackground: async () => ({
      aurora: 1, ripple: 1, dust: 0.7, dustSize: 1, dustBright: 1, mirror: true,
      customBackgrounds: [{ id: BG_ID, kind: 'image' }], current: 'aurora',
      bgOpacity: 0.8, bgSaturation: 1, bgBreathe: true,
    }),
    ...overrides,
  })
  const editBtnOf = (card: FakeEl): FakeEl | null => findByAttr(card, 'data-role', 'card-edit')

  it('内置/自定义/极光/背景收藏四类卡都有编辑钮；两张"+"卡没有', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, seededDeps())
    await flush()
    for (const [attr, id] of [
      ['data-shape-id', 'nebula'], ['data-shape-id', SHAPE_ID],
      ['data-bg-id', 'aurora'], ['data-bg-id', BG_ID],
    ] as const) expect(editBtnOf(findByAttr(parent, attr, id)!)).toBeTruthy()
    expect(editBtnOf(findByAttr(parent, 'data-shape-id', '__plus')!)).toBeNull()
    expect(editBtnOf(findByAttr(parent, 'data-bg-id', '__bg_plus')!)).toBeNull()
  })

  it('渐显与×同款：初始 opacity 0，mouseenter→1，mouseleave→0', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, seededDeps())
    await flush()
    const card = findByAttr(parent, 'data-shape-id', 'nebula')!
    const btn = editBtnOf(card)!
    expect(btn.style.opacity).toBe('0')
    card.dispatch('mouseenter')
    expect(btn.style.opacity).toBe('1')
    card.dispatch('mouseleave')
    expect(btn.style.opacity).toBe('0')
  })

  it('点内置形状卡编辑钮：先选中（current=该卡且退出自定义态）再回调 onEditRequest(shape)', async () => {
    const parent = fakeElement()
    const setShape = vi.fn()
    const onEditRequest = vi.fn()
    new ShapePicker(parent as unknown as HTMLElement, seededDeps({ setShape, onEditRequest }))
    await flush()
    const btn = editBtnOf(findByAttr(parent, 'data-shape-id', 'heart') ?? findByAttr(parent, 'data-shape-id', 'nebula')!)!
    btn.dispatch('click', { stopPropagation: () => {} })
    expect(setShape).toHaveBeenCalledTimes(1)
    expect(setShape.mock.calls[0][0].customCurrent).toBeNull()
    expect(onEditRequest).toHaveBeenCalledWith('shape')
  })

  it('点背景收藏卡编辑钮：先选中（current=该卡）再回调 onEditRequest(background)', async () => {
    const parent = fakeElement()
    const setBackground = vi.fn()
    const onEditRequest = vi.fn()
    new ShapePicker(parent as unknown as HTMLElement, seededDeps({ setBackground, onEditRequest }))
    await flush()
    const btn = editBtnOf(findByAttr(parent, 'data-bg-id', BG_ID)!)!
    btn.dispatch('click', { stopPropagation: () => {} })
    expect(setBackground).toHaveBeenCalledTimes(1)
    expect(setBackground.mock.calls[0][0].current).toBe(BG_ID)
    expect(onEditRequest).toHaveBeenCalledWith('background')
  })
})

describe('卡片显示名与底部暗幕（亲验反馈）', () => {
  const BG_ID = '11111111-2222-3333-4444-666666666666'
  it('背景收藏卡显示 meta.name（无 name 的回落已由既有「视频」用例覆盖）', async () => {
    const parent = fakeElement()
    new ShapePicker(parent as unknown as HTMLElement, makeDeps({
      getBackground: async () => ({
        aurora: 1, ripple: 1, dust: 0.7, dustSize: 1, dustBright: 1, mirror: true,
        customBackgrounds: [{ id: BG_ID, kind: 'video', name: '月夜漫游' }], current: 'aurora',
        bgOpacity: 0.8, bgSaturation: 1, bgBreathe: true,
      }),
    }))
    await flush()
    expect(collectText(findByAttr(parent, 'data-bg-id', BG_ID)!)).toContain('月夜漫游')
  })
  it('底部暗幕：初始隐藏，open 淡入(opacity 1/visible)，close 归 0', async () => {
    const parent = fakeElement()
    const p = new ShapePicker(parent as unknown as HTMLElement, makeDeps())
    await flush()
    const scrim = findByAttr(parent, 'data-role', 'picker-scrim')!
    expect(scrim.style.visibility).toBe('hidden')
    expect(scrim.style.pointerEvents).toBe('none')
    p.open()
    expect(scrim.style.opacity).toBe('1')
    expect(scrim.style.visibility).toBe('visible')
    p.close()
    expect(scrim.style.opacity).toBe('0')
  })
})
