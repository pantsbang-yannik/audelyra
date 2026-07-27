import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AuditionBar } from '../../src/ui/audition-bar'
import { AUDITION_PADS, type PadId } from '../../src/audition/audition-pad'

type Handler = (e: unknown) => void
interface FakeEl {
  style: Record<string, string>
  textContent: string
  tagName: string
  isContentEditable: boolean
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
  hasListener: (type: string) => boolean
}

function fakeElement(tag = 'div'): FakeEl {
  const listeners: Record<string, Handler[]> = {}
  const styleObj: Record<string, string> = {}
  const el: FakeEl = {
    get style() {
      return new Proxy(styleObj, {
        set: (target, key, value: string) => {
          if (typeof key === 'symbol') return true
          if (key === 'cssText') {
            styleObj.cssText = value
            for (const part of value.split(';').filter((p) => p.trim())) {
              const [k, v] = part.split(':').map((s) => s.trim())
              if (k && v) styleObj[k] = v
            }
          } else {
            target[key] = value
          }
          return true
        }
      })
    },
    textContent: '', tagName: tag.toUpperCase(), isContentEditable: false,
    attributes: {}, children: [], _parent: null,
    setAttribute: (k, v) => { el.attributes[k] = v },
    appendChild: (c) => { const child = c as FakeEl; child._parent = el; el.children.push(child) },
    append: (...cs) => { for (const c of cs) el.appendChild(c) },
    remove: () => {
      const p = el._parent
      if (p) { p.children = p.children.filter((c) => c !== el); el._parent = null }
    },
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb) },
    dispatch: (type, e) => { for (const cb of listeners[type] ?? []) cb(e) },
    hasListener: (type) => (listeners[type] ?? []).length > 0
  }
  return el
}

let windowStub: FakeEl

beforeEach(() => {
  vi.useFakeTimers()
  windowStub = fakeElement('window')
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => fakeElement(tag)
  }
  ;(globalThis as unknown as { window: unknown }).window = windowStub
})

afterEach(() => {
  vi.useRealTimers()
})

function findRole(el: FakeEl, role: string): FakeEl | null {
  if (el.attributes['data-role'] === role) return el
  for (const c of el.children) {
    const hit = findRole(c, role)
    if (hit) return hit
  }
  return null
}

function make(): {
  bar: AuditionBar
  root: FakeEl
  parent: FakeEl
  deps: { onTrigger: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> }
} {
  const deps = { onTrigger: vi.fn((_id: PadId) => {}), onExit: vi.fn(() => {}) }
  const parent = fakeElement()
  const bar = new AuditionBar(parent as unknown as HTMLElement, deps)
  return { bar, root: bar.el as unknown as FakeEl, parent, deps }
}

const padEl = (root: FakeEl, id: PadId): FakeEl => findRole(root, `audition-pad-${id}`)!
const key = (k: string, extra: Record<string, unknown> = {}): unknown =>
  ({ key: k, preventDefault: () => {}, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra })

describe('AuditionBar 渲染', () => {
  it('挂到传入的 parent 上（#audelyra-overlay，不属于任何面板）', () => {
    const { parent, root } = make()
    expect(parent.children).toContain(root)
  })

  it('每个声明的 pad 都渲染出按钮，带 label 与键位', () => {
    const { root } = make()
    for (const p of AUDITION_PADS) {
      const el = padEl(root, p.id)
      expect(el).toBeTruthy()
      const texts = el.children.map((c) => c.textContent)
      expect(texts).toContain(p.label)
      expect(texts).toContain(p.key)
    }
  })

  it('有「试音」标签与退出入口，退出也带键位提示（条内只有一种语法：名称 + 键位）', () => {
    const { root } = make()
    expect(findRole(root, 'audition-label')!.textContent).toBe('试音')
    const exit = findRole(root, 'audition-exit')!
    const texts = exit.children.map((c) => c.textContent)
    expect(texts).toContain('退出')
    expect(texts).toContain('Esc')
  })

  it('底部居中且抬到操作坞之上（坞在 bottom 24px + 图标 18px，不许叠）', () => {
    const { root } = make()
    expect(root.style.position).toBe('fixed')
    expect(Number.parseInt(root.style.bottom, 10)).toBeGreaterThan(24 + 18)
    expect(root.style.left).toBe('50%')
  })

  it('构造后默认隐去：进入模式才显形', () => {
    const { root, bar } = make()
    expect(bar.isShown).toBe(false)
    expect(root.style.opacity).toBe('0')
    expect(root.style.pointerEvents).toBe('none')
  })
})

