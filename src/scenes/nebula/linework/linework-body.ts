// 线条系画板（线条系主体 spec §技术方案，方案甲）：单块 billboard 平面 + fragment SDF——
// 环/条/辉光全部数学距离画出，条高从 uniformArray(64) 读入；spectrum/waveform 两形态共用
// 一个材质（uMode 混合，两分支每像素都算、mix 选型，避免 WGSL 动态分支）。
// 铁律：additive 亮度全部折进 colorNode（M2 坑清单）；smoothstep 恒正向。
// 手感常量集中此处（trace 回放调参惯例）。
import * as THREE from 'three/webgpu'
import {
  uniform, uniformArray, uv, vec3, float, floor, fract, abs, exp,
  smoothstep, mix, atan, length, clamp,
} from 'three/tsl'
import { BIN_COUNT } from './spectrum-bins'

const PLANE_SIZE = 17.0     // 画板世界边长：罩住环(R1.15)+满长条+辉光+波形线（波形宽度旋钮上限3×半宽2.7=8.1，画板半边须≥8.1 保软收不裁；6.0→17.0）
const RING_R = 1.15         // 环半径：与粒子形状包围尺度同级（sphere 1.15）
const CORE_W = 0.012        // 环芯半宽：图6 的"细亮实线"
const HALO_W = 0.05         // 外晕指数衰减尺度
const BAR_GAP = 0.05        // 条根距环外缘
const BAR_LEN = 0.85        // 条满长（bin=1 时）
const BAR_SOFT_TIP = 0.14   // 条梢软收比例
const WAVE_HALF_W = 2.7     // 波形线半宽（fb1 用户反馈"过于小气" 1.9→2.7）
const WAVE_MAX_H = 0.8      // 波形条满半高（fb1 随宽度同步抬 0.7→0.8）
const HAIRLINE = 0.008      // 静线/中线半宽
const KICK_GLOW = 0.5       // 鼓点全环/全线提亮
const KICK_POP = 0.025      // 鼓点环半径微 pop 比例
const SHOCK_SPEED = 1.4     // drop 冲击环外扩距离（uDrop 1→0 全程）
const ORIENT_TAU = 0.25     // faceCamera 缓跟随时间常数（同歌名粒子）
const MAP_GLOW_GAIN = 0.6  // 映射密度跨度：density=1 时辉光 ×1.6（手感，亲验调）
const MAP_THICK_GAIN = 0.9 // 映射厚度跨度：thickness=1 时环芯/波形线宽 ×1.9（手感，亲验调）
const MAP_BAR_WIDEN = 0.07 // 映射厚度→频谱条加宽：fract 软缝窗各向外扩最多 0.07

export class LineworkBody {
  readonly group = new THREE.Group()
  private readonly uBins = uniformArray<'float'>(Array.from({ length: BIN_COUNT }, () => 0), 'float')
  private readonly uMode = uniform(0)     // 0=spectrum 1=waveform
  private readonly uOpacity = uniform(0)  // 主体交接 crossfade（编排层喂）
  private readonly uKick = uniform(0)
  private readonly uDrop = uniform(0)
  private readonly uSleep = uniform(0)
  private readonly uEnergy = uniform(0.5)
  private readonly uColA = uniform(new THREE.Color(0.35, 0.5, 1.0))
  private readonly uColC = uniform(new THREE.Color(0.85, 0.92, 1.0))
  private readonly uUserBright = uniform(1) // 调音台"线条亮度"旋钮（fb2）
  private readonly uUserBarH = uniform(1)   // 调音台"柱高范围"旋钮（fb2）：环条/波形条满长同乘
  private readonly uPulseSpace = uniform(0)  // 音画映射·空间脉冲（fb3：mapper 对线条主体同样生效）
  private readonly uPulseBright = uniform(0) // 音画映射·亮度脉冲（幅度沿用粒子 4.6"点头级"纪律）
  private readonly uMapDensity = uniform(0) // 音画映射·密度（死线接活）：辉光浓度基量 0..1，0=中性
  private readonly uMapThick = uniform(0)   // 音画映射·厚度（死线接活）：线宽/条宽加粗基量 0..1，0=中性
  private readonly uWaveWidth = uniform(1)  // 波形线横向宽度旋钮：WAVE_HALF_W 乘子（仅 waveform 分支消费，spectrum 无副作用），1=现状
  private readonly geo: THREE.PlaneGeometry
  private readonly mat: THREE.MeshBasicNodeMaterial
  private readonly orientTmp = new THREE.Object3D()

