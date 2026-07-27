import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BenchPanel } from '../../src/ui/debug/bench-panel'

// FakeEl + document 桩（node 环境无 jsdom，复用 player-bar/perf-hud 惯例）
type Handler = (e: unknown) => void
interface FakeEl {
  style: Record<string, string>
  textContent: string
  tagName: string
  attributes: Record<string, string>
  children: FakeEl[]
  _parent: FakeEl | null
  setAttribute: (k: string, v: string) => void
  appendChild: (c: unknown) => void
  remove: () => void
  addEventListener: (type: string, cb: Handler) => void
  removeEventListener: (type: string, cb: Handler) => void
  dispatch: (type: string, e?: unknown) => void
}

function fakeElement(tag = 'div'): FakeEl {
  const listeners: Record<string, Handler[]> = {}
  const styleObj: Record<string, string> = {}
  const el: FakeEl = {
    style: styleObj,
    textContent: '', tagName: tag.toUpperCase(), attributes: {}, children: [], _parent: null,
    setAttribute: (k, v) => { el.attributes[k] = v },
    appendChild: (c) => { const child = c as FakeEl; child._parent = el; el.children.push(child) },
    remove: () => {
      const p = el._parent
      if (p) { p.children = p.children.filter((c) => c !== el); el._parent = null }
    },
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb) },
    dispatch: (type, e) => { for (const cb of listeners[type] ?? []) cb(e) },
  }
  return el
}

function findByRole(root: FakeEl, role: string): FakeEl | null {
  if (root.attributes['data-role'] === role) return root
  for (const c of root.children) {
    const hit = findByRole(c, role)
    if (hit) return hit
  }
  return null
}

let parent: FakeEl

beforeEach(() => {
  parent = fakeElement()
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => fakeElement(tag),
  }
})

function deps() {
  return { onRunSuite: vi.fn(), onRunSoak: vi.fn(), onRunPower: vi.fn() }
}

describe('BenchPanel', () => {
  it('根节点必须显式 pointerEvents=auto——overlay 整体穿透，不设就点不了按钮', () => {
    new BenchPanel(parent as unknown as HTMLElement, deps())
    expect(findByRole(parent, 'bench-panel')!.style.pointerEvents).toBe('auto')
  })

  it('三个按钮点击各自触发对应回调', () => {
    const d = deps()
    new BenchPanel(parent as unknown as HTMLElement, d)
    findByRole(parent, 'bench-run-suite')!.dispatch('click')
    expect(d.onRunSuite).toHaveBeenCalledOnce()
    findByRole(parent, 'bench-run-power')!.dispatch('click')
    expect(d.onRunPower).toHaveBeenCalledOnce()
    findByRole(parent, 'bench-run-soak')!.dispatch('click')
    expect(d.onRunSoak).toHaveBeenCalledOnce()
  })

  it('setStatus 更新状态行', () => {
    const panel = new BenchPanel(parent as unknown as HTMLElement, deps())
    panel.setStatus('测量中…')
    expect(findByRole(parent, 'bench-status')!.textContent).toBe('测量中…')
  })

  it('dispose 后根节点从父节点摘除', () => {
    const panel = new BenchPanel(parent as unknown as HTMLElement, deps())
    panel.dispose()
    expect(findByRole(parent, 'bench-panel')).toBeNull()
  })
})
