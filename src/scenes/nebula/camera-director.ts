// CameraDirector —— 导演层：自动电影运镜（段落机位 / 节拍呼吸 / drop 冲击微震 / 手持漂移 / 手动接管）。
// 设计 4.3 + 4.6 第 5 条铁律：运镜量化到「段落」——机位/焦段只在 SectionTracker 边沿切换，
// 逐拍只有重阻尼呼吸；drop 才打镜头微震（每拍震镜头三分钟就晕）。机位按能量选池（Phase D）。
//
// GSAP 纪律：tween 目标是 proxy 对象（sectionProxy/manualProxy），每帧在 update 里把 proxy 读进 camera；
// 绝不让 GSAP 直接改 camera（否则与呼吸/微震/漂移的叠加顺序打架）。ease 一律传 motion 曲线函数。
//
// 叠加顺序（每帧）：机位基准(proxy) → 呼吸 dolly → drop dolly/微震 → FOV 冲击 → 手持漂移 → 环绕公转 → 手动偏移 → lookAt(0,0,0)
import * as THREE from 'three/webgpu'
import gsap from 'gsap'
import type { Signals } from '../../engine/types'
import type { NarrativeState } from '../../engine/narrative'
import { ArPulse, Spring, quantizeToBeatGrid, easeDrift } from '../shared/motion'
import { SectionTracker } from './section-tracker'
import { MIRROR_Y } from './background-types'
import { CAMERA_LIMITS } from './camera-types'

interface Preset {
  x: number
  y: number
  z: number
  fov: number
}

// 五个预设机位——整体后移（Phase D 治「突然贴脸」）：默认 HOME 3.0 形状一览无余；
// 原 INTIMATE 降级为安静段落专属（能量选池 pickNextPreset 决定可达性）
const PRESETS: Preset[] = [
  { x: 0, y: 0.2, z: 3.0, fov: 58 }, // HOME（默认全景）
  { x: 0, y: -0.35, z: 3.1, fov: 62 }, // TIDAL（低平贴潮汐）
  { x: 0.5, y: 1.0, z: 3.3, fov: 50 }, // OVERLOOK（微俯全景）
  { x: 0, y: 0.15, z: 2.4, fov: 60 }, // INTIMATE（安静段落专属贴近）
  { x: 0, y: -1.05, z: 3.0, fov: 63 } // SKIM（低角度仰拍：云底之下、镜面之上，看粒子云+倒影——最出片构图）
]
// 能量选池（spec §3.2）：安静段落才允许贴近细看，中高能量一律远景——随机跳回贴脸位的病根就此拔掉
export const QUIET_POOL = [0, 1, 3]
export const ACTIVE_POOL = [0, 1, 2, 4] // SKIM 只在中高能量出场（高光段落优先调度的最简实现）
export const QUIET_ENERGY_MAX = 0.35

// 虚空之镜防穿面：俯仰包络用软地板（留 drift/shake ±0.024rad 的余量），组装后再硬钳兜底
const CAM_FLOOR_Y = MIRROR_Y + 0.25
const CAM_HARD_FLOOR_Y = MIRROR_Y + 0.15

const CAM_DT_CAP = 1 / 30 // Spring 大 dt 突刺可发散 → 调用侧钳制（沿用 M2 纪律）
const DRIFT_AMP = 0.02 // rad，段落内手持漂移幅度
const SHAKE_AMP = 0.004 // rad，drop 镜头微震幅度（× dropPulse）
const BREATH_RATIO = 0.03 // 节拍呼吸 ±3% 距离
const DROP_DOLLY = -0.3 // 负值=向外拉远（Phase D 反转：炸开瞬间看全貌，原 +0.12 推近加剧「看不全」）
const ORBIT_SPEED_MAX = 0.06 // rad/s，burst 峰值公转速——一圈约 100s，是氛围不是转椅（spec §5.1）
const DRAG_SENS = 0.005 // rad/px，拖拽灵敏度
// 滚轮灵敏度：deltaY → distScale 增量。滚轮直接改「默认距离倍率」而非临时偏移——
// 滚轮=调默认距离（与调音台距离滑块同一个源），调到哪粘到哪，不再几秒后自动飘回（用户拍板 #镜头精修）
const WHEEL_SENS_SCALE = 0.0016 // 一格滚轮 deltaY≈100 → distScale ±0.16，全程 [0.5,3] 约 15 格走完
// 距离安全钳基准值（distScale=1 时的窗口），仍用于最终 dist 的等比钳位（× distScale）
const DIST_MIN = 1.6
const DIST_MAX = 4.6 // ×1 档下 OVERLOOK 3.48 + drop 拉远 0.3×2（活跃度顶格）≈ 4.08 仍可表达
const MANUAL_IDLE_SEC = 4 // 手动静止多久后自动归位
const MANUAL_RETURN_SEC = 3 // 归位 tween 时长
const PITCH_LIMIT = 0.8 // rad，手动 pitch 上下限（防翻转）