  constructor() {
    // fb1 方块根因：只写 colorNode 时片元 alpha 恒 1——帧缓冲 alpha 被整块画板抹成 1，
    // 后级/画布合成把这块"隐形正方形"显形（星系图鉴 T2 同款教训："additive 输出 alpha 恒 1 渲成方块"）。
    // 修法 = premultipliedAlpha（混合因子 ONE/ONE，颜色仍按 colorNode 原样相加，屏上观感零变化）
    // + opacityNode 按强度成形（帧缓冲 alpha 随图形衰减，画板边界外归零）
    this.mat = new THREE.MeshBasicNodeMaterial({
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, premultipliedAlpha: true,
    })
    const p = uv().sub(0.5).mul(PLANE_SIZE) // 画板局部世界坐标，原点=中心
    // 映射厚度→线宽乘子（环芯/波形线共用）；映射厚度→条宽（fract 窗外扩）
    const thickMul = this.uMapThick.mul(MAP_THICK_GAIN).add(1)
    const widen = this.uMapThick.mul(MAP_BAR_WIDEN)

    // —— 桶索引（两形态共用手法：binF → floor 取桶值、fract 留条间缝）——
    // 环形：atan(x,y)∈(-π,π]，0=正上方；|·|/π 左右镜像 → 低频在顶、高频沉底（fb2 用户拍板翻转）
    const angN = abs(atan(p.x, p.y)).div(Math.PI)
    const ringBinF = angN.mul(BIN_COUNT).min(BIN_COUNT - 0.001)
    // 线形：|x|/半宽 → 低频中央、高频向两端镜像（山峰轮廓）；半宽随「整体宽度」旋钮缩放
    const waveHalfW = float(WAVE_HALF_W).mul(this.uWaveWidth)
    const waveBinF = abs(p.x).div(waveHalfW).min(0.999).mul(BIN_COUNT)
    const binF = mix(ringBinF, waveBinF, this.uMode)
    const v = this.uBins.element(floor(binF))
    // 条间缝：桶内相位居中 62% 是条、两侧软缝
    const f = fract(binF)
    const barMask = smoothstep(float(0.14).sub(widen), float(0.24).sub(widen), f).mul(smoothstep(float(0.76).add(widen), float(0.86).add(widen), f).oneMinus())

    // —— 频谱环分支 ——
    const r = length(p)
    // 环半径 = 鼓点 pop × 映射空间脉冲呼吸（fb3：uPulseSpace 对粒子撑舞台、对环撑半径，语义同源）
    const popR = float(RING_R).mul(this.uKick.mul(KICK_POP).add(1)).mul(this.uPulseSpace.mul(0.08).add(1))
    const dRing = r.sub(popR).abs()
    const ringCore = smoothstep(float(0.0), float(CORE_W).mul(thickMul), dRing).oneMinus()
    const ringHalo = exp(dRing.div(HALO_W).negate()).mul(this.uEnergy.mul(0.2).add(0.3)).mul(this.uMapDensity.mul(MAP_GLOW_GAIN).add(1))
    const barT = r.sub(popR.add(BAR_GAP)).div(v.mul(BAR_LEN).mul(this.uUserBarH).add(1e-4))
    const barBody = smoothstep(0.0, 0.06, barT).mul(smoothstep(1 - BAR_SOFT_TIP, 1.0, barT).oneMinus())
    const bars = barBody.mul(barMask).mul(smoothstep(0.02, 0.08, v))
    // drop 冲击环：uDrop 是现成的 1→0 衰减脉冲，半径随衰减外扩、强度随脉冲熄灭（免时钟）
    const rShock = popR.add(float(1).sub(this.uDrop).mul(SHOCK_SPEED))
    const shock = exp(r.sub(rShock).abs().div(0.08).negate()).mul(this.uDrop).mul(0.8)
    const ringI = ringCore.mul(1.6).add(ringHalo).add(bars.mul(0.9)).add(shock)

    // —— 波形线分支 ——
    // 条半高；无声=hairline 静线；映射空间脉冲抬摆幅（fb3，与环半径呼吸同源）
    const h = v.mul(WAVE_MAX_H).mul(this.uUserBarH).mul(this.uPulseSpace.mul(0.2).add(1)).mul(barMask).add(HAIRLINE)
    const dY = abs(p.y).sub(h)
    const waveCore = smoothstep(float(0.0), float(0.012).mul(thickMul), dY).oneMinus()
    const waveGlow = exp(clamp(dY, 0.0, 10.0).div(0.06).negate()).mul(0.3).mul(this.uMapDensity.mul(MAP_GLOW_GAIN).add(1))
    const xFade = smoothstep(waveHalfW.sub(0.15), waveHalfW, abs(p.x)).oneMinus() // 两端软收（随整体宽度移动）
    const centerFlash = exp(abs(p.y).div(0.05).negate()).mul(this.uDrop).mul(0.9)  // drop 中线闪白
    const waveI = waveCore.add(waveGlow).mul(xFade).add(centerFlash)

    // —— 合成：鼓点提亮 × 沉睡压暗 × 交接透明度，全部折进 colorNode（additive 铁律）——
    const intensity = mix(ringI, waveI, this.uMode)
      .mul(this.uKick.mul(KICK_GLOW).add(1))
      .mul(float(1).sub(this.uSleep.mul(0.85)))
      .mul(this.uOpacity)
      .mul(this.uUserBright)
      .mul(this.uPulseBright.mul(0.3).add(1)) // 映射亮度脉冲（系数对齐粒子 lit 的 0.3）
    // 色温层次（#光效精修 ③·推广）：原始 intensity + 高门槛 smoothstep 替代 clamp，腰部保饱和 uColA(显封面/背景色)、只有最亮核心才白
    const albedo = mix(vec3(this.uColA), vec3(this.uColC), smoothstep(1.7, 5.0, intensity))
    this.mat.colorNode = albedo.mul(intensity)
    this.mat.opacityNode = clamp(intensity, 0.0, 1.0) // 帧缓冲 alpha 成形（premult 下不再乘进颜色）

    this.geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE)
    const mesh = new THREE.Mesh(this.geo, this.mat)
    mesh.frustumCulled = false
    this.group.add(mesh)
  }

  setMode(mode: 'spectrum' | 'waveform'): void {
    this.uMode.value = mode === 'waveform' ? 1 : 0
  }

  update(dt: number, inp: {
    bins: Float32Array; kickEnv: number; drop: number
    sleep: number; energy: number; opacity: number
    colorA: THREE.Color; colorC: THREE.Color
    brightness: number; barHeight: number // 调音台"主体·线条"旋钮（fb2）
    waveWidth: number // 波形线横向宽度旋钮（仅 waveform 分支生效）
    pulseSpace: number; pulseBright: number // 音画映射脉冲（fb3：AudioVisualMapper 同帧输出）
    mapDensity: number; mapThick: number // 音画映射·密度/厚度（调音台规范化：死线接活，0=中性）
  }): void {
    void dt
    const arr = this.uBins.array as number[]
    for (let i = 0; i < BIN_COUNT; i++) arr[i] = inp.bins[i]
    this.uUserBright.value = inp.brightness
    this.uUserBarH.value = inp.barHeight
    this.uWaveWidth.value = inp.waveWidth
    this.uPulseSpace.value = inp.pulseSpace
    this.uPulseBright.value = inp.pulseBright
    this.uMapDensity.value = inp.mapDensity
    this.uMapThick.value = inp.mapThick
    this.uKick.value = inp.kickEnv
    this.uDrop.value = inp.drop
    this.uSleep.value = inp.sleep
    this.uEnergy.value = inp.energy
    this.uOpacity.value = inp.opacity
    this.uColA.value.copy(inp.colorA)
    this.uColC.value.copy(inp.colorC)
  }

  /** 每帧阻尼缓跟随镜头（歌名粒子 faceCamera 同款先例，title-particles.ts:111） */
  faceCamera(camPos: THREE.Vector3, dt: number): void {
    this.orientTmp.position.copy(this.group.position)
    this.orientTmp.lookAt(camPos)
    this.group.quaternion.slerp(this.orientTmp.quaternion, 1 - Math.exp(-dt / ORIENT_TAU))
  }

  get opacityForTest(): number { return this.uOpacity.value }
  get modeForTest(): number { return this.uMode.value }
  get mapDensityForTest(): number { return this.uMapDensity.value }
  get mapThickForTest(): number { return this.uMapThick.value }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}
