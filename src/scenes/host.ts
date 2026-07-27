import { createScene } from './registry'
import type { Scene, SceneTrackEvent, QualityTier, UiFocusProfile, ScenePlaybackProgress, SceneLyricsDoc } from './types'
import type { SignalBus } from '../engine/bus'
import { perf } from '../perf/collector'
import type { MappingValues } from './nebula/mapping/types'
import type { ShapeSettings } from './nebula/shapes/types'
import type { MotionSettings } from './nebula/motion/types'
import type { CameraSettings } from './nebula/camera-types'
import type { TitleSettings } from './nebula/title-fx'
import type { LyricsSettings } from './nebula/lyrics/lyrics-fx'
import type { BackgroundSettings } from './nebula/background-types'
import type { GalaxyView } from './nebula/galaxy/types'

export class SceneHost {
  private scene: Scene | null = null
  private rafId = 0
  private lastNow: number | null = null
  private pendingTrack: SceneTrackEvent | null = null
  private lastTrack: SceneTrackEvent | null = null // 场景启动后补发最近一次 track
  private startToken = 0
  private readonly raf: (cb: FrameRequestCallback) => number
  private readonly caf: (id: number) => void
  private lastUiFocus: { v: number; profile: UiFocusProfile } = { v: 0, profile: 'full' }
  private lastInteractive = true
  private lastMapping: MappingValues | null = null
  /** 试音态（换场景后重放，见 setAuditionActive）；null = 不在试音中 */
  private auditionState: { resetPeaks?: [number, number, number] } | null = null
  private lastShape: ShapeSettings | null = null
  private lastMotion: MotionSettings | null = null
  private lastCamera: CameraSettings | null = null
  private lastTitle: TitleSettings | null = null
  private lastLyrics: LyricsSettings | null = null
  private lastBackground: BackgroundSettings | null = null
  private lastProgress: ScenePlaybackProgress | null = null
  private pendingProgress: ScenePlaybackProgress | null = null // 终审I1：progress 队列化到下一帧，帧内让 track 清场先行
  private lastLyricsDoc: SceneLyricsDoc | null = null
  private lastGalaxy: GalaxyView | null = null

  private readonly afterFrame?: (nowMs: number) => void
  private readonly onInitError?: (sceneName: string, err: unknown) => void
  private readonly onCameraCommit?: (c: CameraSettings) => void

