import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ControlDock, type DockDeps, type DockMode } from '../../src/ui/control-dock'

type Handler = (e: unknown) => void
interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }
interface FakeEl {
  style: Record<string, string>
  textContent: string
  attributes: Record<string, string>
  innerHTML: string
  children: FakeEl[]
  _parent: FakeEl | null
  setAttribute: (k: string, v: string) => void
  appendChild: (c: unknown) => void
  remove: () => void
  addEventListener: (type: string, cb: Handler) => void
  removeEventListener: (type: string, cb: Handler) => void
  hasListener: (type: string) => boolean
  dispatch: (type: string, e?: unknown) => void
  getBoundingClientRect: () => Rect
}

/** node 环境无 DOM：stub 最小 document/element 表面（同 settings-panel.test.ts 模式），
 * 额外记录每次 createElement 产出的元素；tooltip 已换成自定义节点（见 tooltip.ts），
 * 故按钮不再有 title，改由「触发 mouseenter 造出的 tooltip 节点文字」反查按钮身份 */
function fakeElement(): FakeEl {
  const listeners: Record<string, Handler[]> = {}
  const el: FakeEl = {
    style: {},
    textContent: '',
    attributes: {},
    innerHTML: '',
    children: [],
    _parent: null,
    setAttribute: (k, v) => { el.attributes[k] = v },
    appendChild: (c) => { const child = c as FakeEl; child._parent = el; el.children.push(child) },
    remove: () => {
      const p = el._parent
      if (p) { p.children = p.children.filter((c) => c !== el); el._parent = null }
    },
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb)
    },
    hasListener: (type) => (listeners[type] ?? []).length > 0,
    dispatch: (type, e) => { for (const cb of listeners[type] ?? []) cb(e) },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 })
  }
  return el
}

let created: FakeEl[]
let docBody: FakeEl

beforeEach(() => {
  created = []
  docBody = fakeElement()
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const el = fakeElement()
      created.push(el)
      return el
    },
    body: docBody
  }
})

function makeDeps(): DockDeps & {
  toggleTuning: ReturnType<typeof vi.fn>
  toggleShapes: ReturnType<typeof vi.fn>
  snapPoster: ReturnType<typeof vi.fn>
  snapClip: ReturnType<typeof vi.fn>
  openLocalFile: ReturnType<typeof vi.fn>
  toggleAudition: ReturnType<typeof vi.fn>
} {
  return {
    toggleTuning: vi.fn(() => {}),
    toggleShapes: vi.fn(() => {}),
    snapPoster: vi.fn(() => {}),
    snapClip: vi.fn(() => {}),
    openLocalFile: vi.fn(() => {}),
    toggleAudition: vi.fn(() => {})
  }
}

/** 按钮不再有原生 title：触发每个按钮的 mouseenter，读它造出的自定义 tooltip 节点文字反查身份 */
function buttonsByTitle(): Record<string, FakeEl> {
  const map: Record<string, FakeEl> = {}
  const buttons = created.filter((el) => el.hasListener('click'))
  for (const btn of buttons) {
    btn.dispatch('mouseenter')
    const tip = docBody.children.find((c) => 'data-tooltip' in c.attributes)
    if (tip) { map[tip.textContent] = btn; tip.remove() }
  }
  return map
}

