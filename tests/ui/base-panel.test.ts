import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BasePanel } from '../../src/ui/base-panel'

type Handler = (e: unknown) => void
interface FakeEl {
  id: string
  style: Record<string, string>
  textContent: string
  children: FakeEl[]
  appendChild: (c: unknown) => void
  remove: () => void
  addEventListener: (type: string, cb: Handler) => void
  removeEventListener: (type: string, cb: Handler) => void
  dispatch: (type: string, e?: unknown) => void
  contains: (node: unknown) => boolean
}

/** node 环境无 DOM：stub 最小 document/element 表面（同 tuning-panel.test.ts 模式），
 * 含 children/contains——点外部关闭要靠 container.contains(e.target) 判定 */
function fakeElement(): FakeEl {
  const listeners: Record<string, Handler[]> = {}
  const children: FakeEl[] = []
  const el: FakeEl = {
    id: '',
    style: {},
    textContent: '',
    children,
    appendChild: (c) => { children.push(c as FakeEl) },
    remove: () => {},
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb)
    },
    dispatch: (type, e) => { for (const cb of listeners[type] ?? []) cb(e) },
    contains: (node) => node === el || children.some((c) => c.contains(node))
  }
  return el
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 暴露 appendRow 供测试往内容区加行——真实消费者（SettingsPanel 等）都是子类，这里模拟同样的用法 */
class TestPanel extends BasePanel {
  addTestRow(el: HTMLElement): void {
    this.appendRow(el)
  }
  addFixed(el: HTMLElement): void {
    this.appendFixed(el)
  }
}

let created: FakeEl[]
let docListeners: Record<string, Handler[]>

beforeEach(() => {
  created = []
  docListeners = {}
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const el = fakeElement()
      created.push(el)
      return el
    },
    addEventListener: (type: string, cb: Handler) => { (docListeners[type] ??= []).push(cb) },
    removeEventListener: (type: string, cb: Handler) => {
      docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== cb)
    }
  }
})

