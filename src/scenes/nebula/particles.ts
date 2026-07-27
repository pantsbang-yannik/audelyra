import * as THREE from 'three/webgpu'
import {
  Fn, If, instancedArray, instanceIndex, uniform, float, vec3, vec4, vec2, hash, cross,
  mx_noise_float, mx_noise_vec3, smoothstep, mix, length, normalize, uv, positionView, saturate,
  modelViewMatrix, atan
} from 'three/tsl'
import type { ShapePointCloud } from './cover-points'

/** 全部为 three 的 uniform 节点，CPU 侧写 .value（Task 7 SignalRig 驱动全部；本任务仅 uDt/uTime/uDrive 更新） */
export interface NebulaUniforms {
  uDt: { value: number }
  uTime: { value: number }
  uDrive: { value: number } // loudness 包络 0..1 → 流场总强度
  uLow: { value: number } // 低频占比×drive → 潮汐幅度
  uMid: { value: number } // 中频占比×drive → C2 尺度分层的中尺度波纹（C1 只建插座，kernel 未消费）
  uHigh: { value: number } // 高频占比×drive → 材质色路细碎闪烁（T12a：亮度语义，运动域已退役）
  uBeat: { value: number } // 鼓点余韵脉冲 0..1（松弛窗/冲击波增益，衰减由 CPU Pulse 管）
  uBeatCenter: { value: THREE.Vector3 } // 本次凿击位置（轮换）
  uBeatGlow: { value: number } // 鼓点亮度模式的脉冲
  uKick: { value: number } // 单帧打击冲量（速度跳变=干脆；鼓点帧非零，其余帧 0）
  uKickMode: { value: number } // 0=径向凿击 1=涡旋拧转 2=环形冲击波
  uBeatAge: { value: number } // 距上次鼓点秒数（冲击波半径时钟）
  uKickEnv: { value: number } // 律动包络（attack=0 / release 90ms）→ 渲染时位移，"频谱柱式"快速起落
  uTempo: { value: number } // BPM 归一 0.7..1.6，全场速度感
  uDrop: { value: number } // drop 爆发脉冲
  uSleep: { value: number } // 0=清醒 1=沉睡幕布
  uSleepBreath: { value: number } // 沉睡明度呼吸相位 0..1（CPU 按 25s 周期算）
  uEnergy: { value: number } // 段落能量包络 → 软边界半径（低能量收拢聚光="黑暗中的舞台"）
  uMorph: { value: number } // 0=自由星云 1=吸附封面目标
  uFocusDist: { value: number } // 焦平面到相机的距离（= camera.position.length()，index 每帧同步）——CoC 焦外散景锚点
  uColorA: { value: THREE.Color } // 三色系统：primary
  uColorB: { value: THREE.Color } // deep
  uColorC: { value: THREE.Color } // highlight
  uUiDim: { value: number } // UI 退台调光：1=舞台全亮，UI 前置时收到 ~0.55
  uUiDefocus: { value: number } // UI 退台整体退焦：抬高 CoC 下限，星云成为 UI 的失焦远景层
  uPulseSpace: { value: number } // 全场弹性脉冲（Task 7，AudioVisualMapper 驱动）：膨胀/pop 分量 0..~1.5（软限幅 CAP 1.25 + 弹簧过冲）
  uPulseBright: { value: number } // 全场弹性脉冲：提亮分量
  uThicken: { value: number } // 映射厚度（调音台规范化）：低频重量→粒径饱满乘子，1=中性（index 1.5 段每帧写入）
  uTargetHasColor: { value: number } // 1=目标点云自带颜色（封面像素）；0=无色几何形状，morph=1 仍走情绪三色（spec §4.2）
  uTargetPlanar: { value: number } // 1=薄板目标（封面）：亮度补偿/打击站位 z 压平生效；几何形状 0（spec §4.4）
  uShatter: { value: number } // 形状切换「碎」相：单帧打碎冲量（同 uKick 语义，场景侧写入后下一帧清零，B1 亲验反馈轮③）
  uGather: { value: number } // 形状切换「聚」相：弹簧刚度临时增益 0..1，场景侧按时间衰减（B1 亲验反馈轮③）
  // —— C2 方言 uniform（MotionProgram 名下，index.ts 分工注释为锚；kernel/材质纯消费）——
  uSwellAmp: { value: number } // 低频→大尺度鼓包幅度（径向涌动）
  uRippleAmp: { value: number } // 中频→中尺度波纹幅度
  uJitterAmp: { value: number } // 高频→细尺度毛刺（速度噪声；亮度分量见 uTwinkleAmp）
  uWaveSpeed: { value: number } // 波前扩张速率倍率（旋钮）
  uWavefrontAmp: { value: number } // 波前强度（轰炸强度旋钮）
  uBuildSqueeze: { value: number } // 蓄力向心收缩 0..1（叙事 build 相）
  uNarrDim: { value: number } // 叙事亮度乘子（蓄力变暗/尾音回落），1=无叙事加成
  uFlash: { value: number } // 闪白脉冲（光敏安全门后的值；材质亮度突增）
  uTwinkleAmp: { value: number } // 细碎闪烁幅度缩放（细节密度旋钮）
  // —— 方言家族（方言期批1，DialectConductor 名下；kernel/材质纯消费）——
  uDialContour: { value: number } // 1=表面法线约束家族（雕像/心脏）：律动力方向→aux 法线（鼓面模式曲面版）
  uDialHeart: { value: number } // 1=心脏家族：泵动力启用（含 contour 约束）
  uDialCrystal: { value: number } // 1=晶体家族：棱边尖刺+棱光脉冲+内核打拍（批2）
  uHeartPulse: { value: number } // 心脏收缩包络 0..1.2（鼓点/自主心跳，Conductor 驱动）
  uPointBeat: { value: number } // 点源打击语法权重（批1-fb1）：1=圆形凿击/波前/尖刺/位移层照常（星云/星球/封面）；0=三新家族退役点源，各用形状原生打击
  uBodyDim: { value: number } // 线条系交接：粒子整体透明度乘子（编排层 crossfade 喂，1=全显）
}