describe('ControlDock（悬停显影的界面内图标操作入口，两态下恒为 [形状,调音台,试音|海报,回放|本地]）', () => {
  it('fullscreen 态：poke 后显影，设置/星系图鉴已迁出（含调音台/形状两钮，无全屏钮，已迁至右上角 CornerCluster）', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('fullscreen')
    dock.pokeActivity()
    expect(dock.visible).toBe(true)
    const btns = buttonsByTitle()
    expect(btns['调音台']).toBeTruthy()
    expect(btns['形状 / 背景']).toBeTruthy()
    expect(btns['设置']).toBeFalsy()
    expect(btns['星系图鉴']).toBeFalsy()
    expect(btns['全屏']).toBeFalsy()
    dock.dispose()
  })

  it('windowed 态：设置/星系图鉴已迁出（含调音台/形状两钮，无全屏钮）', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('windowed')
    const btns = buttonsByTitle()
    expect(btns['全屏']).toBeFalsy()
    expect(btns['调音台']).toBeTruthy()
    expect(btns['形状 / 背景']).toBeTruthy()
    expect(btns['设置']).toBeFalsy()
    expect(btns['星系图鉴']).toBeFalsy()
    dock.dispose()
  })

  it('setEnabled(false) 后：poke 不显', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('windowed')
    dock.setEnabled(false)
    dock.pokeActivity()
    expect(dock.visible).toBe(false)
    dock.dispose()
  })

  it('点击图标：转发到对应 dep（形状→toggleShapes，调音台→toggleTuning）', () => {
    const deps = makeDeps()
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, deps)
    dock.setMode('windowed')
    const btns = buttonsByTitle()
    btns['形状 / 背景'].dispatch('click')
    expect(deps.toggleShapes).toHaveBeenCalledTimes(1)
    btns['调音台'].dispatch('click')
    expect(deps.toggleTuning).toHaveBeenCalledTimes(1)
    dock.dispose()
  })

  it('element：返回操作坞容器节点（供 PanelCoordinator.setTriggerContainers 登记忽略区）', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    const container = created[0]
    expect(dock.element).toBe(container)
    dock.dispose()
  })

  it('dispose：容器从父节点解绑（remove 被调用）', () => {
    const parent = fakeElement()
    const dock = new ControlDock(parent as unknown as HTMLElement, makeDeps())
    const container = created[0]
    const removeSpy = vi.spyOn(container, 'remove')
    dock.dispose()
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('形状图标存在且居首，点击调 toggleShapes（Phase B2 T5）', () => {
    const deps = makeDeps()
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, deps)
    dock.setMode('windowed')
    const buttons = created.filter((el) => el.hasListener('click'))
    const titles = buttons.map((btn) => {
      btn.dispatch('mouseenter')
      const tip = docBody.children.find((c) => 'data-tooltip' in c.attributes)
      const text = tip?.textContent ?? ''
      tip?.remove()
      return text
    })
    expect(titles).toEqual(['形状 / 背景', '调音台', '试音', '星图海报', 'Drop 回放', '本地播放']) // 三组：布置｜快门｜内容（性质分区，主界面布局重组）
    buttons[0].dispatch('click')
    expect(deps.toggleShapes).toHaveBeenCalledTimes(1)
    dock.dispose()
  })

  it('本地播放图标:点击转发 openLocalFile(本地音频播放 V1)', () => {
    const deps = makeDeps()
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, deps)
    dock.setMode('windowed')
    const btns = buttonsByTitle()
    btns['本地播放'].dispatch('click')
    expect(deps.openLocalFile).toHaveBeenCalledTimes(1)
    dock.dispose()
  })

  it('三组结构：容器 children = [布置(3), 快门(2), 内容(1)]，组间靠容器 gap 34px', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('windowed')
    const container = created[0]
    expect(container.children.length).toBe(3)
    // 布置组 3 枚：形状 + 调音台 + 试音——试音按「用户目的」跟调音台成一条工作流（调 + 试），
    // 不按技术实现归到「换信号源」那组
    expect(container.children.map((g) => g.children.length)).toEqual([3, 2, 1])
    expect(container.style.cssText).toContain('gap: 34px')
    dock.dispose()
  })

  it('试音图标：点击转发 toggleAudition（显影 V0 试音模式入口）', () => {
    const deps = makeDeps()
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, deps)
    dock.setMode('windowed')
    const btns = buttonsByTitle()
    expect(btns['试音']).toBeTruthy()
    btns['试音'].dispatch('click')
    expect(deps.toggleAudition).toHaveBeenCalledTimes(1)
    dock.dispose()
  })

  it('tooltip 快捷键后缀：形状 ⌘⇧S / 调音台 ⌘⇧T / 星图海报 ⌘⇧P / Drop 回放 ⌘⇧R，本地播放无', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('windowed')
    const buttons = created.filter((el) => el.hasListener('click'))
    const pairs = buttons.map((btn) => {
      btn.dispatch('mouseenter')
      const tip = docBody.children.find((c) => 'data-tooltip' in c.attributes)
      const pair = [tip?.textContent ?? '', tip?.children[0]?.textContent ?? '']
      tip?.remove()
      return pair
    })
    expect(pairs).toEqual([
      ['形状 / 背景', '⌘⇧S'], ['调音台', '⌘⇧T'], ['试音', ''],
      ['星图海报', '⌘⇧P'], ['Drop 回放', '⌘⇧R'],
      ['本地播放', '']
    ])
    dock.dispose()
  })

  it('引导期整坞禁用覆盖形状入口（B1 终审 M2 回归钉）：setEnabled(false) 后坞不可见', () => {
    const dock = new ControlDock(fakeElement() as unknown as HTMLElement, makeDeps())
    dock.setMode('windowed')
    dock.pokeActivity()
    dock.setEnabled(false)
    expect(dock.visible).toBe(false)
    dock.dispose()
  })
})