describe('AuditionBar 进出模式', () => {
  it('show：显形并挂键盘加速键', () => {
    const { root, bar } = make()
    bar.show()
    expect(bar.isShown).toBe(true)
    expect(root.style.opacity).toBe('1')
    expect(root.style.pointerEvents).toBe('auto')
    expect(windowStub.hasListener('keydown')).toBe(true)
  })

  it('hide：隐去并卸键盘加速键——不卸的话别的界面上 A/S/D 还在打鼓', () => {
    const { root, bar, deps } = make()
    bar.show()
    bar.hide()
    expect(bar.isShown).toBe(false)
    expect(root.style.opacity).toBe('0')
    expect(windowStub.hasListener('keydown')).toBe(false)
    windowStub.dispatch('keydown', key('a'))
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })

  it('show/hide 幂等：重复调用不重复挂监听', () => {
    const { bar, deps } = make()
    bar.show()
    bar.show()
    bar.hide()
    expect(windowStub.hasListener('keydown')).toBe(false) // 若挂了两次，卸一次会残留
    bar.hide()
    expect(deps.onExit).not.toHaveBeenCalled()
  })

  it('点「退出」触发 onExit', () => {
    const { root, bar, deps } = make()
    bar.show()
    findRole(root, 'audition-exit')!.dispatch('click')
    expect(deps.onExit).toHaveBeenCalledTimes(1)
  })

  it('按 Esc 触发 onExit（同星系图鉴的退出惯例）', () => {
    const { bar, deps } = make()
    bar.show()
    windowStub.dispatch('keydown', key('Escape'))
    expect(deps.onExit).toHaveBeenCalledTimes(1)
  })

  it('退出时清掉残留高亮，下次进来是干净的', () => {
    const { root, bar } = make()
    bar.show()
    const b = padEl(root, 'beat')
    b.dispatch('click')
    const flashed = b.style.color
    bar.hide()
    expect(b.style.color).not.toBe(flashed)
  })
})

describe('AuditionBar 触发', () => {
  it('点 pad 触发 onTrigger', () => {
    const { root, bar, deps } = make()
    bar.show()
    padEl(root, 'beat').dispatch('click')
    expect(deps.onTrigger).toHaveBeenCalledWith('beat')
  })

  it('未进入模式时点 pad 不触发（pointerEvents 是外观防线，fire 的检查是真防线）', () => {
    const { root, deps } = make()
    padEl(root, 'beat').dispatch('click')
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })

  it('按下高亮并在 FLASH_MS 后回落', () => {
    const { root, bar } = make()
    bar.show()
    const b = padEl(root, 'drop')
    const idle = b.style.color
    b.dispatch('click')
    const flashed = b.style.color
    expect(flashed).not.toBe(idle)
    vi.advanceTimersByTime(500)
    expect(b.style.color).not.toBe(flashed)
  })

  it('连击重置回落计时，不被前一次的定时器提前掐掉高亮', () => {
    const { root, bar } = make()
    bar.show()
    const b = padEl(root, 'low')
    b.dispatch('click')
    const flashed = b.style.color
    vi.advanceTimersByTime(100)
    b.dispatch('click')
    vi.advanceTimersByTime(80) // 若沿用旧计时器，此刻已被掐掉
    expect(b.style.color).toBe(flashed)
  })
})

