import { BadgeVisibility } from './track-badge'
import { attachTooltip } from './tooltip'

export type DockMode = 'fullscreen' | 'windowed'

export interface DockDeps {
  toggleTuning: () => void
  toggleShapes: () => void
  /** 星图海报快门（idea #6）：抓帧→排版→存下载夹，重入保护在装配层 */
  snapPoster: () => void
  /** Drop 回放快门（idea #8）：取预录缓冲封 MP4→预览→存/弃，重入保护在装配层（与海报共用忙标） */
  snapClip: () => void
  /** 本地音频播放（V1）：弹系统文件选择框，装配层接隐藏 <input type=file> */
  openLocalFile: () => void
  /** 试音模式（显影 V0）：合成信号替代真实音乐，进出由装配层管（同星系图鉴的模式语义） */
  toggleAudition: () => void
}

/** 一枚图标按钮的定义：标题（title 提示 + 查找用）、SVG 内联标记、点击回调、可选快捷键后缀 */
interface IconSpec {
  title: string
  svg: string
  onClick: () => void
  shortcut?: string
}

const ICON_SIZE = 18
const BASE_COLOR = 'rgba(255, 255, 255, 0.45)'
const HOVER_COLOR = 'rgba(255, 255, 255, 0.85)'

/**
 * 操作坞——界面内悬停显影的图标操作入口（两态下恒为 [形状 调音台 试音 | 星图海报 Drop回放 | 本地播放]；设置/星系/全屏在右上 CornerCluster）
 * 显隐模型复用 track-badge 的 BadgeVisibility：两态下 hasContent 恒 true（坞本身不再随态隐藏），
 * 只叠加 enabled（首启引导期间整体禁用，与 TrackBadge M3-T8 同款语义）
 */
export class ControlDock {
  private visibility: BadgeVisibility
  private container: HTMLElement
  /** 上次写入 DOM 的可见状态——去重，visible 变化才写样式（同 TrackBadge） */
  private lastVisibleState: boolean | null = null
  /** 上次渲染按钮所依据的 mode——去重，mode 没变不重建按钮 DOM */
  private lastMode: DockMode | null = null
  /** 当前按钮挂载的 tooltip 清理函数——rebuild/dispose 前逐个调用，防 tooltip 节点泄漏 */
  private tooltipCleanups: (() => void)[] = []

  constructor(parent: HTMLElement, private deps: DockDeps) {
    this.visibility = new BadgeVisibility(3)

    this.container = document.createElement('div')
    this.container.id = 'control-dock'
    this.container.style.cssText = `
      position: fixed;
      right: 28px;
      bottom: 24px;
      display: flex;
      gap: 34px;
      pointer-events: none;
      opacity: 0;
      filter: blur(6px);
      transition: opacity 500ms cubic-bezier(0.33, 1, 0.68, 1),
                  filter 500ms cubic-bezier(0.33, 1, 0.68, 1);
    `
    parent.appendChild(this.container)
  }

  setMode(m: DockMode): void {
    // 两态下操作坞恒可显示（hasContent 默认 true）：显隐只看鼠标活动/enabled，不再随 mode 门控
    this.rebuild(m)
    this.updateDOM()
  }

  setEnabled(on: boolean): void {
    this.visibility.setEnabled(on)
    this.updateDOM()
  }

  pokeActivity(): void {
    this.visibility.poke()
  }

  update(dt: number): void {
    this.visibility.update(dt)
    this.updateDOM()
  }

  get visible(): boolean {
    return this.visibility.visible
  }

  /** 操作坞容器节点——供 PanelCoordinator.setTriggerContainers 取用，登记为面板的
   * 点外部关忽略区（点图标本身不该被当成「点了外部」，见 base-panel.ts 顶部注释） */
  get element(): HTMLElement {
    return this.container
  }

  /** mode 没变就不重写按钮 DOM（去重纪律，同角标/提示） */
  private rebuild(m: DockMode): void {
    if (m === this.lastMode) return
    this.lastMode = m
    this.clearTooltips()
    this.container.innerHTML = ''
    for (const group of this.iconGroups()) {
      const g = document.createElement('div')
      g.style.cssText = 'display: flex; gap: 18px;'
      for (const icon of group) g.appendChild(this.makeButton(icon))
      this.container.appendChild(g)
    }
  }