// 聚合窗口阻尼增益（B1-fb4 手感旋钮）：uGather=1 时阻尼 1.2→8.7, 对刚度 27 的 ζ≈0.84——
// 2026-07-10 用户调参 6.0→7.5：弹性幅度压到很低但不归零（到站近乎直接吸住，留一丝软回弹）。
// 数值边界：uSleep=1∧uGather=1 且 dt 撞 0.1 clamp 时 dt·c≈1.15，|1-dt·c|<1 仍收敛（真失稳需 dt·c>2），安全
const GATHER_DAMP_BOOST = 7.8

// 定格阻尼（形状改造②）：到位粒子按"距目标残余距离"叠加阻尼——gather 窗口(1.1s)按时撒手后
// 基础 ζ≈0.2 的震铃由此消灭（没到位的粒子不受影响，继续全速飞向目标 = "按到位程度撒手"）。
// 到位后 ζ=(1.2+5.5)/(2√9)≈1.12 微过临界：吸住即定，软回弹来自入带前最后一次欠阻尼过冲。
// uMorph 门控：自由态星云权重恒零，"活泼惯性"不受影响。方言大位移(心脏泵动等)超出 far 带自动豁免；
// 带内小位移(区域呼吸/涟漪)幅度略受压，观感发闷时优先收窄 far 而非降 damp（亲验调参点）。
// 数值稳定：dt clamp 0.1 最坏 dt·c=0.1×(4+7.8+5.5)=1.73<2 仍收敛（同 GATHER_DAMP_BOOST 边界论证）
export const SETTLE = { damp: 5.5, near: 0.06, far: 0.35 } as const

// 心脏泵动力度（方言批1手感常量）：uHeartPulse 峰值 ~1 × 此系数 × dt = 收缩速度增量。
// 参照系：蓄力收缩 1.6 / 区域呼吸 2.4 / 波前 26×dt——泵动要一眼可读（整体收缩）但不散形（弹簧拉得回）
const HEART_PUMP_GAIN = 5.0

// —— curl noise：vec3 势场 ψ 的旋度（∇×ψ 天然无散度）。中央差分，6 次 mx_noise_vec3 评估
// （评审修订：原两梯度叉积需 12 次标量噪声/粒子/帧，改势场旋度成本减半；e=0.1 降高频颤动）——
const curl = /* @__PURE__ */ Fn(([p]: [THREE.Node<'vec3'>]) => {
  const e = float(0.1)
  const dx = mx_noise_vec3(p.add(vec3(e, 0, 0))).sub(mx_noise_vec3(p.sub(vec3(e, 0, 0))))
  const dy = mx_noise_vec3(p.add(vec3(0, e, 0))).sub(mx_noise_vec3(p.sub(vec3(0, e, 0))))
  const dz = mx_noise_vec3(p.add(vec3(0, 0, e))).sub(mx_noise_vec3(p.sub(vec3(0, 0, e))))
  // ∇×ψ = (∂ψz/∂y−∂ψy/∂z, ∂ψx/∂z−∂ψz/∂x, ∂ψy/∂x−∂ψx/∂y)
  return vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).div(e.mul(2)).mul(0.5)
})

export class NebulaParticles {
  readonly mesh: THREE.InstancedMesh
  readonly uniforms: NebulaUniforms

  private readonly count: number
  private readonly positions: THREE.StorageBufferNode<'vec3'>
  private readonly velocities: THREE.StorageBufferNode<'vec3'>
  private readonly targets: THREE.StorageBufferNode<'vec3'>
  private readonly targetColors: THREE.StorageBufferNode<'vec3'>
  private readonly auxs: THREE.StorageBufferNode<'vec4'> // 逐粒子附加数据（方言底座，Task 7 kernel 消费；本任务仅建通道）
  private readonly defaultTargets: Float32Array // 构造时保存的球壳分布 = 星云默认目标（setTargets(null) 写回它）
  private readonly computeInitNode: THREE.ComputeNode
  private readonly computeUpdateNode: THREE.ComputeNode
  private readonly geometry: THREE.PlaneGeometry
  private readonly material: THREE.SpriteNodeMaterial