describe('AuditionBar 键盘加速键', () => {
  it('每个声明的键位都能触发对应 pad（大小写都认）', () => {
    const { bar, deps } = make()
    bar.show()
    for (const p of AUDITION_PADS) {
      deps.onTrigger.mockClear()
      windowStub.dispatch('keydown', key(p.key.toLowerCase()))
      expect(deps.onTrigger).toHaveBeenCalledWith(p.id)
    }
  })

  it('带修饰键不触发：让路给 ⌘⇧S 海报 / ⌘⇧R Drop / ⌘⇧T 调音台', () => {
    const { bar, deps } = make()
    bar.show()
    windowStub.dispatch('keydown', key('a', { metaKey: true }))
    windowStub.dispatch('keydown', key('a', { ctrlKey: true }))
    windowStub.dispatch('keydown', key('a', { altKey: true }))
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })

  it('未绑定的键不触发', () => {
    const { bar, deps } = make()
    bar.show()
    windowStub.dispatch('keydown', key('z'))
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })

  it('焦点在 range 滑块上仍触发——「在调音台拖完滑块立刻按 A 验」是本模式最常见路径', () => {
    const { bar, deps } = make()
    bar.show()
    windowStub.dispatch('keydown', key('a', { target: { tagName: 'INPUT', type: 'range' } }))
    expect(deps.onTrigger).toHaveBeenCalled()
  })

  it('焦点在文本输入里不劫持单键', () => {
    const { bar, deps } = make()
    bar.show()
    windowStub.dispatch('keydown', key('a', { target: { tagName: 'INPUT', type: 'text' } }))
    windowStub.dispatch('keydown', key('a', { target: { tagName: 'TEXTAREA' } }))
    windowStub.dispatch('keydown', key('a', { target: { tagName: 'DIV', isContentEditable: true } }))
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })
})

describe('AuditionBar 销毁', () => {
  it('dispose 卸监听并摘节点', () => {
    const { bar, parent, root, deps } = make()
    bar.show()
    bar.dispose()
    expect(windowStub.hasListener('keydown')).toBe(false)
    expect(parent.children).not.toContain(root)
    windowStub.dispatch('keydown', key('a'))
    expect(deps.onTrigger).not.toHaveBeenCalled()
  })

  it('dispose 后待回落的 flash 定时器不再报错', () => {
    const { root, bar } = make()
    bar.show()
    padEl(root, 'beat').dispatch('click')
    bar.dispose()
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
  })
})

// 把「符合已有 UI 规范」固化成可检查的约束：这类偏差（引入全仓唯一的彩色、唯一的 @keyframes）
// 靠人眼审查极易漏过。下面三条钉死设计语言，回退即红。
describe('AuditionBar 视觉规范', () => {
  /** 收集本组件写出的全部样式文本（cssText + 显式属性） */
  function allStyleText(root: FakeEl): string {
    const out: string[] = []
    const walk = (el: FakeEl): void => {
      out.push(Object.entries(el.style).map(([k, v]) => `${k}:${v}`).join(';'))
      for (const c of el.children) walk(c)
    }
    walk(root)
    return out.join(';')
  }

  it('无装饰性彩色：只用白/黑 + 透明度（淡蓝 rgba(160,200,255) 是全仓「激活态」专用语义色，不可挪用）', () => {
    const { root, bar } = make()
    bar.show()
    padEl(root, 'beat').dispatch('click') // 把 hover/flash 分支的颜色也写出来
    const colors = allStyleText(root).match(/rgba?\([^)]*\)/g) ?? []
    expect(colors.length).toBeGreaterThan(0) // 自检：确实抓到了颜色，否则本用例是空转
    for (const c of colors) {
      const [r, g, b] = c.replace(/rgba?\(|\)/g, '').split(',').map((n) => Number(n.trim()))
      const isGrey = r === g && g === b // 纯白/纯黑/灰阶
      const isDarkBase = r < 40 && g < 40 && b < 40 // 浮层底色 rgba(20,26,36) 同族
      expect(isGrey || isDarkBase, `出现装饰性彩色 ${c}`).toBe(true)
    }
  })

  it('无 @keyframes / animation：全仓显隐统一是 opacity + filter 的 transition', () => {
    const { root, parent } = make()
    expect(allStyleText(root)).not.toContain('animation')
    // 也不许偷偷往 parent 注入 <style> 承载 keyframes
    expect(parent.children.some((c) => c.tagName === 'STYLE')).toBe(false)
  })

  it('容器规格与 PlayerBar 同款（同为底部浮层，不该长得像两个产品）', () => {
    const { root } = make()
    const css = root.style.cssText
    expect(css).toContain('rgba(20, 26, 36, 0.78)') // 同款底色
    expect(css).toContain('rgba(255, 255, 255, 0.08)') // 同款边框
    expect(css).toContain('blur(12px)') // 同款毛玻璃
    expect(css).toContain('300 13px') // 同款字重字号
  })
})