  constructor(
    private canvas: HTMLCanvasElement,
    private bus: SignalBus,
    opts: {
      raf?: (cb: FrameRequestCallback) => number
      caf?: (id: number) => void
      /** 渲染后钩子（idea #8 Drop 回放）：每帧 update 之后同任务调用——WebGPU 画布只在
       * present 前的同任务窗口内可读（海报教训），录制捕获必须挂这里而非独立 rAF */
      afterFrame?: (nowMs: number) => void
      /** 场景 init 失败上报（发布准备③ 导出诊断）：WebGPU 初始化失败是「画面不动」类问题的头号嫌犯，
       * 内部 catch 吞掉后 window.onerror 看不见，必须在此显式外送 */
      onInitError?: (sceneName: string, err: unknown) => void
      /** 镜头设置提交回调（#镜头精修 ①）：场景内滚轮改默认距离时冒泡出来，交由 main.ts 落盘 + 广播 */
      onCameraCommit?: (c: CameraSettings) => void
    } = {}
  ) {
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb))
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id))
    this.afterFrame = opts.afterFrame
    this.onInitError = opts.onInitError
    this.onCameraCommit = opts.onCameraCommit
  }

  async start(name: string, quality: QualityTier, forcedTier?: QualityTier, trackTimestamp?: boolean): Promise<void> {
    const token = ++this.startToken // 重入防护：只有最新一次 start 有权落地
    this.stop()
    let scene = createScene(name)
    try {
      await scene.init({ canvas: this.canvas, quality, forcedTier, trackTimestamp })
    } catch (err) {
      console.error(`[scene] ${name} init 失败，回退 placeholder`, err)
      this.onInitError?.(name, err)
      try { scene.dispose() } catch { /* 半初始化场景，尽力释放 */ }
      scene = createScene('placeholder')
      try {
        await scene.init({ canvas: this.canvas, quality, forcedTier, trackTimestamp })
      } catch (fatal) {
        console.error('[scene] placeholder 兜底也失败（canvas 可能已被 GPU 上下文占用）', fatal)
        this.onInitError?.('placeholder', fatal)
        return
      }
    }
    if (token !== this.startToken) {
      scene.dispose() // 更新的 start 已在途/已落地，本次结果作废
      return
    }
    this.scene = scene
    // 重放 UI 信号缓存
    if (this.lastUiFocus.v !== 0) scene.setUiFocus?.(this.lastUiFocus.v, this.lastUiFocus.profile)
    if (this.lastMapping) this.scene.applyMapping?.(this.lastMapping)
    if (this.lastShape) this.scene.applyShape?.(this.lastShape)
    if (this.lastMotion) this.scene.applyMotion?.(this.lastMotion)
    if (this.lastCamera) this.scene.applyCamera?.(this.lastCamera)
    if (this.onCameraCommit) scene.setCameraCommit?.(this.onCameraCommit)
    if (!this.lastInteractive) scene.setInteractive?.(false)
    if (this.lastTitle) this.scene.applyTitle?.(this.lastTitle)
    if (this.lastLyrics) this.scene.applyLyrics?.(this.lastLyrics)
    if (this.lastBackground) this.scene.applyBackground?.(this.lastBackground)
    if (this.lastGalaxy) this.scene.applyGalaxy?.(this.lastGalaxy)
    // 试音态必须重放：新场景据此建立自己的「进入前快照」，否则退出时无从还原、
    // 试音的定标会继续压制真实歌曲（换画质档位会走到这里重建场景）
    if (this.auditionState) this.scene.setAuditionActive?.(true, this.auditionState.resetPeaks)
    // 重放走队列（终审复核残留）：若直调 onProgress，随后首帧消费 pendingTrack 时 onTrackChange
    // 的 clock.reset() 会把这个刚 mark 的基准抹掉——排进队列借帧循环既定顺序（track 先 progress 后），
    // 首帧 onTrackChange 清场后才 mark，重建不失基准
    if (this.lastProgress) this.pendingProgress = this.lastProgress
    if (this.lastLyricsDoc) this.scene.onLyrics?.(this.lastLyricsDoc)
    if (this.lastTrack) this.pendingTrack = this.lastTrack
    this.lastNow = null
    // resize 全链路归 host（评审修订：此前 Scene.resize 定义了但无人调用，全屏一改尺寸就拉伸糊图）
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize)
    this.rafId = this.raf(this.frame)
  }

  notifyTrack(t: SceneTrackEvent): void {
    this.lastTrack = t
    this.pendingTrack = t
  }

  stop(): void {
    this.caf(this.rafId)
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize)
    this.scene?.dispose()
    this.scene = null
  }

  setUiFocus(v: number, profile: UiFocusProfile = 'full'): void {
    this.lastUiFocus = { v, profile }
    this.scene?.setUiFocus?.(v, profile)
  }

  applyMapping(m: MappingValues): void {
    this.lastMapping = m
    this.scene?.applyMapping?.(m)
  }

  applyShape(s: ShapeSettings): void {
    this.lastShape = s
    this.scene?.applyShape?.(s)
  }

  applyMotion(m: MotionSettings): void {
    this.lastMotion = m
    this.scene?.applyMotion?.(m)
  }

  applyCamera(c: CameraSettings): void {
    this.lastCamera = c
    this.scene?.applyCamera?.(c)
  }

  // 当前无调用方（两态模型下运镜恒开，2026-07-06 拍板小窗/置顶退役）；
  // API 留给未来——图钉/挂件形态回归时启用
  setInteractive(on: boolean): void {
    this.lastInteractive = on
    this.scene?.setInteractive?.(on)
  }

  applyTitle(t: TitleSettings): void {
    this.lastTitle = t
    this.scene?.applyTitle?.(t)
  }

  /** 快门（idea #6）：委派当前场景的可选 snapshot；场景未起/不支持 → null（调用方按"没拍成"处理） */
  snapshot(): Promise<ImageData | null> {
    return this.scene?.snapshot?.() ?? Promise.resolve(null)
  }

  notifyProgress(p: ScenePlaybackProgress): void {
    // 不直转发（终审I1）：主进程先发 progress 后发 track，若这里同步直转发，切歌时新歌的首个
    // progress 会先被 mark，下一帧 pendingTrack 消费时 onTrackChange 的 clock.reset() 才把它抹掉——
    // 首句歌词最多延迟一个轮询周期。队列到 frame() 里，排在 pendingTrack 消费之后再喂给场景。
    this.lastProgress = p
    this.pendingProgress = p
  }

  notifyLyrics(d: SceneLyricsDoc): void {
    this.lastLyricsDoc = d
    this.scene?.onLyrics?.(d)
  }

  applyLyrics(s: LyricsSettings): void {
    this.lastLyrics = s
    this.scene?.applyLyrics?.(s)
  }

  /** 试音模式进出转发（信号源切换时隔离场景侧自适应状态，见 Scene.setAuditionActive）。
   * **必须记忆并在换场景后重放**：试音期间用户仍可改画质档位而触发 Scene 重建，
   * 新场景若不知道自己身处试音中，就没有「进入前快照」，退出时无从还原，
   * 试音的定标会继续压制真实歌曲。 */
  setAuditionActive(active: boolean, resetPeaks?: [number, number, number]): void {
    this.auditionState = active ? { resetPeaks } : null
    this.scene?.setAuditionActive?.(active, resetPeaks)
  }

  /** 星系是否已完全退出（未实现该钩子的场景视为恒 true，不阻塞模式切换） */
  isGalaxyIdle(): boolean {
    return this.scene?.isGalaxyIdle?.() ?? true
  }

  applyBackground(b: BackgroundSettings): void {
    this.lastBackground = b
    this.scene?.applyBackground?.(b)
  }

  /** 星系图鉴（idea #4）：视图整包注入，重放语义同 applyShape（档位重建自动回星系） */
  applyGalaxy(g: GalaxyView): void {
    this.lastGalaxy = g
    this.scene?.applyGalaxy?.(g)
  }

  private onResize = (): void => {
    this.scene?.resize?.(window.innerWidth, window.innerHeight)
  }

  private frame = (now: number): void => {
    const scene = this.scene
    if (!scene) return
    const probing = perf.enabled // off 态零开销：热路径只读一个布尔
    if (probing) perf.beginFrame(now)
    const dt = this.lastNow === null ? 0.016 : Math.min((now - this.lastNow) / 1000, 0.1)
    this.lastNow = now
    if (this.pendingTrack) {
      scene.onTrackChange(this.pendingTrack)
      this.pendingTrack = null
    }
    // track 先行、progress 随后（终审I1）：帧内先让 onTrackChange 的 clock.reset() 清场，
    // 再喂新进度，避免新歌首个 progress 被旧 track 清场抹掉
    if (this.pendingProgress) {
      scene.onProgress?.(this.pendingProgress)
      this.pendingProgress = null
    }
    scene.update(dt, this.bus.takeFrame())
    this.afterFrame?.(now)
    if (probing) perf.endFrame(performance.now())
    this.rafId = this.raf(this.frame)
  }
}
