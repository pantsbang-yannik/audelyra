// NebulaScene 正式组装：把前 10 个任务的部件接成完整场景。
// 分工纪律：SignalRig 每帧覆写 uDrive/uLow/uMid/uHigh/uEnergy/uBeat/uBeatGlow/uKick/uKickMode/
// uKickEnv/uBeatAge/uTempo/uDrop/uSleepBreath；本场景管 uSleep/uMorph/uTime/uDt/uColor* + 状态机 + 相机 + 封面。
// 方言 9 uniform（uSwellAmp…uTwinkleAmp）只由 NebulaMotionProgram 覆写（Phase C2）。
// 方言家族 13 uniform（uDial× 6 家族 + uPointBeat + 驱动值 6，SSOT=DialectUniforms）只由 DialectConductor 覆写（方言期批1/批2）。
import * as THREE from 'three/webgpu'
import type { Signals } from '../../engine/types'
import type { Scene, SceneTrackEvent, UiFocusProfile } from '../types'
import { uiFocusOutput } from './ui-focus'
import { NebulaParticles } from './particles'
import { SignalRig } from './signal-rig'
import { NebulaStateMachine, type NebulaState } from './state'
import { CoverController } from './cover-loader'
import { CustomShapeController } from './custom-shapes'
import { NebulaBackground } from './background'
import { NebulaPost } from './post'
import { CameraDirector } from './camera-director'
import { Tween, quantizeToBeatGrid, easeStandard, easeImpact, easeDrift } from '../shared/motion'
import { pickInitialTier, FpsGovernor } from '../shared/quality'
import { AwakeningDirector } from './awakening'
import { AudioVisualMapper } from './mapping/mapper'
import { defaultRhythmPreset } from './mapping/spec'
import type { MappingValues } from './mapping/types'
import { resolveShape, planRefreshAction, shapeSelectionChanged, isBackfillReveal, type ResolvedKind, type ResolvedShape } from './shapes/resolve'
import { isBodyConcealed } from './body-visibility-link'
import { DEFAULT_SHAPE_SETTINGS, selectedCustomMeta, type ShapeSettings, type BodyKind } from './shapes/types'
import type { ShapePointCloud } from './cover-points'
import { NebulaMotionProgram } from './motion/nebula-program'
import { DEFAULT_MOTION_SETTINGS, climaxScale, type MotionSettings } from './motion/types'
import { DialectConductor } from './motion/dialects'
import type { DialectFamily } from './shapes/types'
import { DEFAULT_CAMERA_SETTINGS, type CameraSettings } from './camera-types'
import { TitleFxProgram, DEFAULT_TITLE_SETTINGS, type TitleSettings } from './title-fx'
import { TitleParticles } from './title-particles'
import { renderTitleImage, sampleTitlePoints } from './title-points'
import { LyricsFxProgram, DEFAULT_LYRICS_SETTINGS, type LyricsSettings, type LyricsFrame } from './lyrics/lyrics-fx'
import { LyricsParticles } from './lyrics/lyrics-particles'
import { renderLyricLine, LYRIC_WORLD_WIDTH } from './lyrics/lyric-points'
import { PlaybackClock } from './lyrics/clock'
import { LyricsRhythm } from './lyrics/lyrics-rhythm'
import type { NarrativePhase } from '../../engine/narrative'
import type { ScenePlaybackProgress, SceneLyricsDoc } from '../types'
import { NebulaSky } from './sky'
import { NebulaMirror } from './mirror'
import { UserBackdrop } from './user-backdrop'
import { RippleController } from './ripples'
import { DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from './background-types'
import type { BackgroundCaps } from '../types'
import { galaxyStep, type GalaxyPhase, type GalaxyAction } from './galaxy/phase'
import { GalaxyDirector } from './galaxy/director'
import type { GalaxyView } from './galaxy/types'
import { SpectrumBins } from './linework/spectrum-bins'
import { LineworkBody } from './linework/linework-body'
import { BodyCrossfade, slotOfBody, type BodySlot } from './linework/body-fade'
import { LedWaves } from './linework/led-waves'
import { LaserSweep } from './linework/laser-sweep'
import { EclipseBody } from './linework/eclipse-body'
import { LedmatrixBody } from './linework/ledmatrix-body'
import { LaserBody } from './linework/laser-body'
import { perf } from '../../perf/collector'
import type { GpuUnavailableReason } from '../../perf/gpu-timing'

// GPU 计时可用性（性能基线）：init 后回读真实状态，供报告记录不可用原因——
// 绝不静默填 0，取不到就要说清为什么取不到
let gpuUnavailable: GpuUnavailableReason | null = null
export const nebulaGpuUnavailableReason = (): GpuUnavailableReason | null => gpuUnavailable

// 真实 resolve 在飞标志。必须与 accumulator 的 inFlight 分开：后者会被 reset() 解开，
// 而 three 的 pendingResolve 不会——只靠 accumulator 判断会拿到跨 reset 边界的混合窗口数据
let gpuResolveInFlight = false

// 5 个打击位（球内均布、立体分散），SignalRig 返回的站位轮换命中
const BEAT_SITES = [
  new THREE.Vector3(0, 0.3, 0),
  new THREE.Vector3(0.9, 0, 0.4),
  new THREE.Vector3(-0.7, 0.5, -0.5),
  new THREE.Vector3(0.5, -0.4, 0.8),
  new THREE.Vector3(-0.5, -0.3, -0.9)
]

const AWAKENING_SEC = 2.5
const SHAPE_PREVIEW_GRACE_SEC = 8 // 切形状唤醒预览的宽限时长；结束后静默计时重新累积，≥10s 自然回睡
const BASE_CAM = new THREE.Vector3(0, 0.2, 3.0) // 星云内部边缘「被包裹视角」基础版（= 导演层 HOME 机位，仅作 init 初值，首帧即被导演层覆盖）

// B1 亲验反馈轮③：用户主动切形状「碎-散-聚」快编排常量（vs 换歌/reloading 沿用的拍级溶解节奏）
const SHATTER_IMPULSE = 4.0 // 碎相冲量幅度
const SNAP_DISSOLVE_SEC = 1.0 // 散相：morph 快速压 0
const SNAP_GATHER_SEC = 0.2 // 聚相：morph 快速回 1（用户调参：聚合更果断 0.55→0.2）
const MAP_THICKEN_SPAN = 0.6 // 映射厚度跨度：thickness=1 时粒径 ×1.6（0.35→0.6：滑块全行程可感，亲验调）
const LINE_RATE_SPAN = 1.5 // 映射速度→线条响应速率跨度：speed=1 时快 2.5×（手感，亲验调）
const GATHER_DECAY_SEC = 1.1 // 聚合刚度+阻尼增益衰减时长。配合法则：≈ SNAP_GATHER_SEC + 刹车余量(~0.7s)——
// 窗口必须罩住"到站后的刹车距离",调短到贴着聚合时长会让阻尼在粒子还带余速时撤掉→连环回弹(2026-07-10 亲验教训)

const BODY_FADE_SEC = 0.6 // 粒子↔线条交接 crossfade 时长

export function createNebulaScene(): Scene {
  let renderer: THREE.WebGPURenderer | null = null
  let scene: THREE.Scene
  let camera: THREE.PerspectiveCamera
  let particles: NebulaParticles | null = null
  let linework: LineworkBody | null = null // 线条系主体（Task 3）：与 particles 平级挂载，crossfade 交接见 update 4c 段
  let eclipse: EclipseBody | null = null   // 三连主体：惰性创建，切走隐藏复用（spec §编排）
  let ledmatrix: LedmatrixBody | null = null
  let laser: LaserBody | null = null
  const bodyXfade = new BodyCrossfade()
  const ledWaves = new LedWaves()
  const laserSweep = new LaserSweep()
  const spectrumBins = new SpectrumBins()
  let rig: SignalRig | null = null
  let sm: NebulaStateMachine
  let cover: CoverController | null = null
  let custom: CustomShapeController | null = null
  let background: NebulaBackground | null = null
  let post: NebulaPost | null = null
  let director: CameraDirector | null = null
  let sky: NebulaSky | null = null
  let mirror: NebulaMirror | null = null
  let backdrop: UserBackdrop | null = null // 用户图片背景（自定义背景 v1）：与 sky/mirror 互斥
  let bgSwitchGen = 0 // 背景源切换代际：贴图加载完成才拆旧景（不闪黑），迟到回调自弃
  const rippleCtl = new RippleController()
  let backgroundSettings: BackgroundSettings = { ...DEFAULT_BACKGROUND_SETTINGS }
  let bgCaps: BackgroundCaps = { auroraDetail: 'full', ripple: true, nearDust: true }

  // Task 7：全场弹性脉冲——mapper 纯逻辑算 space/brightness，粒子端 additive uniform 消费。
  // mapping 是闭包变量，applyMapping 热更后立即在下一帧生效；rebuildParticlesHalf 只重置
  // mapper 内部状态（新粒子无历史），mapping 本身沿用，满足重放铁律（spec §7）。
  let mapper = new AudioVisualMapper()
  let mapping: MappingValues = defaultRhythmPreset()

  // Phase C2 运动方言：program 持有粒子 uniform 引用，与 rig 同生命周期（构造/重建完全同步）；
  // motionSettings 是闭包变量，applyMotion 热更后立即在下一帧生效（重放语义同 mapping）
  let motionProgram: NebulaMotionProgram | null = null
  let motionSettings: MotionSettings = { ...DEFAULT_MOTION_SETTINGS }

  // cameraSettings 是闭包变量，applyCamera 热更后下一帧生效（重放语义同 motion）
  let cameraSettings: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS }
  // 滚轮改默认距离的落盘通道（#镜头精修 ①）：main.ts 注入，防抖 400ms 提交，避免每格滚轮刷盘
  let cameraCommit: ((c: CameraSettings) => void) | null = null
  let cameraCommitTimer: ReturnType<typeof setTimeout> | null = null

  // 方言指挥：家族权重+逐家族驱动器；与 rig/motionProgram 同生命周期（构造/重建同步）
  let dialect: DialectConductor | null = null
  let appliedDialect: DialectFamily = 'none' // drop 崩解重聚判据（applyResolved 记账）
  let prevDrop = 0 // drop 包络上升沿检测（崩解重聚点火用）

  // 切歌拼字（spec 2026-07-12-particle-title）：状态机纯逻辑 + 独立小池渲染，与主池完全解耦；
  // titleSettings 是闭包变量，applyTitle 热更后下一帧生效（重放语义同 camera）
  const titleFx = new TitleFxProgram()
  let titleParticles: TitleParticles | null = null
  let titleSettings: TitleSettings = { ...DEFAULT_TITLE_SETTINGS }

  // 歌词粒子（二期 spec §5）：状态机+外插钟纯逻辑，渲染独立双缓冲小池；与歌名拼字时间互斥
  const lyricsFx = new LyricsFxProgram()
  const lyricsClock = new PlaybackClock()
  const lyricsRhythm = new LyricsRhythm()
  let lyricsPrevNarrPhase: NarrativePhase = 'steady' // burst 进入沿追踪（歌词冲击层专用）
  let lyricsPrevPhase: LyricsFrame['phase'] = 'idle' // 上一帧歌词相位：gather 免疫 drop 冲散用（fb4）
  let lyricsParticles: LyricsParticles | null = null
  let lyricsSettings: LyricsSettings = { ...DEFAULT_LYRICS_SETTINGS }
  let lyricsEnabledPrev = lyricsSettings.enabled
  // undefined = 尚未收到过任何 track 事件；null = 已收到但 unknown（同 appliedTarget 的哨兵先例）。
  // 二者都不能初始化成同一个值：否则「首次 unknown」会被同曲守卫误判成「重复 unknown」而跳过清场（终审C1）
  let currentTrackKey: string | null | undefined = undefined
  let pendingLyricsDoc: SceneLyricsDoc | null = null // 词先到 track 后到的补挂（启动补发竞态）

  /** 歌词文档只在 key 匹配当前歌时消费；none = 明确无词（清空） */
  function applyLyricsDoc(d: SceneLyricsDoc): void {
    lyricsFx.setDoc('lines' in d ? d.lines : null)
  }

  // Phase B1 形状编排：settings 经 applyShape 注入；appliedTarget 引用判等短路重复 setTargets
  // （priority=off 换歌时 resolve 结果不变，不必重传缓冲）；undefined 哨兵 = 尚未应用（重建后强制重传）
  let shapeSettings: ShapeSettings = { ...DEFAULT_SHAPE_SETTINGS }
  let appliedKind: ResolvedKind = 'free'
  let appliedPlanar = false
  let appliedHasColor = false
  let appliedBody: BodyKind = 'particles' // 线条系（Task 2）：记账贯穿，交接动画归 Task 4
  let appliedTarget: ShapePointCloud | null | undefined = undefined
  let hasTarget = false
  let pendingSwap: ResolvedShape | null = null // 跨 cover 边界切换：溶解到 0 再翻转（spec §4.3 N1）
  let shapeSeeded = false // 首次 applyShape=播种/重建重放，不触发唤醒预览（spec §4.6 防误唤醒铁律）
  let wakeGraceSec = 0 // 切形状的「假不静默」宽限：>0 时向状态机谎报不静默，粒子苏醒成形展示
  // B1 亲验反馈轮③：形状切换「碎-散-聚」快编排 —— 只影响用户主动切换触发的这一次过渡，
  // 换歌/reloading 溶解与之前一样走拍级节奏（quantizeToBeatGrid），互不干扰
  let snapSwap = false // 本次 refreshShape 由用户主动切换触发：走快编排（vs 换歌的拍级溶解）
  let backfillEligible = false // 本次 refreshShape 来自「已播种后的 applyShape 重放」：补切仪式的资格位（启动播种/直调 refreshShape 均无资格）
  let snapSwapPending = false // 当前在途的 pendingSwap 是否为快编排（决定 morphTween 时长与落地后是否点火 uGather）
  let gatherSec = 0 // 聚合刚度增益剩余时长（>0 时 uGather 按 gatherSec/GATHER_DECAY_SEC 线性衰减）

  let time = 0
  let lastBpm: number | null = null
  let prevState: NebulaState = 'sleep'
  let reloading = false // 换歌溶解中：强制 morph→0 直到新目标就绪（onSettled 解除）

  // ===== 星系图鉴（idea #4，spec §三）：galaxy 模式分流。分工：director 管星系对象（点云/相机/accents），
  // 本文件管 morph/uniform/仲裁记账（闭包不外借）；相位转移全部走 galaxyStep 纯 reducer（Step 3b，可单测），
  // 本文件只执行 actions。galaxy 期音频驱动整段跳过（「不叠加」拍板）。
  let galaxyDirector: GalaxyDirector | null = null
  let galaxyView: GalaxyView | null = null
  let galaxyPhase: GalaxyPhase = 'off'
  let galaxyLastTrack: SceneTrackEvent | null = null // galaxy 期缓存的最近 track；退出时自喂恢复封面/拼字

  // Task 13：FPS 降级监督。降级顺序 DPR→后期→粒子→floor（粒子是核心资产，最后才动）。
  const governor = new FpsGovernor()
  let pendingParticleRebuild = false // lowerParticles 命中后挂起，等 silence 或下一次换歌窗口才真正重建（播放中重建是大顿挫）
  let floorWarned = false // floor 只 warn 一次，避免每个观察窗都刷屏

  const sleepTween = new Tween()
  const morphTween = new Tween()
  let morphTarget = 0

  // 苏醒延迟决策：边沿帧能量包络还没爬起来，先用 M2 基线起步，观察窗口内取 max(energy) 后定稿
  const awakenDirector = new AwakeningDirector()

  /** 把仲裁结果落到粒子：目标缓冲 + 两枚封面标定 uniform + 记账 */
  function applyResolved(r: ResolvedShape): void {
    if (!particles) return
    particles.setTargets(r.target)
    particles.uniforms.uTargetHasColor.value = r.hasColor ? 1 : 0
    particles.uniforms.uTargetPlanar.value = r.planar ? 1 : 0
    appliedKind = r.kind
    appliedPlanar = r.planar
    appliedHasColor = r.hasColor
    appliedBody = r.body
    appliedTarget = r.target
    dialect?.setFamily(r.dialect) // 家族翻转发生在 morph≈0 窗口（dissolve 落地/immediate 时 morph 语义见 spec §3.2）
    appliedDialect = r.dialect
  }

  /** 天空+镜面成对重建（初建/降级 dropBgRipple 共用）：镜面不再依赖天空 uniform（亲验 fb1 修订①：
   * 倒影解析天空已退役），成对重建纯粹因为二者共用同一次降级触发点（auroraDetail/ripple 一起变化）。 */
  function buildSkyMirror(): void {
    if (backdrop) return // 用户背景在场（含加载中）：天空/镜面不拆不建——互斥判据看 backdrop 实体而非 settings，失败回落时 backdrop 已拆除置空，本函数即可正常重建（评审⑤Important 黑屏路径的根治）
    if (mirror) { scene.remove(mirror.group); mirror.dispose(); mirror = null }
    if (sky) { scene.remove(sky.mesh); sky.dispose(); sky = null }
    sky = new NebulaSky(bgCaps.auroraDetail)
    scene.add(sky.mesh)
    mirror = new NebulaMirror({ ripple: bgCaps.ripple })
    scene.add(mirror.group)
    mirror.group.visible = backgroundSettings.mirror // 降级/初建重建后重套开关，不得复活已关闭的镜面
  }

  /** 背景源互斥切换（自定义背景 spec §三）：aurora ↔ 上传图。上传图贴图加载完成才拆天空/镜面
   * （切换全程不露黑）；加载失败回落星空极光（只影响画面，settings 不动，卡片缩略图侧自会破图提示）；
   * 代际守卫防连点乱序。 */
  function applyBackgroundSource(): void {
    const cur = backgroundSettings.current
    const myGen = ++bgSwitchGen
    if (cur === 'aurora') {
      if (backdrop) {
        scene.remove(backdrop.mesh); backdrop.dispose(); backdrop = null
        // 切回极光：解除调色总线的背景接管，颜色 tween 回当前封面色（#背景取色 ②）
        cover?.reapplyCoverColor(lastBpm)
      }
      cover?.setColorSuppressed(false)
      if (!sky) buildSkyMirror()
      return
    }
    if (!backdrop) { backdrop = new UserBackdrop(); scene.add(backdrop.mesh) }
    const meta = backgroundSettings.customBackgrounds.find((m) => m.id === cur)
    void backdrop.show(cur, meta?.kind ?? 'image').then((ok) => {
      if (myGen !== bgSwitchGen) return // 期间又切了源：让最新一次接管
      if (ok) {
        if (mirror) { scene.remove(mirror.group); mirror.dispose(); mirror = null }
        if (sky) { scene.remove(sky.mesh); sky.dispose(); sky = null }
        // 背景取色接管调色总线（#背景取色 ②）：尘埃/歌词/主体光改随上传背景基调，而非专辑封面。
        // 取色失败（如视频首帧未就绪）则回落封面色，别把总线冻在旧背景色
        const mood = backdrop?.mood ?? null
        if (mood) {
          cover?.setColorSuppressed(true)
          cover?.applyExternalMood(mood, lastBpm)
        } else {
          cover?.setColorSuppressed(false)
          cover?.reapplyCoverColor(lastBpm)
        }
      } else {
        if (backdrop) { scene.remove(backdrop.mesh); backdrop.dispose(); backdrop = null }
        cover?.setColorSuppressed(false)
        if (!sky) buildSkyMirror()
      }
    })
  }

  /** 重新仲裁（形状/开关变更、封面 cloud 变更、粒子重建后调用）。
   * 跨 cover 边界 → 挂 pendingSwap，update 循环等 morph 溶解到 0 再翻转（防单帧爆闪）；
   * 其余立即落地（geometry↔geometry = 弹簧当场变形，"真身即预览"）——
   * 除非本次由用户主动切换触发（snapSwap）：碎散聚编排需要先散再聚，immediate 直换做不出散相，
   * 所以 snapSwap 命中时一律走 pendingSwap 溶解路径，即使是 geometry↔geometry（B1 亲验反馈轮③）。 */
  function refreshShape(): void {
    if (galaxyPhase !== 'off') return // 星系期形状仲裁冻结：cover/custom 异步 decode 落地、设置回流、
    // ShapePicker 切形状一律不碰 targets/uTargetHasColor/uTargetPlanar/dialect——否则星系点云被当场覆写。
    // 退出时 exitRestore 会在相位翻回 'off' 后重调 refreshShape（appliedTarget 已标脏 → 必重传），语义自愈
    if (!particles || !cover) return
    const r = resolveShape({
      current: shapeSettings.current,
      coverPriority: shapeSettings.coverPriority,
      coverCloud: cover.cloud,
      custom: custom?.state ?? null,
      count: particles.mesh.count,
    })
    hasTarget = r.target !== null
    const action = planRefreshAction({
      appliedKind, appliedPlanar, appliedHasColor, appliedBody, appliedTarget, next: r,
      morph: particles.uniforms.uMorph.value, snap: snapSwap,
    })
    if (action === 'skip') {
      pendingSwap = null // 结果没变：清掉可能在途的旧 swap 即可
      snapSwapPending = false // 悔棋后回拍级语义：在途的快编排也一并取消
      return
    }
    if (action === 'dissolve') {
      pendingSwap = r
      if (snapSwap) {
        particles.uniforms.uShatter.value = SHATTER_IMPULSE // 碎：下一帧 kernel 消费，update 帧末（compute 之后）清零
        snapSwapPending = true // 记住本次 pendingSwap 是快编排，溶解/聚合都走快节奏
      }
    } else {
      // 补切仪式感（S2 回账）：轮廓资产就绪的 free→geometry 落地——借快编排聚相（成形果断）
      // + 唤醒预览宽限（无音乐时也给一场成形展示，随后自然回睡）。判定必须在 applyResolved
      // 之前取 appliedKind（applyResolved 会覆写它）。
      // seeded 参数传资格位 backfillEligible（=「已播种后的 applyShape 重放」快照，applyShape 置位
      // shapeSeeded 之前取）而非闭包 shapeSeeded：否则启动播种（首个 applyShape 重放持久化的
      // 同步几何形状）会误触发仪式（强制唤醒预览），违反 spec §4.6 防误唤醒铁律
      const backfill = isBackfillReveal(appliedKind, r.kind, backfillEligible, snapSwap)
      pendingSwap = null
      snapSwapPending = false // 本次落地不是（或不再是）在途的快编排，清掉可能残留的旧标记
      applyResolved(r)
      if (snapSwap) { // morph 本来就≈0（沉睡/自由态）：无需散，直接快聚
        gatherSec = GATHER_DECAY_SEC
      } else if (backfill) {
        gatherSec = GATHER_DECAY_SEC
        snapSwapPending = true // 借快编排聚相时长（0.2s 果断成形）；无散相——粒子本就自由态
        wakeGraceSec = Math.max(wakeGraceSec, SHAPE_PREVIEW_GRACE_SEC)
      }
    }
  }

  /** galaxy 相位动作执行器：reducer 决定"做什么"，这里决定"怎么做"。signals 只在 update 循环内的
   * morphZero 事件路径可用（exitRestore 的入睡判定用），applyGalaxy 路径传 null。 */
  function runGalaxyAction(a: GalaxyAction, signals: Signals | null): void {
    if (!particles || !galaxyDirector) return
    const u = particles.uniforms
    if (a === 'beginDissolve') {
      // 进入：碎散（快编排同款）→ 谷底 mount → 快聚。音频 uniform 一次性清零（rig 不再覆写）
      u.uShatter.value = SHATTER_IMPULSE
      for (const k of ['uDrive', 'uLow', 'uMid', 'uHigh', 'uBeat', 'uBeatGlow', 'uKick', 'uKickEnv', 'uDrop',
        'uPulseSpace', 'uPulseBright', 'uSwellAmp', 'uRippleAmp', 'uJitterAmp', 'uBuildSqueeze', 'uFlash',
        'uHeartPulse'] as const) {
        u[k].value = 0
      }
      u.uNarrDim.value = 1
      u.uThicken.value = 1 // 映射厚度回中性（星系期 mapper 不跑，防冻结残留；uPulseSpace 同理已在清零表）
      u.uTempo.value = 1 // 评审 P2：残留 BPM 缩放（0.7..1.6）会改星系 idle 湍流速度
      u.uEnergy.value = 1 // 软边界撑满（bound 2.7 > 星系半径 ~2.15），energyDim 全亮
      // 评审 P1-2：在场歌名/歌词粒子若不藏，会以最后一帧 spread/fade 冻结成"幽灵字"挂在星系里
      if (titleParticles) titleParticles.group.visible = false
      if (lyricsParticles) lyricsParticles.group.visible = false
      // 线条系交接（图形三连）：星系期 update() 早退，4c 段不再跑，bodyXfade/可见性会冻结在入场瞬间的值——
      // 同上一条 P1-2 教训，若当时在线条系主体卡（bodyXfade 已淡出粒子）星系点云会拿不到粒子本体、线条画板又冻结残留。
      // 进场强制归位：粒子回场、线条系全部藏起；可见性之外 uBodyDim 也必须复位（审查 Critical：
      // opacityNode 乘 uBodyDim，冻结在 0 时 mesh.visible=true 也全透明=星系照样黑屏）——
      // 与本段上方 uDrive/uEnergy 等"uniform 归位"同构；退出后 4c 从 1 优雅衰减回线条态，正好复现 0.6s crossfade
      particles.mesh.visible = true
      bodyXfade.update(BODY_FADE_SEC, 'particles', BODY_FADE_SEC) // dt≥fadeSec：单步打满，等价原地强制 bodyFade=1
      u.uBodyDim.value = bodyXfade.fadeOf('particles')
      if (linework) linework.group.visible = false
      if (eclipse) eclipse.group.visible = false
      if (ledmatrix) ledmatrix.group.visible = false
      if (laser) laser.group.visible = false
      sleepTween.start(u.uSleep.value, 0, 0.6, easeStandard) // 沉睡中进星系也醒来
      morphTween.start(u.uMorph.value, 0, SNAP_DISSOLVE_SEC, easeImpact)
      pendingSwap = null; snapSwapPending = false; reloading = false // 在途溶解一律作废，星系接管
    } else if (a === 'mount') {
      if (!galaxyView) return
      particles.setTargets(galaxyDirector.mount(galaxyView, particles.mesh.count))
      u.uTargetHasColor.value = 1
      u.uTargetPlanar.value = 0
      dialect?.setFamily('none')
      appliedTarget = undefined // 星系直写 targets 绕过仲裁记账：标脏，退出时 refreshShape 强制重传
      gatherSec = GATHER_DECAY_SEC
      morphTween.start(0, 1, 0.8, easeStandard)
      director?.setManualEnabled(false) // 关断 CameraDirector 手动输入（其 gsap 只写 proxy，不与 GalaxyCamera 抢 camera）
      galaxyDirector.setNowPlaying(currentTrackKey ?? null) // 播种当前歌脉动:音乐播放中手动进星系,不等下一次切歌事件(终审I1)
    } else if (a === 'setView') {
      if (!galaxyView) return
      const cloud = galaxyDirector.setView(galaxyView, particles.mesh.count)
      if (cloud) { particles.setTargets(cloud); gatherSec = GATHER_DECAY_SEC }
    } else if (a === 'beginRestore') {
      galaxyDirector.beginExit(BASE_CAM) // 评审 P1-1：restore 期把镜头送回 HOME + 星/封面淡出，落地无硬跳
      morphTween.start(u.uMorph.value, 0, SNAP_DISSOLVE_SEC, easeImpact)
    } else if (a === 'exitRestore') {
      // 此刻 reducer 已把相位翻回 'off'（评审 P0-2 的顺序保证）：refreshShape 门放行、onTrackChange 门放行
      galaxyDirector.unmount()
      director?.setManualEnabled(true)
      if (titleParticles) titleParticles.group.visible = true
      if (lyricsParticles) lyricsParticles.group.visible = true
      appliedTarget = undefined
      refreshShape() // 重新仲裁当前形状（appliedTarget 已标脏 → 必重传）
      morphTarget = 0 // live 循环按状态机重算 desiredMorph
      sleepTween.start(u.uSleep.value, (signals?.silence ?? true) ? 1 : 0, 2, easeDrift)
      if (galaxyLastTrack) { const t = galaxyLastTrack; galaxyLastTrack = null; onTrackChangeImpl(t) } // 恢复封面/歌词/拼字现场
    }
  }

  // lowerParticles 真正执行时调用：半数粒子重建。旧 particles dispose + 移出 scene，
  // 新建后重接 rig（其持有 uniforms 引用，重建后必须 new SignalRig(新 uniforms)）；
  // cover.rebind 原地恢复当前封面目标点云与颜色。post 的 scenePass 引用的是 scene 对象本身
  // （只换 mesh，scene 没变），不用重建。
  function rebuildParticlesHalf(): void {
    if (!renderer || !particles || !cover) return
    const newCount = Math.max(1, Math.floor(particles.mesh.count / 2))
    scene.remove(particles.mesh)
    particles.dispose()
    particles = new NebulaParticles(newCount)
    scene.add(particles.mesh)
    particles.init(renderer)
    rig = new SignalRig(particles.uniforms)
    motionProgram = new NebulaMotionProgram(particles.uniforms) // 新粒子新 uniform，program 无历史债——闪白/收缩包络重置，语义同 mapper 重置先例
    dialect = new DialectConductor(particles.uniforms) // 新粒子新 uniform；家族由后续 refreshShape→applyResolved 重放
    mapper = new AudioVisualMapper() // 新粒子/新 rig 后重置弹性脉冲状态；mapping 闭包变量沿用，下一帧自动重放
    cover.rebind(particles, newCount)
    custom?.rebind(newCount)
    appliedTarget = undefined // 新粒子缓冲是空白的：强制重传（引用判等短路失效点，评审 I3）
    refreshShape() // 几何形状用 newCount 重新 generate（i%n 取模复用会重叠疏密）
    console.log('[quality] particles rebuilt →', newCount)
  }

  // 提为闭包函数（评审 P0-2 前置）：exitRestore 需要直接自喂 track 恢复现场，不依赖场景对象的 `this`
  const onTrackChangeImpl = (t: SceneTrackEvent): void => {
    if (!cover) return
    if (galaxyPhase !== 'off') {
      // galaxy 期不动封面/拼字/歌词，只记账 + 喂正在播放脉动（Task 9 accents 消费）
      galaxyLastTrack = t
      galaxyDirector?.setNowPlaying(t.kind === 'change' ? `${t.title}\0${t.artist}` : null)
      return
    }
    titleFx.onTrack(t)
    // 歌词随切歌清场：旧词旧进度不得驱动新歌（key 匹配即挂上晚到/先到的文档）。
    // 同曲守卫（终审C1，镜像 title-fx.onTrack 的去重纪律，见该文件 93 行 `if (key === this.lastKey) return`）：
    // 一期既有语义是同一首歌封面晚到会补发第二次 change（无封面 change 先到、缓存命中快速挂词，
    // 带封面 change 随后补发）。若不设防，第二次 change 会把刚挂上的词整首清掉且再也不恢复——
    // 因为 clear() 之后没有任何东西会重新 setDoc。key 不变（同曲）时整个歌词清场块原样跳过。
    const nextKey = t.kind === 'change' ? `${t.title}\0${t.artist}` : null
    if (nextKey !== currentTrackKey) {
      currentTrackKey = nextKey
      lyricsClock.reset()
      lyricsFx.clear()
      if (pendingLyricsDoc && currentTrackKey && pendingLyricsDoc.key === currentTrackKey) {
        applyLyricsDoc(pendingLyricsDoc)
        pendingLyricsDoc = null
      }
    }
    // 挂起的粒子降级：换歌窗口也是视觉过渡点，此刻重建不比等静默更突兀
    if (pendingParticleRebuild) {
      rebuildParticlesHalf()
      pendingParticleRebuild = false
    }
    if (t.kind === 'change' && t.artworkDataUrl) {
      cover.loadCover(t.artworkDataUrl, lastBpm, `${t.title}\0${t.artist}`)
      // 溶解锁仅在「当前显示的确实是封面」时上：旧封面在屏上才需要先溶解等新目标；
      // 显示几何形状/自由态时换歌，形状纹丝不动（评审 I2）
      if (appliedKind === 'cover') reloading = true
    } else {
      // change 无图 / unknown → 退化星云 + 调色渐回冷色骨架
      cover.clear(lastBpm)
    }
  }

  return {
    async init(ctx) {
      // trackTimestamp 必须构造期传入：three 的 Backend 从 parameters 读取，构造后赋值无效
      renderer = new THREE.WebGPURenderer({
        canvas: ctx.canvas, antialias: false, trackTimestamp: ctx.trackTimestamp === true,
      })
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.toneMapping = THREE.AgXToneMapping
      await renderer.init() // WebGPU 不可用时 renderer.backend 在此期间才会回落到 WebGLBackend，之前问都问不出真实 backend
      // ctx.quality（main.ts 传入 TIERS.high）只是上限参考；真正初档按探得的 backend 裁决（设计第 6 节：默认值不许拿最高档）
      const backend = renderer.backend.constructor.name === 'WebGPUBackend' ? 'webgpu' : 'webgl'
      // GPU 计时可用性回读：backend 内部还会与设备 timestamp-query feature 求与，
      // 传了 true 也可能被否——必须读回真实值而不是假定生效
      if (ctx.trackTimestamp) {
        const tracking = (renderer.backend as { trackTimestamp?: boolean }).trackTimestamp === true
        gpuUnavailable = backend === 'webgl' ? 'webgl-backend' : tracking ? null : 'feature-unsupported'
      }
      const quality = ctx.forcedTier ?? pickInitialTier(backend) // 手动档位优先；'auto' 走 backend 自动选档
      perf.setActiveTier(quality.name, quality.particles) // 回填实际生效档位供 HUD/报告读真源
      renderer.setPixelRatio(Math.min(devicePixelRatio, quality.dprCap))
      console.log('[nebula] backend =', renderer.backend.constructor.name, 'tier =', quality.name, 'count =', quality.particles)

      scene = new THREE.Scene()
      camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100)
      camera.position.copy(BASE_CAM)
      camera.lookAt(0, 0, 0)

      particles = new NebulaParticles(quality.particles)
      scene.add(particles.mesh)
      particles.init(renderer)

      linework = new LineworkBody() // 线条系主体：与 particles 平级挂载，默认隐藏，crossfade 交接见 update 4c 段
      linework.group.visible = false
      scene.add(linework.group)

      rig = new SignalRig(particles.uniforms)
      motionProgram = new NebulaMotionProgram(particles.uniforms)
      dialect = new DialectConductor(particles.uniforms)
      sm = new NebulaStateMachine({ awakeningSec: AWAKENING_SEC })
      cover = new CoverController(particles, quality.particles, {
        onSettled: () => { reloading = false },
        // decode 完成时可能已拨开关/切形状（设置竞态，评审 I2）：一律重新问仲裁，绝不直落 setTargets
        onCloudChanged: () => refreshShape(),
      })
      custom = new CustomShapeController(quality.particles, {
        // 直调路径补资格位：图片异步就绪（decode/sample 完成）与 applyShape 重放（heart 轮廓资产就绪）
        // 不走同一条调用路径，但理应同享补切仪式——否则重启恢复选中图片形状时永远看不到成形一幕
        onCloudChanged: () => { backfillEligible = shapeSeeded; refreshShape(); backfillEligible = false },
      })
      // 上限池（亲验 fb1 修订④：用户要「更多一点」）：high 档默认密度 0.7 → far+mid 实绘 ≈21k，比旧 15k 多
      background = new NebulaBackground(quality.name === 'low' ? 20_000 : 48_000, quality.background.nearDust) // 亲验 fb2：30k 仍「不够」→ 上限池再提（默认密度 0.7 ≈ 33.6k）
      background.setDustDensity(backgroundSettings.dust)
      background.setDustLook(backgroundSettings.dustSize, backgroundSettings.dustBright)
      scene.add(background.group)
      bgCaps = { ...quality.background }
      buildSkyMirror()
      applyBackgroundSource() // 启动即用户背景时补建 backdrop（buildSkyMirror 对该源早退）
      titleParticles = new TitleParticles(quality.name === 'low' ? 16_000 : 32_000) // #光效精修③ 加密：笔画更实、可读性更强，additive 叠加下笔芯自然聚成亮白核
      scene.add(titleParticles.group)
      lyricsParticles = new LyricsParticles(quality.name === 'low' ? 16_000 : 32_000) // #光效精修③ 加密：同 title，歌词笔画更实更易读
      scene.add(lyricsParticles.group)
      post = quality.bloom ? new NebulaPost(renderer, scene, camera, { bloom: true }) : null
      director = new CameraDirector(camera, ctx.canvas) // 导演层：段落机位/呼吸/drop冲击/手动接管，接管相机
      // 滚轮改默认距离（#镜头精修 ①）：立即更新闭包 cameraSettings（下一帧 setDistScale 即用新值，粘住不飘回），
      // 再防抖落盘 + 广播——落盘回流 applyCamera 会用同值整包覆盖 cameraSettings，与调音台距离滑块联动
      director.setOnDistScaleChange((v) => {
        cameraSettings = { ...cameraSettings, distScale: v }
        if (cameraCommitTimer) clearTimeout(cameraCommitTimer)
        cameraCommitTimer = setTimeout(() => {
          cameraCommitTimer = null
          cameraCommit?.(cameraSettings)
        }, 400)
      })

      // 开机即沉睡幕布、morph 归零。tween 起手持有当前值，等状态边沿再真正过渡。
      particles.uniforms.uSleep.value = 1
      particles.uniforms.uMorph.value = 0
      sleepTween.start(1, 1, 1e-3, easeDrift)
      morphTween.start(0, 0, 1e-3, easeStandard)
      refreshShape() // 默认星云=free，uniform 落 0/0，确定性起点
      galaxyDirector = new GalaxyDirector(scene, ctx.canvas)
      prevState = 'sleep'
    },

    update(dt, signals) {
      if (!renderer || !particles || !rig || !cover) return

      // ===== galaxy 模式（idea #4）：独立更新路径——不跑 rig/sm/mapper/方言/歌词/拼字/governor =====
      if (galaxyPhase !== 'off') {
        const u = particles.uniforms
        time += dt
        u.uDt.value = dt
        u.uTime.value = time
        u.uSleep.value = sleepTween.update(dt)
        u.uMorph.value = morphTween.update(dt)
        if ((galaxyPhase === 'dissolve' || galaxyPhase === 'restore') && u.uMorph.value <= 0.02) {
          // 谷底事件：dissolve→mount；restore→按最新 view.active 决定 exitRestore 或转 dissolve 重挂
          //（评审 P0：restore 期再进入不丢——谷底转 dissolve，下一帧再触发 morphZero→mount，uniforms 沿用已清零态）
          const r = galaxyStep(galaxyPhase, { kind: 'morphZero' }, galaxyView?.active ?? false)
          galaxyPhase = r.phase
          for (const a of r.actions) runGalaxyAction(a, signals)
          if (galaxyPhase === 'off') return // 已回 live：保持上一呈现帧一帧，下帧起 live 循环接管（避免同帧双跑 tween）
        }
        gatherSec = Math.max(0, gatherSec - dt)
        u.uGather.value = gatherSec > 0 ? gatherSec / GATHER_DECAY_SEC : 0
        // 脉动只属于「正在出声」（fb2 鬼点根因）：currentTrackKey 是"最近一首"不是"正在放"——
        // 无音乐时它仍指着历史曲目，mount 播种的呼吸辉光就成了永闪鬼点。静默即撤，恢复出声即回。
        galaxyDirector?.setNowPlaying((signals?.silence ?? true) ? null : currentTrackKey ?? null)
        // restore 期也继续跑星系相机（评审 P1-1）：beginExit 已把目标换成 HOME，镜头边溶解边归位
        if (galaxyPhase === 'on' || galaxyPhase === 'restore') galaxyDirector?.update(dt, camera)
        // 背景三件套继续喂帧（评审 P1-2：极光/水面/尘不许死机）——drop/beat 类输入给零，其余用冻结现值
        sky?.update(dt, {
          primary: u.uColorA.value, deep: u.uColorB.value, energy: u.uEnergy.value,
          drop: 0, sleep: u.uSleep.value, low: 0, mid: 0, flowMul: 1, level: backgroundSettings.aurora,
        })
        background?.update(dt, { deep: u.uColorB.value, energy: u.uEnergy.value, drop: 0, sleep: u.uSleep.value, kick: 0, high: 0 }) // high 归零对齐 sky 的 low/mid 冻结先例（频段类统一冻结，图鉴模式背景不追音频细节）
        const galaxyRipples = rippleCtl.update(dt, {
          onBeat: false, strength: 0, dropEdge: false, silence: true, sleeping: false,
          gain: bgCaps.ripple ? backgroundSettings.ripple : 0,
        })
        mirror?.update(dt, { primary: u.uColorA.value, energy: u.uEnergy.value, sleep: u.uSleep.value, ripples: galaxyRipples })
        backdrop?.update(dt, camera, {
          energy: u.uEnergy.value, sleep: u.uSleep.value,
          opacity: backgroundSettings.bgOpacity, saturation: backgroundSettings.bgSaturation, breathe: backgroundSettings.bgBreathe,
        })
        u.uFocusDist.value = camera.position.length()
        particles.compute(renderer)
        u.uShatter.value = 0 // 冲量单帧语义：compute 之后清（同 live 循环纪律）
        if (post) { post.setDropGlow(0); post.setTrail(0); post.render() } else { renderer.render(scene, camera) }
        return
      }

      // 0) 挂起的粒子降级：等到静默才真正重建（播放中重建=全场大顿挫，静默本就是视觉过渡点）
      if (pendingParticleRebuild && (signals?.silence ?? true)) {
        rebuildParticlesHalf()
        pendingParticleRebuild = false
      }

      // 分段打点（性能基线）：probing 是热路径唯一读的布尔，off 态零开销
      const probing = perf.enabled
      const mark = (k: 'signal' | 'mapping' | 'state' | 'visual' | 'camera' | 'submit', t0: number): void => {
        if (probing) perf.markPhase(k, performance.now() - t0)
      }

      const u = particles.uniforms
      lastBpm = signals?.bpm ?? null

      // 1) SignalRig 一次性覆写其名下 uniform，并返回本拍站位
      const tSignal = probing ? performance.now() : 0
      const site = rig.update(dt, signals)
      if (site >= 0) {
        // 打击位是为 3D 星云选的立体站位；封面态把 z 压向封面平面（uTargetPlanar=1 时随 uMorph 投影）；几何形状 planar=0 不压平（B1 T4 门控）
        const s = BEAT_SITES[site]
        u.uBeatCenter.value.set(s.x, s.y, s.z * (1 - u.uMorph.value * u.uTargetPlanar.value))
      }
      mark('signal', tSignal)

      // 1.5) 全场弹性脉冲（Task 7）：mapper 纯逻辑算 space/brightness → additive uniform，
      // 不碰 SignalRig 名下的 14 个 uniform（其每帧无条件覆写，见文件头分工纪律）
      const tMapping = probing ? performance.now() : 0
      const controls = mapper.update(signals, mapping, dt)
      u.uPulseSpace.value = controls.space
      u.uPulseBright.value = controls.brightness * climaxScale(motionSettings.climaxBrightness) // #高潮亮度：全场脉冲提亮压档
      u.uThicken.value = 1 + controls.thickness * MAP_THICKEN_SPAN // 死线接活：厚度→粒径饱满（默认规则=低频重量）

      // 1.6) C2 运动方言：MotionProgram 消费叙事+三 band 包络，写方言 9 uniform + 产后期乐器值
      const motionInputs = {
        narrative: rig.narrative,
        low: u.uLow.value, mid: u.uMid.value, high: u.uHigh.value,
        kickEnv: u.uKickEnv.value, dropPulse: u.uDrop.value, kickStrength: u.uKick.value,
        energy: u.uEnergy.value,
        mapSpeed: controls.speed, mapDensity: controls.density, // 死线接活：mapper 同帧输出（1.5 段已算）
      }
      const instrument = motionProgram!.update(dt, motionInputs, motionSettings)

      // 1.7) 方言家族驱动（方言期批1）：心跳/行进波/星系自转——家族权重由 applyResolved 经 setFamily 翻转
      dialect!.update(dt, motionInputs, motionSettings)

      // 1.8) 雕像/心脏 drop=崩解重聚（spec §4，碎散聚机制收敛版）：drop 包络上升沿，成形中（morph>0.9）
      // 点火小幅碎相+聚相——粒子炸散又被增益弹簧拽回原形，morph 不动不走溶解。
      // 退路（spec §7）：亲验若破坏庄重感 → 删本段，drop 自动回落到力5 的 lockDir 法线方向
      const dropEdge = u.uDrop.value > 0.5 && prevDrop <= 0.5 // 歌词冲击层（5.7）同帧复用
      if (dropEdge && u.uMorph.value > 0.9
        && (appliedDialect === 'contour' || appliedDialect === 'heart')) {
        u.uShatter.value = SHATTER_IMPULSE * 0.45 // 收敛版：约半力崩解，重聚快于形状切换
        gatherSec = GATHER_DECAY_SEC
      }
      prevDrop = u.uDrop.value
      mark('mapping', tMapping)

      // 2) 状态机。silence 被切形状宽限期覆写为 false（spec §4.6：唤醒预览）；
      //    宽限只影响状态机睡/醒判定，不碰 pendingParticleRebuild 等其它 silence 消费点
      const tState = probing ? performance.now() : 0
      wakeGraceSec = Math.max(0, wakeGraceSec - dt)
      const state = sm.update(dt, { silence: (signals?.silence ?? true) && wakeGraceSec <= 0, hasTarget })

      // 3) 状态边沿：苏醒冲量 + uSleep tween 方向
      if (state !== prevState) {
        if (prevState === 'sleep') {
          // sleep→awakening：z 向幕布炸开涌入纵深。必须走 rig，直接写 uDrop 会被同帧覆写。
          // 边沿帧能量包络（attack 0.08s，T10a 后现值）积累不再是 ~3% 量级，但单帧仍未收敛，此刻判「安静/炸歌」仍可能失真——
          // 先用 M2 基线（2.5s/0.6）起步，观察窗口（0.35s，窗内可达位 ~99%）结束再定稿（详见 AwakeningDirector）。
          const temp = awakenDirector.onEdge()
          sm.awakeningSec = temp.durationSec
          rig.triggerDrop(temp.kickStrength)
          sleepTween.start(u.uSleep.value, 0, temp.durationSec, easeImpact)
        }
        if (state === 'sleep') {
          sleepTween.start(u.uSleep.value, 1, quantizeToBeatGrid(2, lastBpm), easeDrift)
        }
        prevState = state
      }

      // 3.5) 苏醒观察窗口：每帧喂能量包络，窗口结束定稿——用窗口内 max(energy) 重排剩余时长、
      //      并对「炸歌」安全追加冲量（Pulse.trigger 取 max，不会打断已在衰减的更强冲量）。
      if (state === 'awakening') {
        const final = awakenDirector.update(dt, u.uEnergy.value)
        if (final) {
          sm.awakeningSec = final.durationSec
          if (final.kickStrength > 0.6) rig.triggerDrop(final.kickStrength)
          // 剩余时长重排：tween 从当前 uSleep 起步，无跳变
          sleepTween.start(u.uSleep.value, 0, final.durationSec * (1 - sm.awakenProgress), easeImpact)
        }
      }
      u.uSleep.value = sleepTween.update(dt)

      // 4) uMorph：有形态则吸附；换歌 reloading（仅封面显示中上锁）与跨界溶解（pendingSwap）期间强制 →0
      const desiredMorph = state === 'cover' && !reloading && !pendingSwap ? 1 : 0
      if (desiredMorph !== morphTarget) {
        // 快编排聚相被外因打断（换歌 reloading / 入睡）：此翻 0 不是 snap 溶解（那由 pendingSwap 驱动）——
        // 复位快编排标志，本次及后续溶解回拍级语义（否则换歌溶解误用 0.2s，违反「换歌观感零变化」）
        if (desiredMorph === 0 && !pendingSwap) snapSwapPending = false
        morphTarget = desiredMorph
        const ease = desiredMorph === 1 ? easeStandard : easeImpact // 重组缓 / 溶解快
        // 快编排（用户主动切形状）：散/聚都用短促固定时长，不量化到拍级网格——
        // 「果断」优先于「卡拍」；其余（换歌/reloading）仍量化拍级，观感零变化
        const dur = snapSwapPending
          ? (desiredMorph === 1 ? SNAP_GATHER_SEC : SNAP_DISSOLVE_SEC)
          : quantizeToBeatGrid(3, lastBpm)
        morphTween.start(u.uMorph.value, desiredMorph, dur, ease)
      }
      u.uMorph.value = morphTween.update(dt)
      // 4b) 溶解落地：morph 已归零 → 翻转目标与封面标定 uniform，下一帧朝新形态重组（spec §4.3 N1）
      if (pendingSwap && u.uMorph.value <= 0.02) {
        applyResolved(pendingSwap)
        pendingSwap = null
        if (snapSwapPending) gatherSec = GATHER_DECAY_SEC // 聚：谷底落地，刚度增益点火
      }
      // 快编排收尾：聚相完成（morph 已回到 1 附近）后回归拍级节奏，不再影响下一次普通切换
      if (snapSwapPending && morphTarget === 1 && u.uMorph.value >= 0.98) snapSwapPending = false
      // uGather 衰减（放在 compute 前：kernel 本帧读到的是本帧目标衰减值，无一帧延迟）
      gatherSec = Math.max(0, gatherSec - dt)
      u.uGather.value = gatherSec > 0 ? gatherSec / GATHER_DECAY_SEC : 0

      // 4c) 主体交接（图形三连）：BodyCrossfade 多槽状态机——active 槽淡入其余淡出，
      // 粒子也是普通槽（线条↔线条互切粒子恒 0 不闪现）；星系期强制粒子回场
      // （galaxyPhase≠off 时星系点云需要粒子本体）。淡尽后互相隐藏省算力。
      const activeSlot: BodySlot = galaxyPhase !== 'off' ? 'particles' : slotOfBody(appliedBody)
      bodyXfade.update(dt, activeSlot, BODY_FADE_SEC)
      const particleFade = bodyXfade.fadeOf('particles')
      u.uBodyDim.value = particleFade
      // 显示主体（二期通用化）：主体 tab 顶部总开关，任何背景下都生效；选中自定义背景时联动关闭，
      // 用户可随时再打开。判据委托 isBodyConcealed（防黑屏自愈纪律：自定义背景加载中/失败时不隐主体）
      // 星系模式不受影响——入场段已强制 particles.mesh.visible=true，且星系期本段不执行
      const bodyConcealed = isBodyConcealed(shapeSettings.showBody, backgroundSettings.current, !!sky)
      particles.mesh.visible = !bodyConcealed && particleFade > 0.01
      const lineRate = 1 + LINE_RATE_SPAN * controls.speed
      // 线条系共用帧输入：节拍事件喂纯逻辑模块，其余喂画板 uniform
      const bodyEv = {
        onBeat: signals?.beat.onBeat ?? false, strength: signals?.beat.strength ?? 0,
        dropEdge, silence: signals?.silence ?? true, sleeping: u.uSleep.value > 0.5,
        energy: u.uEnergy.value, rateMul: lineRate,
      }
      const sharedInp = {
        kickEnv: u.uKickEnv.value, drop: u.uDrop.value,
        sleep: u.uSleep.value, energy: u.uEnergy.value,
        colorA: u.uColorA.value, colorC: u.uColorC.value,
        brightness: motionSettings.lineBrightness,
        pulseSpace: u.uPulseSpace.value, pulseBright: u.uPulseBright.value,
        mapDensity: controls.density, mapThick: controls.thickness,
      }
      // 频谱桶：linework/eclipse 两个消费方任一在场才推进
      if (bodyXfade.fadeOf('linework') > 0.01 || bodyXfade.fadeOf('eclipse') > 0.01) {
        spectrumBins.update(signals?.spectrum ?? null, signals?.silence ?? true, dt, lineRate)
      }
      // —— 频谱环/波形线（共用画板，现状语义） ——
      const lineFade = bodyXfade.fadeOf('linework')
      if (linework) {
        linework.group.visible = !bodyConcealed && lineFade > 0.01
        if (appliedBody === 'spectrum' || appliedBody === 'waveform') linework.setMode(appliedBody)
        if (lineFade > 0.01) {
          linework.update(dt, {
            bins: spectrumBins.values, opacity: lineFade,
            barHeight: motionSettings.lineBarHeight, waveWidth: motionSettings.waveWidth, ...sharedInp,
          })
          linework.faceCamera(camera.position, dt)
        }
      }
      // —— 日食 ——
      if (activeSlot === 'eclipse' && !eclipse) {
        eclipse = new EclipseBody()
        scene.add(eclipse.group)
      }
      if (eclipse) {
        const fade = bodyXfade.fadeOf('eclipse')
        eclipse.group.visible = !bodyConcealed && fade > 0.01
        if (fade > 0.01) {
          eclipse.update(dt, {
            bins: spectrumBins.values, opacity: fade,
            waveLen: motionSettings.eclipseWaveLen, waveGap: motionSettings.eclipseWaveGap,
            corona: motionSettings.eclipseCorona,
            ...sharedInp,
          })
          eclipse.faceCamera(camera.position, dt)
        }
      }
      // —— 点阵 ——
      if (activeSlot === 'ledmatrix' && !ledmatrix) {
        ledmatrix = new LedmatrixBody()
        scene.add(ledmatrix.group)
      }
      if (ledmatrix) {
        const fade = bodyXfade.fadeOf('ledmatrix')
        ledmatrix.group.visible = !bodyConcealed && fade > 0.01
        if (fade > 0.01) {
          ledWaves.update(dt, { ...bodyEv, rateMul: bodyEv.rateMul * motionSettings.ledWaveSpeed })
          ledmatrix.update(dt, {
            waveRadii: ledWaves.radii, waveAmps: ledWaves.amps, opacity: fade,
            strobeOn: motionSettings.strobeEnabled, ...sharedInp,
            density: motionSettings.ledDensity, cross: motionSettings.ledCross,
            waveThick: motionSettings.ledWaveThick, waveBright: motionSettings.ledWaveBright,
          })
          ledmatrix.faceCamera(camera.position, dt)
        }
      }
      // —— 激光 ——
      if (activeSlot === 'laser' && !laser) {
        laser = new LaserBody()
        scene.add(laser.group)
      }
      if (laser) {
        const fade = bodyXfade.fadeOf('laser')
        laser.group.visible = !bodyConcealed && fade > 0.01
        if (fade > 0.01) {
          laserSweep.update(dt, { ...bodyEv, spreadMul: motionSettings.laserSpread, speedMul: motionSettings.laserSpeed, chaos: motionSettings.laserChaos, maxCount: motionSettings.laserMaxCount })
          laser.update(dt, { angles: laserSweep.angles, gains: laserSweep.gains, opacity: fade, ...sharedInp })
          laser.faceCamera(camera.position, dt)
        }
      }
      mark('state', tState)

      // 5) 调色过渡 + 背景三件套（天空/尘埃/镜面）——palette 同源（uColorA=primary uColorB=deep）
      const tVisual = probing ? performance.now() : 0
      cover.update(dt)
      const flowMul = rig.narrative.phase === 'burst' ? 1.6 : 1 // 副歌天空流速加快（spec §四层①）
      sky?.update(dt, {
        primary: u.uColorA.value, deep: u.uColorB.value,
        energy: u.uEnergy.value, drop: u.uDrop.value, sleep: u.uSleep.value,
        low: u.uLow.value, mid: u.uMid.value, // 频段驱动（spec §四层①）：rig 平滑包络同源同帧
        flowMul, level: backgroundSettings.aurora,
      })
      background?.update(dt, {
        deep: u.uColorB.value, energy: u.uEnergy.value,
        drop: u.uDrop.value, sleep: u.uSleep.value, kick: u.uKickEnv.value, high: u.uHigh.value
      })
      // 涟漪：消费 beat 事件与 drop 沿（dropEdge 在 1.8 已算）；滑杆归零/沉睡/静默不起圈
      const ripples = rippleCtl.update(dt, {
        onBeat: signals?.beat.onBeat ?? false, strength: signals?.beat.strength ?? 0,
        dropEdge, silence: signals?.silence ?? true, sleeping: u.uSleep.value > 0.5,
        gain: bgCaps.ripple ? backgroundSettings.ripple : 0,
      })
      mirror?.update(dt, {
        primary: u.uColorA.value, energy: u.uEnergy.value, sleep: u.uSleep.value,
        ripples,
      })
      backdrop?.update(dt, camera, {
        energy: u.uEnergy.value, sleep: u.uSleep.value,
        opacity: backgroundSettings.bgOpacity, saturation: backgroundSettings.bgSaturation, breathe: backgroundSettings.bgBreathe,
      })

      // 5.5) 切歌拼字：状态机出帧 → spawn 时采样上传+出生朝向镜头；亮度随沉睡幕布压暗。
      // 模式/位置/大小走每帧 setter 注入（同 director.setLiveliness 先例）：applyTitle 热更下一帧生效。
      // setAnchor 在 spawn 的 orientTo 之前：出生帧朝向按本帧锚点位置计算
      // 歌名 always 让位（spec §5.1）：当前歌抓到歌词且歌词开启时，常驻歌名按 timed 行为退场；
      // 抓不到词则 always 照旧——歌词只在真的有词时才抢位
      const titleYields = titleSettings.mode === 'always' && lyricsSettings.enabled && lyricsFx.hasDoc()
      titleFx.setMode(titleYields ? 'timed' : titleSettings.mode)
      titleParticles?.setScale(titleSettings.scale)
      titleParticles?.setAnchorY(titleSettings.position)
      titleParticles?.setBrightness(titleSettings.brightness)
      const tf = titleFx.update(dt)
      if (tf.spawn && titleParticles) {
        const img = renderTitleImage(tf.spawn.title, tf.spawn.artist)
        const cloud = img ? sampleTitlePoints(img, titleParticles.capacity) : null
        if (cloud) {
          titleParticles.setCloud(cloud)
          titleParticles.orientTo(camera.position) // 出生帧对准，此后 faceCamera 缓跟随
        } else {
          titleFx.cancel() // 画布不可用/全空文字：本次放弃，不留隐形动画
        }
      }
      titleParticles?.setPalette(u.uColorA.value, u.uColorC.value)
      titleParticles?.setFrame(tf.spread, tf.fade, 1 - u.uSleep.value)
      titleParticles?.faceCamera(camera.position, dt)

      // 5.7) 歌词粒子（spec §5）：外插钟推进 → 状态机出帧 → spawn 时单行采样上传。
      // 互斥：歌名任何在场相位（tf.phase ≠ idle）歌词都让路；设置关闭 = 清词 + 池隐藏
      if (lyricsSettings.enabled !== lyricsEnabledPrev) {
        lyricsEnabledPrev = lyricsSettings.enabled
        if (!lyricsSettings.enabled) lyricsFx.clear()
      }
      // setAnchor 在 spawn 块（orientTo）之前：出生帧朝向按本帧锚点位置计算（同 title 块注释纪律，终审M3——
      // orientTo 内部 group.lookAt 读的是 group.position，若 setAnchor 晚于 orientTo 调用，
      // 本帧朝向会用上一帧的锚点位置计算，切位置档位的当帧会歪一下）
      lyricsParticles?.setAnchorY(lyricsSettings.position) // 歌词独立位置档（亲验期追加：原沿用歌名档）
      lyricsClock.advance(dt)
      const lyricsPos = lyricsSettings.enabled ? lyricsClock.position() : null
      // 批2 节奏三层：呼吸/沸腾随连续量（rig 平滑包络同源同帧），脉冲随 beat，burst/drop 走沿；
      // dynamics 关 = 中性输出 + 不对拍不冲散（opts 不传，批1 静态行为）
      const lyricsBurstEdge = rig.narrative.phase === 'burst' && lyricsPrevNarrPhase !== 'burst'
      lyricsPrevNarrPhase = rig.narrative.phase
      // 亲验 fb1-D：dynamicsGain 在消费端整体缩放节奏层幅度（LyricsRhythm 本身不感知设置，
      // 保持纯逻辑——同批2既有分工）；gain=0 时 applyGain 输出退化为 NEUTRAL。
      // fb4 碎散聚：drop 冲散从调度层（杀句）改道节奏层幅度通路——炸开-重聚不杀句；
      // gather 免疫沿用（苏醒 drop 不误杀刚进场首句）：gather 相位不给节奏层递 drop 沿
      const lyricsDropEdge = dropEdge && lyricsPrevPhase !== 'gather'
      const lr = LyricsRhythm.applyGain(lyricsRhythm.update(dt, {
        energy: u.uEnergy.value,
        mid: u.uMid.value,
        onBeat: signals?.beat.onBeat ?? false,
        beatStrength: signals?.beat.strength ?? 0,
        bpm: signals?.bpm ?? null,
        burstEdge: lyricsBurstEdge,
        dropEdge: lyricsDropEdge,
      }, lyricsSettings.dynamics), lyricsSettings.dynamicsGain)
      const lf = lyricsFx.update(dt, lyricsPos, tf.phase !== 'idle',
        lyricsSettings.dynamics ? { nextBeatIn: lyricsRhythm.nextBeatIn() } : undefined)
      lyricsPrevPhase = lf.phase
      if (lf.spawn && lyricsParticles) {
        const img = renderLyricLine(lf.spawn.text)
        const cloud = img
          ? sampleTitlePoints(img, lyricsParticles.capacity, { worldWidth: LYRIC_WORLD_WIDTH })
          : null
        if (cloud) {
          lyricsParticles.setCloud(lf.spawn.slot, cloud)
          if (lf.phase === 'gather') lyricsParticles.orientTo(camera.position) // 出生帧对准，此后 faceCamera 缓跟随
        } else {
          lyricsFx.cancel() // 画布不可用/全空句：本句放弃（坏句不重试），不留隐形动画
        }
      }
      lyricsParticles?.setScale(lyricsSettings.scale * lr.scaleMul)
      lyricsParticles?.setBrightness(lyricsSettings.brightness * (1 + lr.brightAdd))
      lyricsParticles?.setPalette(u.uColorA.value, u.uColorC.value)
      lyricsParticles?.setFrame(Math.min(1, lf.spread + lr.spreadAdd), lf.fade, lf.mix, 1 - u.uSleep.value)
      lyricsParticles?.faceCamera(camera.position, dt)
      mark('visual', tVisual)

      // 6) 导演层运镜：段落机位（GSAP）→ 呼吸推拉 → drop 冲击/微震 → 手持漂移 → 手动接管
      const tCamera = probing ? performance.now() : 0
      time += dt
      // calm 系数改吃 rig 平滑后的 uEnergy（与粒子/背景常驻动效同源）——rig.update 已在本帧
      // step 1 跑过，u.uEnergy.value 是当帧新值，director.update 之前设置不产生一帧延迟（T5 复审）
      director?.setCalmEnergy(u.uEnergy.value)
      director?.setNarrative(rig.narrative) // 叙事驱动环绕/FOV 冲击 arm（Phase D，与方言层同源同帧）
      director?.setLiveliness(cameraSettings.liveliness)
      director?.setDistScale(cameraSettings.distScale)
      director?.update(dt, signals, u.uDrop.value)
      // 运镜推拉后取最新距离：焦平面恒锚在原点主体（"封面永远锐利，前后景化雾"）
      u.uFocusDist.value = camera.position.length()
      mark('camera', tCamera)

      // 7) 推进 GPU 仿真并渲染
      const tSubmit = probing ? performance.now() : 0
      u.uDt.value = dt
      u.uTime.value = time
      particles.compute(renderer)
      // uShatter 是单帧冲量（同 uKick 语义）：写入发生在 refreshShape（事件时刻，早于本帧 compute），
      // kernel 消费就在上一行 compute 里——必须等 compute 跑完再清零，否则冲量还没被 GPU 见到就被抹掉
      u.uShatter.value = 0
      if (post) {
        post.setDropGlow(u.uDrop.value)
        post.setTrail(u.uDrop.value)
        post.setInstrument(instrument)
        post.render()
      } else {
        renderer.render(scene, camera)
      }
      mark('submit', tSubmit)

      // GPU 批次采样（性能基线）：resolveTimestampsAsync 返回的是「上次清空到本次清空之间
      // 全部 pass 的时长总和」而非单帧值，且回读跨帧——所以严格 single-flight，
      // 由 GpuTimingAccumulator 记账每批覆盖帧数后摊成均值。render/compute 分属两个 pool，两边都要取。
      if (perf.trackGpu && gpuUnavailable === null && !gpuResolveInFlight && perf.gpu.canStartBatch()) {
        // 两道锁缺一不可：
        // ① gpuResolveInFlight（本地）——挡住 three 自身的 pendingResolve 复用。reset() 会解开
        //    accumulator 的 inFlight，但真实 GPU resolve 可能仍未完成；此时若发起新批，three 会
        //    把「同一个」pending Promise 交回来，新 epoch 拿到的是跨越 reset 边界的旧窗口时长——
        //    epoch 对得上，数据却是混的。本地标志不受 reset 影响，堵的正是这个洞。
        // ② epoch（accumulator）——挡住跨 reset 落地的陈旧回调污染新场景样本。
        gpuResolveInFlight = true
        const epoch = perf.gpu.beginBatch()
        const r = renderer
        void Promise.all([r.resolveTimestampsAsync('render'), r.resolveTimestampsAsync('compute')])
          .then(([renderMs, computeMs]) => {
            const total = (renderMs ?? 0) + (computeMs ?? 0)
            perf.gpu.endBatch(epoch, total > 0 ? total : null)
          })
          .catch(() => perf.gpu.endBatch(epoch, null))
          .finally(() => { gpuResolveInFlight = false })
      }

      // 8) 性能降级监督：滑窗均值持续低于目标 85% 时按序动作，DPR→后期→涟漪→粒子→floor
      // （亲验 fb1 修订①：倒影退役后序列缩至 5 级，dropBgRipple 吸收了原 dropBgReflection 的近尘职责）
      // bench 期间必须停摆（spec §8.4）：forcedTier 只锁初始档，管不到运行时降级——
      // 若不停，低配机跑分触发降级会让同一场景样本混两种配置，测的是「降级后的性能」
      if (perf.mode !== 'bench') {
        const action = governor.push(dt)
        if (action !== 'keep') {
          console.log('[quality]', action)
          if (action === 'lowerDpr') {
            renderer.setPixelRatio(Math.max(0.75, renderer.getPixelRatio() * 0.75))
          } else if (action === 'disablePost') {
            post?.dispose()
            post = null
          } else if (action === 'dropBgRipple') {
            // 背景先于主粒子被牺牲：涟漪关+极光简化+近尘关一次性归档（涟漪最后的「活」感也让位于粒子这个核心资产）。
            // low 档 caps 本就是 simple+ripple:false+nearDust:false：无变化时跳过重建，免得最挣扎的机器白吃一次 shader 重编译（终审 I1）
            const bgRippleChanged = bgCaps.ripple || bgCaps.auroraDetail !== 'simple'
            bgCaps = { ...bgCaps, ripple: false, auroraDetail: 'simple', nearDust: false }
            background?.setNearDust(false)
            if (bgRippleChanged) buildSkyMirror() // 极光降 simple 需换着色器：成对重建（一次性卡顿发生在本就掉帧的时刻，同 disablePost 先例）
          } else if (action === 'lowerParticles') {
            pendingParticleRebuild = true
          } else if (action === 'floor') {
            if (!floorWarned) {
              console.warn('[quality] floor：已到最低档，不再继续降级')
              floorWarned = true
            }
          }
        }
      }
    },

    onTrackChange: (t: SceneTrackEvent) => onTrackChangeImpl(t),

    resize(w: number, h: number) {
      renderer?.setSize(w, h)
      if (camera) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
    },

    /** 快门（idea #6 亲验 fb1/fb2）：所见即所得——同任务补渲一帧后立即 drawImage 回读（含 bloom 等全部后期）。
     * fb2 实锤：present 之后画布缓冲会被合成器回收，事件回调时刻直接 drawImage 得全透明空帧（「拍摄失败」根因）——
     * 渲染与回读必须同任务完成。补渲用的 uniform 全是上一帧的值，画面与屏幕所见一致。
     * （RT 竖构图重渲路线已退役：视角与屏幕不符+丢 bloom，fb1 用户拍板） */
    async snapshot(): Promise<ImageData | null> {
      if (!renderer || !scene || !camera) return null
      try {
        if (post) post.render()
        else renderer.render(scene, camera) // r183 init 后为同步提交路径（与 update 每帧同款调用）
        const src = renderer.domElement
        if (!src.width || !src.height) return null
        const cv = document.createElement('canvas')
        cv.width = src.width
        cv.height = src.height
        const c2d = cv.getContext('2d')
        if (!c2d) return null
        // 黑底打底：不同 alphaMode 下回读 alpha 语义不稳，先铺不透明底再合成，海报永不透明
        c2d.fillStyle = '#000'
        c2d.fillRect(0, 0, cv.width, cv.height)
        c2d.drawImage(src, 0, 0)
        const data = c2d.getImageData(0, 0, cv.width, cv.height)
        // 空帧哨兵（铺底后 alpha 恒 255，改判 RGB）：5×5 稀疏网格全黑=回读失败。
        // 真·全黑帧（深度沉睡）会误判成失败——可接受：有失败提示，来音乐重拍即好；预览模态是最后兜底
        let anyLit = false
        for (let gy = 0; gy < 5 && !anyLit; gy++) {
          for (let gx = 0; gx < 5 && !anyLit; gx++) {
            const px = Math.floor(((gx + 0.5) / 5) * cv.width)
            const py = Math.floor(((gy + 0.5) / 5) * cv.height)
            const i = (py * cv.width + px) * 4
            if (data.data[i] || data.data[i + 1] || data.data[i + 2]) anyLit = true
          }
        }
        if (!anyLit) {
          console.error('[nebula] snapshot 回读为全黑帧（回读失败或极端沉睡态）')
          return null
        }
        return data
      } catch (err) {
        console.error('[nebula] snapshot 失败', err)
        return null
      }
    },

    setUiFocus(v: number, profile: UiFocusProfile = 'full'): void {
      const o = uiFocusOutput(v, profile)
      const u = particles?.uniforms
      if (u) {
        u.uUiDim.value = o.dim
        u.uUiDefocus.value = o.defocus
      }
      director?.setUiDist(o.camera) // 后拉幅度：预设距离 +0.8 内（吃 DIST clamp）
    },
    setInteractive(on: boolean): void {
      director?.setManualEnabled(on)
    },
    applyMapping(m: MappingValues): void {
      mapping = m
    },
    applyMotion(m: MotionSettings): void {
      motionSettings = m
    },
    applyCamera(c: CameraSettings): void {
      cameraSettings = c
    },
    setCameraCommit(cb: (c: CameraSettings) => void): void {
      cameraCommit = cb // #镜头精修 ①：滚轮改默认距离的落盘出口
    },
    applyTitle(t: TitleSettings): void {
      titleSettings = t
    },
    applyLyrics(s: LyricsSettings): void {
      lyricsSettings = s
    },
    applyBackground(b: BackgroundSettings): void {
      const sourceChanged = b.current !== backgroundSettings.current
      backgroundSettings = b
      background?.setDustDensity(b.dust)
      background?.setDustLook(b.dustSize, b.dustBright)
      if (mirror) mirror.group.visible = b.mirror // 镜面总开关（#镜面开关）：Object3D 显隐零重建
      // renderer 未就绪 = init 前播种：init 尾部的 applyBackgroundSource 统一收口，这里不抢跑
      if (sourceChanged && renderer) applyBackgroundSource()
    },
    onProgress(p: ScenePlaybackProgress): void {
      lyricsClock.mark({ elapsedTime: p.elapsedTime, playbackRate: p.playbackRate, playing: p.playing })
    },
    onLyrics(d: SceneLyricsDoc): void {
      // 词与 track 事件到达顺序不保证（主进程补发/抓词异步）：key 匹配即消费，否则挂起等 track
      if (currentTrackKey && d.key === currentTrackKey) applyLyricsDoc(d)
      else pendingLyricsDoc = d
    },
    applyShape(s: ShapeSettings): void {
      // snapSwap 只标记「本次 refreshShape 调用」是否走碎散聚快编排——用完立即复位，
      // 不影响后续由换歌/reloading 触发的 refreshShape（那些仍走拍级溶解）
      const userSwitch = shapeSelectionChanged(shapeSettings, s, shapeSeeded)
      if (userSwitch) wakeGraceSec = SHAPE_PREVIEW_GRACE_SEC
      snapSwap = userSwitch
      backfillEligible = shapeSeeded && !userSwitch // 快照在置位之前：启动播种（首个 applyShape）无资格
      shapeSettings = s
      shapeSeeded = true
      // controller 的 onCloudChanged 会再触发一次 refreshShape（skip 短路兜底，与 cover 同构无害）
      custom?.setSource(selectedCustomMeta(s))
      refreshShape()
      snapSwap = false
      backfillEligible = false
    },

    applyGalaxy(g: GalaxyView): void {
      galaxyView = g
      if (!particles || !galaxyDirector) return
      const r = galaxyStep(galaxyPhase, { kind: 'apply', active: g.active }, g.active)
      galaxyPhase = r.phase
      for (const a of r.actions) runGalaxyAction(a, null)
    },

    dispose() {
      if (cameraCommitTimer) { clearTimeout(cameraCommitTimer); cameraCommitTimer = null }
      director?.dispose()
      director = null
      post?.dispose()
      post = null
      mirror?.dispose()
      mirror = null
      sky?.dispose()
      sky = null
      backdrop?.dispose()
      backdrop = null
      // 场景销毁也要作废背景切换代际：加载在途时若切画质档触发 dispose，
      // 迟到的 show() 回调不递增代际会在死场景上通过失败分支复活 sky/mirror（泄漏）
      bgSwitchGen++
      background?.dispose()
      background = null
      titleParticles?.dispose()
      titleParticles = null
      lyricsParticles?.dispose()
      lyricsParticles = null
      particles?.dispose()
      linework?.dispose()
      linework = null
      eclipse?.dispose()
      eclipse = null
      ledmatrix?.dispose()
      ledmatrix = null
      laser?.dispose()
      laser = null
      renderer?.dispose()
      renderer = null
      particles = null
      galaxyDirector?.dispose()
      galaxyDirector = null
    }
  }
}
