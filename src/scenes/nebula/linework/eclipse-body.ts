// 日食主体（图形三连 spec §①）：双画板——additive 辉光（日冕/光环/锯齿/冲击环）+ normal 黑盘。
// additive 只能加亮画不出"黑盘遮挡"，黑盘独立 NormalBlending 画板 renderOrder 压在辉光上。
// 铁律：additive 亮度全折 colorNode + premultipliedAlpha + opacityNode 成形（LineworkBody 先例）。
// 手感常量集中此处（trace 回放调参惯例）。
import * as THREE from 'three/webgpu'
import {
  uniform, uniformArray, uv, vec2, vec3, float, floor, fract, abs, exp,
  smoothstep, mix, length, clamp,
} from 'three/tsl'
import { BIN_COUNT } from './spectrum-bins'

const PLANE_W = 14         // 满屏宽画板（盖住可见半宽~7），fb1 改矩形前为方形 PLANE_SIZE=6
const PLANE_H = 6          // 画板高，与 LineworkBody 同级量程共用标定
const DISC_R = 0.85        // 黑盘半径（频谱环 R1.15 略小，留日冕呼吸空间）
const DISC_EDGE = 0.02     // 黑盘边缘软化半宽
const CORONA_W = 0.22      // 日冕指数衰减尺度
const RING1_R = 1.02       // 内光环半径
const RING2_R = 1.3        // 外光环半径（更淡）
const RING_W = 0.01        // 光环芯半宽
const WAVE_BINS = 32       // 锯齿只用低 32 桶（低频靠盘、高频向外）
const WAVE_SPAN_MAX = PLANE_W / 2 - DISC_R - 0.4 // 锯齿满长基准（旋钮 waveLen=1 时铺展长度，尾部留软收余量）
const WAVE_MAX_H = 0.5     // 锯齿满幅半高
const HAIRLINE = 0.006     // 静线半宽（无声时地平细线）
const KICK_GLOW = 0.5      // 鼓点全局提亮（线条系统一手感）
const KICK_POP = 0.02      // 鼓点盘半径微 pop
const SHOCK_SPEED = 1.6    // drop 冲击环外扩距离
const ORIENT_TAU = 0.25    // faceCamera 缓跟随（歌名粒子先例）
const MAP_GLOW_GAIN = 0.6  // 映射密度→辉光浓度跨度（线条系同值）
const MAP_THICK_GAIN = 0.9 // 映射厚度→线宽跨度（线条系同值）

export class EclipseBody {
  readonly group = new THREE.Group()
  private readonly uBins = uniformArray<'float'>(Array.from({ length: BIN_COUNT }, () => 0), 'float')
  private readonly uOpacity = uniform(0)
  private readonly uKick = uniform(0)
  private readonly uDrop = uniform(0)
  private readonly uSleep = uniform(0)
  private readonly uEnergy = uniform(0.5)
  private readonly uColA = uniform(new THREE.Color(0.35, 0.5, 1.0))
  private readonly uColC = uniform(new THREE.Color(0.85, 0.92, 1.0))
  private readonly uUserBright = uniform(1)
  private readonly uPulseSpace = uniform(0)
  private readonly uPulseBright = uniform(0)
  private readonly uMapDensity = uniform(0)
  private readonly uMapThick = uniform(0)
  private readonly uWaveLen = uniform(1)
  private readonly uWaveGap = uniform(0.3)
  private readonly uCorona = uniform(1)
  private readonly geo: THREE.PlaneGeometry
  private readonly glowMat: THREE.MeshBasicNodeMaterial
  private readonly discMat: THREE.MeshBasicNodeMaterial
  private readonly orientTmp = new THREE.Object3D()

