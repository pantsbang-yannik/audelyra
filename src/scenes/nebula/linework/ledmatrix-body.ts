// 点阵主体(图形三连 spec §②):满屏 LED 格子墙——fract 网格数学切分,亮度场全在格心采样
// (整格同亮=LED 神韵);环波 4 槽高斯包络+中心十字光束+drop 闪白(过频闪闸)。
// 满屏画板 spike 结论:超大画板(34)faceCamera 盖住 DIST_MAX(4.6)×distScale(3) 极端机位视锥,
// 不挂相机子节点——呼吸推拉带来格距微呼吸=神韵加分;SDF 逐像素成本与画板尺寸无关。
// 铁律:亮度折 colorNode + premultipliedAlpha(LineworkBody 先例)。
import * as THREE from 'three/webgpu'
import {
  uniform, uniformArray, uv, vec3, float, floor, fract, abs, exp,
  smoothstep, mix, length, clamp,
} from 'three/tsl'
import { LED_SLOTS } from './led-waves'

const PLANE_SIZE = 34      // 满屏:盖住最远机位(距离钳 4.6×distScale 3=13.8)的视锥
const CELL = 0.30          // 格距(世界单位,fb1 新默认——密度加倍)
const CELL_FILL = 0.62     // 格内亮块占比
const CROSS_W = 0.1        // 十字光束衰减半宽
const WAVE_SIGMA = 0.9     // 环波高斯包络厚度
const WAVE_FAR_DECAY = 0.045 // 环走远渐隐系数
const BASE_LIT = 0.045     // 格子底亮
const LED_BASE_BRIGHT = 0.6 // 点阵整体亮度(固定):原 lineBrightness 默认缩放并入此常量,点阵不再暴露"调整墙"旋钮——环波亮度改由 uWaveBright 单独调
const HOT_W = 0.55         // 中心光斑衰减尺度
const KICK_CROSS = 0.8     // 鼓点十字提亮
const DROP_CROSS_STROBE = 1.6 // 频闪开:drop 十字爆亮增益(取代原全屏白闪——洗白整墙会看不清,改为集中提亮十字)
const DROP_CROSS_CALM = 0.35  // 频闪关:drop 十字缓涌(光敏安全,沿用 spec 决策)
const ORIENT_TAU = 0.25
const MAP_GLOW_GAIN = 0.6  // 映射密度→底亮/波幅浓度
const MAP_FILL_GAIN = 0.2  // 映射厚度→格块填充率加宽
const WAVE_GAIN = 0.5      // 环波整体亮度增益:压低"环波一出整墙都亮"的洗亮感,让环波是含蓄亮圈而非照亮全墙(亲验调)

export class LedmatrixBody {
  readonly group = new THREE.Group()
  private readonly uWaveR = uniformArray<'float'>(Array.from({ length: LED_SLOTS }, () => 99), 'float')
  private readonly uWaveA = uniformArray<'float'>(Array.from({ length: LED_SLOTS }, () => 0), 'float')
  private readonly uOpacity = uniform(0)
  private readonly uKick = uniform(0)
  private readonly uDrop = uniform(0)
  private readonly uSleep = uniform(0)
  private readonly uEnergy = uniform(0.5)
  private readonly uStrobe = uniform(1)
  private readonly uColA = uniform(new THREE.Color(0.35, 0.5, 1.0))
  private readonly uColC = uniform(new THREE.Color(0.85, 0.92, 1.0))
  private readonly uWaveBright = uniform(1) // 环波亮度旋钮：只乘环波这一层，不碰底亮/十字/中心斑
  private readonly uPulseBright = uniform(0)
  private readonly uMapDensity = uniform(0)
  private readonly uMapThick = uniform(0)
  private readonly uDensity = uniform(1)
  private readonly uCross = uniform(1)
  private readonly uWaveThick = uniform(1) // 环波粗细旋钮：高斯包络厚度乘子，1=现状
  private readonly geo: THREE.PlaneGeometry
  private readonly mat: THREE.MeshBasicNodeMaterial
  private readonly orientTmp = new THREE.Object3D()