describe('BasePanel（面板基座，Phase A2 T2）', () => {
  it('固定标题栏：顶部 sticky，标题文字位于内容区之上', () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '调音台', retreatProfile: 'camera'
    })
    const container = created[0] // 根容器：[标题栏, 固定区, 内容区]
    const header = container.children[0]
    const content = container.children[2]
    expect(header.textContent).toBe('调音台')
    // 样式走 cssText 整块赋值（仓库惯例，见 settings-panel/tuning-panel）——断言关键片段而非单个属性
    expect(header.style.cssText).toContain('position: sticky')
    expect(header.style.cssText).toContain('top: 0')
    expect(content.style.cssText).toContain('overflow-y: auto')
    panel.dispose()
  })

  it('内容行挂在内容区、排在标题栏之后（从上往下）', () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const container = created[0]
    const content = container.children[2]
    const row = fakeElement() as unknown as HTMLElement
    panel.addTestRow(row)
    expect(content.children).toContain(row)
    panel.dispose()
  })

  it('固定区：appendFixed 的元素排在标题栏与内容区之间，不随内容滚动（不在 overflow 区内）', () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '调音台', retreatProfile: 'camera'
    })
    const container = created[0]
    const fixed = container.children[1]
    const content = container.children[2]
    const tab = fakeElement() as unknown as HTMLElement
    panel.addFixed(tab)
    expect(fixed.children).toContain(tab)       // 固定区收下它
    expect(content.children).not.toContain(tab) // 不在滚动内容区
    expect(fixed.style.cssText).toContain('flex: none') // 与标题栏同为不滚动的固定段
    panel.dispose()
  })

  it('open()/close()/toggle()：isOpen 正确切换 + onOpenChange 广播', () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const onOpenChange = vi.fn()
    panel.onOpenChange = onOpenChange
    panel.toggle()
    expect(panel.isOpen).toBe(true)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    panel.toggle()
    expect(panel.isOpen).toBe(false)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    panel.dispose()
  })

  it('Esc keydown 在 open 态关面板并 stopPropagation', () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    panel.open()
    const stopPropagation = vi.fn()
    for (const cb of docListeners['keydown'] ?? []) cb({ key: 'Escape', stopPropagation })
    expect(stopPropagation).toHaveBeenCalled()
    expect(panel.isOpen).toBe(false)
    panel.dispose()
  })

  it('点面板外部区域关闭面板', async () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    panel.open()
    await flushMacrotask() // pointerdown 监听延迟到下一宏任务才注册

    const outside = fakeElement()
    for (const cb of docListeners['pointerdown'] ?? []) cb({ target: outside })
    expect(panel.isOpen).toBe(false)
    panel.dispose()
  })

  it('点面板内部区域不关闭面板', async () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    panel.open()
    await flushMacrotask()

    const container = created[0]
    for (const cb of docListeners['pointerdown'] ?? []) cb({ target: container })
    expect(panel.isOpen).toBe(true)
    panel.dispose()
  })

  it('操作坞图标落入忽略区：pointerdown 不关闭面板，图标自身 toggle() 干净关闭（Task A-toggle-fix，取代已删除的 suppressNextToggle 时序标志）', async () => {
    // 旧模型靠 suppressNextToggle + setTimeout(0) 抑制竞态：真实浏览器里 pointerdown 与 click
    // 常跨宏任务，setTimeout(0) 的清除会抢跑，等 click→toggle() 时标志已被清、面板已被 pointerdown
    // 关闭，toggle() 见 open_===false 又重新 open()——面板关不掉。新模型排除触发源：dock 容器落入
    // ignoreOutsideClickWithin，onPointerDown 直接跳过，不会先 close()，toggle() 独立干净处理开关。
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const dockContainer = fakeElement()
    panel.ignoreOutsideClickWithin = [dockContainer as unknown as HTMLElement]
    panel.open()
    await flushMacrotask()

    // pointerdown 落在忽略区（dock 容器）内——onPointerDown 应跳过，面板保持打开
    for (const cb of docListeners['pointerdown'] ?? []) cb({ target: dockContainer })
    expect(panel.isOpen).toBe(true)

    // 图标自身的 click→toggle()：干净关闭，不依赖任何抑制标志
    panel.toggle()
    expect(panel.isOpen).toBe(false)
    panel.dispose()
  })

  it('忽略区排除不依赖 setTimeout 时序：pointerdown 后刷一个宏任务再 toggle，仍应干净关闭', async () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const dockContainer = fakeElement()
    panel.ignoreOutsideClickWithin = [dockContainer as unknown as HTMLElement]
    panel.open()
    await flushMacrotask()

    for (const cb of docListeners['pointerdown'] ?? []) cb({ target: dockContainer })
    await flushMacrotask() // 模拟 pointerdown 与 click 跨宏任务的真实时序
    panel.toggle()
    expect(panel.isOpen).toBe(false)
    panel.dispose()
  })

  it('场景暗幕（亲验反馈轮②）：垫在面板之下、不截获指针，随开合淡入淡出，dispose 一并移除', () => {
    const parent = fakeElement()
    const panel = new TestPanel(parent as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const scrim = created[1] // 构造序：容器(0) → 暗幕(1) → 标题栏 → 内容区
    expect(scrim.style.cssText).toContain('pointer-events: none')
    expect(scrim.style.cssText).toContain('linear-gradient(to right') // 从左往右渐入黑（用户拍板：舞台侧幕布，非卡片容器）
    expect(parent.children[0]).toBe(scrim) // 先挂先画：幕布在面板之下
    panel.open()
    expect(scrim.style.opacity).toBe('1')
    expect(scrim.style.visibility).toBe('visible')
    panel.close()
    expect(scrim.style.opacity).toBe('0') // 突变验证：close 不收幕布应红
    const removeSpy = vi.spyOn(scrim, 'remove')
    panel.dispose()
    expect(removeSpy).toHaveBeenCalled()
  })

  it('dispose 清理：移除容器 + 注销 document 监听（keydown/pointerdown）', async () => {
    const panel = new TestPanel(fakeElement() as unknown as HTMLElement, {
      id: 'test-panel', title: '设置', retreatProfile: 'full'
    })
    const container = created[0]
    const removeSpy = vi.spyOn(container, 'remove')
    panel.open()
    await flushMacrotask() // 让 pointerdown 监听也挂上，验证 dispose 一并注销
    panel.dispose()
    expect(removeSpy).toHaveBeenCalled()
    expect(docListeners['keydown'] ?? []).toEqual([])
    expect(docListeners['pointerdown'] ?? []).toEqual([])
  })
})
