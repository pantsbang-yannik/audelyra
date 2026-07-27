import { describe, it, expect, beforeEach } from 'vitest'
import { PerfHud } from '../../src/ui/debug/perf-hud'
import type { FrameStatsSummary } from '../../src/perf/stats'

// FakeEl 与 fakeElement 从 player-bar.test.ts 复制（node 环境无 jsdom，项目既有惯例）
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
        },
      })
    },
    textContent: '', tagName: tag.toUpperCase(), attributes: {}, children: [], _parent: null,
    setAttribute: (k, v) => { el.attributes[k] = v },
    appendChild: (c) => { const child = c as FakeEl; child._parent = el; el.children.push(child) },
    remove: () => {
      const p = el._parent
      if (p) { p.children = p.children.filter((c) => c !== el); el._parent = null }
    },
    addEventListener: (type, cb) => { (listeners[type] ??= []).push(cb) },
    removeEventListener: (type, cb) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb) },
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

const SUMMARY: FrameStatsSummary = {
  frames: 600,
  cpuFrameMs: { p50: 4, p95: 7, p99: 9, max: 20 },
  intervalMs: { p50: 16.7, p95: 17.2, p99: 25, max: 48 },
  jankEventRate: 0.0125,
  missedVsyncRate: 0.004,
  hitchCount: 2,
  phasesMs: { signal: 0.4, mapping: 0.9, state: 0.5, visual: 1.2, camera: 0.3, submit: 1.8 },
}

let parent: FakeEl

beforeEach(() => {
  parent = fakeElement()
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => fakeElement(tag),
  }
})

describe('PerfHud', () => {
  it('挂载后父节点下出现 perf-hud 根节点', () => {
    new PerfHud(parent as unknown as HTMLElement)
    expect(findByRole(parent, 'perf-hud')).not.toBeNull()
  })

  it('update 后各字段显示实际数字', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    hud.update(SUMMARY, { targetIntervalMs: 16.67, tier: 'ultra', particles: 450_000, gpuAvgMs: 6.2 })
    expect(findByRole(parent, 'perf-interval')!.textContent).toContain('16.7')
    expect(findByRole(parent, 'perf-cpu')!.textContent).toContain('4')
    expect(findByRole(parent, 'perf-gpu')!.textContent).toContain('6.2')
    expect(findByRole(parent, 'perf-tier')!.textContent).toContain('ultra')
  })

  it('FPS 由帧间隔 p50 换算，不另存计数器', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    hud.update(SUMMARY, { targetIntervalMs: 16.67, tier: 'ultra', particles: 450_000, gpuAvgMs: null })
    expect(findByRole(parent, 'perf-fps')!.textContent).toContain('59') // 1000/16.7 ≈ 59.9
  })

  it('gpuAvgMs 为 null 时显示「—」而不是 NaN', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    hud.update(SUMMARY, { targetIntervalMs: 16.67, tier: 'ultra', particles: 450_000, gpuAvgMs: null })
    const t = findByRole(parent, 'perf-gpu')!.textContent
    expect(t).toContain('—')
    expect(t).not.toContain('NaN')
  })

  it('掉帧区同时显示三个指标', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    hud.update(SUMMARY, { targetIntervalMs: 16.67, tier: 'ultra', particles: 450_000, gpuAvgMs: null })
    const t = findByRole(parent, 'perf-drops')!.textContent
    expect(t).toContain('1.25')  // jankEventRate 百分比
    expect(t).toContain('2')     // hitchCount
  })

  it('零帧摘要不崩、不出 NaN', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    const empty: FrameStatsSummary = {
      frames: 0,
      cpuFrameMs: { p50: 0, p95: 0, p99: 0, max: 0 },
      intervalMs: { p50: 0, p95: 0, p99: 0, max: 0 },
      jankEventRate: 0, missedVsyncRate: 0, hitchCount: 0,
      phasesMs: { signal: 0, mapping: 0, state: 0, visual: 0, camera: 0, submit: 0 },
    }
    expect(() => hud.update(empty, { targetIntervalMs: 16.67, tier: 'ultra', particles: 0, gpuAvgMs: null })).not.toThrow()
    expect(findByRole(parent, 'perf-fps')!.textContent).not.toContain('NaN')
  })

  it('dispose 后根节点从父节点摘除', () => {
    const hud = new PerfHud(parent as unknown as HTMLElement)
    hud.dispose()
    expect(findByRole(parent, 'perf-hud')).toBeNull()
  })
})
