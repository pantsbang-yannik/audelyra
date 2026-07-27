// 实时性能 HUD——仅 #perf 入口挂载。挂在 #audelyra-overlay 下（UI 铁律）。
// 测试锚点用 data-role（惯例见 player-bar）。样式显式属性写，不用 cssText——
// 测试的 FakeEl 不解析 cssText，写 cssText 断言就抓不到。
import type { FrameStatsSummary } from '../../perf/stats'

const DASH = '—'

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : DASH
}

export interface PerfHudExtra {
  targetIntervalMs: number
  tier: string
  particles: number
  gpuAvgMs: number | null
}

export class PerfHud {
  private readonly root: HTMLElement
  private readonly fps: HTMLElement
  private readonly interval: HTMLElement
  private readonly cpu: HTMLElement
  private readonly gpu: HTMLElement
  private readonly drops: HTMLElement
  private readonly tier: HTMLElement
  private readonly phases: HTMLElement

  constructor(parent: HTMLElement) {
    const mk = (role: string): HTMLElement => {
      const el = document.createElement('div')
      el.setAttribute('data-role', role)
      el.style.whiteSpace = 'pre'
      return el
    }
    this.root = mk('perf-hud')
    this.root.style.position = 'fixed'
    this.root.style.right = '12px'
    // 顶部 28px 是拖拽区（铁律），HUD 从 40px 起排，且本身不接受点击
    this.root.style.top = '40px'
    this.root.style.padding = '8px 10px'
    this.root.style.background = 'rgba(0,0,0,0.62)'
    this.root.style.color = '#d8e2f0'
    this.root.style.font = '11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace'
    this.root.style.borderRadius = '6px'
    this.root.style.pointerEvents = 'none'
    this.root.style.zIndex = '9999'

    this.fps = mk('perf-fps')
    this.interval = mk('perf-interval')
    this.cpu = mk('perf-cpu')
    this.gpu = mk('perf-gpu')
    this.drops = mk('perf-drops')
    this.tier = mk('perf-tier')
    this.phases = mk('perf-phases')
    for (const el of [this.fps, this.interval, this.cpu, this.gpu, this.drops, this.tier, this.phases]) {
      this.root.appendChild(el)
    }
    parent.appendChild(this.root)
  }

  update(s: FrameStatsSummary, extra: PerfHudExtra): void {
    // FPS 由帧间隔 p50 换算，不另存计数器——两个来源会漂移，单一真源更可信
    const fps = s.intervalMs.p50 > 0 ? 1000 / s.intervalMs.p50 : 0
    this.fps.textContent = `FPS ${fmt(fps)}  (目标 ${fmt(1000 / extra.targetIntervalMs)})`
    this.interval.textContent = `间隔 p50 ${fmt(s.intervalMs.p50)} · p95 ${fmt(s.intervalMs.p95)} · p99 ${fmt(s.intervalMs.p99)} ms`
    this.cpu.textContent = `CPU  p50 ${fmt(s.cpuFrameMs.p50)} · p95 ${fmt(s.cpuFrameMs.p95)} · p99 ${fmt(s.cpuFrameMs.p99)} ms`
    this.gpu.textContent = `GPU  批均 ${extra.gpuAvgMs === null ? DASH : fmt(extra.gpuAvgMs)} ms`
    this.drops.textContent = `慢帧 ${fmt(s.jankEventRate * 100, 2)}% · 漏同步 ${fmt(s.missedVsyncRate * 100, 2)}% · 卡顿 ${s.hitchCount} 次`
    this.tier.textContent = `档位 ${extra.tier} · ${extra.particles} 粒子 · ${s.frames} 帧`
    const p = s.phasesMs
    this.phases.textContent = `分段 信号${fmt(p.signal, 2)} 映射${fmt(p.mapping, 2)} 状态${fmt(p.state, 2)} 画面${fmt(p.visual, 2)} 相机${fmt(p.camera, 2)} 提交${fmt(p.submit, 2)}`
  }

  dispose(): void {
    this.root.remove()
  }
}