  constructor() {
    this.mat = new THREE.MeshBasicNodeMaterial({
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, premultipliedAlpha: true,
    })
    const p = uv().sub(0.5).mul(PLANE_SIZE)
    // 格距节点化:密度旋钮实时改格距(数值越大格子越密)
    const cell = float(CELL).div(this.uDensity)
    // 格心坐标:亮度场只在格心取值→整格同亮(LED 神韵之源)
    const cc = floor(p.div(cell)).add(0.5).mul(cell)
    const cuv = fract(p.div(cell)).sub(0.5)
    const r = length(cc)
    const densMul = this.uMapDensity.mul(MAP_GLOW_GAIN).add(1)

    // 环波场:4 槽高斯包络(JS 侧展开+reduce 累加,post.ts:53 先例;WGSL 无动态分支)
    // sigma 乘环波粗细旋钮:越大高斯越宽=光带越粗
    const sigma = float(WAVE_SIGMA).mul(this.uWaveThick)
    const waveTaps = Array.from({ length: LED_SLOTS }, (_, i) => {
      const d = r.sub(this.uWaveR.element(i)).div(sigma)
      return exp(d.mul(d).negate()).mul(this.uWaveA.element(i))
    })
    const waves = waveTaps.reduce((a, b) => a.add(b)).mul(WAVE_GAIN).mul(this.uWaveBright).mul(exp(r.mul(-WAVE_FAR_DECAY))).mul(densMul)
    // 底亮+能量呼吸
    const base = float(BASE_LIT).add(this.uEnergy.mul(0.09)).mul(densMul)
    // 中心十字光束(格级亮度):鼓点提亮 + drop 爆亮(过 strobe 光敏闸)——
    // drop 冲击从原「全屏白闪」转移到此,只提亮十字线,不再把整墙格子洗白
    const dropPunch = this.uDrop.mul(this.uStrobe.mul(DROP_CROSS_STROBE - DROP_CROSS_CALM).add(DROP_CROSS_CALM))
    const cross = exp(abs(cc.x).div(CROSS_W).negate()).add(exp(abs(cc.y).div(CROSS_W).negate()))
      .mul(this.uKick.mul(KICK_CROSS).add(dropPunch).add(0.85)).mul(this.uCross)
    // 中心光斑
    const hot = exp(r.div(HOT_W).negate()).mul(1.3)
    // drop 视觉 = 十字爆亮(上方) + 环波大环(waves 由 dropEdge 触发 LED_DROP_AMP 大环),无全屏 flash
    const lit = base.add(waves).add(cross).add(hot)
    // 格内方块掩膜(LED 芯):映射厚度加宽填充率,边缘软化(smoothstep 恒正向+oneMinus,铁律)
    const half = float(CELL_FILL / 2).add(this.uMapThick.mul(MAP_FILL_GAIN / 2))
    const box = smoothstep(half.sub(0.05), half, abs(cuv.x).max(abs(cuv.y))).oneMinus()

    const intensity = lit.mul(box)
      .mul(float(1).sub(this.uSleep.mul(0.85)))
      .mul(this.uOpacity).mul(LED_BASE_BRIGHT)
      .mul(this.uPulseBright.mul(0.3).add(1))
    // 色温层次（#光效精修 ③·推广）：原始 lit + 高门槛 smoothstep 替代 clamp，腰部保饱和 uColA(显封面/背景色)、只有最亮核心才白
    const albedo = mix(vec3(this.uColA), vec3(this.uColC), smoothstep(2.2, 6.0, lit))
    this.mat.colorNode = albedo.mul(intensity)
    this.mat.opacityNode = clamp(intensity, 0.0, 1.0)

    this.geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE)
    const mesh = new THREE.Mesh(this.geo, this.mat)
    mesh.frustumCulled = false
    this.group.add(mesh)
  }

  update(dt: number, inp: {
    waveRadii: Float32Array; waveAmps: Float32Array
    kickEnv: number; drop: number; sleep: number; energy: number; opacity: number
    colorA: THREE.Color; colorC: THREE.Color
    waveBright: number; strobeOn: boolean
    pulseBright: number; mapDensity: number; mapThick: number
    density: number; cross: number; waveThick: number
  }): void {
    void dt
    const rArr = this.uWaveR.array as number[]
    const aArr = this.uWaveA.array as number[]
    for (let i = 0; i < LED_SLOTS; i++) { rArr[i] = inp.waveRadii[i]; aArr[i] = inp.waveAmps[i] }
    this.uKick.value = inp.kickEnv
    this.uDrop.value = inp.drop
    this.uSleep.value = inp.sleep
    this.uEnergy.value = inp.energy
    this.uOpacity.value = inp.opacity
    this.uStrobe.value = inp.strobeOn ? 1 : 0
    this.uColA.value.copy(inp.colorA)
    this.uColC.value.copy(inp.colorC)
    this.uWaveBright.value = inp.waveBright
    this.uPulseBright.value = inp.pulseBright
    this.uMapDensity.value = inp.mapDensity
    this.uMapThick.value = inp.mapThick
    this.uDensity.value = inp.density
    this.uCross.value = inp.cross
    this.uWaveThick.value = inp.waveThick
  }

  faceCamera(camPos: THREE.Vector3, dt: number): void {
    this.orientTmp.position.copy(this.group.position)
    this.orientTmp.lookAt(camPos)
    this.group.quaternion.slerp(this.orientTmp.quaternion, 1 - Math.exp(-dt / ORIENT_TAU))
  }

  get opacityForTest(): number { return this.uOpacity.value }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}