  constructor(count: number) {
    this.count = count

    // —— storage buffers（instancedArray 泛型跟着字面量走，kernel 引用保持同作用域内联，见 M2-conclusions ③）——
    const positions = instancedArray(count, 'vec3')
    const velocities = instancedArray(count, 'vec3')
    const targets = instancedArray(count, 'vec3')
    const targetColors = instancedArray(count, 'vec3')
    const auxs = instancedArray(count, 'vec4')
    this.positions = positions
    this.velocities = velocities
    this.targets = targets
    this.targetColors = targetColors
    this.auxs = auxs

    // —— uniforms（默认值见任务上下文：uEnergy=1.0 撑开软边界，其余脉冲/形变 0）——
    const uDt = uniform(0)
    const uTime = uniform(0)
    const uDrive = uniform(0)
    const uLow = uniform(0)
    const uMid = uniform(0)
    const uHigh = uniform(0)
    const uBeat = uniform(0)
    const uBeatCenter = uniform(new THREE.Vector3(0, 0, 0))
    const uBeatGlow = uniform(0)
    const uKick = uniform(0)
    const uKickMode = uniform(0)
    const uBeatAge = uniform(2)
    const uKickEnv = uniform(0)
    const uTempo = uniform(1)
    const uDrop = uniform(0)
    const uSleep = uniform(0)
    const uSleepBreath = uniform(0)
    const uEnergy = uniform(1)
    const uMorph = uniform(0)
    const uFocusDist = uniform(2.2) // 默认=BASE_CAM 到原点距离；index 每帧覆写为 camera.position.length()
    const uColorA = uniform(new THREE.Color(0.35, 0.5, 1.0))
    const uColorB = uniform(new THREE.Color(0.12, 0.1, 0.4))
    const uColorC = uniform(new THREE.Color(0.85, 0.92, 1.0))
    const uUiDim = uniform(1) // UI 退台调光：1=舞台全亮，UI 前置时收到 ~0.55
    const uUiDefocus = uniform(0) // UI 退台整体退焦：抬高 CoC 下限，星云成为 UI 的失焦远景层
    const uPulseSpace = uniform(0) // 全场弹性脉冲：膨胀/pop 分量（Task 7，index 每帧由 AudioVisualMapper 写入）
    const uPulseBright = uniform(0) // 全场弹性脉冲：提亮分量
    const uThicken = uniform(1) // 映射厚度：默认 1 无副作用
    const uTargetHasColor = uniform(1) // 默认 1=封面语义（Phase B1 T4，翻转责任在 Task 7 编排层）
    const uTargetPlanar = uniform(1) // 默认 1=封面语义（Phase B1 T4，翻转责任在 Task 7 编排层）
    const uShatter = uniform(0) // 默认 0：无副作用（B1 亲验反馈轮③，场景侧编排层驱动）
    const uGather = uniform(0) // 默认 0：无副作用（B1 亲验反馈轮③，场景侧编排层驱动）
    const uSwellAmp = uniform(0)
    const uRippleAmp = uniform(0)
    const uJitterAmp = uniform(0)
    const uWaveSpeed = uniform(1)
    const uWavefrontAmp = uniform(1)
    const uBuildSqueeze = uniform(0)
    const uNarrDim = uniform(1)
    const uFlash = uniform(0)
    const uTwinkleAmp = uniform(1)
    const uDialContour = uniform(0)
    const uDialHeart = uniform(0)
    const uDialCrystal = uniform(0)
    const uHeartPulse = uniform(0)
    const uPointBeat = uniform(1)
    const uBodyDim = uniform(1)
    this.uniforms = {
      uDt, uTime, uDrive, uLow, uMid, uHigh, uBeat, uBeatCenter, uBeatGlow,
      uKick, uKickMode, uBeatAge, uKickEnv, uTempo,
      uDrop, uSleep, uSleepBreath, uEnergy, uMorph, uFocusDist, uColorA, uColorB, uColorC,
      uUiDim, uUiDefocus, uPulseSpace, uPulseBright, uThicken, uTargetHasColor, uTargetPlanar,
      uShatter, uGather,
      uSwellAmp, uRippleAmp, uJitterAmp, uWaveSpeed, uWavefrontAmp, uBuildSqueeze, uNarrDim, uFlash, uTwinkleAmp,
      uDialContour, uDialHeart, uDialCrystal, uHeartPulse,
      uPointBeat, uBodyDim
    }

    // —— 初始化 kernel：均匀球壳分布 + 零速度 —— (targets 由 CPU 在构造末尾 seed)
    this.computeInitNode = Fn(() => {
      const pos = positions.element(instanceIndex)
      const a = hash(instanceIndex).mul(Math.PI * 2)
      const z = hash(instanceIndex.add(1)).mul(2).sub(1)
      const r = hash(instanceIndex.add(2)).mul(0.5).add(1)
      const s = z.mul(z).oneMinus().sqrt()
      pos.assign(vec3(s.mul(a.cos()), s.mul(a.sin()), z).mul(r))
      velocities.element(instanceIndex).assign(vec3(0))
    })().compute(count)

    // —— 每帧更新 kernel：一个 Fn 内按顺序叠加各力（每种力一段注释）——
    this.computeUpdateNode = Fn(() => {
      const pos = positions.element(instanceIndex)
      const vel = velocities.element(instanceIndex)

      // 1) 基础 curl 流场：星云的呼吸底色，强度随 uDrive×uTempo（快歌全场更快）。
      //    0.08 底噪是"不听音乐也在动"的闲置湍流——T5 挂上段落能量（×lerp(0.35,1,uEnergy)）：
      //    安静段落舞台跟着收敛，视觉不再拖累音乐自己的动静对比（北极星：赋能节奏感）
      //    T10c（Phase C1）收静：安静端 0.35→0.12——安静要真静（0.08×0.12≈0.01 近停），
      //    动静对比的"静"这一半交给它；uEnergy 快起慢落（T10a）保证不误伤过门
      const flow = curl(pos.mul(0.6).add(vec3(0, 0, uTime.mul(0.02))))
      const idleFloor = float(0.08).mul(mix(float(0.12), float(1.0), uEnergy))
      vel.addAssign(flow.mul(uDt).mul(uDrive.mul(0.8).add(idleFloor)).mul(uTempo))

      // —— 鼓面模式权重（fb2 引入，fb3 提前到所有力之前并贯彻全部 xy 域力——用户复验实锤：
      //    fb2 只管住了新方言层，封面上最抢眼的每拍运动其实来自老的凿击/拧转/位移层/潮汐）——
      //    封面=平面目标：任何 xy 分量都会打散画面，节奏必须全部走 z（法线浮雕）。
      //    morphPlanar=1（封面吸附完成）时全部打击/律动力 方向→法线；几何形状（planar=0）不受影响
      // —— 约束权重（fb2/fb3 封面鼓面模式，方言期批1推广到任意曲面）——
      // 封面=平面目标：约束方向 planeN；雕像/心脏=曲面目标：约束方向=逐粒子表面法线（aux.xyz，S2 烘焙）。
      // 两家族互斥（cover 与 contour 不同时为 1），lockW=权重和恒 ≤1；uDialContour=0 时
      // lockW=morphPlanar、lockDir=planeN——与推广前逐项代数等价（零回归红线）
      const morphPlanar = uMorph.mul(uTargetPlanar)
      const planeN = vec3(0, 0, 1)
      // surfN：aux 未填（free/球体等，uDialContour=0 场景）时全 0，加 ε 后 normalize(0.0001,0.0001,0.0001)
      // 是有限退化向量，不会 NaN；此时 uDialContour=0 门控令 lockDir 恒取 planeN，surfN 不进任何力，安全
      const surfN = normalize(auxs.element(instanceIndex).xyz.add(0.0001))
      const lockW = morphPlanar.add(uMorph.mul(uDialContour))
      const lockDir = mix(planeN, surfN, uDialContour)
      // 径向外向单位向量（晶体方言批2 4e 尖刺复用，原 5b 声明上提）：
      // 作用域覆盖 4e 与原 5b 区域呼吸/尖刺段
      const dirOut = normalize(pos.add(0.0001))

      // 2) 低频潮汐：贴地横波，只作用于下半空间（品牌语言"低频像潮汐铺开"）；
      //    fb3：鼓面模式下归零——x 向横漂是封面画面涂抹的来源之一
      //    smoothstep 一律正向参数（edge0<edge1；反向在 GLSL 规范未定义，WebGL2 回退路径会花屏）
      const tide = mx_noise_float(vec3(pos.x.mul(0.4), uTime.mul(0.3), pos.z.mul(0.4)))
      const groundW = smoothstep(-0.5, 0.5, pos.y).oneMinus() // y 越低权重越大
      vel.x.addAssign(tide.mul(uLow).mul(groundW).mul(uDt).mul(2).mul(uTempo).mul(float(1).sub(lockW)))

      // 3) 高频通道已迁出运动域（T12a，Phase C1）：高频=亮度细碎闪烁，见材质色路 twinkle——
      //    旧"少数粒子上飘"是语义错位（听到细碎、看到漂浮），映射 spec v3 §6.3 定案

      // 4) 鼓点打击——M2 反馈二轮重做："干脆" = 单帧速度跳变（冲击），不是持续力（推挤）。
      //    uKick 只在鼓点帧非零，直接加到速度上（不乘 uDt——这是冲量不是力）；
      //    三种运动语言逐拍轮换（uKickMode），画面不落进单一"圆形扬起"的套路
      const toBeat = pos.sub(uBeatCenter)
      const beatDist = length(toBeat)
      const beatFall = smoothstep(0.0, 1.5, beatDist).oneMinus()
      const beatDir = normalize(toBeat.add(0.0001))
      If(uKick.greaterThan(0.001), () => {
        If(uKickMode.lessThan(0.5), () => {
          // 语言 0：径向凿击的物理余味（主打击已移交渲染位移层，这里减量做质感）；
          // fb3 鼓面模式：凿击方向转法线——封面上"凿"变成局部鼓面下沉/弹起
          vel.addAssign(mix(beatDir, lockDir, lockW).mul(uKick).mul(beatFall).mul(mix(float(0.7), float(1.2), uMorph)).mul(uPointBeat))
        }).ElseIf(uKickMode.lessThan(1.5), () => {
          // 语言 1：涡旋拧转——绕打击点切向拧一把（旋转的美来自物理传播，保持全量）；
          // fb3 鼓面模式：切向"拧"正是把封面扭麻花的主犯，转法线
          const tang = normalize(cross(vec3(0.2, 0.75, 0.35), toBeat).add(0.0001))
          vel.addAssign(mix(tang, lockDir, lockW).mul(uKick).mul(beatFall).mul(mix(float(1.1), float(2.2), uMorph)).mul(uPointBeat))
        })
        // 语言 2 在下方冲击波段持续展开（kick 帧只记时钟起点）
      })

      // 4b) 事件波前（C2 方言签名：每拍从打击点推出环形涟漪）——扩张速率受"波前速度"旋钮，
      //     推力受"轰炸强度"；鼓面模式下推力方向转法线：涟漪变成扫过封面的浮雕波，不撕 xy
      const ringR = uBeatAge.mul(float(3.5).mul(uWaveSpeed))
      const band = smoothstep(0.0, 0.3, ringR.sub(beatDist).abs()).oneMinus()
      const waveDir = mix(beatDir, lockDir, lockW)
      vel.addAssign(waveDir.mul(uBeat).mul(band).mul(uDt).mul(mix(float(26), float(14), lockW)).mul(uWavefrontAmp).mul(uPointBeat))

      // 4c) 雕像方言·浮雕扫波（批1-fb1）：每拍一道法线浮雕带沿雕像高度自上而下扫过——
      //     打击语法从「点源圆形」换成「整面扫波」（圆斑在雕像上退役,uPointBeat=0）。
      //     复用波前时钟 uBeatAge 与波前速度旋钮；心脏不扫（泵动是其唯一打击语义）。
      //     fb1 亲验修（"只有头在动"）：uBeat 半衰 0.18s 而全程扫完要 0.52s——扫到胸口力已剩 13%，
      //     快歌下一拍还重置时钟。①扫速 5.2→9（0.3s 扫完，快歌也走完全身）②包络开平方压平衰减
      //     （底部保留 ~56% 力度，仍随拍强弱），扫波带的"力度梯度"读作自然消散而非只动头顶
      If(uDialContour.greaterThan(0.5), () => {
        If(uDialHeart.lessThan(0.5), () => {
          const sweepY = float(1.4).sub(uBeatAge.mul(uWaveSpeed).mul(9.0))
          const sweepBand = smoothstep(0.0, 0.3, pos.y.sub(sweepY).abs()).oneMinus()
          vel.addAssign(surfN.mul(uBeat.sqrt()).mul(sweepBand).mul(uDt).mul(20))
        })
      })

      // 4e) 晶体方言·棱边尖刺（批2，fb1 铁律：形状坐标系，非点源）——鼓点瞬间粒子沿
      //     「垂直于所在棱的外向分量」炸出细刺（perp = dirOut 去掉沿棱分量后归一）；
      //     内核粒子 aux=0 → edgeW=0 力自然为零（内核的打拍走材质亮度，见色路 crystalCore）
      If(uDialCrystal.greaterThan(0.5), () => {
        If(uKick.greaterThan(0.001), () => {
          const edgeDir = auxs.element(instanceIndex).xyz
          const edgeW = length(edgeDir) // 棱上≈1 / 内核=0
          const perp = normalize(dirOut.sub(edgeDir.mul(dirOut.dot(edgeDir))).add(0.0001))
          vel.addAssign(perp.mul(uKick).mul(edgeW).mul(1.6)) // 冲量语义不乘 uDt；1.6 介于凿击/拧转之间
        })
      })

      // 5) drop 爆发：全场径向外抛（drop 是稀有事件，允许全场，但方向是径向而非缩放）；
      //    力度随段落能量加成（高潮的 drop 该更狠）；fb3 鼓面模式：爆发也走法线（整张封面朝镜头轰）
      vel.addAssign(mix(normalize(pos.add(0.0001)), lockDir, lockW).mul(uDrop).mul(uDt).mul(mix(float(5), float(9), uEnergy)))

      // 5b) C2 方言·区域呼吸 + 鼓点尖刺（fb1 重做，2026-07-11 用户亲验反馈①）——
      //     原"波长≈场半径的整场涌动"在某些节奏下=气球式鼓包；用户拍板：**小区域各自径向进出**，
      //     区域必须碎（波长 ~0.6/0.36 场半径），噪声符号=向内/向外，永远沿球心方向（参考图8态）
      //     方言方向（fb2 鼓面模式）：自由场=径向进出；封面=沿法线浮雕（xy 交给弹簧锁住，画面可读）
      const dialectDir = mix(dirOut, lockDir, lockW)
      //     低频→中碎区域呼吸（波长 1.6）：各小块自顾自地进出，不同相=不鼓包；鼓面模式幅度收敛
      const region = mx_noise_float(pos.mul(1.6).add(vec3(0, uTime.mul(0.25), 0)))
      vel.addAssign(dialectDir.mul(region).mul(uSwellAmp).mul(uDt).mul(mix(float(2.4), float(1.4), lockW)))
      //     中频→细碎区域波动（波长 2.8、更快时钟）：叠在低频区域上的次级碎浪
      const rippleR = mx_noise_float(pos.mul(2.8).add(vec3(uTime.mul(0.7), 0, 0)))
      vel.addAssign(dialectDir.mul(rippleR).mul(uRippleAmp).mul(uDt).mul(mix(float(1.6), float(1.0), lockW)))
      //     鼓点尖刺（图3/5"强劲鼓点/快速连击"）：区域场正半波 pow(3) 尖化——只有最强的少数
      //     区域在打击窗口（uKickEnv 起落）内炸出细刺；鼓面模式=朝镜头方向弹出（封面"打鼓"）
      const spike = saturate(region).pow(3)
      vel.addAssign(dialectDir.mul(spike).mul(uKickEnv).mul(uSwellAmp).mul(uDt).mul(mix(float(9), float(6), lockW)).mul(uPointBeat))
      //     高频运动毛刺已退役（fb1 绒毛感主犯；重申 C1 T12 拍板：高频=亮度语义走 twinkle）——
      //     uJitterAmp 保留为插座不消费，细节密度旋钮现在只作用于碎光闪烁
      // 5c) 叙事·蓄力收缩：drop 前全场向心"吸气"（MotionProgram 按 build progress 驱动，爆发瞬间松手）；
      //     鼓面模式衰减 70%——向心收缩会把封面 xy 挤变形，只留一点"屏息"感
      vel.addAssign(normalize(pos.add(0.0001)).negate().mul(uBuildSqueeze).mul(uDt)
        .mul(float(1.6).mul(float(1).sub(lockW.mul(0.7)))))

      // 5d) 心脏泵动（方言批1，用户拍板「音乐为主+静态微搏」）：全身沿质心收缩，回弹交给吸附弹簧
      //     ——「收缩-回弹」的心肌感；uHeartPulse 由 DialectConductor 驱动（鼓点包络/60bpm 自主微搏）。
      //     过 uMorph 门：吸附成形中才有「心」可缩；uniform 分支=全体粒子同路径，非心脏家族整段跳过
      If(uDialHeart.greaterThan(0.5), () => {
        vel.addAssign(normalize(pos.add(0.0001)).negate().mul(uHeartPulse).mul(uMorph).mul(uDt).mul(HEART_PUMP_GAIN))
      })

      // 6a) 形状切换「碎」相：单帧随机方向冲量（干脆=速度跳变，M2 结论沿用；方向逐粒子 hash 去相关，
      //     B1 亲验反馈轮③——用户主动切形状时先打碎散开，再快速聚合，全程 ~1s 而非弹簧慢拽）
      If(uShatter.greaterThan(0.001), () => {
        const dir = normalize(vec3(
          hash(instanceIndex.add(31)).sub(0.5),
          hash(instanceIndex.add(37)).sub(0.5),
          hash(instanceIndex.add(41)).sub(0.5)
        ).add(0.0001))
        vel.addAssign(dir.mul(uShatter).mul(float(0.7).add(hash(instanceIndex.add(43)).mul(0.6))))
      })

      // 6) 封面吸附：uMorph 权重下被目标点拉住。弹簧加硬（4→9）——快打快回，
      //    单帧冲量 + 硬弹簧 = 弹飞→狠拽回→轻微过冲的弹性抖动（干脆的另一半）；
      //    鼓点瞬间仍在打击半径内局部"松手"，给冲量留出形变空间；
      //    uGather 是形状切换「聚」相的刚度临时增益，逐粒子 stagger 让聚合有参差不齐感（非机械同步落地）
      const target = targets.element(instanceIndex)
      const springTarget = target
      const grip = uMorph.mul(float(1).sub(uBeat.mul(beatFall).mul(0.7)))
      const gatherStagger = float(0.7).add(hash(instanceIndex.add(47)).mul(0.6))
      const stiffness = mix(float(4), float(9), uMorph).mul(float(1).add(uGather.mul(2).mul(gatherStagger)))
      vel.addAssign(springTarget.sub(pos).mul(grip).mul(uDt).mul(stiffness))

      // 7) 沉睡：压成面向观众的 z≈0 幕布 + 缓慢蠕动（"静默平面不能是死的"）
      //    蠕动相位用连续 uTime（锯齿相位会每 25s 突跳）
      const creep = mx_noise_float(pos.mul(1.2).add(uTime.mul(0.24)))
      vel.z.addAssign(pos.z.negate().mul(uSleep).mul(uDt).mul(3))
      vel.addAssign(vec3(creep, creep.negate(), 0).mul(uSleep).mul(uDt).mul(0.05))

      // 8) 阻尼 + 软边界。基础阻尼 1.2 是"随乐飘动的活泼惯性"刻意调低值；
      //    聚合窗口内(uGather>0)同步增益阻尼——刚度拉到 ~27 时 ζ 仅 0.1 会连环过冲震荡,
      //    +6 增益把 ζ 抬到 ~0.7(轻微软回弹后定格,保弹性质感不保震铃)。窗口过后回落,律动惯性不变。
      //    半径随 uEnergy 收缩（"黑暗中的舞台"：低能量归拢聚光，高潮撑满 2.5）。
      //    下限 1.5→1.8（T5）：引擎真燃料后安静段 energy 真会探到 0.1 以下（旧引擎恒饱和 ≈1，
      //    这个收缩区间从未被真正跑到过）——1.5 时粒子密度升 ~4.6×，加色混合把核心堆成纯白球
      //    T10b（Phase C1）拉幅度：1.8..2.5→1.6..2.7——安静更收、高潮更撑（动静对比的空间维度）。
      //    1.6 比 T5 踩雷的 1.5 留一步余量，且 energyDim 暗端同步 0.6→0.45 加深补偿（联动铁律，勿单独动）
      const settleDist = length(springTarget.sub(pos))
      const settled = smoothstep(SETTLE.near, SETTLE.far, settleDist).oneMinus().mul(uMorph)
      vel.mulAssign(float(1).sub(uDt.mul(mix(float(1.2), float(4), uSleep)
        .add(uGather.mul(GATHER_DAMP_BOOST)).add(settled.mul(SETTLE.damp)))))
      const bound = mix(float(1.6), float(2.7), uEnergy).add(uPulseSpace.mul(0.85)).sub(uBuildSqueeze.mul(0.5)) // 蓄力时舞台同步收拢（吸气）；0.6→0.85：滑块全行程可感
      const dist = length(pos)
      If(dist.greaterThan(bound), () => {
        vel.addAssign(pos.div(dist).negate().mul(dist.sub(bound)).mul(uDt).mul(3))
      })

      pos.addAssign(vel.mul(uDt))
    })().compute(count)

    // —— 材质（彩虹禁令：颜色只来自三色 uniform，按 kind 与速度插值，不映射频率）——
    const mat = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true
    })
    // —— 律动位移层（M2 反馈三轮，调研结论：MilkDrop 一系的节奏响应是确定性包络驱动位移，
    //    物理模拟只做质感纹理）。uKickEnv 是 AR 包络：attack 40ms（粒子"运动过去"，
    //    位置连续，永不瞬移）→ release 110ms 快落回 simulation 位置——回弹不欠物理弹簧的债。
    //    打击半径 1.1：命中局部（凿击语义），不是每拍掀起整张封面 ——
    const simPos = positions.element(instanceIndex)
    const kickVec = simPos.sub(uBeatCenter)
    const kickDir = normalize(kickVec.add(0.0001))
    const kickFall = smoothstep(0.0, 1.1, length(kickVec)).oneMinus()
    // 每粒子幅度差异（0.7~1.3×）：整片弹出但边缘参差，避免"整块平移"的机械感
    const kickAmp = mix(float(0.1), float(0.3), uMorph).mul(float(0.7).add(hash(instanceIndex.add(13)).mul(0.6)))
    // fb3 鼓面模式 + 方言期曲面推广（材质域独立算一份权重/方向，不跨节点图复用 kernel 表达式）：
    // 位移层是每拍最显眼的运动——封面沿 z、雕像/心脏沿表面法线弹，位置恒由弹簧锁定
    const morphPlanarMat = uMorph.mul(uTargetPlanar)
    const surfNMat = normalize(auxs.element(instanceIndex).xyz.add(0.0001))
    const lockWMat = morphPlanarMat.add(uMorph.mul(uDialContour))
    const lockDirMat = mix(vec3(0, 0, 1), surfNMat, uDialContour)
    const kickDirDrum = mix(kickDir, lockDirMat, lockWMat)
    mat.positionNode = simPos
      .add(kickDirDrum.mul(uKickEnv).mul(kickFall).mul(kickAmp).mul(uPointBeat))
      .add(vec3(0, 0, 1).mul(uPulseSpace).mul(0.4)) // 全场弹性脉冲朝相机 pop（无距离衰减，Task 7）；0.25→0.4：滑块全行程可感

    const speed = length(velocities.element(instanceIndex))
    // 速度拉伸：把速度变换到视空间取屏幕平面分量，sprite 沿该方向旋转+拉长
    // （drop/凿击时局部粒子成光丝，慢速时回圆点——设计 4.5 P1）。
    const velView = modelViewMatrix.mul(vec4(velocities.element(instanceIndex), 0)).xyz
    const stretch = smoothstep(0.8, 3.0, speed).mul(2.2)
    mat.rotationNode = atan(velView.y, velView.x.add(1e-5)) // SpriteNodeMaterial 平面内旋转（Node<float>）
    const baseScale = float(0.008).add(hash(instanceIndex.add(9)).mul(0.01)) // 世界单位，多而小，自带透视衰减
    // scaleNode 从标量改 vec2：长轴 ×(1+stretch)，短轴 ÷(1+stretch×0.4)——近似保面积，亮度不炸
    const stretchScale = vec2(baseScale.mul(stretch.add(1)), baseScale.div(stretch.mul(0.4).add(1)))
    // 逐粒子 CoC 散景（设计 4.5 P1）：视深与焦平面（uFocusDist，index 每帧同步相机距离，
    // 恒锚在原点主体）的偏差→[0, 0.5] 软化系数。焦外粒子放大成柔光斑，
    // 透明度按近似面积守恒下降（放大 4 倍面积→衰减到 1/(1+4·coc)），留给 bloom 吃光斑。
    // 注意：不能用内置 positionView 节点——它在 SpriteNodeMaterial 里由 setupPositionView 内部
    // 构建，scaleNode 正是该管线的输入之一，引用 positionView 会形成自引用递归（WGSL 编译报
    // "Recursion detected"）。改用 simPos 手算视空间坐标（同 velView 手法），语义等价且无环。
    const particleViewZ = modelViewMatrix.mul(vec4(simPos, 1)).z
    const viewDepth = particleViewZ.negate()
    // fb1 锐化（2026-07-11 亲验反馈②"绒毛感"）：散景增益 0.18→0.13、上限 0.5→0.4——
    // 焦外柔化保留纵深语言，但收窄影响带，主体层粒子回到锐点
    const coc = saturate(viewDepth.sub(uFocusDist).abs().mul(0.13)).min(0.4).max(uUiDefocus.mul(0.3))
    mat.scaleNode = stretchScale.mul(coc.mul(2.5).add(1)).mul(uThicken)
    // 软圆盘 sprite（硬边方点 = "程序员可视化"第一指纹）。
    // 评审修订：oneMinus 后经 saturate 夹到 [0,1] 再 pow——sprite 四角 length 可 >0.5，
    // 若 smoothstep 未内钳则 oneMinus 出负值进 pow(1.5) 是未定义域。
    // fb1 锐化：pow 1.5→2.2——软盘边缘收紧，粒子从"绒球"回到"光点"（软边仍在，只是更窄）
    mat.opacityNode = saturate(smoothstep(0.0, 0.5, uv().sub(0.5).length()).oneMinus()).pow(2.2).mul(0.75)
      .mul(float(1).div(coc.mul(4).add(1)))
      .mul(uBodyDim) // 线条系交接：编排层 crossfade 淡出粒子（1=全显，默认无副作用）

    // 高频细碎闪烁（T12a）：高频=画面表层的"鸡皮疙瘩"——亮度快闪，不是运动。
    // 约 1/3 粒子参与（hash 门控渐入），速率/相位逐粒子去相关；pow(3) 尖峰化：
    // 大部分时间贴 0、瞬间冒尖 = "细碎"。彩虹禁令合规：只朝 uColorC 提亮，无新色相
    const twinkKind = hash(instanceIndex.add(21))
    const twinkGate = smoothstep(0.62, 0.95, twinkKind)
    const twinkRate = float(6).add(hash(instanceIndex.add(29)).mul(7)) // 6..13Hz 逐粒子
    const twinkPhase = hash(instanceIndex.add(23)).mul(Math.PI * 2)
    const twinkle = uTime.mul(twinkRate).add(twinkPhase).sin().mul(0.5).add(0.5)
      .pow(3).mul(twinkGate).mul(uHigh).mul(uTwinkleAmp)

    // 晶体方言·亮度乐器（批2，fb1 纪律：材质域独立取 aux，不复用 kernel 表达式）：
    // ①棱光脉冲——每拍一道光沿全部棱边从起点跑到终点（aux.w=沿棱相位，速度吃波前旋钮）
    // ②内核打拍——中心能量核随打击包络呼吸提亮。两项均由 uDialCrystal 门控，其余形状恒零
    const crystalAux = auxs.element(instanceIndex)
    const crystalEdgeW = length(crystalAux.xyz)
    const crystalBand = smoothstep(0.0, 0.18, crystalAux.w.sub(uBeatAge.mul(uWaveSpeed).mul(2.2)).abs()).oneMinus()
    const crystalEdgePulse = crystalBand.mul(crystalEdgeW).mul(uBeat).mul(uDialCrystal)
    const crystalCore = float(1).sub(crystalEdgeW).mul(uKickEnv).mul(uDialCrystal)

    const base = mix(uColorB, uColorA, hash(instanceIndex.add(3))) // deep↔primary 随机体
    // 封面色按 uMorph 混入（setTargets 维护 targetColors）；morph=0 时退化为 base
    const albedo = mix(base, targetColors.element(instanceIndex), uMorph.mul(uTargetHasColor))
    // 鼓点辉光局部化（半径略大于形变的 1.2）；
    // 4.6 律动重定义（用户已拍板）：禁「廉价爆闪级」整体脉冲；允许低幅度、锁 BPM、
    // 弹性过冲呼吸的「点头级」整体脉动（uPulseSpace/uPulseBright，见 mapping 层）。
    const glowFall = smoothstep(0.0, 1.6, positions.element(instanceIndex).sub(uBeatCenter).length()).oneMinus()
    // 变亮总权重（原内联在 mix 里，现提出来驱动「色温层次」两段过渡）
    const glowT = saturate(smoothstep(0.5, 2.0, speed).mul(0.6) // 高速粒子发光（冲量重做后整体速度上移，阈值同步上调防泛白）
      .add(uBeatGlow.mul(0.55).mul(glowFall).mul(uPointBeat)) // 鼓点亮度模式（局部；M2 反馈上调 0.4→0.55）
      .add(uPulseBright.mul(0.3)) // 全场脉冲提亮，无距离衰减（4.6 重定义，Task 7）；0.18→0.3：滑块可感下限，仍守「点头级」不爆闪
      .add(twinkle.mul(0.5)) // T12a 高频碎光闪烁
      .add(crystalEdgePulse.mul(0.5)) // 晶体棱光脉冲
      .add(crystalCore.mul(0.45))) // 晶体内核打拍；saturate 钳总权重防叠加外插爆白
    // 色温层次（#光效精修 ③·三版，用户参考图：核心白 → 外缘饱和色）：
    // 病根——原来 lit 一变亮就 mix 到 uColorC（highlight 在 remapToMood 里特意低饱和≈白），
    // 于是「越亮越灰白」= 廉价发光。改为两段色温，复刻参考图「白核 + 饱和晕」的规律：
    //   ① 发光腰部 → 染上饱和主色调 uColorA（primary，随②调色总线：暖歌暖、冷歌冷）
    //   ② 只有最亮核心（glowT 后段）→ 才过渡到近白 uColorC，形成刺破的白核
    const lit = mix(
      mix(albedo, uColorA, glowT),        // 腰部：饱和主色调（保 albedo 起点，morph 时封面色仍在）
      uColorC,                            // 核心：近白高光
      smoothstep(0.72, 1.0, glowT)        // 仅最强发光（glowT>0.72）才趋白，其余保持饱和色
    )
    // 深度调暗：远粒子沉入暗部（纵深线索，也是"黑是奢侈品"的落地之一）
    const depthDim = smoothstep(1.0, 4.5, positionView.z.negate()).oneMinus().mul(0.75).add(0.25)
    // 封面亮度补偿：morph 聚拢时粒子挤进薄板不补偿会加色过曝奔白（0.35 起调）；
    // 沉睡整体压暗至 0.12 并叠 25s 明度呼吸
    // 方言期批1：有意不推广到 uDialContour——薄板挤压过曝是平面特有几何效应，
    // 雕像/心脏是有厚度的 3D 曲面，法线锁定不会把粒子挤扁堆叠，无过曝风险
    const breath = uSleepBreath.mul(Math.PI * 2).sin().mul(0.5).add(0.5)
    // 安静段落密度补偿压暗（T5）：低能量时软边界收拢让密度升 ~2-3×，不补偿会"越安静越亮"
    // （真燃料 tiaowu 尾段实测近白 9.5% 的纯白球）；沉睡态有自己的明度曲线，混回 1 不叠加
    // T10b（Phase C1）：暗端 0.6→0.45——软边界下限 1.8→1.6 密度再升 ~1.4×，补偿同步加深；安静=又收又暗
    const energyDim = mix(mix(float(0.45), float(1.0), uEnergy), float(1.0), uSleep)
    const intensity = mix(float(1.0), float(0.35), uMorph.mul(uTargetPlanar))
      .mul(energyDim)
      .mul(uNarrDim) // 叙事三幕：蓄力变暗/尾音回落（MotionProgram 驱动，默认 1 无副作用）
      .mul(mix(float(1.0), float(0.12).add(breath.mul(0.08)), uSleep))
    // 节奏闪光收敛为「带当前色调的辉光」（#光效精修 ③，用户拍板：震动为主、光收成辉光、跟背景基调）：
    // 旧写法 ×(1+uFlash·1.2) 是全屏乘白——暗背景粒子也被整体拔亮 → 刺眼且糊住画面。改为两段：
    //  1) flashFlat：平铺提亮从 1.2 收到 0.3，仅留极轻的整体呼吸，不再爆白；
    //  2) flashGlow：只给「本就偏亮」的粒子（baseCol 权重，暗粒子≈0）叠一记 highlight 色加光——
    //     唯有亮核越过 bloom 阈值(0.75)被晕开成辉光；且 uColorC 随封面/上传背景走（②），
    //     于是暖背景→暖光晕，而非刺眼纯白。背景主体亮度稳定、只有光核在节奏上「呼吸晕开」。
    const baseCol = lit.mul(depthDim).mul(intensity).mul(uUiDim)
    const flashFlat = float(1).add(uFlash.mul(0.3))
    // 增益 1.1→0.8（#光效精修 ③·二版）：少往 bloom 灌能量，配合收紧的 bloom 让亮核保色不奔白、不糊
    const flashGlow = baseCol.mul(uColorC).mul(uFlash).mul(0.8)
    // vec3() 包裹保证落进 colorNode 的类型联合（避免 color/vec3 运算结果推断不入并）
    mat.colorNode = vec3(baseCol.mul(flashFlat).add(flashGlow))

    this.geometry = new THREE.PlaneGeometry(1, 1)
    this.material = mat
    const mesh = new THREE.InstancedMesh(this.geometry, mat, count)
    mesh.frustumCulled = false // 粒子位置由 GPU 写，包围盒无意义
    this.mesh = mesh

    // 构造末尾 seed 默认球壳目标（与粒子初始分布同分布），并写入 targets 缓冲
    this.defaultTargets = makeSphereShell(count)
    this.setTargets(null)
  }

  /** 跑 computeInit（须在 await renderer.init() 之后，见 M2-conclusions ④）*/
  init(renderer: THREE.WebGPURenderer): void {
    renderer.compute(this.computeInitNode)
  }

  /** 每帧跑 computeUpdate */
  compute(renderer: THREE.WebGPURenderer): void {
    renderer.compute(this.computeUpdateNode)
  }

  /** null=无目标（退化为球壳星云）；有目标时按模复用点云覆盖全部粒子；colors 缺失时清零（uTargetHasColor 门掉） */
  setTargets(cloud: ShapePointCloud | null): void {
    const posArr = this.targets.value.array as Float32Array
    const colArr = this.targetColors.value.array as Float32Array
    const auxArr = this.auxs.value.array as Float32Array
    if (cloud === null) {
      posArr.set(this.defaultTargets)
      colArr.fill(0) // 无目标：morph 恒 0，targetColors 不参与显示
      auxArr.fill(0) // 无目标：默认球壳无方向数据
    } else {
      const n = cloud.positions.length / 3
      const colors = cloud.colors ?? null
      const auxSrc = cloud.aux ?? null
      if (!colors) colArr.fill(0) // 几何形状点云：无色，确定性清零
      if (!auxSrc) auxArr.fill(0) // 无 aux 数据的点云（如封面）：确定性清零
      for (let i = 0; i < this.count; i++) {
        const src = (i % n) * 3
        const dst = i * 3
        posArr[dst] = cloud.positions[src]
        posArr[dst + 1] = cloud.positions[src + 1]
        posArr[dst + 2] = cloud.positions[src + 2]
        if (colors) {
          colArr[dst] = colors[src]
          colArr[dst + 1] = colors[src + 1]
          colArr[dst + 2] = colors[src + 2]
        }
        if (auxSrc) {
          const s4 = (i % n) * 4
          const d4 = i * 4
          auxArr[d4] = auxSrc[s4]
          auxArr[d4 + 1] = auxSrc[s4 + 1]
          auxArr[d4 + 2] = auxSrc[s4 + 2]
          auxArr[d4 + 3] = auxSrc[s4 + 3]
        }
      }
    }
    this.targets.value.needsUpdate = true
    this.targetColors.value.needsUpdate = true
    this.auxs.value.needsUpdate = true
  }

  dispose(): void {
    // 5 个 storage buffer 节点无真正的显存释放 API（StorageBufferNode 只有基类 Node.dispose，
    // 仅派发 dispose 事件；真正的 GPU 内存回收落在场景 dispose 里的 renderer.dispose()，
    // 见 particles.ts 头部注释引用的核实结论）——这里调用只为让潜在监听该事件的缓存立即失效，
    // 不必等 GC，不代表已释放显存
    this.positions.dispose()
    this.velocities.dispose()
    this.targets.dispose()
    this.targetColors.dispose()
    this.auxs.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** 均匀球壳分布（半径 [1,1.5]，与 computeInit 的 GPU 分布同参数）。用确定性 xorshift 保稳定。 */
function makeSphereShell(count: number): Float32Array {
  const arr = new Float32Array(count * 3)
  let seed = 0x9e3779b9 >>> 0
  const rand = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const z = rand() * 2 - 1
    const r = rand() * 0.5 + 1
    const s = Math.sqrt(Math.max(0, 1 - z * z))
    arr[i * 3] = s * Math.cos(a) * r
    arr[i * 3 + 1] = s * Math.sin(a) * r
    arr[i * 3 + 2] = z * r
  }
  return arr
}