const PUNCH_DEG = 5 // FOV 冲击基准度数（× strength × 活跃度）
const PUNCH_MAX_DEG = 6 // 安全上限写死：旋钮/强拍顶格也不破（spec §5.2/§7）
const PUNCH_MIN_GAP_SEC = 0.8 // 最小间隔下限；与 2 拍取大者

export class CameraDirector {
  private readonly camera: THREE.PerspectiveCamera
  private readonly dom: HTMLElement
  private readonly tracker = new SectionTracker()

  private time = 0
  private currentPreset = 0
  private sectionCount = 0

  // GSAP 只写这两个 proxy，update 每帧读进 camera
  private readonly sectionProxy: Preset = { ...PRESETS[0] }
  private readonly manualProxy = { yaw: 0, pitch: 0 } // 拖拽方位偏移（静止后自动归位）；距离已交给 distScale 永久旋钮

  // 呼吸/漂移的重阻尼 Spring（保留 M2 的 Spring(0.15,1.0) 手持质感）
  private readonly breathSpring = new Spring(0.2, 1.0)
  private readonly driftYawSpring = new Spring(0.15, 1.0)
  private readonly driftPitchSpring = new Spring(0.15, 1.0)
  // drop dolly-out：镜头是「重物」，attack 60ms 比粒子慢，release 800ms（拉远要有停留感，猛拉猛回像故障）
  private readonly dropArPulse = new ArPulse(0.06, 0.8)
  private prevDropPulse = 0 // 上一帧 uDrop，用于上升沿检测（否则衰减中每帧都满足 trigger 条件，release 永不生效）

  // 环绕（Phase D）：叙事驱动的缓慢公转。Spring 平滑转速（起停无顿挫），yaw 累积量叠进旋转链。
  // 累积角是无界随机游走（burst 每秒 ~3.4°），挪进 proxy 是为了归位能用 gsap tween 平滑归零
  // ——与 sectionProxy/manualProxy 同族纪律：GSAP 只写 proxy，update 每帧读进 camera
  private readonly orbitSpring = new Spring(0.2, 1.0)
  private readonly orbitProxy = { yaw: 0 }
  private orbitDir = 1 // 每段落边沿哈希翻转 ±1（确定性）
  private narrative: NarrativeState = { phase: 'steady', progress: 0 }
  private liveliness = 1 // 运镜活跃度旋钮：只乘新手法（环绕/FOV 冲击/drop 拉远），spec §6
  private distScale = 1 // 默认距离倍率旋钮：等比缩放所有机位距离（0.7 贴近派 ↔ 1.3 远观派）
  private onDistScaleChange: ((v: number) => void) | null = null // 滚轮改默认距离 → 冒泡给场景持久化（与滑块同源）

  // FOV 冲击（Phase D）：重拍瞬间焦段猛缩弹回，安全上限/限频写死在 FovPunch 内
  private readonly fovPunch = new FovPunch()

  // 手动接管状态
  private manualHold = false // 手动接管中（含 4s 静止窗口 + 归位过渡）
  private manualIdle = 0
  private returning = false // 归位 tween 进行中
  private homing = false // returnHome() 的 orbitYaw 归位 tween 进行中：刹住环绕，避免「边归位边公转」
  private dragging = false
  private lastX = 0
  private lastY = 0