  /** 三组：布置（开面板改"怎么看" + 试音验效果）｜快门（记录当下）｜内容（换"听什么"）——
   * 按**用户目的**分区，不按技术实现（主界面布局重组）。
   * 形状居首为既定顺序；设置/星系图鉴已迁右上 CornerCluster */
  private iconGroups(): IconSpec[][] {
    return [
      [
        {
          title: '形状 / 背景', shortcut: '⌘⇧S', // 名称与卡片层的双 tab 对齐
          svg: '<circle cx="8.5" cy="8.5" r="4.5"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.5"/>',
          onClick: () => this.deps.toggleShapes()
        },
        {
          title: '调音台', shortcut: '⌘⇧T',
          svg: '<line x1="6" y1="4" x2="6" y2="20"/><circle cx="6" cy="9" r="2" fill="currentColor" stroke="none"/>' +
            '<line x1="12" y1="4" x2="12" y2="20"/><circle cx="12" cy="15" r="2" fill="currentColor" stroke="none"/>' +
            '<line x1="18" y1="4" x2="18" y2="20"/><circle cx="18" cy="11" r="2" fill="currentColor" stroke="none"/>',
          onClick: () => this.deps.toggleTuning()
        },
        {
          // 紧跟调音台：按**用户目的**归组（调 + 试是一条工作流），不按技术实现
          // （试音换的是信号源，但用户心智里「本地播放」是要放自己的歌、「试音」是要调效果，目的不同）
          title: '试音',
          svg: '<rect x="3" y="7" width="18" height="10" rx="1.5"/>' +
            '<line x1="9" y1="7" x2="9" y2="17"/><line x1="15" y1="7" x2="15" y2="17"/>' +
            '<path d="M6 4.6 v1.2 M12 4.6 v1.2 M18 4.6 v1.2"/>',
          onClick: () => this.deps.toggleAudition()
        }
      ],
      [
        {
          title: '星图海报', shortcut: '⌘⇧P',
          svg: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/>' +
            '<path d="M12 8.2 l0.9 2.4 2.4 0.9 -2.4 0.9 -0.9 2.4 -0.9-2.4 -2.4-0.9 2.4-0.9 z"/>' +
            '<circle cx="7" cy="8" r="0.8" fill="currentColor" stroke="none"/>' +
            '<circle cx="16.8" cy="15.6" r="0.8" fill="currentColor" stroke="none"/>',
          onClick: () => this.deps.snapPoster()
        },
        {
          title: 'Drop 回放', shortcut: '⌘⇧R',
          svg: '<path d="M3 12 a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74 L3 8"/><path d="M3 3 v5 h5"/>' +
            '<path d="M10.5 9.3 l4.6 2.7 -4.6 2.7 z" fill="currentColor" stroke="none"/>',
          onClick: () => this.deps.snapClip()
        }
      ],
      [
        {
          title: '本地播放',
          svg: '<path d="M3.5 8.5 V7 a1.5 1.5 0 0 1 1.5-1.5 h3.6 l2 2 h8.4 a1.5 1.5 0 0 1 1.5 1.5 v8.5 a1.5 1.5 0 0 1-1.5 1.5 H5 a1.5 1.5 0 0 1-1.5-1.5 z"/>' +
            '<circle cx="11" cy="15.3" r="1.4" fill="currentColor" stroke="none"/><path d="M12.4 15.3 V11.2 l2.8 0.9"/>',
          onClick: () => this.deps.openLocalFile()
        }
      ]
    ]
  }

  private makeButton(icon: IconSpec): HTMLElement {
    const btn = document.createElement('button')
    this.tooltipCleanups.push(attachTooltip(btn, icon.title, 'top', icon.shortcut))
    btn.style.cssText = `
      pointer-events: auto;
      cursor: pointer;
      background: none;
      border: none;
      padding: 0;
      color: ${BASE_COLOR};
      transition: color 200ms;
    `
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icon.svg}</svg>`
    btn.addEventListener('click', icon.onClick)
    btn.addEventListener('mouseenter', () => { btn.style.color = HOVER_COLOR })
    btn.addEventListener('mouseleave', () => { btn.style.color = BASE_COLOR })
    return btn
  }

  private updateDOM(): void {
    if (this.visible === this.lastVisibleState) return
    this.lastVisibleState = this.visible
    if (this.visible) {
      this.container.style.opacity = '1'
      this.container.style.filter = 'blur(0)'
    } else {
      this.container.style.opacity = '0'
      this.container.style.filter = 'blur(6px)'
    }
  }

  /** 逐个调用并清空 tooltip 清理函数——重建/销毁前调用，防 tooltip 节点残留在 body */
  private clearTooltips(): void {
    for (const cleanup of this.tooltipCleanups) cleanup()
    this.tooltipCleanups = []
  }

  dispose(): void {
    this.clearTooltips()
    this.container.remove()
  }
}
