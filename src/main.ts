import { AudelyraEngine } from './engine/engine'
import { SceneHost } from './scenes/host'
import { registerScene } from './scenes/registry'
import { createPlaceholderScene } from './scenes/placeholder'
import { createNebulaScene } from './scenes/nebula'
import { TrackBadge } from './ui/track-badge'
import { ControlDock } from './ui/control-dock'
import { CornerCluster } from './ui/corner-cluster'
import { DragStrip } from './ui/drag-strip'
import { UiStage } from './ui/ui-stage'
import { PanelCoordinator } from './ui/panel-coordinator'
import { SettingsPanel } from './ui/settings-panel'
import { TuningPanel } from './ui/tuning-panel'
import { ShapePicker } from './ui/shape-picker'
import { runOnboarding } from './ui/onboarding'
import { OnboardingDemoScript, runDemoPlayback, DEMO_STATION_HINTS, type DemoPlayback } from './ui/onboarding-demo'
// ?raw 编译期内联（审② P0）：打包版 win.loadFile 是 file:// origin，fetch 不支持 file: scheme——
// 内联进 bundle 让 dev/打包两形态同一条路，1.2MB 可接受
import demoTraceRaw from './assets/traces/onboarding-demo.jsonl?raw'
import demoAudioUrl from './assets/audio/onboarding-demo.mp3?url'
import { IdleHint } from './ui/idle-hint'
import { IdleHintLogic } from './ui/idle-hint-logic'
import { frameRms, AUDIBLE_RMS } from './audio/pcm-energy'
import { EnergyRibbon, composePoster, posterFilename, type PosterMeta } from './ui/poster'
import { MediaPreview, type MediaChoice } from './ui/poster-preview'
import { ReplayRecorder } from './replay/replay-recorder'
import { replayFilename } from './replay/replay-clip'
import { ShapeCreatePanel } from './ui/shape-create'
import { DropOverlay } from './ui/drop-overlay'
import { DropChoice } from './ui/drop-choice'
import { UpdateNotice, type UpdateStatusMsg } from './ui/update-toast'
import { LocalPlayer } from './audio/local-player'
import { PlayerBar } from './ui/player-bar'
import { LocalQueue, type QueueTrack } from './audio/local-queue'
import { readTags } from './audio/track-tags'
import { isSupportedAudio } from './audio/audio-file'
import { isSupportedImage, decodeImageFile, ingestErrorText } from './ui/custom-shape-ingest'
import { decodeBackgroundFile, captureVideoThumb, isSupportedVideo } from './ui/background-ingest'
import { checkImageUsable } from './scenes/nebula/custom-points'
import { loadContourAssets, unloadContourAssets, DEMO_CONTOUR_IDS } from './scenes/nebula/shapes/contour'
import { evictShapeCache } from './scenes/nebula/shapes'
import { setCustomShapeFetcher } from './scenes/nebula/custom-shapes'
import { setCustomBackgroundFetcher } from './scenes/nebula/user-backdrop'
import { TIERS } from './scenes/shared/quality'
import { GalaxyBar } from './ui/galaxy-bar'
import { GalaxyCard } from './ui/galaxy-card'
import { GalaxyTooltip } from './ui/galaxy-tooltip'
import { aggregateStars, localDateOf } from './scenes/nebula/galaxy/aggregate'
import { buildFilterView, anniversaryFor } from './scenes/nebula/galaxy/filter'
import { dominantTint } from './scenes/nebula/galaxy/tint'
import { setGalaxyArtworkFetcher } from './scenes/nebula/galaxy/covers'
import type { StartupMarks, StartupResult } from './perf/report'
import type { GalaxyPlayRecord, GalaxyStar, GalaxyFilter, GalaxyFilterView } from './scenes/nebula/galaxy/types'
import type { SceneTrackEvent, QualityTier, ScenePlaybackProgress, SceneLyricsDoc } from './scenes/types'
import type { MappingValues } from './scenes/nebula/mapping/types'
import type { MacroKnobs } from './scenes/nebula/mapping/macro'
import { CUSTOM_SHAPES_MAX, DEMO_SHAPE_IDS, SHAPE_IDS, DEFAULT_SHAPE_SETTINGS, type ShapeSettings, type ShapeId } from './scenes/nebula/shapes/types'
import { DEFAULT_MOTION_SETTINGS, type MotionSettings } from './scenes/nebula/motion/types'
import { DEFAULT_CAMERA_SETTINGS, type CameraSettings } from './scenes/nebula/camera-types'
import type { TitleSettings } from './scenes/nebula/title-fx'
import { DEFAULT_LYRICS_SETTINGS, type LyricsSettings } from './scenes/nebula/lyrics/lyrics-fx'
import { CUSTOM_BACKGROUNDS_MAX, BACKGROUND_VIDEO_MAX_BYTES, DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from './scenes/nebula/background-types'
import { REVISION as THREE_VERSION } from 'three'

type TrackMsg = SceneTrackEvent

// 与 electron/settings.ts / windows.ts 的形状保持一致——两侧的顶层设置容器类型各自独立声明
// （标量字段不共享 import）；嵌套对象类型（mapping/shape）经 src/scenes 共享同一份类型源，
// 契约漂移由 tsc + 冒烟兜住
type RendererSettings = {
  tier: 'auto' | 'high' | 'mid' | 'low'
  title: TitleSettings
  launchAtLogin: boolean
  winBounds: { x: number; y: number; width: number; height: number } | null
  preventSleep: boolean
  onboarded: boolean
  mapping: MappingValues
  macroKnobs: MacroKnobs
  tuningAdvancedExpanded: boolean
  shape: ShapeSettings
  motion: MotionSettings
  camera: CameraSettings
  lyrics: LyricsSettings
  background: BackgroundSettings
  updateCheck: { enabled: boolean; skippedVersion: string | null }
}
type RendererWindowMode = 'fullscreen' | 'windowed'

declare global {
  interface Window {
    audelyra: {
      onPcmFrame(cb: (f: { sampleRate: number; channels: number; samples: Float32Array }) => void): void
      onCaptureStatus(cb: (s: string) => void): void
      onTrack(cb: (t: TrackMsg) => void): void
      onProgress(cb: (p: ScenePlaybackProgress) => void): void
      onLyrics(cb: (d: SceneLyricsDoc) => void): void
      rendererReady(): void
      // M4 壳层通道
      getSettings(): Promise<RendererSettings>
      setSettings(patch: Partial<RendererSettings>): void
      onSettingsChanged(cb: (s: RendererSettings) => void): void
      getWindowMode(): Promise<RendererWindowMode>
      setWindowMode(m: RendererWindowMode): void
      onWindowMode(cb: (m: RendererWindowMode) => void): void
      onOpenSettingsRequest(cb: () => void): void
      // 模态仲裁 / 捕获重启 / 系统设置深链
      setModalOpen(open: boolean): void
      restartCapture(): void
      openAudioCapturePrefs(): void
      // mapping 预览(不落盘)/提交(落盘)双通道
      previewMapping(m: MappingValues): void
      commitMapping(m: MappingValues): void
      onMappingChanged(cb: (m: MappingValues) => void): void
      // motion 预览(不落盘)/提交(落盘)双通道（Phase C2 T1）
      previewMotion(m: MotionSettings): void
      commitMotion(m: MotionSettings): void
      onMotionChanged(cb: (m: MotionSettings) => void): void
      // camera 预览(不落盘)/提交(落盘)双通道（Phase D）
      previewCamera(c: CameraSettings): void
      commitCamera(c: CameraSettings): void
      onCameraChanged(cb: (c: CameraSettings) => void): void
      // shape 二进制资产通道（主进程读文件，白名单守卫防路径穿越；含序幕形体）
      getShapeAsset(id: string): Promise<Uint8Array>
      // 自定义形状图片仓库（idea #12）：userData/custom-shapes/，主进程 uuid 白名单守卫
      saveCustomShape(id: string, png: Uint8Array): Promise<void>
      readCustomShape(id: string): Promise<Uint8Array>
      deleteCustomShape(id: string): Promise<void>
      convertImageToPng(bytes: Uint8Array): Promise<Uint8Array>
      // 自定义背景图片仓库（自定义背景 v1）：userData/backgrounds/，主进程 uuid 白名单守卫
      saveCustomBackground(id: string, jpeg: Uint8Array): Promise<void>
      readCustomBackground(id: string): Promise<Uint8Array>
      deleteCustomBackground(id: string): Promise<void>
      // 自定义背景视频 + 缩略图（自定义背景 v2）：userData/backgrounds/，路径直拷无内存过手
      saveCustomBackgroundVideo(id: string, path: string): Promise<void>
      saveCustomBackgroundThumb(id: string, jpeg: Uint8Array): Promise<void>
      readCustomBackgroundThumb(id: string): Promise<Uint8Array>
      // 拖入文件 → 真实路径（webUtils，Electron 32+）：大文件走路径直拷，绝不整包过 IPC
      getPathForFile(f: File): string
      // 星图海报（idea #6）：主进程写下载夹，回执路径；reveal=Finder 定位（fb5 轻提示点击）
      savePoster(filename: string, png: Uint8Array): Promise<{ ok: boolean; path: string }>
      revealPoster(path: string): void
      // Drop 回放动图（idea #8）：主进程写下载夹；Finder 定位复用 revealPoster
      saveClip(filename: string, mp4: Uint8Array): Promise<{ ok: boolean; path: string }>
      // 星系图鉴（idea #4）：历史读取
      readHistory(): Promise<Array<{ title: string; artist: string; duration: number | null; listenedSeconds: number; endedAt: string; artworkKey: string | null }>>
      readHistoryArtwork(key: string): Promise<Uint8Array | null>
      // 本地音频 V2：本地播放报历史（有标签才发 change；无标签只发 stop 结算）
      localTrackChange(p: { title: string; artist: string; duration: number | null; coverBytes: Uint8Array | null; coverMime: string | null }): void
      localTrackStop(): void
      localProgress(playing: boolean): void
      lookupLyrics(title: string, artist: string, duration: number | null): Promise<Array<{ t: number; text: string }> | null>
      // 更新体系 v1（发布准备②）：主进程推决策；下载/跳过动作上行（链接白名单守卫在主进程）
      onUpdateStatus(cb: (d: unknown) => void): void
      openUpdateDownload(url: string): void
      skipUpdate(version: string): void
      getAppVersion(): Promise<string>
      checkUpdate(): void
      // 导出诊断（发布准备③）：报告生成在主进程；logDiag 上行渲染层错误进环形日志
      exportDiagnostics(): Promise<{ ok: boolean; path: string }>
      logDiag(source: string, message: string): void
      // 性能基准（性能基线）：打包版主进程未注册对应 handler，调用会 reject
      perfGetEnv(): Promise<import('./perf/report').PerfEnv | null>
      perfStandardizeWindow(): Promise<{ w: number; h: number } | null>
      perfRestoreWindow(size: { w: number; h: number }): Promise<void>
      perfGetStartupMarks(): Promise<{
        processStartMs: number; windowCreatedMs: number
        mainNowMs: number; mainWallMs: number
      }>
    }
    // 启动里程碑（性能基线）：#perf 入口下三次累积对齐后写入，供 Task 14 归档读取；未采集完成前不存在
    __audelyraStartup?: StartupResult
  }
}

async function boot(): Promise<void> {
  // 启动里程碑（性能基线）：renderer 侧三个点，单位是渲染层 performance.now()，
  // 换算到主进程坐标系在 #perf 装配处统一做
  const markRendererLoaded = performance.now()
  let markSceneInitDone = 0
  let markFirstFrame = 0

  // 渲染层未捕获错误进主进程诊断日志（发布准备③）：纯内存环形缓冲，仅用户导出报告时落盘。
  // 挂在 boot 最前——后续任何装配步骤抛错都能被记到
  window.addEventListener('error', (e) => window.audelyra.logDiag('window', String(e.message).slice(0, 300)))
  window.addEventListener('unhandledrejection', (e) => {
    window.audelyra.logDiag('promise', String(e.reason).split('\n')[0]?.slice(0, 300) ?? '')
  })

  const engine = new AudelyraEngine()
  let liveMuted = false
  let replayActive = false
  let localActive = false
  let demoActive = false // 序幕 demo trace 在演（发布准备③）：同回放语义,旁路系统捕获防双信号灌引擎
  // 静音是"或"语义:trace 回放、本地播放、序幕演示任一活跃都旁路系统捕获(防双重进引擎/信号打架)
  const updateLiveMute = (): void => { liveMuted = replayActive || localActive || demoActive }
  // 原始帧能量探针（发布准备③）：「听到声音」判定与 bus 解耦——liveMuted 期间（demo/回放/本地）
  // 真实系统声照样被探到，引导成功判定与空状态提示都吃这一路
  let lastAudibleAt = -Infinity
  window.audelyra.onPcmFrame((f) => {
    if (!liveMuted) engine.ingest(f)
    if (frameRms(f.samples) >= AUDIBLE_RMS) lastAudibleAt = performance.now()
  })
  // 捕获状态接入空状态提示（发布准备③ 权限闭环）：unavailable 从此有 UI 出路，不再只 console
  let captureUnavailable = false
  window.audelyra.onCaptureStatus((s) => {
    captureUnavailable = s === 'unavailable'
    console.log('capture:', s)
  })

  const canvas = document.getElementById('stage') as HTMLCanvasElement

  // trace 回放控制装到两条路由外（Task 6 起场景开发一律可拖 trace 调参）
  if (import.meta.env.DEV) {
    // 生产剥离：R 键 trace 录制/回放仅开发版可用，DEV=false 时整个分支连 chunk 一起被消除
    const { installTraceControls } = await import('./ui/debug/trace-controls')
    installTraceControls({
      bus: engine.bus,
      onReplayStart: () => { replayActive = true; updateLiveMute() },
      onReplayEnd: () => { replayActive = false; updateLiveMute() }
    })
  }

  // #perf 走正常场景装配路径（不是 #debug 的 2D 分支）——HUD 与基准必须能看到真正的 Nebula
  const isPerf = import.meta.env.DEV && location.hash.includes('perf')
  if (import.meta.env.DEV && location.hash.includes('debug') && !isPerf) {
    const { DebugView } = await import('./ui/debug/debug-view')
    const view = new DebugView(canvas)
    engine.bus.subscribe((s) => view.update(s))
    window.audelyra.onTrack((t) => {
      if (t.kind === 'change') view.setTrack(t.title, t.artist, t.artworkDataUrl)
      else view.setTrack('unknown', '', null)
    })
  } else {
    registerScene('placeholder', createPlaceholderScene) // 兜底：nebula init 失败时 SceneHost 自动回退
    registerScene('nebula', createNebulaScene)
    let replayCapture: ((nowMs: number) => void) | null = null
    const host = new SceneHost(canvas, engine.bus, {
      afterFrame: (now) => {
        // 首帧只记一次；用 performance.now() 而非 rAF 回调的 now 参数——
        // 实测二者口径不一致，now 有时比同一时刻的 performance.now() 早几十毫秒，
        // 会让 sceneInitDoneMs 反超 firstFrameSubmittedMs，破坏里程碑单调性
        if (markFirstFrame === 0) markFirstFrame = performance.now()
        replayCapture?.(now)
      },
      // 场景 init 失败进诊断日志（发布准备③）：内部 catch 吞掉的 WebGPU 失败 window.onerror 看不见
      onInitError: (sceneName, err) => window.audelyra.logDiag('scene-init', `${sceneName}: ${String(err).slice(0, 300)}`),
      // 滚轮改默认距离 → 落盘 + 广播（#镜头精修 ①）：与调音台距离滑块同一条 commit 路径，两边联动、重启保留
      onCameraCommit: (c) => window.audelyra.commitCamera(c)
    })

    // 角标初始化
    const overlayDiv = document.getElementById('audelyra-overlay') as HTMLElement
    const badge = new TrackBadge(overlayDiv)

    // 鼠标活动驱动显隐（保存引用便于清理）
    const onMouseMove = (): void => {
      badge.pokeActivity()
      dock.pokeActivity()
      corner.pokeActivity()
    }
    document.addEventListener('mousemove', onMouseMove)

    // 星系空闲自动进出的钩子（评审留档）：真身在装配块后段赋值，此处先占位防 TDZ——
    // interval 首跳可能早于 boot 走到 galaxy 装配块（中间隔着 await），直接引用会撞暂时性死区
    let galaxyIdleTick: () => void = () => {}

    // 轻量计时驱动隐藏（精度 250ms 足够）
    const badgeUpdateInterval = setInterval(() => {
      badge.update(0.25)
      dock.update(0.25)
      corner.update(0.25)
      galaxyIdleTick()
    }, 250)

    // ===== 星图海报（idea #6）：声纹缓冲 + 落款元数据 + 快门链路 =====
    const posterRibbon = new EnergyRibbon() // 唯一常驻状态：600 桶 ×100ms=最近 60s 能量
    engine.bus.subscribe((s) => posterRibbon.push(s.loudness.instant, performance.now()))
    let posterMeta: PosterMeta | null = null // 从未有过曲目时 null → 海报落款只有时间戳
    // ===== Drop 回放动图（idea #8）：常驻预录引擎（方案B：持续硬编码+GOP环形，快门秒出） =====
    const replayRecorder = new ReplayRecorder(canvas, { getMeta: () => currentPosterMeta() })
    replayCapture = (now) => replayRecorder.capture(now)
    // 闪白反馈：快门瞬间 0.85 白幕，400ms 渐隐（惯例同既有 UI 过渡曲线）
    const flashEl = document.createElement('div')
    flashEl.style.cssText = `position: fixed; inset: 0; background: #fff; opacity: 0;
      pointer-events: none; z-index: 9999; transition: opacity 400ms cubic-bezier(0.33, 1, 0.68, 1);`
    overlayDiv.appendChild(flashEl)
    const flash = (): void => {
      flashEl.style.transition = 'none'
      flashEl.style.opacity = '0.85'
      void flashEl.offsetHeight // 强制 reflow，让两次样式写入分属两帧
      flashEl.style.transition = 'opacity 400ms cubic-bezier(0.33, 1, 0.68, 1)'
      flashEl.style.opacity = '0'
    }
    // 保存成功轻提示（fb5）：居中、窗口上方靠下一点，点击→Finder 定位海报，5s 自动消失。
    // top 64px 避开顶部 28px 拖拽区（fb2 铁律：拖拽区内不许放可点元素）
    const savedToast = document.createElement('div')
    savedToast.style.cssText = `position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
      padding: 10px 20px; border-radius: 8px; background: rgba(20, 26, 36, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.08); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      color: rgba(255, 255, 255, 0.85); font: 300 13px -apple-system, "PingFang SC", sans-serif; letter-spacing: 0.04em;
      cursor: pointer; pointer-events: none; opacity: 0; filter: blur(6px); z-index: 9997; white-space: nowrap;
      transition: opacity 400ms cubic-bezier(0.33, 1, 0.68, 1), filter 400ms cubic-bezier(0.33, 1, 0.68, 1);`
    overlayDiv.appendChild(savedToast)
    let savedToastTimer: ReturnType<typeof setTimeout> | null = null
    let savedToastPath: string | null = null
    const hideSavedToast = (): void => {
      savedToast.style.opacity = '0'
      savedToast.style.filter = 'blur(6px)'
      savedToast.style.pointerEvents = 'none'
      if (savedToastTimer) { clearTimeout(savedToastTimer); savedToastTimer = null }
    }
    savedToast.addEventListener('click', () => {
      if (savedToastPath) window.audelyra.revealPoster(savedToastPath)
      hideSavedToast()
    })
    savedToast.addEventListener('mouseenter', () => { savedToast.style.color = 'rgba(255, 255, 255, 1)' })
    savedToast.addEventListener('mouseleave', () => { savedToast.style.color = 'rgba(255, 255, 255, 0.85)' })
    // 顶部轻提示通用化（更新体系 v1 复用）：path 非空=点击可 Finder 定位；null=纯信息（点击只收起）
    const showTopToast = (text: string, path: string | null): void => {
      savedToastPath = path
      savedToast.textContent = text
      savedToast.style.opacity = '1'
      savedToast.style.filter = 'blur(0)'
      savedToast.style.pointerEvents = 'auto'
      if (savedToastTimer) clearTimeout(savedToastTimer)
      savedToastTimer = setTimeout(hideSavedToast, 5000)
    }
    const showSavedToast = (path: string): void => showTopToast('已保存到「下载」文件夹 · 点击查看', path)

    // 轻提示（海报拍摄/保存失败、自定义形状创建失败/收藏已满共用；双审①P6：无提示会被当成拍成了——
    // 本来就是通用的顶部/底部轻提示，Task 7 起改名 showToast 反映其通用性）
    const failEl = document.createElement('div')
    failEl.style.cssText = `position: fixed; bottom: 72px; left: 50%; transform: translateX(-50%);
      color: rgba(255, 130, 130, 0.9); font: 13px -apple-system, "PingFang SC", sans-serif; opacity: 0;
      pointer-events: none; z-index: 9999; transition: opacity 300ms;`
    overlayDiv.appendChild(failEl)
    let failTimer: ReturnType<typeof setTimeout> | null = null
    const showToast = (text: string): void => {
      failEl.textContent = text
      failEl.style.opacity = '1'
      if (failTimer) clearTimeout(failTimer)
      failTimer = setTimeout(() => { failEl.style.opacity = '0' }, 2600)
    }
    // 本地播放期间系统媒体事件全部只缓存不转发(防歌词/角标张冠李戴);关闭本地播放时重放缓存恢复现场
    let lastSysTrack: SceneTrackEvent | null = null
    let lastSysProgress: ScenePlaybackProgress | null = null
    let lastSysLyrics: SceneLyricsDoc | null = null
    window.audelyra.onTrack((t) => {
      lastSysTrack = t as SceneTrackEvent
      // unknown 不清空（fb3：歌名没显示）：媒体会话闪断/切歌间隙常发 unknown，保留上一首已知曲目做落款——
      // 画面大概率就是它的；真错了预览模态可弃兜底
      if (t.kind === 'change' && !localActive) posterMeta = { title: t.title, artist: t.artist }
      if (localActive) return
      host.notifyTrack(t as SceneTrackEvent)
      badge.setTrack(t as SceneTrackEvent)
    })
    window.audelyra.onProgress((p) => { lastSysProgress = p; if (!localActive) host.notifyProgress(p) })
    window.audelyra.onLyrics((d) => { lastSysLyrics = d; if (!localActive) host.notifyLyrics(d) })

    // ===== 更新体系 v1（发布准备②）：轻提示卡/强更阻断层 + 手动检查回音 =====
    // 订阅须先于 rendererReady 报到（同歌词冷启动纪律）：reload 后主进程补发未结算决策不能落空。
    // 但 modalCount 版 setModal 定义在装配后段——前向引用（主进程 manualUpdateCheck 同款手法），
    // 直连 setModalOpen 会绕过计数仲裁：后续面板开合归零就把强更的模态位覆盖掉（审修 I2）。
    // 占位兜底直写布尔：只在 forced 早于 modalCount 赋值到达的极窄窗口生效，聊胜于丢
    let updateSetModal: (open: boolean) => void = (open) => window.audelyra.setModalOpen(open)
    const updateNotice = new UpdateNotice(overlayDiv, {
      openDownload: (url) => window.audelyra.openUpdateDownload(url),
      skip: (version) => window.audelyra.skipUpdate(version),
      showMessage: (text) => showTopToast(text, null),
      setModal: (open) => updateSetModal(open)
    })
    window.audelyra.onUpdateStatus((d) => updateNotice.handleStatus(d as UpdateStatusMsg))

    // 报到必须在三订阅挂完之后（#歌词冷启动）：主进程收到才补发缓存的 track/lyrics/progress，
    // 根治 did-finish-load 与订阅注册之间的空窗（boot 内 await 越多空窗越大，dev 动态 import 尤甚）
    window.audelyra.rendererReady()

    // ===== 本地音频播放（V2：会话队列+标签歌词；V1 管道 <audio>→worklet→engine 原样复用）=====
    const queue = new LocalQueue()
    let failStreak = 0 // 连败计数：连续失败盖过队列长度即整体停止，防坏文件队列循环空转
    const refreshQueueUi = (): void => {
      playerBar.setQueue(queue.tracks.map((x) => ({
        id: x.id,
        title: x.tag.kind === 'tagged' ? x.tag.title : x.displayName,
        artist: x.tag.kind === 'tagged' ? x.tag.artist : null,
        active: x.id === queue.current?.id
      })))
    }
    const playerBar = new PlayerBar(overlayDiv, {
      onToggle: () => localPlayer.toggle(),
      onSeek: (sec) => localPlayer.seek(sec),
      onClose: () => stopLocalPlayback(),
      onPrev: () => { const t = queue.prev(); if (t) void playTrack(t) },
      onNext: () => { const t = queue.next(); if (t) void playTrack(t) },
      onLoopToggle: () => { queue.setLoop(!queue.loop); playerBar.setLoop(queue.loop) },
      onQueueSelect: (id) => { const t = queue.jumpTo(id); if (t) void playTrack(t) },
      onQueueRemove: (id) => {
        const r = queue.remove(id)
        refreshQueueUi()
        if (!r.removedCurrent) return
        if (r.next) void playTrack(r.next) // 删当前→接班者顶上
        else stopLocalPlayback() // 删到空=等同关闭
      }
    })
    const localPlayer = new LocalPlayer({
      // trace 回放活跃时本地 PCM 也让位,防双信号灌引擎(同 updateLiveMute 的 replayActive||localActive 口径)
      onPcm: (f) => { if (localActive && !replayActive && !demoActive) engine.ingest(f) }, // demo 同回放让位（纵深，引导期拖放已挂起）
      onTime: (cur, dur) => {
        playerBar.setTime(cur, dur)
        // 本地进度喂场景做歌词时钟(系统 progress 在 localActive 期间被拦,见上方缓存逻辑)
        if (localActive) host.notifyProgress({ elapsedTime: cur, duration: dur > 0 ? dur : null, playbackRate: 1, playing: localPlayer.playing })
      },
      onPlayState: (playing) => {
        playerBar.setPlaying(playing)
        if (localActive) window.audelyra.localProgress(playing) // 聆听钟暂停/恢复
      },
      onEnded: () => {
        const nxt = queue.advance()
        if (nxt) void playTrack(nxt)
        else stopLocalPlayback() // 队列播完(循环关):恢复监听模式(V2 spec 改掉 V1 的停驻行为)
      },
      onError: (err) => {
        // 过期错误事件抑制:load 换源会重置 audio.error——err 为空说明错误属于已被换掉的上一首,
        // 真实解码失败时 error 事件必带非空 MediaError(规格保证),不会误吞
        if (!err) return
        // AbortError 只来自换源/暂停打断 pending play(toggle 的 catch 路径),从不代表文件坏——不跳不提示
        if (err instanceof DOMException && err.name === 'AbortError') return
        const cur = queue.current
        if (cur) skipCurrent(cur.id)
        else stopLocalPlayback()
      }
    })
    /** 失败跳过（load reject 与 <audio> error 事件可能双报同一首:按 id 判重,第一跳生效后第二报落空） */
    const skipCurrent = (id: number): void => {
      if (queue.current?.id !== id) return
      showToast('这个文件放不了，跳过它')
      failStreak++
      if (failStreak >= queue.size) { stopLocalPlayback(); return }
      const nxt = queue.advance()
      if (nxt) void playTrack(nxt)
      else stopLocalPlayback()
    }
    /** 标签态 → 全套呈现：控制条/场景 track/角标/海报落款/历史上报/查词。起播时与标签迟到时各调一次 */
    const applyTrackPresentation = (t: QueueTrack): void => {
      if (t.tag.kind === 'tagged') {
        const g = t.tag
        playerBar.setNowPlaying({ title: g.title, artist: g.artist, coverDataUrl: g.coverDataUrl })
        const ev = { kind: 'change' as const, title: g.title, artist: g.artist, artworkDataUrl: g.coverDataUrl }
        host.notifyTrack(ev)
        badge.setTrack(ev)
        posterMeta = { title: g.title, artist: g.artist }
        window.audelyra.localTrackChange({ title: g.title, artist: g.artist, duration: g.duration, coverBytes: g.coverBytes, coverMime: g.coverMime })
        void lookupLocalLyrics(t)
      } else {
        // 无标签(或还没解析完):文件名兜底,不进历史/星系;localTrackStop 顺手结算上一首的钟
        playerBar.setNowPlaying({ title: t.displayName, artist: null, coverDataUrl: null })
        host.notifyTrack({ kind: 'unknown' })
        badge.setTrack({ kind: 'unknown' })
        posterMeta = { title: t.displayName, artist: '' }
        window.audelyra.localTrackStop()
      }
    }
    const lookupLocalLyrics = async (t: QueueTrack): Promise<void> => {
      if (t.tag.kind !== 'tagged') return
      const key = `${t.tag.title}\0${t.tag.artist}`
      const lines = await window.audelyra.lookupLyrics(t.tag.title, t.tag.artist, t.tag.duration)
      if (!localActive || queue.current?.id !== t.id) return // 已切歌/已退出,过期结果丢弃
      host.notifyLyrics(lines ? { key, lines } : { key, none: true })
    }
    const playTrack = async (t: QueueTrack): Promise<void> => {
      try {
        await localPlayer.load(t.file)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return // 被新一轮 load/暂停打断的良性中断,非解码失败
        console.warn('[local-audio] 播放失败', err)
        skipCurrent(t.id)
        return
      }
      failStreak = 0
      localActive = true
      updateLiveMute()
      window.audelyra.localProgress(true) // load 成功即在播:首帧 play 事件早于 localActive 置位,聆听钟起表不能靠残留的 playing 兜底
      playerBar.show(t.displayName)
      playerBar.setLoop(queue.loop)
      refreshQueueUi()
      applyTrackPresentation(t)
    }
    // 标签解析链:单并发逐首后台解析,不阻塞播放;解析到当前首时就地刷新呈现
    let parsingTags = false
    const nextPendingTag = (): QueueTrack | null => queue.tracks.find((x) => x.tag.kind === 'pending') ?? null
    const parseTagsChain = async (): Promise<void> => {
      if (parsingTags) return
      parsingTags = true
      try {
        for (let t = nextPendingTag(); t; t = nextPendingTag()) {
          const tags = await readTags(t.file)
          queue.setTag(t.id, tags ? { kind: 'tagged', ...tags } : { kind: 'none' })
          refreshQueueUi()
          if (localActive && queue.current?.id === t.id) applyTrackPresentation(t)
        }
      } finally {
        parsingTags = false
      }
    }
    const enqueueLocal = (files: File[]): void => {
      const audio = files.filter((f) => isSupportedAudio(f.name, f.type))
      if (audio.length === 0) return
      queue.add(audio)
      refreshQueueUi()
      void parseTagsChain()
      if (!localActive) { const cur = queue.current; if (cur) void playTrack(cur) }
    }
    const stopLocalPlayback = (): void => {
      localPlayer.stop()
      window.audelyra.localTrackStop() // 结算聆听钟(不足 30s 自然丢弃)
      queue.clear()
      failStreak = 0
      refreshQueueUi()
      localActive = false
      updateLiveMute()
      playerBar.hide()
      // 重放缓存恢复系统现场:track/进度/歌词全部补喂(期间系统可能已切歌,缓存是最新的)
      if (lastSysTrack) {
        host.notifyTrack(lastSysTrack)
        badge.setTrack(lastSysTrack)
        if (lastSysTrack.kind === 'change') posterMeta = { title: lastSysTrack.title, artist: lastSysTrack.artist }
      }
      if (lastSysProgress) host.notifyProgress(lastSysProgress)
      if (lastSysLyrics) host.notifyLyrics(lastSysLyrics)
    }
    // 隐藏文件选择框:操作坞图标触发;accept 双保险(MIME + 扩展名);V2 起可多选
    const audioInput = document.createElement('input')
    audioInput.type = 'file'
    audioInput.multiple = true
    audioInput.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus'
    audioInput.style.display = 'none'
    overlayDiv.appendChild(audioInput)
    audioInput.addEventListener('change', () => {
      const files = Array.from(audioInput.files ?? [])
      audioInput.value = '' // 清掉记录,同一批文件连选两次也触发 change
      if (files.length > 0) enqueueLocal(files)
    })

    // 面板退台舞台：uiStage 驱动场景退台（相机后拉/CoC 退焦/调光，画风按 profile 分级）；
    // 面板开合/互斥/退台路由统一经 PanelCoordinator 仲裁（Phase A2 T2）
    const uiStage = new UiStage((v, profile) => host.setUiFocus(v, profile))

    // 模态计数：面板与引导可叠开（uiStage 同款语义），主进程只认布尔——归零才解除
    let modalCount = 0
    const setModal = (open: boolean): void => {
      modalCount = Math.max(0, modalCount + (open ? 1 : -1))
      window.audelyra.setModalOpen(modalCount > 0)
    }
    updateSetModal = setModal // 前向引用接真值（审修 I2）：强更阻断从此走计数仲裁，不再被面板开合覆盖

    const coordinator = new PanelCoordinator({ uiStage, setModal })

    const panel = new SettingsPanel(overlayDiv, {
      getSettings: () => window.audelyra.getSettings(),
      setSettings: (p) => window.audelyra.setSettings(p),
      onSettingsChanged: (cb) => window.audelyra.onSettingsChanged(cb),
      getVersion: () => window.audelyra.getAppVersion(),
      onCheckUpdate: () => window.audelyra.checkUpdate(),
      // 导出诊断（发布准备③）：回执带路径→顶部轻提示可点击 Finder 定位（复用海报落盘同款回音）
      onExportDiagnostics: () => {
        void window.audelyra.exportDiagnostics()
          .then((r) => showTopToast('诊断报告已保存到「下载」文件夹 · 点击查看', r.path))
          .catch(() => showToast('诊断报告导出失败'))
      }
    })
    coordinator.register(panel, 'full')
    window.audelyra.onOpenSettingsRequest(() => panel.toggle())

    // 调音台：右侧竖向停靠栏，专业槽位层（Slice ① 收官）。收敛到 BasePanel 后与设置面板同经
    // 协调器仲裁——保持互斥，退台 profile='camera'（仅镜头后拉，不像设置那样接管整场景，
    // 粒子云仍占主画面，见 tuning-panel.ts 顶部注释）
    const tuningPanel = new TuningPanel(overlayDiv, {
      getMapping: async () => (await window.audelyra.getSettings()).mapping,
      previewMapping: (m) => window.audelyra.previewMapping(m),
      commitMapping: (m) => window.audelyra.commitMapping(m),
      getMacroKnobs: async () => (await window.audelyra.getSettings()).macroKnobs,
      commitMacroKnobs: (k) => window.audelyra.setSettings({ macroKnobs: k }),
      getAdvancedExpanded: async () => (await window.audelyra.getSettings()).tuningAdvancedExpanded,
      commitAdvancedExpanded: (v) => window.audelyra.setSettings({ tuningAdvancedExpanded: v }),
      getShape: async () => (await window.audelyra.getSettings()).shape,
      setShape: (s) => window.audelyra.setSettings({ shape: s }),
      onShapeChanged: (cb) => window.audelyra.onSettingsChanged((s) => cb(s.shape)),
      getMotion: async () => (await window.audelyra.getSettings()).motion,
      previewMotion: (m) => window.audelyra.previewMotion(m),
      commitMotion: (m) => window.audelyra.commitMotion(m),
      getCamera: async () => (await window.audelyra.getSettings()).camera,
      previewCamera: (c) => window.audelyra.previewCamera(c),
      commitCamera: (c) => window.audelyra.commitCamera(c),
      // 歌词歌名 tab（批2）：preview 直调 host（拖动实时、不落盘），commit 走 setSettings 落盘；
      // 落盘回流订阅会再 apply 一次同值，幂等无害
      getTitleFx: async () => (await window.audelyra.getSettings()).title,
      previewTitleFx: (t) => host.applyTitle(t),
      commitTitleFx: (t) => window.audelyra.setSettings({ title: t }),
      getLyricsFx: async () => (await window.audelyra.getSettings()).lyrics,
      previewLyricsFx: (s) => host.applyLyrics(s),
      commitLyricsFx: (s) => window.audelyra.setSettings({ lyrics: s }),
      // 背景 tab（虚空之镜）：preview 直调 host（拖动实时、不落盘），commit 走 setSettings 落盘；同 lyrics 语义
      getBackgroundFx: async () => (await window.audelyra.getSettings()).background,
      previewBackgroundFx: (b) => host.applyBackground(b),
      commitBackgroundFx: (b) => window.audelyra.setSettings({ background: b }),
      // 背景回流（自定义背景 v1）：shape-picker 也会改 background，draft 不吃回流会在下次 commit
      // 把过期 customBackgrounds/current 整包写回（静默撤销选择）
      onBackgroundChanged: (cb) => window.audelyra.onSettingsChanged((s) => cb(s.background)),
    })
    coordinator.register(tuningPanel, 'camera')

    // 自定义形状创建（idea #12 Task 7）：图片走 ingest 降采样+可用性校验，文字直接落盘设置——
    // 两条路径共用「收藏已满」与「保存/生成失败」的轻提示出口
    const currentShape = async (): Promise<ShapeSettings> => (await window.audelyra.getSettings()).shape

    const createShapeFromImage = async (file: File): Promise<void> => {
      if (!isSupportedImage(file.name, file.type)) { showToast(ingestErrorText('unsupported')); return }
      let shape = await currentShape()
      if (shape.customShapes.length >= CUSTOM_SHAPES_MAX) { showToast('收藏已满，先删一个'); return } // 早退快检：省去已满时的解码/sips 开销
      try {
        const { imageData, png } = await decodeImageFile(file, (b) => window.audelyra.convertImageToPng(b))
        const usable = checkImageUsable(imageData)
        if (usable !== 'ok') { showToast(ingestErrorText(usable)); return }
        const id = crypto.randomUUID()
        await window.audelyra.saveCustomShape(id, new Uint8Array(await png.arrayBuffer())) // 先文件后设置：设置是权威，文件缺失可兜底，反之是孤儿元数据
        // decode/sips 可达数秒：落盘成功后重取快照再拼 setSettings，防窗口期内用户删卡/拨开关/并发创建
        // 被整段覆盖回滚（终审 Finding 2）——上面的早退快检基于旧快照，这里才是权威判定
        shape = await currentShape()
        if (shape.customShapes.length >= CUSTOM_SHAPES_MAX) { showToast('收藏已满，先删一个'); return }
        window.audelyra.setSettings({ shape: { ...shape, customShapes: [...shape.customShapes, { id, kind: 'image' }], customCurrent: id } })
      } catch (err) {
        console.warn('[main] 自定义形状创建失败', err)
        showToast(ingestErrorText('failed'))
      }
    }

    const createShapeFromText = async (text: string): Promise<void> => {
      const t = text.trim()
      if (t === '') return
      const id = crypto.randomUUID() // meta.id 与 customCurrent 必须同一个值（选中即新条目）
      const shape = await currentShape() // 落盘前才取快照（与 createShapeFromImage 统一口径，终审 Finding 2）；本路径无中间异步步骤，单次取值已是权威判定
      if (shape.customShapes.length >= CUSTOM_SHAPES_MAX) { showToast('收藏已满，先删一个'); return }
      window.audelyra.setSettings({ shape: { ...shape, customShapes: [...shape.customShapes, { id, kind: 'text', text: t }], customCurrent: id } })
    }

    // 背景创建（自定义背景 v1）：口径对齐 createShapeFromImage——早退快检省解码开销，
    // 落盘成功后重取快照再拼 setSettings（防窗口期并发覆盖，终审 Finding 2 同款纪律）
    const currentBackground = async (): Promise<BackgroundSettings> => (await window.audelyra.getSettings()).background
    // 卡片显示名（亲验反馈）：原文件名去扩展名；sanitize 侧截 80 字符兜底
    const bgDisplayName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')

    const createBackgroundFromImage = async (file: File): Promise<void> => {
      if (!isSupportedImage(file.name, file.type)) { showToast(ingestErrorText('unsupported')); return }
      let bg = await currentBackground()
      if (bg.customBackgrounds.length >= CUSTOM_BACKGROUNDS_MAX) { showToast('背景已满，先删一个'); return }
      try {
        const { jpeg } = await decodeBackgroundFile(file, (b) => window.audelyra.convertImageToPng(b))
        const id = crypto.randomUUID()
        await window.audelyra.saveCustomBackground(id, new Uint8Array(await jpeg.arrayBuffer())) // 先文件后设置：settings 是权威
        bg = await currentBackground()
        if (bg.customBackgrounds.length >= CUSTOM_BACKGROUNDS_MAX) { showToast('背景已满，先删一个'); return }
        window.audelyra.setSettings({ background: { ...bg, customBackgrounds: [...bg.customBackgrounds, { id, kind: 'image', name: bgDisplayName(file.name) }], current: id } })
      } catch (err) {
        console.warn('[main] 自定义背景创建失败', err)
        showToast('背景创建失败，换张图试试')
      }
    }

    // 视频背景创建（v2）：路径直拷（webUtils → 主进程 copyFile，500MB 不过 IPC 内存）；
    // 缩略图失败不阻断（卡片占位剪影兜底）；口径同 createBackgroundFromImage（快检早退/落盘后重取快照）
    const createBackgroundFromVideo = async (file: File): Promise<void> => {
      let bg = await currentBackground()
      if (bg.customBackgrounds.length >= CUSTOM_BACKGROUNDS_MAX) { showToast('背景已满，先删一个'); return }
      if (file.size > BACKGROUND_VIDEO_MAX_BYTES) { showToast('视频太大（≤500MB）'); return }
      try {
        const path = window.audelyra.getPathForFile(file)
        const id = crypto.randomUUID()
        await window.audelyra.saveCustomBackgroundVideo(id, path) // 先文件后设置：settings 是权威
        try {
          const url = URL.createObjectURL(file)
          try {
            const { jpeg } = await captureVideoThumb(url)
            await window.audelyra.saveCustomBackgroundThumb(id, new Uint8Array(await jpeg.arrayBuffer()))
          } finally { URL.revokeObjectURL(url) }
        } catch { /* 缩略图缺失=卡片占位兜底，不阻断入库 */ }
        bg = await currentBackground()
        if (bg.customBackgrounds.length >= CUSTOM_BACKGROUNDS_MAX) {
          showToast('背景已满，先删一个')
          void window.audelyra.deleteCustomBackground(id) // 已落盘的 500MB 视频没写进设置就成孤儿，幂等删除闭环
          return
        }
        window.audelyra.setSettings({ background: { ...bg, customBackgrounds: [...bg.customBackgrounds, { id, kind: 'video', name: bgDisplayName(file.name) }], current: id } })
      } catch (err) {
        console.warn('[main] 视频背景创建失败', err)
        showToast('视频背景创建失败，换个文件试试')
      }
    }

    // 创建面板 + 全窗口拖放（idea #12 Task 7）：面板开着时全窗口拖放挂起，避免双热区抢 drop
    // （置于 ShapePicker 建造之前——其 deps 的 onCreateRequest 要引用 shapeCreate）
    const shapeCreate = new ShapeCreatePanel(overlayDiv, {
      onSubmitImage: (f) => { void createShapeFromImage(f) },
      onSubmitText: (t) => { void createShapeFromText(t) },
      setModalOpen: setModal,
    })
    // 引导幕开着时新快捷键/拖放静默——声明提前到 DropOverlay 之前（审① P1-1：isSuspended 闭包引用，防 TDZ）
    let onboardingOpen = false
    // 拖放用途选择条（自定义背景 v1）：拖图松手后问「拼成图形 / 铺成背景」；开着时全窗口拖放挂起
    const dropChoice = new DropChoice(overlayDiv, {
      onShape: (f) => { void createShapeFromImage(f) },
      onBackground: (f) => { void (isSupportedVideo(f.name, f.type) ? createBackgroundFromVideo(f) : createBackgroundFromImage(f)) },
      setModalOpen: setModal,
    })
    const dropOverlay = new DropOverlay(overlayDiv, {
      // 音频全部入队,其余第一个走自定义形状(混合拖入两者都成立,互不冲突)
      onDropFiles: (files) => {
        enqueueLocal(files) // 内部自滤音频,无音频时静默
        const other = files.find((f) => !isSupportedAudio(f.name, f.type))
        if (!other) return
        if (isSupportedImage(other.name, other.type)) { dropChoice.ask(other); return }
        if (isSupportedVideo(other.name, other.type)) { dropChoice.ask(other, { backgroundOnly: true }); return } // 视频只能铺背景（spec §二）
        showToast(ingestErrorText('unsupported'))
      },
      // 引导期挂起（审① P1-1）：listening 幕文案诱导放歌，拖入本地会与序幕 demo 双信号灌 bus，
      // 且探针听不到本地播放（只看系统 tap 帧）会误判 denied——引导期统一走系统播放器
      isSuspended: () => shapeCreate.isOpen || dropChoice.isOpen || onboardingOpen,
    })

    // ===== 星系图鉴（idea #4）：数据管线 + 双入口 + 筛选/胶囊 + 状态单向流 =====
    setGalaxyArtworkFetcher((key) => window.audelyra.readHistoryArtwork(key))
    const galaxyBar = new GalaxyBar(overlayDiv, { onFilterChange: (f) => { setGalaxyFilter(f) } })
    const galaxyCard = new GalaxyCard(overlayDiv, {
      onPickDay: (date) => setGalaxyFilter({ kind: 'day', date }),
      onClose: () => { galaxySelected = null; galaxyCard.hide(); pushGalaxy() },
    })
    const galaxyTooltip = new GalaxyTooltip(overlayDiv)
    let galaxyOn = false
    let galaxyAuto = false // 空闲自动进入的（音乐一来自动退）；手动进入不受影响
    let shapePickerOpen = false // suppression 汇流用（评审 P1-5）：ShapePicker deps 稍后赋值
    let galaxyRecords: GalaxyPlayRecord[] = []
    let galaxyStars: GalaxyStar[] = []
    let galaxyFilter: GalaxyFilter = { kind: 'all' }
    let galaxyFilterView: GalaxyFilterView | null = null // 记忆化（评审 P1-3）：仅 filter/records 变化重建——点星不再整包重烘焙
    let galaxySelected: string | null = null
    const tintCache = new Map<string, [number, number, number] | null>() // artworkKey → 主色（跨进出复用）
    const todayStr = (): string => localDateOf(new Date().toISOString())

    // 角标压制（评审 P1-5）：galaxy 与 ShapePicker 共用布尔 setSuppressed，
    // 各自直写会互踩（galaxy 期开关 picker 把压制解掉）——统一求或后写入
    const updateSuppressed = (): void => {
      const s = galaxyOn || shapePickerOpen
      badge.setSuppressed(s)
    }

    const pushGalaxy = (): void => {
      host.applyGalaxy({
        active: galaxyOn, stars: galaxyStars, filterView: galaxyFilterView, selectedKey: galaxySelected,
        onPick: (key) => {
          if (!galaxyOn) return // restore溶解期(~1s)拾取仍活着:退出瞬间点星不得在live画面上弹卡(终审I2)
          galaxySelected = key
          const star = key ? galaxyStars.find((s) => s.key === key) ?? null : null
          if (star) galaxyCard.show(star)
          else galaxyCard.hide()
          pushGalaxy()
        },
        onHover: (hit) => {
          // restore 溶解期拾取仍活着（同 onPick 终审I2 守卫）：退出瞬间不在 live 画面上挂悬浮条
          const star = hit && galaxyOn ? galaxyStars.find((s) => s.key === hit.key) ?? null : null
          if (star && hit) galaxyTooltip.show(star.key, star.title, star.artist, star.playCount, hit.x, hit.y)
          else galaxyTooltip.hide()
        },
      })
    }
    const setGalaxyFilter = (f: GalaxyFilter): void => {
      galaxyFilter = f
      galaxyFilterView = buildFilterView(galaxyRecords, galaxyFilter, todayStr())
      galaxyBar.setFilter(f)
      pushGalaxy()
    }

    const galaxyTint = async (artworkKey: string): Promise<[number, number, number] | null> => {
      if (tintCache.has(artworkKey)) return tintCache.get(artworkKey)!
      let tint: [number, number, number] | null = null
      try {
        const bytes = await window.audelyra.readHistoryArtwork(artworkKey)
        if (bytes) {
          // 同 covers.ts decodeBitmap 已知 TS 泛型冲突（Uint8Array<ArrayBufferLike> 不满足 BlobPart）：
          // 显式裁剪出精确字节范围再断言 ArrayBuffer，本项目从不跨 Worker 传 SharedArrayBuffer，安全
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const bmp = await createImageBitmap(new Blob([buf]))
          const cv = document.createElement('canvas')
          cv.width = 4; cv.height = 4
          const c2d = cv.getContext('2d')!
          c2d.drawImage(bmp, 0, 0, 4, 4)
          tint = dominantTint(c2d.getImageData(0, 0, 4, 4))
          bmp.close()
        }
      } catch { /* 封面坏/缺 → 默认星色 */ }
      tintCache.set(artworkKey, tint)
      return tint
    }

    // 主色异步回填（评审 P1-4，守 spec §10「先进场景，星到齐逐颗亮」）：不阻塞入场——
    // 先用默认星色变身，主色到货后换新 stars 引用再推一次（setView 重烘焙上色 = 低配版逐颗点亮）
    const backfillTints = async (): Promise<void> => {
      const snapshot = galaxyStars
      const pending = snapshot.filter((s) => s.artworkKey && !tintCache.has(s.artworkKey))
      for (let i = 0; i < pending.length; i += 8) { // 并发限流 8：几百星不挤爆 IPC/解码
        await Promise.all(pending.slice(i, i + 8).map((s) => galaxyTint(s.artworkKey!)))
      }
      if (!galaxyOn || galaxyStars !== snapshot) return // 期间退出/重进：作废
      galaxyStars = snapshot.map((s) => (s.artworkKey ? { ...s, tint: tintCache.get(s.artworkKey) ?? null } : s))
      pushGalaxy()
    }

    const enterGalaxy = async (auto: boolean): Promise<void> => {
      if (galaxyOn) return
      galaxyOn = true
      galaxyAuto = auto
      galaxyFilter = { kind: 'all' }
      galaxyFilterView = null
      galaxySelected = null
      nonSilentSince = null
      setModal(true) // 评审 P1-2：参与模态仲裁——主进程 Esc 不再抢跑（全屏下退星系不连退全屏）
      try {
        galaxyRecords = await window.audelyra.readHistory()
      } catch (err) {
        console.warn('[galaxy] 历史读取失败，按空宇宙处理', err)
        galaxyRecords = []
      }
      if (!galaxyOn) return // 读盘间隙被退出（快速连点）：不再推视图
      galaxyStars = aggregateStars(galaxyRecords).map((s) =>
        s.artworkKey && tintCache.has(s.artworkKey) ? { ...s, tint: tintCache.get(s.artworkKey)! } : s) // 二次进入直接命中缓存
      galaxyBar.show(galaxyStars.length)
      galaxyBar.setFilter(galaxyFilter)
      const ann = anniversaryFor(galaxyRecords, new Date())
      galaxyBar.showAnniversary(ann ? {
        label: ann.label, title: ann.title,
        onClick: () => setGalaxyFilter({ kind: 'day', date: ann.date }),
      } : null)
      updateSuppressed() // 星系是前台主角：角标/全屏提示让位（惯例同 shape-picker，经汇流）
      pushGalaxy() // 立即变身：星先用默认色/已缓存主色
      void backfillTints()
    }
    const exitGalaxy = (): void => {
      if (!galaxyOn) return
      galaxyOn = false
      galaxyAuto = false
      galaxySelected = null
      lastAudioTs = performance.now() // 手动退出重开一轮完整空闲窗（根因:不重置则250ms内idle-tick把用户塞回星系,永卡）
      setModal(false)
      galaxyCard.hide()
      galaxyTooltip.hide()
      galaxyBar.hide()
      updateSuppressed()
      pushGalaxy()
    }

    // 空闲自动进出（spec §三，计划级修订：信号源从 progress 事件改为引擎 silence——系统播放/本地播放/
    // 回放全走 engine，一个信号覆盖所有源。注意 silence 的真实机制：无 PCM 时 bus 冻结不再回调，
    // lastAudioTs 停走即自然累计空闲，正合语义）
    const IDLE_ENTER_MS = 120_000
    const AUTO_EXIT_AFTER_MS = 1500 // 评审 P2：非静默需持续 1.5s 才自动退——系统通知"叮"一声不打断星系
    let lastAudioTs = performance.now() // 启动即给满宽限
    let nonSilentSince: number | null = null
    engine.bus.subscribe((s) => {
      if (!s.silence) {
        const nowTs = performance.now()
        if (nowTs - lastAudioTs > 1000) nonSilentSince = null // 总线冻结断流后重新发声=新一轮计时:防第二声通知击穿1.5s防抖(终审I3)
        lastAudioTs = nowTs
        if (galaxyOn && galaxyAuto) {
          if (nonSilentSince === null) nonSilentSince = performance.now()
          else if (performance.now() - nonSilentSince > AUTO_EXIT_AFTER_MS) exitGalaxy() // 音乐真回来了：自动进的自动退
        }
      } else {
        nonSilentSince = null
      }
    })
    // Esc 退出（手动/自动通用）。不设 modalCount 门（fb1:计数耦合脆弱,曾致 Esc 失效）——所有面板/卡片
    // 开着时各自 capture+stopPropagation 先吃掉 Esc,本 bubble 兜底天然被屏蔽;主进程仲裁仍靠 uiModalOpen(galaxy 在场恒 true)
    const onGalaxyEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && galaxyOn) exitGalaxy()
    }
    document.addEventListener('keydown', onGalaxyEsc)
    let idleHintPermission = false // 权限指引在场时星系不空闲劫持（发布准备③）：真身在 idle-hint 接线段随采样更新
    galaxyIdleTick = () => {
      // !localActive：spec §3.2 拍板「本地播放不算空闲」——本地暂停接电话回来不该发现自己进了星系（评审 P1-6）
      if (!galaxyOn && modalCount === 0 && !localActive && !shapePickerOpen && !idleHintPermission && performance.now() - lastAudioTs > IDLE_ENTER_MS) { // 选择器开着=用户正在交互,不劫持进星系(探针实锤picker不计modalCount)
        void enterGalaxy(true)
      }
    }

    // 星系落款（spec §九）：大标题=视图名，meta 行=「N 颗星 · 日期」（composePoster 原样复用）
    const galaxyPosterMeta = (): PosterMeta => {
      const n = galaxyFilterView ? galaxyFilterView.activeKeys.length : galaxyStars.length
      const title = galaxyFilter.kind === 'all' ? '我的星系'
        : galaxyFilter.kind === 'range' ? `最近 ${galaxyFilter.days} 天` : galaxyFilter.date
      return { title, artist: `${n} 颗星` }
    }
    const currentPosterMeta = (): PosterMeta | null => (galaxyOn ? galaxyPosterMeta() : posterMeta)

    // 背景"+"卡 → 系统文件选择框（意图明确不再问用途，spec §二）；value 复位允许连选同一文件
    // 隐藏文件选择框：惯例同 audioInput（495 行）——挂 overlayDiv 隐藏，图鉴按钮触发 click()
    const bgFileInput = document.createElement('input')
    bgFileInput.type = 'file'
    bgFileInput.accept = 'image/*,.heic,.heif,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm'
    bgFileInput.style.display = 'none'
    overlayDiv.appendChild(bgFileInput)
    bgFileInput.addEventListener('change', () => {
      const f = bgFileInput.files?.[0]
      if (f) void (isSupportedVideo(f.name, f.type) ? createBackgroundFromVideo(f) : createBackgroundFromImage(f))
      bgFileInput.value = ''
    })

    // 形状选择器（Phase B2）：底部卡片层，camera 退台 + 与设置/调音台互斥（PanelLike 结构注册）
    const shapePicker = new ShapePicker(overlayDiv, {
      getShape: async () => (await window.audelyra.getSettings()).shape,
      setShape: (s) => window.audelyra.setSettings({ shape: s }),
      onShapeChanged: (cb) => window.audelyra.onSettingsChanged((s) => cb(s.shape)),
      onOpenStateChanged: (open) => {
        shapePickerOpen = open; updateSuppressed() // 选择器是前台主角：角标/全屏提示让位（B2 亲验反馈，重叠实锤）——
        // 与 galaxy 共用布尔汇流后经 updateSuppressed 统一写入（评审 P1-5，防两者直写互踩）
        playerBar.setSuppressed(open) // 同惯例：底部全宽卡片打开时会压在 PlayerBar 上，一并让位
        if (!open) lastAudioTs = performance.now() // 关闭=刚交互完,重开一轮空闲窗——否则空闲已超时会秒进星系（同 exitGalaxy 语义）
      },
      readCustomShapeImage: (id) => window.audelyra.readCustomShape(id),
      deleteCustomShapeFile: (id) => { void window.audelyra.deleteCustomShape(id) },
      onCreateRequest: () => shapeCreate.open(),
      showHint: showToast,
      // 背景 dep 全套接线（自定义背景 v1 Task 8）：三件必填镜像 getShape/setShape/onShapeChanged，
      // 三件可选补齐收藏卡的文件读写与「+」卡上传入口
      getBackground: async () => (await window.audelyra.getSettings()).background,
      setBackground: (b) => window.audelyra.setSettings({ background: b }),
      onBackgroundChanged: (cb) => window.audelyra.onSettingsChanged((s) => cb(s.background)),
      readCustomBackgroundImage: (id) => window.audelyra.readCustomBackground(id),
      readCustomBackgroundThumb: (id) => window.audelyra.readCustomBackgroundThumb(id),
      deleteCustomBackgroundFile: (id) => { void window.audelyra.deleteCustomBackground(id) },
      onBackgroundCreateRequest: () => { bgFileInput.click() },
      // 卡片编辑钮（v2 亲验反馈②）：picker 侧已先选中该卡，这里开调音台直落对应页（互斥退台归协调器）
      onEditRequest: (tab) => { tuningPanel.openToTab(tab) },
    })
    coordinator.register(shapePicker, 'camera')

    // 操作坞：界面内悬停显影的图标入口（形状/调音台/设置），依赖 panel.toggle / tuningPanel.toggle / shapePicker.toggle 故置于其后
    // 快门链路（fb1③：拍后先预览再定存/弃；模态语义 setModal+uiStage 退台，同 onboarding 先例）——
    // 置于 setModal/uiStage 之后、dock 之前：shutter 引用前两者，dock 引用 shutter
    const posterPreview = new MediaPreview(overlayDiv, { kind: 'image', saveLabel: '保存海报' })
    const replayPreview = new MediaPreview(overlayDiv, { kind: 'video', saveLabel: '保存视频' })
    let shutterBusy = false // 重入保护贯穿整个"拍→预览→裁决"流程：模态开着时连按快门/快捷键全部忽略
    const shutter = async (): Promise<void> => {
      if (shutterBusy) return
      shutterBusy = true
      try {
        const shot = await host.snapshot() // 所见即所得：画布当前呈现帧（fb1①②拍板）
        if (!shot) {
          // 场景未就绪/回读失败要有反馈（聚焦审#3：WebGL 回退后端 drawing buffer 不保留，快门会一直走到这——
          // 不提示就是"静默死功能"；M4 主力路径是 WebGPU，此路日常不触发）
          showToast('星图海报拍摄失败')
          return
        }
        flash() // 闪白=快门已按下（拍照心智）
        const now = new Date()
        const meta = currentPosterMeta()
        const blob = await composePoster(shot, meta, posterRibbon.values(), now)
        const filename = posterFilename(meta?.title ?? '', now)
        setModal(true)
        uiStage.push()
        let choice: 'save' | 'discard'
        try {
          choice = await posterPreview.show(blob)
        } finally {
          uiStage.pop()
          setModal(false)
        }
        if (choice === 'save') {
          const res = await window.audelyra.savePoster(filename, new Uint8Array(await blob.arrayBuffer()))
          showSavedToast(res.path) // fb5：成功反馈=应用内轻提示（可点击定位），系统通知已退役
        }
      } catch (err) {
        console.error('[poster] 快门失败', err)
        showToast('星图海报保存失败')
      } finally {
        shutterBusy = false
      }
    }
    const clipShutter = async (): Promise<void> => {
      if (shutterBusy) return
      shutterBusy = true
      try {
        const clip = await replayRecorder.takeClip()
        if (!clip) {
          // 攒不够(<1s)/引擎未就绪 与 本机不支持 分开说话（spec 修订②：不可用降级=点击出提示）
          showToast(replayRecorder.available ? '画面还没攒够，再等等' : '这台设备不支持视频录制')
          return
        }
        flash() // 快门已按下（拍照心智，同海报）
        const filename = replayFilename(currentPosterMeta()?.title ?? '', new Date())
        setModal(true)
        uiStage.push()
        let choice: MediaChoice
        try {
          choice = await replayPreview.show(clip.blob)
        } finally {
          uiStage.pop()
          setModal(false)
        }
        if (choice === 'save') {
          const res = await window.audelyra.saveClip(filename, new Uint8Array(await clip.blob.arrayBuffer()))
          showSavedToast(res.path) // 轻提示点击→Finder 定位，revealPoster 通道复用
        }
      } catch (err) {
        console.error('[replay] Drop 快门失败', err)
        showToast('Drop 视频保存失败')
      } finally {
        shutterBusy = false
      }
    }
    // 引导幕开着时新快捷键静默（⌘⇧S/⌘⇧T 会开面板压引导，⌘⇧P/⌘⇧R 维持既有不拦——shutterBusy 自保护）；
    // onboardingOpen 声明已提前到 DropOverlay 装配点（审① P1-1）
    // 快捷键 ⌘⇧P/R/S/T（主进程 before-input-event 只拦 Esc/⌃⌘F/⌘,，无冲突；渲染层 keydown 惯例同 shape-picker）
    document.addEventListener('keydown', (e) => {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey)) return
      if (e.code === 'KeyP') {
        e.preventDefault()
        void shutter()
      }
      // ⌘⇧R（idea #8）
      if (e.code === 'KeyR') {
        e.preventDefault()
        void clipShutter()
      }
      // ⌘⇧S/⌘⇧T（主界面布局重组）：与点击操作坞图标同一 toggle 路径，天然继承面板互斥/退台仲裁
      if (e.code === 'KeyS' && !onboardingOpen) {
        e.preventDefault()
        shapePicker.toggle()
      }
      if (e.code === 'KeyT' && !onboardingOpen) {
        e.preventDefault()
        tuningPanel.toggle()
      }
    })

    const dock = new ControlDock(overlayDiv, {
      toggleTuning: () => tuningPanel.toggle(),
      toggleShapes: () => shapePicker.toggle(),
      snapPoster: () => void shutter(),
      snapClip: () => void clipShutter(),
      openLocalFile: () => audioInput.click()
    })
    // 操作坞容器登记为「点外部关」的忽略区——点图标本身不该被面板的 pointerdown 当成点外部
    // 先行 close，避免图标自身的 click→toggle() 因面板已被抢先关闭而重开（Task A-toggle-fix）
    // 右上模式/系统角：全屏（迁自 FullscreenButton）+ 星系图鉴/设置（迁自操作坞）——
    // 「改变整个界面状态」的入口归右上（主界面布局重组）；设置就近右上面板弹出位
    const corner = new CornerCluster(overlayDiv, {
      setWindowMode: (m) => window.audelyra.setWindowMode(m),
      toggleSettings: () => panel.toggle(),
      toggleGalaxy: () => { if (galaxyOn) exitGalaxy(); else void enterGalaxy(false) }
    })
    coordinator.setTriggerContainers([dock.element, corner.element])

    // 顶部拖拽条：普通窗用 OS 原生 app-region 移窗（两态模型拍板 2026-07-06，取代已退役的小窗拖拽泵）
    const dragStrip = new DragStrip(overlayDiv)

    // 窗口态统一接线：拖拽条显隐（两态下运镜恒开，不再需要 host.setInteractive 门控）
    const applyWindowMode = (m: RendererWindowMode): void => {
      dock.setMode(m)
      corner.setMode(m)
      dragStrip.setMode(m)
    }
    window.audelyra.onWindowMode(applyWindowMode)
    void window.audelyra.getWindowMode().then(applyWindowMode)

    // 档位：'auto' 交给 nebula 自选（forcedTier 缺省），手动档位直接强制
    const initial = await window.audelyra.getSettings()
    let appliedTier: RendererSettings['tier'] = initial.tier
    const forced = (t: RendererSettings['tier']): QualityTier | undefined =>
      t === 'auto' ? undefined : TIERS[t]
    await host.start('nebula', TIERS.high, forced(appliedTier))
    markSceneInitDone = performance.now() // 启动里程碑（性能基线）：场景初始化完成

    // 性能基线：#perf 入口挂 HUD 与基准面板，1Hz 刷新（分位数排序绝不进渲染帧）
    if (isPerf) {
      const [{ perf }, { PerfHud }, { BenchPanel }, { BenchHost }, { SUITE }, { TracePlayer }, { formatSummary }, { nebulaGpuUnavailableReason }] =
        await Promise.all([
          import('./perf/collector'), import('./ui/debug/perf-hud'), import('./ui/debug/bench-panel'),
          import('./perf/bench-host'), import('./perf/bench-runner'), import('./engine/trace'),
          import('./perf/report'), import('./scenes/nebula'),
        ])
      const env = await window.audelyra.perfGetEnv()
      const displayHz = env?.displayHz ?? 60
      perf.setMode('hud', { displayHz })
      const hud = new PerfHud(overlayDiv)
      const benchQuality = TIERS.ultra // bench 锁 ultra：档位浮动会让样本混合两种配置
      // HUD 档位读 perf.activeTier（场景 init 回填的实际生效档位真源）——hud 档下场景可能不是 ultra，
      // 不能拿 benchQuality 硬顶；bench 跑起来后锁 ultra，activeTier 也会是 ultra，天然一致
      const hudInterval = setInterval(() => {
        const g = perf.gpu.summarize(perf.frameStats.count)
        const t = perf.activeTier
        hud.update(perf.frameStats.summarize(), {
          targetIntervalMs: perf.targetIntervalMs,
          tier: t?.name ?? '未知', particles: t?.particles ?? 0,
          gpuAvgMs: g?.batchAvgMs.p50 ?? null,
        })
      }, 1000)
      window.addEventListener('beforeunload', () => clearInterval(hudInterval))

      // 输入源：trace 走 bus 直灌（视觉基准）；pcm 走 engine.ingest（引擎基准，唯一能测 engine 延迟的路径）
      let tracePlayer: InstanceType<typeof TracePlayer> | null = null
      let traceRaf = 0
      let traceSha: string | null = null
      let pcmTimer = 0

      const startTrace = (): void => {
        void (async () => {
          const text = await (await fetch(new URL('./assets/traces/onboarding-demo.jsonl', import.meta.url))).text()
          traceSha = await sha256Hex(text)
          tracePlayer = new TracePlayer(text)
          replayActive = true; updateLiveMute()
          let last = performance.now()
          const step = (now: number): void => {
            tracePlayer?.step(Math.min((now - last) / 1000, 0.1), (s) => engine.bus.publish(s))
            last = now
            traceRaf = requestAnimationFrame(step)
          }
          traceRaf = requestAnimationFrame(step)
        })()
      }
      const stopTrace = (): void => {
        cancelAnimationFrame(traceRaf); tracePlayer = null
        replayActive = false; updateLiveMute()
      }
      const startPcm = async (): Promise<void> => {
        // 预解码不计入测量：解码在 warmup 之前完成
        const buf = await (await fetch(new URL('./assets/audio/onboarding-demo.mp3', import.meta.url))).arrayBuffer()
        const ctx = new AudioContext()
        const decoded = await ctx.decodeAudioData(buf)
        const ch = decoded.getChannelData(0)
        const sr = decoded.sampleRate
        const BATCH = 1024 // 与 PcmBatcher.BATCH_SAMPLES 一致
        let cursor = 0
        replayActive = true; updateLiveMute() // 旁路系统捕获，防双信号灌引擎
        // 按挂钟节奏补送，与真实链路的突发特性接近
        const blockMs = (BATCH / sr) * 1000
        pcmTimer = window.setInterval(() => {
          const due = Math.max(1, Math.round(20 / blockMs))
          for (let i = 0; i < due; i++) {
            if (cursor + BATCH > ch.length) cursor = 0 // 循环
            engine.ingest({ sampleRate: sr, channels: 1, samples: ch.slice(cursor, cursor + BATCH) })
            cursor += BATCH
          }
        }, 20)
        void ctx.close()
      }
      const stopPcm = (): void => {
        window.clearInterval(pcmTimer)
        replayActive = false; updateLiveMute()
      }

      // 声明顺序：panel 的按钮回调要引用 runBench，runBench 又要报进度给 panel——
      // 用 let 前置声明打破循环，panel 在最后构造
      let panel: InstanceType<typeof BenchPanel> | null = null

      const benchHost = new BenchHost({
        startTrace, stopTrace, startPcm, stopPcm,
        setShape: (id) => host.applyShape({ ...DEFAULT_SHAPE_SETTINGS, current: SHAPE_IDS.includes(id as ShapeId) ? (id as ShapeId) : DEFAULT_SHAPE_SETTINGS.current }),
        setLyricsEnabled: (on) => host.applyLyrics({ ...DEFAULT_LYRICS_SETTINGS, enabled: on }),
        enterGalaxy: () => host.applyGalaxy({ active: true, stars: [], filterView: null, selectedKey: null }),
        exitGalaxy: () => host.applyGalaxy({ active: false, stars: [], filterView: null, selectedKey: null }),
        gpuUnavailableReason: nebulaGpuUnavailableReason,
        tierName: () => benchQuality.name,
        particleCount: () => benchQuality.particles,
        displayHz: () => displayHz,
        onProgress: (t) => panel?.setStatus(t),
        meta: async () => ({
          appVersion: await window.audelyra.getAppVersion(),
          commitSha: env?.commitSha ?? null, buildType: env?.buildType ?? 'dev',
          osVersion: env?.osVersion ?? '未知', electronVersion: env?.electronVersion ?? '未知',
          threeVersion: THREE_VERSION,
          hw: { chip: env?.chip ?? '未知', memoryGB: env?.memoryGB ?? 0 },
          backend: 'webgpu',
          windowSize: { w: window.innerWidth, h: window.innerHeight },
          drawingBufferSize: { w: Math.round(window.innerWidth * devicePixelRatio), h: Math.round(window.innerHeight * devicePixelRatio) },
          devicePixelRatio,
          displayHz, rafMedianMs: perf.frameStats.summarize().intervalMs.p50,
          powerSource: env?.powerSource ?? 'ac', batteryPercent: env?.batteryPercent ?? null,
          lowPowerMode: env?.lowPowerMode ?? null,
          settingsProfile: 'default', trackTimestamp: true, traceSha256: traceSha,
          generatedAt: new Date().toISOString(),
        }),
      })

      const runBench = async (names: Parameters<typeof benchHost.run>[0]): Promise<void> => {
        // prevSize 声明在 try 外：现场改动（窗口尺寸/用户设置/perf.mode）与 benchHost.run
        // 全部纳入同一个 try——任何一步抛错都必须走到 finally，否则窗口/设置/模式会永久卡死
        let prevSize: { w: number; h: number } | null = null
        try {
          prevSize = await window.audelyra.perfStandardizeWindow()
          // 强制标准环境：默认设置消除变量（记录现状只能解释差异，消除不了）
          host.applyShape(DEFAULT_SHAPE_SETTINGS)
          host.applyMotion(DEFAULT_MOTION_SETTINGS)
          host.applyCamera(DEFAULT_CAMERA_SETTINGS)
          host.applyBackground(DEFAULT_BACKGROUND_SETTINGS)
          // 锁 ultra 并禁用降级器（bench 纪律）：档位中途变会让样本混合两种配置
          await host.start('nebula', TIERS.high, benchQuality, true)
          perf.setMode('bench', { displayHz })
          const report = await benchHost.run(names)
          console.log(formatSummary(report))
          downloadJson(report, `audelyra-perf-${report.meta.generatedAt.replace(/[:.]/g, '-')}.json`)
          panel?.setStatus('完成，报告已下载')
        } catch (err) {
          console.error('[bench] 基准执行中断', err)
          panel?.setStatus(`基准中断：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          // 每步独立兜底：任一步失败不能连累后续恢复步骤
          // 恢复失败要汇总进面板状态——用户是非技术用户，不看 console，
          // 若只 console.error 而报告显示"完成"，用户会误以为窗口/设置已复原
          const restoreFails: string[] = []
          try {
            perf.setMode('hud', { displayHz })
          } catch (err) {
            console.error('[bench] 恢复 perf 模式失败', err)
          }
          try {
            if (prevSize) await window.audelyra.perfRestoreWindow(prevSize)
          } catch (err) {
            console.error('[bench] 恢复窗口尺寸失败', err)
            restoreFails.push('窗口')
          }
          try {
            const s = await window.audelyra.getSettings()
            host.applyShape(s.shape); host.applyMotion(s.motion)
            host.applyCamera(s.camera); host.applyBackground(s.background)
          } catch (err) {
            console.error('[bench] 恢复用户设置失败', err)
            restoreFails.push('设置')
          }
          if (restoreFails.length > 0) panel?.setStatus(`⚠️ ${restoreFails.join('、')}未能恢复，建议重启应用`)
        }
      }

      // panel 最后构造：此时 runBench 已定义，回调可安全引用
      panel = new BenchPanel(overlayDiv, {
        onRunSuite: () => void runBench([...SUITE]),
        onRunPower: () => void runBench(['power-playback']),
        onRunSoak: () => void runBench(['soak']),
      })

      // 启动里程碑：跨进程时钟对齐后累积三次，取中位数作判据（单次噪声过大）
      void (async () => {
        // 等首帧真的渲染出来再采集——否则 markFirstFrame 还是 0，算出来的是垃圾数字
        await new Promise<void>((r) => {
          const wait = (): void => (markFirstFrame > 0 ? r() : void requestAnimationFrame(wait))
          wait()
        })
        const raw = await window.audelyra.perfGetStartupMarks()
        // 主进程 performance.now() 零点对应的墙钟时刻
        const mainEpochWall = raw.mainWallMs - raw.mainNowMs
        // 渲染层 performance.now() 值 → 主进程坐标系
        const toMain = (rendererNow: number): number =>
          performance.timeOrigin + rendererNow - mainEpochWall
        // 全部里程碑归一到「进程启动 = 0」
        const base = raw.processStartMs
        const marks: StartupMarks = {
          processStartMs: 0,
          windowCreatedMs: raw.windowCreatedMs - base,
          rendererLoadedMs: toMain(markRendererLoaded) - base,
          sceneInitDoneMs: toMain(markSceneInitDone) - base,
          firstFrameSubmittedMs: toMain(markFirstFrame) - base,
        }
        const KEY = 'audelyra.perf.startup'
        const prev: StartupMarks[] = JSON.parse(localStorage.getItem(KEY) ?? '[]')
        const runs = [...prev, marks].slice(-3) // 只留最近三次
        localStorage.setItem(KEY, JSON.stringify(runs))
        const sorted = runs.map((r) => r.firstFrameSubmittedMs).sort((a, b) => a - b)
        const startup: StartupResult = { runs, medianToFirstFrameMs: sorted[Math.floor(sorted.length / 2)] }
        window.__audelyraStartup = startup
        console.log(`[perf] 冷启动第 ${runs.length}/3 次：首帧 ${marks.firstFrameSubmittedMs.toFixed(0)}ms` +
          (runs.length < 3 ? '（再重启应用 ' + (3 - runs.length) + ' 次凑满）' : `，中位数 ${startup.medianToFirstFrameMs.toFixed(0)}ms`))
      })()
    }

    host.applyTitle(initial.title) // 切歌拼字设置播种（模式+大小，重放语义同 camera）
    host.applyLyrics(initial.lyrics) // 歌词设置播种（重放语义同 title）
    // 自定义背景 fetcher 接线（自定义背景 v1 Task 8）：必须在 host.applyBackground(initial.background) 之前——
    // 启动恢复自定义选中时 UserBackdrop 才取得到文件（同 setCustomShapeFetcher/applyShape 先例，防 fetcher 未就绪时静默回落极光）
    setCustomBackgroundFetcher((id) => window.audelyra.readCustomBackground(id))
    host.applyBackground(initial.background) // 背景（虚空之镜）设置播种（重放语义同 lyrics）
    host.applyMapping(initial.mapping) // host.start 之后调用以命中当前场景实例
    // 自定义形状 fetcher 接线（idea #12）：必须在 host.applyShape(initial.shape) 之前——
    // 启动恢复自定义选中时 CustomShapeController 才取得到文件（不能照抄 loadContourAssets 更靠后的接线点）
    setCustomShapeFetcher((id) => window.audelyra.readCustomShape(id))
    host.applyShape(initial.shape) // 形状与映射同点重放（评审 I3：档位重建也走 host 缓存）
    host.applyMotion(initial.motion) // 运动方言同点重放（Phase C2 T5）
    host.applyCamera(initial.camera) // 镜头活跃度同点重放（Phase D）

    // 轮廓形状（心脏）异步资产加载：未就绪 generate 返回 null → 仲裁回退星云；
    // 每个资产就绪后重放一次当前 shape settings = 自动补切（S2 spec §4.3）
    loadContourAssets(
      (id) => window.audelyra.getShapeAsset(id),
      async () => {
        // 序幕期跳过补切重放：持久化形状会覆写瞬态站形体（首站启动竞态实锤）；
        // 判定放 await 之后——getSettings 在途时序幕开演同样要拦。停演后 stopDemo 自会恢复真形状
        const s = await window.audelyra.getSettings()
        if (!demoActive) host.applyShape(s.shape)
      },
    )

    // mapping 实时预览（拖动每帧广播，不落盘）：主进程原样转发，直接喂运行中场景
    window.audelyra.onMappingChanged((m) => host.applyMapping(m))
    window.audelyra.onMotionChanged((m) => host.applyMotion(m))
    window.audelyra.onCameraChanged((c) => host.applyCamera(c))

    // 首启引导：星云舞台上的一幕（拒绝授权不报错只静音，判定靠信号交叉，见 onboarding-logic）
    // 放 host.start 之后——引导要星云已经在跑。
    // ③起带序幕「声音的形状进化史」：demo trace 驱动脉动 + 点击推进换形体，成功/落幕即停演交还真实信号
    let onboarding: { dispose: () => void } | null = null
    let onboardedFlag = initial.onboarded // 空状态提示的引导完成门（onDone 当刻置真，不等设置回流）
    if (!initial.onboarded) {
      let lastTrackKind: 'change' | 'unknown' = 'unknown'
      window.audelyra.onTrack((t) => { lastTrackKind = t.kind }) // 与既有 onTrack 订阅并存（preload 是多播 on）

      const demoScript = new OnboardingDemoScript()
      let demoPlayback: DemoPlayback | null = null
      let demoAudio: HTMLAudioElement | null = null
      // 序幕形体瞬态 apply 不落盘：coverPriority 关死防封面点云抢站位，customCurrent 清空防自定义盖过站形体，
      // showBody 压真防旧存档关着主体导致序幕黑屏
      const applyStation = (id: ShapeId): void => {
        host.applyShape({ ...initial.shape, current: id, customCurrent: null, coverPriority: false, showBody: true })
      }
      const stopDemo = (): void => {
        if (demoPlayback) { demoPlayback.stop(); demoPlayback = null }
        if (demoAudio) { // 落幕快淡出（300ms）防硬切；淡完即释放
          const a = demoAudio
          demoAudio = null
          const fade = setInterval(() => {
            a.volume = Math.max(0, a.volume - 0.1)
            if (a.volume <= 0) { clearInterval(fade); a.pause() }
          }, 30)
        }
        if (demoActive) {
          demoActive = false
          updateLiveMute() // 停演即解除静音，真实信号无缝接管
          void window.audelyra.getSettings().then((s) => host.applyShape(s.shape)) // 恢复用户真形状（瞬态站形体不落盘）
          // 序幕资产收尾卸载（审①P2-3/审②P2-9）：raw 点数据 + 生成态点云共 ~30MB 只属首启会话
          unloadContourAssets(DEMO_CONTOUR_IDS)
          evictShapeCache(DEMO_SHAPE_IDS)
        }
      }
      // trace 已内联（审② P0 回修）：内容坏/空 → runDemoPlayback null → 无序幕直接 intro（不新增失败路径）
      const playback = runDemoPlayback(demoTraceRaw, (s) => engine.bus.publish(s))
      if (playback) {
        demoPlayback = playback
        demoActive = true
        updateLiveMute()
        // 序幕配乐（亲验反馈轮②）：与 trace 出自同一音源同一段落 → 脉动与听感同拍；
        // 播放失败（自动播放策略等）静默降级为无声序幕，不阻塞流程
        demoAudio = new Audio(demoAudioUrl)
        demoAudio.loop = true
        void demoAudio.play().catch(() => {})
        // 序幕四形体按需加载（trace 就绪才值得拉，不拖累常规启动）：迟到就绪自动补切当前站；
        // 缺失 → contourCloud null → 自由态星云兜底
        loadContourAssets(
          // 加载失败除星云兜底外必须留痕（「静默跳过掩盖 P0」教训）：外送诊断日志，导出报告可见
          (id) => window.audelyra.getShapeAsset(id).catch((err: unknown) => {
            window.audelyra.logDiag('onboarding', `序幕形体资产 ${id} 加载失败：${String(err)}`)
            throw err
          }),
          () => { if (demoActive) applyStation(demoScript.currentShape) },
          DEMO_CONTOUR_IDS
        )
        applyStation(demoScript.currentShape) // 第一站：留声机聚形
      }
      onboarding = runOnboarding({
        parent: overlayDiv,
        // 原始帧能量探针（spec §1.3 判定改道）：demo 信号灌 bus 不会造成假成功
        latestHasAudio: () => performance.now() - lastAudibleAt < 1000,
        hasTrack: () => lastTrackKind === 'change',
        restartCapture: () => window.audelyra.restartCapture(),
        openAudioPrefs: () => window.audelyra.openAudioCapturePrefs(),
        prologue: playback
          ? {
              advance: () => {
                const next = demoScript.advance()
                if (next) applyStation(next)
                return demoScript.atEnd
              },
              skip: () => applyStation(demoScript.skipToEnd()),
              hint: () => DEMO_STATION_HINTS[demoScript.currentShape] ?? '',
              toggleAudio: () => {
                if (!demoAudio) return true // 无音频视作已静音（按钮显示「打开音乐」但点了无效果，序幕本就无声）
                demoAudio.muted = !demoAudio.muted
                return demoAudio.muted
              }
            }
          : null,
        onOpenStateChanged: (open) => {
          setModal(open)
          // ③起不再 uiStage 退台：序幕要星云全亮表演，四幕文字浮在表演之上（spec §1.4）
          dock.setEnabled(!open) // 引导幕上不出操作坞；引导结束才恢复
          corner.setEnabled(!open) // 同上——引导期间屏蔽右上角三枚（全屏/星系/设置），防误触改 OS 窗口态
          onboardingOpen = open // 新快捷键与 dock/corner setEnabled 同步屏蔽（引导期无副作用）
          if (!open) stopDemo() // 落幕（success 淡出/dispose）即停演
        },
        onDone: () => {
          onboardedFlag = true
          window.audelyra.setSettings({ onboarded: true })
        }
      })
    }

    // ===== 空状态教学 + 权限闭环（发布准备③ spec §2）：引导之后的长期出路 =====
    // 1s 采样：audible 走原始帧探针（bus 冻结/回放污染都不影响）；suppressed 汇流所有前台活动
    const idleHint = new IdleHint(overlayDiv, {
      openAudioPrefs: () => window.audelyra.openAudioCapturePrefs(),
      restartCapture: () => window.audelyra.restartCapture()
    })
    const idleHintLogic = new IdleHintLogic()
    const IDLE_HINT_TICK_MS = 1000
    const idleHintInterval = setInterval(() => {
      const state = idleHintLogic.sample({
        audible: performance.now() - lastAudibleAt < 1000,
        hasTrack: lastSysTrack?.kind === 'change' && lastSysProgress?.playing === true,
        captureUnavailable,
        suppressed: modalCount > 0 || shapePickerOpen || localActive || replayActive || onboardingOpen || !onboardedFlag,
        dt: IDLE_HINT_TICK_MS / 1000
      })
      idleHintPermission = state === 'permission'
      idleHint.setState(state)
    }, IDLE_HINT_TICK_MS)

    window.audelyra.onSettingsChanged((s) => {
      if (s.tier !== appliedTier) {
        appliedTier = s.tier
        void host.start('nebula', TIERS.high, forced(s.tier)) // start 自带重入令牌，连点安全
      }
      host.applyTitle(s.title) // 切歌拼字设置并入统一回流订阅
      host.applyLyrics(s.lyrics) // 歌词设置并入统一回流订阅
      host.applyBackground(s.background) // 背景（虚空之镜）设置并入统一回流订阅
      host.applyMapping(s.mapping) // 落盘回流也重放（commit 后 settings:changed 会带最终 mapping）
      // 序幕期跳过形状重放：站形体是瞬态不落盘，任何 settings 写盘（winBounds 记忆等）的回流
      // 都会把它覆写回持久化形状（demo id 不可持久化）；停演时 stopDemo 自会恢复真形状
      if (!demoActive) host.applyShape(s.shape) // 落盘回流重放：调音台/选择器双入口共用此环
      host.applyMotion(s.motion) // 落盘回流重放：同上双入口共用此环（Phase C2 T5）
      host.applyCamera(s.camera) // 落盘回流重放：同上双入口共用此环（Phase D）
    })

    // 清理
    window.addEventListener('beforeunload', () => {
      clearInterval(badgeUpdateInterval)
      clearInterval(idleHintInterval)
      idleHint.dispose()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('keydown', onGalaxyEsc)
      badge.dispose()
      dock.dispose()
      corner.dispose()
      dragStrip.dispose()
      panel.dispose()
      tuningPanel.dispose()
      shapePicker.dispose()
      shapeCreate.dispose()
      dropOverlay.dispose()
      localPlayer.dispose()
      playerBar.dispose()
      galaxyBar.dispose()
      galaxyCard.dispose()
      onboarding?.dispose() // ③起引导不再 push uiStage，顺序不再敏感；cleanup 内会经 onOpenStateChanged 停演
      uiStage.dispose()
    })
  }
}

void boot()

/** trace 内容 hash——保证两次基准跑的是同一份输入 */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 报告下载——走浏览器下载而非 IPC 写盘：零主进程改动，开发期够用 */
function downloadJson(data: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
