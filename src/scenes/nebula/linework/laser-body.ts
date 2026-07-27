// 激光主体(图形三连 spec §③,#激光动态束):全屏扇面——顶部下射束池(自画板顶缘中心扇出)+
// 底部上射束池(自画板底缘向上射,对射交织),条数烘死进 TSL 节点图、逐束 gains 门控可见亮度;
// 副束 2 根自底部两角向内上交叉(参考里的 X 形,固定角)。束=点到射线 SDF+指数辉光。
// 满屏画板手法同 LedmatrixBody(spike 结论:超大画板 34 faceCamera,不挂相机)。
// 铁律:亮度折 colorNode + premultipliedAlpha(LineworkBody 先例)。
import * as THREE from 'three/webgpu'
import {
  uniform, uniformArray, uv, vec2, vec3, float, exp,
  smoothstep, mix, length, clamp, sin, cos,
} from 'three/tsl'
import { LASER_TOP_POOL, LASER_BOTTOM_POOL, LASER_POOL } from './laser-sweep'

const PLANE_SIZE = 34
const TOP_Y = PLANE_SIZE / 2          // 主扇锚点(0, +TOP_Y):画板顶缘中点
const BEAM_CORE = 0.02                // 束芯半宽
const BEAM_GLOW = 0.14                // 束辉光衰减尺度
const SIDE_X = 12.5                   // 副束锚点 |x|
const SIDE_ANGLE = Math.PI - 0.45     // 副束固定角:自底角向内上,两束交叉成 X
const SIDE_GAIN = 0.55                // 副束幅度
const KICK_GLOW = 0.6
const DROP_BOOST = 0.7                // drop 全束闪白提亮(束级非全屏,不过频闪闸,spec 口径)
const ORIENT_TAU = 0.25
const MAP_GLOW_GAIN = 0.6
const MAP_THICK_GAIN = 0.9

export class LaserBody {
  readonly group = new THREE.Group()
  private readonly uAngles = uniformArray<'float'>(Array.from({ length: LASER_POOL }, () => 0), 'float')
  private readonly uGains = uniformArray<'float'>(Array.from({ length: LASER_POOL }, () => 0), 'float')
  private readonly uOpacity = uniform(0)
  private readonly uKick = uniform(0)
  private readonly uDrop = uniform(0)
  private readonly uSleep = uniform(0)
  private readonly uColA = uniform(new THREE.Color(0.35, 0.5, 1.0))
  private readonly uColC = uniform(new THREE.Color(0.85, 0.92, 1.0))
  private readonly uUserBright = uniform(1)
  private readonly uPulseBright = uniform(0)
  private readonly uMapDensity = uniform(0)
  private readonly uMapThick = uniform(0)
  private readonly geo: THREE.PlaneGeometry
  private readonly mat: THREE.MeshBasicNodeMaterial
  private readonly orientTmp = new THREE.Object3D()

  constructor() {
    this.mat = new THREE.MeshBasicNodeMaterial({
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, premultipliedAlpha: true,
    })
    const p = uv().sub(0.5).mul(PLANE_SIZE)
    const thickMul = this.uMapThick.mul(MAP_THICK_GAIN).add(1)
    const densMul = this.uMapDensity.mul(MAP_GLOW_GAIN).add(1)

    // 束 SDF:锚点 A 沿方向 d=(sinθ, -cosθ) 的射线;t=rel·d 截断≥0,dist=|rel-d·t|
    // (节点参数类型用 THREE.Node<'float'>——particles.ts:81 先例;返回类型交给推断)
    const beam = (anchor: ReturnType<typeof vec2>, ang: THREE.Node<'float'>, up = false) => {
      const d = vec2(sin(ang), up ? cos(ang) : cos(ang).negate())
      const rel = p.sub(anchor)
      const t = rel.dot(d).max(0.0)
      const dist = length(rel.sub(d.mul(t)))
      const core = smoothstep(float(0.0), float(BEAM_CORE).mul(thickMul), dist).oneMinus()
      const glow = exp(dist.div(BEAM_GLOW).negate()).mul(0.28).mul(densMul)
      return core.mul(1.5).add(glow)
    }

    // 顶部下射池 + 底部上射池:每束 × gains 亮度门(束数动态=门开合,条数编译期烘死)
    const taps = Array.from({ length: LASER_TOP_POOL }, (_, i) =>
      beam(vec2(0.0, TOP_Y), this.uAngles.element(i)).mul(this.uGains.element(i)))
    for (let k = 0; k < LASER_BOTTOM_POOL; k++) {
      const i = LASER_TOP_POOL + k
      taps.push(beam(vec2(0.0, -TOP_Y), this.uAngles.element(i), true).mul(this.uGains.element(i)))
    }
    taps.push(beam(vec2(-SIDE_X, -TOP_Y), float(SIDE_ANGLE)).mul(SIDE_GAIN))
    taps.push(beam(vec2(SIDE_X, -TOP_Y), float(-SIDE_ANGLE)).mul(SIDE_GAIN))
    const sum = taps.reduce((a, b) => a.add(b))

    const intensity = sum
      .mul(this.uKick.mul(KICK_GLOW).add(1))
      .mul(this.uDrop.mul(DROP_BOOST).add(1))
      .mul(float(1).sub(this.uSleep.mul(0.85)))
      .mul(this.uOpacity).mul(this.uUserBright)
      .mul(this.uPulseBright.mul(0.3).add(1))
    // drop 时白化(colorC 偏白),平时低强度=主色、束芯=高光色
    // 色温层次（#光效精修 ③·推广）：原始 intensity + 高门槛 smoothstep 替代 clamp，腰部保饱和 uColA(显封面/背景色)、
    // 只有最亮核心才白；drop 折进 driver 保留爆点增白
    const albedo = mix(vec3(this.uColA), vec3(this.uColC), smoothstep(2.0, 5.5, intensity.add(this.uDrop.mul(1.5))))
    this.mat.colorNode = albedo.mul(intensity)
    this.mat.opacityNode = clamp(intensity, 0.0, 1.0)

    this.geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE)
    const mesh = new THREE.Mesh(this.geo, this.mat)
    mesh.frustumCulled = false
    this.group.add(mesh)
  }

  update(dt: number, inp: {
    angles: Float32Array; gains: Float32Array
    kickEnv: number; drop: number; sleep: number; energy: number; opacity: number
    colorA: THREE.Color; colorC: THREE.Color
    brightness: number
    pulseBright: number; mapDensity: number; mapThick: number
  }): void {
    void dt
    void inp.energy // 能量已在 LaserSweep 折算为扇开角,画板不重复消费
    const arr = this.uAngles.array as number[]
    const gs = this.uGains.array as number[]
    for (let i = 0; i < LASER_POOL; i++) { arr[i] = inp.angles[i]; gs[i] = inp.gains[i] }
    this.uKick.value = inp.kickEnv
    this.uDrop.value = inp.drop
    this.uSleep.value = inp.sleep
    this.uOpacity.value = inp.opacity
    this.uColA.value.copy(inp.colorA)
    this.uColC.value.copy(inp.colorC)
    this.uUserBright.value = inp.brightness
    this.uPulseBright.value = inp.pulseBright
    this.uMapDensity.value = inp.mapDensity
    this.uMapThick.value = inp.mapThick
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