  constructor() {
    this.glowMat = new THREE.MeshBasicNodeMaterial({
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, premultipliedAlpha: true,
    })
    const p = uv().sub(0.5).mul(vec2(PLANE_W, PLANE_H))
    const r = length(p)
    const thickMul = this.uMapThick.mul(MAP_THICK_GAIN).add(1)
    const densMul = this.uMapDensity.mul(MAP_GLOW_GAIN).add(1)

    // 盘半径：鼓点微 pop × 空间脉冲微撑（与频谱环 popR 同语义）
    const discR = float(DISC_R).mul(this.uKick.mul(KICK_POP).add(1)).mul(this.uPulseSpace.mul(0.07).add(1))
    // 日冕：盘缘向外指数衰减，能量呼吸浓度，旋钮 uCorona 整体控厚薄
    const corona = exp(r.sub(discR).max(0.0).div(CORONA_W).negate())
      .mul(this.uEnergy.mul(0.5).add(0.55)).mul(densMul).mul(this.uCorona)
    // 双细光环
    const ring1 = smoothstep(float(0.0), float(RING_W).mul(thickMul), r.sub(RING1_R).abs()).oneMinus().mul(1.2)
    const ring2 = smoothstep(float(0.0), float(RING_W).mul(thickMul), r.sub(RING2_R).abs()).oneMinus().mul(0.35)
    // 锯齿波形：|x| 从盘缘向外铺 32 桶（铺展长度=旋钮 uWaveLen 缩放满长基准），逐桶定高=锯齿階梯；y 上下对称
    const span = float(WAVE_SPAN_MAX).mul(this.uWaveLen)
    const wx = abs(p.x).sub(DISC_R).div(span)
    const binF = clamp(wx, 0.0, 0.999).mul(WAVE_BINS)
    const v = this.uBins.element(floor(binF))
    // 波段间隙：条内 fract 两端软收出缝，h 乘 barMask（非强度乘）——缝里回落 HAIRLINE 静线，中线连续、条分段
    const f = fract(binF)
    const halfGap = this.uWaveGap.mul(0.5)
    const barMask = smoothstep(halfGap, halfGap.add(0.08), f)
      .mul(smoothstep(float(1).sub(halfGap).sub(0.08), float(1).sub(halfGap), f).oneMinus())
    const h = v.mul(WAVE_MAX_H).mul(this.uPulseSpace.mul(0.2).add(1)).mul(barMask).add(HAIRLINE)
    const dY = abs(p.y).sub(h)
    const waveCore = smoothstep(float(0.0), float(0.012).mul(thickMul), dY).oneMinus()
    const waveGlow = exp(clamp(dY, 0.0, 10.0).div(0.05).negate()).mul(0.35).mul(densMul)
    const inBand = smoothstep(0.0, 0.03, wx).mul(smoothstep(0.9, 1.0, wx).oneMinus()) // 盘内归零、带尾软收
    const wave = waveCore.add(waveGlow).mul(inBand)
    // drop 冲击环：uDrop 1→0 衰减脉冲，半径随衰减外扩（免时钟，LineworkBody 同款）
    const rShock = discR.add(float(1).sub(this.uDrop).mul(SHOCK_SPEED))
    const shock = exp(r.sub(rShock).abs().div(0.08).negate()).mul(this.uDrop).mul(0.8)

    const intensity = corona.add(ring1).add(ring2).add(wave).add(shock)
      .mul(this.uKick.mul(KICK_GLOW).add(1))
      .mul(float(1).sub(this.uSleep.mul(0.85)))
      .mul(this.uOpacity).mul(this.uUserBright)
      .mul(this.uPulseBright.mul(0.3).add(1))
    // 色温层次（#光效精修 ③·推广，用户参考图「白核 + 饱和彩身」）：用原始 intensity + 高门槛 smoothstep
    // 替代原 clamp(intensity*0.6)——后者亮度稍高(>1.67)就冲到 1、整片白，把封面/背景色盖掉（用户反馈
    // 频谱环显不出封面色）。改为发光腰部保持饱和 uColA(随封面/背景走)，只有最亮核心[1.7,5]才过渡到近白 uColC。
    const albedo = mix(vec3(this.uColA), vec3(this.uColC), smoothstep(1.7, 5.0, intensity))
    this.glowMat.colorNode = albedo.mul(intensity)
    this.glowMat.opacityNode = clamp(intensity, 0.0, 1.0)

    // 黑盘画板：normal 混合遮挡背景，渲染序压辉光（spec §① 技术关键）
    this.discMat = new THREE.MeshBasicNodeMaterial({ depthWrite: false, transparent: true })
    this.discMat.colorNode = vec3(0.0)
    // 盘缘基准与日冕/冲击环同源 discR（鼓点 pop×空间脉冲），非静态 DISC_R，避免二者叠加时盘缘脱节亮斑
    this.discMat.opacityNode = smoothstep(discR.sub(DISC_EDGE), discR.add(DISC_EDGE), r).oneMinus().mul(this.uOpacity)

    this.geo = new THREE.PlaneGeometry(PLANE_W, PLANE_H)
    const glow = new THREE.Mesh(this.geo, this.glowMat)
    const disc = new THREE.Mesh(this.geo, this.discMat)
    glow.frustumCulled = false
    disc.frustumCulled = false
    glow.renderOrder = 0
    disc.renderOrder = 1
    this.group.add(glow, disc)
  }

  update(dt: number, inp: {
    bins: Float32Array; kickEnv: number; drop: number
    sleep: number; energy: number; opacity: number
    colorA: THREE.Color; colorC: THREE.Color
    brightness: number
    pulseSpace: number; pulseBright: number
    mapDensity: number; mapThick: number
    waveLen: number; waveGap: number; corona: number
  }): void {
    void dt
    const arr = this.uBins.array as number[]
    for (let i = 0; i < BIN_COUNT; i++) arr[i] = inp.bins[i]
    this.uKick.value = inp.kickEnv
    this.uDrop.value = inp.drop
    this.uSleep.value = inp.sleep
    this.uEnergy.value = inp.energy
    this.uOpacity.value = inp.opacity
    this.uColA.value.copy(inp.colorA)
    this.uColC.value.copy(inp.colorC)
    this.uUserBright.value = inp.brightness
    this.uPulseSpace.value = inp.pulseSpace
    this.uPulseBright.value = inp.pulseBright
    this.uMapDensity.value = inp.mapDensity
    this.uMapThick.value = inp.mapThick
    this.uWaveLen.value = inp.waveLen
    this.uWaveGap.value = inp.waveGap
    this.uCorona.value = inp.corona
  }

  /** 每帧阻尼缓跟随镜头（歌名粒子/LineworkBody 同款先例） */
  faceCamera(camPos: THREE.Vector3, dt: number): void {
    this.orientTmp.position.copy(this.group.position)
    this.orientTmp.lookAt(camPos)
    this.group.quaternion.slerp(this.orientTmp.quaternion, 1 - Math.exp(-dt / ORIENT_TAU))
  }

  get opacityForTest(): number { return this.uOpacity.value }

  dispose(): void {
    this.geo.dispose()
    this.glowMat.dispose()
    this.discMat.dispose()
  }
}
