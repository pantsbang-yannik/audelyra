// 基准控制面板——仅 #perf 入口挂载。三个按钮 + 一行状态。
// 挂 #audelyra-overlay（UI 铁律）；顶部 28px 拖拽区不放可点击元素，故从 40px 起排。
export interface BenchPanelDeps {
  onRunSuite(): void
  onRunSoak(): void
  onRunPower(): void
}

export class BenchPanel {
  private readonly root: HTMLElement
  private readonly status: HTMLElement

  constructor(parent: HTMLElement, deps: BenchPanelDeps) {
    this.root = document.createElement('div')
    this.root.setAttribute('data-role', 'bench-panel')
    this.root.style.position = 'fixed'
    this.root.style.left = '12px'
    this.root.style.top = '40px'
    this.root.style.padding = '8px 10px'
    this.root.style.background = 'rgba(0,0,0,0.62)'
    this.root.style.color = '#d8e2f0'
    this.root.style.font = '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace'
    this.root.style.borderRadius = '6px'
    this.root.style.zIndex = '9999'
    // #audelyra-overlay 整体 pointer-events:none（鼠标穿透让画面可交互）——可点击面板必须显式
    // 声明 auto 才能收到点击（与 base-panel/galaxy-bar 等既有面板同款纪律）
    this.root.style.pointerEvents = 'auto'
    this.root.style.display = 'flex'
    this.root.style.flexDirection = 'column'
    this.root.style.gap = '6px'

    const mkBtn = (role: string, label: string, onClick: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.setAttribute('data-role', role)
      b.textContent = label
      b.style.font = 'inherit'
      b.style.color = '#d8e2f0'
      b.style.background = 'rgba(255,255,255,0.10)'
      b.style.border = '1px solid rgba(255,255,255,0.20)'
      b.style.borderRadius = '4px'
      b.style.padding = '4px 8px'
      b.style.cursor = 'pointer'
      b.addEventListener('click', onClick)
      return b
    }

    this.root.appendChild(mkBtn('bench-run-suite', '跑基准（约 4 分 25 秒）', deps.onRunSuite))
    this.root.appendChild(mkBtn('bench-run-power', '跑功耗场景（65 秒）', deps.onRunPower))
    this.root.appendChild(mkBtn('bench-run-soak', '跑长测（30 分钟）', deps.onRunSoak))

    this.status = document.createElement('div')
    this.status.setAttribute('data-role', 'bench-status')
    this.status.textContent = '就绪'
    this.root.appendChild(this.status)
    parent.appendChild(this.root)
  }

  setStatus(text: string): void {
    this.status.textContent = text
  }

  dispose(): void {
    this.root.remove()
  }
}