  private manualEnabled = true // 小窗态由 T6 置 false，禁手动运镜输入
  private uiDist = 0 // uiFocus 后拉偏移（目标值已被 ui-stage 包络平滑，这里每帧直读）
  // calm 系数专用平滑源：初值 1（冷启动别把镜头压死）。不用 signals.energy（引擎单级 2s EMA）——
  // 常驻动效（粒子/背景）走 SignalRig 的 uEnergy（原始值再叠一级 EnvelopeFollower(0.5,2.0)），
  // 两条支路平滑源分叉会让「安静收敛」拆成两截（镜头先收、粒子/背景滞后 ~2s）。T5 复审统一。
  private calmEnergy = 1

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.manualEnabled) return
    this.dragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.beginManual()
  }
  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.manualEnabled) return
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.manualProxy.yaw -= dx * DRAG_SENS
    this.manualProxy.pitch = clamp(this.manualProxy.pitch + dy * DRAG_SENS, -PITCH_LIMIT, PITCH_LIMIT)
    this.beginManual()
  }
  private readonly onPointerUp = (): void => {
    this.dragging = false
  }
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.manualEnabled) return
    e.preventDefault()
    // 滚轮直接改「默认距离倍率」distScale——调到哪粘到哪，不再是几秒后飘回的临时偏移。
    // 本帧立即写进 this.distScale（无跳变：下一帧 setDistScale 用同值覆盖），并冒泡给场景持久化，
    // 使调音台距离滑块与之联动、重启后保留（用户拍板 #镜头精修 ①）。
    const L = CAMERA_LIMITS.distScale
    const next = clamp(this.distScale + e.deltaY * WHEEL_SENS_SCALE, L.min, L.max)
    if (next === this.distScale) return
    this.distScale = next
    this.onDistScaleChange?.(next)
  }
  private readonly onDblClick = (): void => {
    if (!this.manualEnabled) return
    // 双击回默认机位：段落回 HOME + 手动偏移归零，随后恢复自动
    this.returnHome()
  }

  /** 归位：段落回 HOME + 手动偏移归零 + 环绕方位归零（双击 / 关闭手动运镜时共用，逐行保持原 onDblClick 行为） */
  private returnHome(): void {
    gsap.killTweensOf(this.manualProxy)
    gsap.killTweensOf(this.sectionProxy)
    gsap.killTweensOf(this.orbitProxy)
    this.currentPreset = 0
    gsap.to(this.sectionProxy, {
      ...PRESETS[0],
      duration: MANUAL_RETURN_SEC,
      ease: (t: number) => easeDrift(t)
    })
    gsap.to(this.manualProxy, {
      yaw: 0,
      pitch: 0,
      duration: MANUAL_RETURN_SEC,
      ease: (t: number) => easeDrift(t)
    })
    // orbitYaw 是逐段落哈希翻向的无界随机游走（burst 30s≈103°）——直接 tween 到 0 会绕远路
    // （比如累积到 200° 时会倒转穿越大半圈才归零，观感像镜头突然反转）。先折叠到 (−π, π] 走最短弧，
    // 再 tween：视觉上永远是「就近转回正面」，不是「倒转回正面」
    this.orbitProxy.yaw -= 2 * Math.PI * Math.round(this.orbitProxy.yaw / (2 * Math.PI))
    this.homing = true // 归位 tween 期间刹住环绕（见 update() 里 orbitTarget 门控），避免边归位边公转
    gsap.to(this.orbitProxy, {
      yaw: 0,
      duration: MANUAL_RETURN_SEC,
      ease: (t: number) => easeDrift(t),
      onComplete: () => {
        this.homing = false
      }
    })
    this.dragging = false
    this.manualHold = false
    this.returning = false
  }

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera
    this.dom = dom
    dom.addEventListener('pointerdown', this.onPointerDown)
    dom.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    dom.addEventListener('dblclick', this.onDblClick)
  }

  /** 小窗态禁手动运镜：输入全部早退；关闭瞬间把已有手动偏移缓回，避免冻在半途 */
  setManualEnabled(on: boolean): void {
    if (this.manualEnabled === on) return
    this.manualEnabled = on
    if (!on) this.returnHome()
  }

  setUiDist(d: number): void {
    this.uiDist = d
  }

  /** calm 系数平滑源：调用侧传入 SignalRig 的 uEnergy（与常驻动效同源），保持「安静收敛」是一个整体动作 */
  setCalmEnergy(v: number): void {
    this.calmEnergy = v
  }

  /** 叙事状态：调用侧每帧传 rig.narrative（与方言层同源，全场一个剧本） */
  setNarrative(n: NarrativeState): void {
    this.narrative = n
  }

  /** 运镜活跃度旋钮（settings.camera.liveliness）：调用侧每帧直读闭包，无序竞态 */
  setLiveliness(v: number): void {
    this.liveliness = v
  }

  /** 默认距离倍率旋钮（settings.camera.distScale）：注入方式同 setLiveliness */
  setDistScale(v: number): void {
    this.distScale = v
  }

  /** 滚轮改默认距离时回调（新值已 clamp 到 CAMERA_LIMITS）：场景侧接住 → 更新 cameraSettings + 持久化 */
  setOnDistScaleChange(cb: (v: number) => void): void {
    this.onDistScaleChange = cb
  }

  /** 任何手动输入：暂停自动运镜、复位静止计时、打断归位 tween（含 returnHome 的 orbitYaw 归位） */
  private beginManual(): void {
    this.manualHold = true
    this.manualIdle = 0
    if (this.returning) {
      gsap.killTweensOf(this.manualProxy)
      this.returning = false
    }
    if (this.homing) {
      // 双击回默认后用户又立刻拖拽/滚轮：orbitYaw 归位 tween 继续跑会跟手动 yaw 打架，镜像上面对 returning 的处理
      gsap.killTweensOf(this.orbitProxy)
      this.homing = false
    }
  }

  update(dt: number, signals: Signals | null, dropPulse: number): void {
    this.time += dt
    const camDt = Math.min(dt, CAM_DT_CAP)
    const bpm = signals?.bpm ?? null
    const energy = signals?.energy ?? 0

    // ── 段落检测每帧必跑：手动接管期间也持续喂 EMA（否则恢复自动瞬间会凭陈旧的
    //    fast/slow 状态立即误报边沿），只是 manualHold 时忽略其返回值不切机位 ──
    const sectionEdge = this.tracker.update(energy, dt)

    // ── 手动接管：静止 4s 后 easeDrift 3s 缓慢归位，归位完成恢复自动 ──
    if (this.manualHold) {
      this.manualIdle += dt
      if (!this.returning && this.manualIdle >= MANUAL_IDLE_SEC) {
        this.returning = true
        gsap.to(this.manualProxy, {
          yaw: 0,
          pitch: 0,
          duration: MANUAL_RETURN_SEC,
          ease: (t: number) => easeDrift(t),
          onComplete: () => {
            this.manualHold = false
            this.returning = false
          }
        })
      }
    } else {
      // ── 段落边沿：GSAP tween 到下一个不同机位（位置 + fov），仅此处换机位/焦段 ──
      if (sectionEdge) {
        this.sectionCount++
        const next = pickNextPreset(this.currentPreset, this.calmEnergy, this.sectionCount)
        this.currentPreset = next
        this.orbitDir = hash01(this.sectionCount + 0.5) < 0.5 ? -1 : 1 // +0.5 与选池哈希错开序列
        gsap.killTweensOf(this.sectionProxy)
        gsap.to(this.sectionProxy, {
          x: PRESETS[next].x,
          y: PRESETS[next].y,
          z: PRESETS[next].z,
          fov: PRESETS[next].fov,
          duration: quantizeToBeatGrid(4, bpm, [4, 8]), // 1-2 小节
          ease: (t: number) => easeDrift(t)
        })
      }
    }

    // ── 1) 机位基准：从 GSAP 写好的 sectionProxy 读出。距离偏好倍率在此生效——
    //    乘在基准距离上（而非最终 dist），机位间比例、呼吸 ±3% 都等比跟随，方向/俯仰不受影响 ──
    const basePos = new THREE.Vector3(this.sectionProxy.x, this.sectionProxy.y, this.sectionProxy.z)
    const baseDist = basePos.length() * this.distScale
    const radialDir = basePos.clone().normalize()

    // ── 常驻动效（呼吸/漂移）幅度挂段落能量：×lerp(0.35,1,calmEnergy)——安静段落镜头也安静，
    //    动静对比留给音乐自己说话（T5）。读 calmEnergy（SignalRig 平滑后的 uEnergy），不读原始
    //    signals.energy——与粒子/背景常驻动效同源，避免「安静收敛」拆成两截（T5 复审）──
    const calm = 0.35 + 0.65 * this.calmEnergy

    // ── 2) 节拍呼吸推拉：沿视线 dolly ±3%，周期 2-4 小节，重阻尼 ──
    const breathPeriod = quantizeToBeatGrid(8, bpm, [8, 16])
    const breathTarget = BREATH_RATIO * calm * baseDist * Math.sin((2 * Math.PI * this.time) / breathPeriod)
    const breath = this.breathSpring.update(breathTarget, camDt)

    // ── 3) drop 冲击：dolly-out（ArPulse 形状，拉远看全貌）+ 镜头微震（× dropPulse）──
    // 仅在 uDrop 上升沿 trigger 一次；否则衰减中的 uDrop 每帧都满足 ArPulse 的 strength>=value 条件、
    // 把包络钉在 attack 段，800ms release 永远走不到（每帧误重触发）。
    if (dropPulse > this.prevDropPulse + 0.01) this.dropArPulse.trigger(dropPulse)
    this.prevDropPulse = dropPulse
    const dropDolly = DROP_DOLLY * this.liveliness * this.dropArPulse.update(camDt)
    const shakeYaw = SHAKE_AMP * dropPulse * Math.sin(this.time * 37.1)
    const shakePitch = SHAKE_AMP * dropPulse * Math.sin(this.time * 29.3 + 1.7)

    // ── 3.5) FOV 冲击（Phase D）：只在 burst armed，重拍瞬间焦段猛缩弹回；限频/上限在 FovPunch 内写死 ──
    if (signals?.beat.onBeat) {
      this.fovPunch.onBeat(
        signals.beat.strength, bpm,
        this.narrative.phase === 'burst' && !this.manualHold,
        this.liveliness
      )
    }
    const punchDeg = this.fovPunch.update(camDt)

    // ── 4) 手持漂移：段落内 yaw/pitch 低频噪声 ±0.02rad，重阻尼 Spring（幅度同挂 calm）──
    const driftPeriod = quantizeToBeatGrid(16, bpm, [16, 32]) // 约 8 小节
    const driftAmp = DRIFT_AMP * calm
    const driftYaw = this.driftYawSpring.update(driftAmp * Math.sin((2 * Math.PI * this.time) / driftPeriod), camDt)
    const driftPitch = this.driftPitchSpring.update(
      driftAmp * Math.sin((2 * Math.PI * this.time) / (driftPeriod * 1.3) + 0.7),
      camDt
    )

    // ── 4.5) 环绕公转（Phase D）：转速 = 峰值 × 叙事门 × 活跃度，重阻尼 Spring 起停；
    //    手动接管期间目标归零（Spring 自然刹车），恢复自动再起转 ──
    const orbitTarget = this.manualHold || this.homing
      ? 0
      : ORBIT_SPEED_MAX * orbitGain(this.narrative) * this.liveliness * this.orbitDir
    const orbitSpeed = this.orbitSpring.update(orbitTarget, camDt)
    // homing 期间 orbitProxy.yaw 由 GSAP tween 直接写（归位到 0）——这里只让 Spring 的内部速度
    // 状态继续向 0 衰减（避免归位结束瞬间残留速度导致跳变），但不再手动累加位置，否则与 GSAP 写值打架
    if (!this.homing) this.orbitProxy.yaw += orbitSpeed * camDt

    // ── 组装：距离（呼吸/drop 向内推）→ clamp → 手动距离偏移 + uiFocus 后拉偏移 → 旋转 → lookAt ──
    // uiFocus 后拉也乘 distScale：面板退台的「让位感」是屏幕占比语义（∝ 相对距离变化），
    // 绝对偏移在贴近档会猛拽（1.5→2.3 缩 35%）、远眺档几乎无感（9→9.8 缩 8%），等比后各档一致
    let dist = baseDist - breath - dropDolly + this.uiDist * this.distScale
    dist = clamp(dist, DIST_MIN * this.distScale, DIST_MAX * this.distScale)

    const yaw = driftYaw + shakeYaw + this.orbitProxy.yaw + this.manualProxy.yaw
    const rawPitch = driftPitch + shakePitch + this.manualProxy.pitch
    // 防穿面：按当前 dist 反解允许俯仰区间（软地板留微扰余量），组装后硬钳兜底（正常路径不触发）
    const pitch = clampPitchForFloor(rawPitch, radialDir.y, radialDir.z, dist, CAM_FLOOR_Y)
    const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ')

    const pos = radialDir.multiplyScalar(dist).applyEuler(euler)
    if (pos.y < CAM_HARD_FLOOR_Y) pos.y = CAM_HARD_FLOOR_Y
    this.camera.position.copy(pos)
    this.camera.lookAt(0, 0, 0)

    // fov = 机位基准（GSAP 写 proxy）− 冲击偏移（本类自算）——冲击不写 proxy，两轨叠加互不打架
    const effFov = this.sectionProxy.fov - punchDeg
    if (Math.abs(this.camera.fov - effFov) > 1e-3) {
      this.camera.fov = effFov
      this.camera.updateProjectionMatrix()
    }
  }

  dispose(): void {
    gsap.killTweensOf(this.sectionProxy)
    gsap.killTweensOf(this.manualProxy)
    gsap.killTweensOf(this.orbitProxy)
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    this.dom.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.dom.removeEventListener('wheel', this.onWheel)
    this.dom.removeEventListener('dblclick', this.onDblClick)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 确定性哈希 → [0,1)（signal-rig 同款 fract(sin(n*127.1)*43758.5453)），驱动机位轮换步长 */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

/** 能量选池 + 哈希定序（Phase D）：确定性、同池排除 current；current 不在池内时全池可达 */
export function pickNextPreset(current: number, calmEnergy: number, seq: number): number {
  const pool = calmEnergy < QUIET_ENERGY_MAX ? QUIET_POOL : ACTIVE_POOL
  const candidates = pool.filter((i) => i !== current)
  return candidates[Math.floor(hash01(seq) * candidates.length)]
}

/** 叙事 → 环绕转速门：蓄力随 progress 爬升给「有事要发生」的预感，爆发满速，其余静止 */
export function orbitGain(n: NarrativeState): number {
  if (n.phase === 'burst') return 1
  if (n.phase === 'build') return n.progress
  return 0
}

/**
 * 防穿面俯仰包络（虚空之镜）：y = dist·(dirY·cos p − dirZ·sin p) = dist·C·cos(p+δ)，
 * C=√(dirY²+dirZ²)、δ=atan2(dirZ, dirY)。y ≥ yMin ⇔ p ∈ [−δ−θ, −δ+θ]，θ=acos(min(1, yMin/(dist·C)))。
 * 钳 pitch 而非钳 camera.y：运镜仍在球面上滑动，手感连续（评审 P0 修正）。
 * yMin/(dist·C) ≤ −1 时任何俯仰都安全（近距），不干预；≥1 时（理论不可达）钳到最优 −δ。
 */
export function clampPitchForFloor(pitch: number, dirY: number, dirZ: number, dist: number, yMin: number): number {
  const C = Math.hypot(dirY, dirZ)
  if (C < 1e-6 || dist <= 1e-6) return pitch
  const m = yMin / (dist * C)
  if (m <= -1) return pitch
  const delta = Math.atan2(dirZ, dirY)
  const theta = Math.acos(Math.min(1, m))
  return clamp(pitch, -delta - theta, -delta + theta)
}

/**
 * FOV 冲击（Phase D）：重拍瞬间焦段猛缩再弹回——MV 式打击感。安全纪律全在类内写死：
 * 只在 armed（burst 且非手动接管）触发、strength≥0.6、限频 max(0.8s, 2拍)、峰值 ≤6°。
 * 输出是「度数偏移」，组装时从 sectionProxy.fov 上减——不写 proxy，不与 GSAP 打架。
 */
export class FovPunch {
  private readonly pulse = new ArPulse(0.03, 0.12)
  private t = 0
  private lastTriggerAt = -Infinity

  onBeat(strength: number, bpm: number | null, armed: boolean, gain: number): void {
    if (!armed || strength < 0.6) return
    if (gain <= 0) return // 旋钮拧到 0：无输出，也不占限频窗口——否则旋钮拧上来的第一记强拍会被白白吞掉
    const minGap = Math.max(PUNCH_MIN_GAP_SEC, bpm ? 120 / bpm : 1)
    if (this.t - this.lastTriggerAt < minGap) return
    this.lastTriggerAt = this.t
    this.pulse.trigger(Math.min(PUNCH_MAX_DEG, PUNCH_DEG * strength * gain))
  }

  update(dt: number): number {
    this.t += dt
    return this.pulse.update(dt)
  }
}
