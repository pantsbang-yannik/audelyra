// HDR 后期：AgX 色调映射（renderer 侧已设）+ 克制 bloom（黑是奢侈品）+ 反馈拖尾 + 暗部抖动。
// quality.bloom=false 时不构造本类，NebulaScene 直接走 renderer.render（低档核显免后期，拖尾/dither 同样不生效）。
import * as THREE from 'three/webgpu'
import { pass, uniform, hash, screenUV, screenSize, frameId, renderOutput, mix, vec3, saturate, float } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js'
import type { PostInstrument } from './motion/nebula-program'
import { CLIMAX_DAMP } from './motion/types'

export class NebulaPost {
  private pipeline: THREE.RenderPipeline
  private bloomPass: ReturnType<typeof bloom> | null = null
  private trailPass: ReturnType<typeof afterImage> | null = null
  private trailDamp: ReturnType<typeof uniform> | null = null
  private baseStrength = 0.55
  private baseDamp = 0.72
  private glowDrop = 0
  private glowKick = 0
  // 高潮亮度有效缩放（#高潮亮度）：每帧由 setInstrument 覆写；初值=默认档（settings 就位前首帧也压档）
  private climaxGlow = CLIMAX_DAMP
  private radialAmt: ReturnType<typeof uniform> | null = null
  private chromaAmt: ReturnType<typeof uniform> | null = null

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera,
              opts: { bloom: boolean }) {
    this.pipeline = new THREE.RenderPipeline(renderer)
    const scenePass = pass(scene, camera)
    const color = scenePass.getTextureNode('output')
    if (opts.bloom) {
      // 拖尾：AfterImageNode 的 damp 构造参数若传纯数字会被 nodeObject() 固化成不可变 ConstNode
      // （three/examples/jsm/tsl/display/AfterImageNode.js 里 `damp = float(0.96)`，且它不像
      // BloomNode 那样在构造函数内部自建 uniform()），运行时改 .value 不会反映到已编译的着色器——
      // 自己包一层 uniform() 传进去，拿到的 this.damp 就是同一个可写引用
      this.trailDamp = uniform(this.baseDamp)
      this.trailPass = afterImage(color, this.trailDamp)
      // `@types/three` 给 AfterImageNode 的声明没标 `TempNode<"vec4">` 泛型（BloomNode 有标），
      // 导致 .add() 等运算符方法在类型层面缺失——走它自己文档化的 getTextureNode() 拿正经
      // TextureNode（内部就是同一个节点引用，setup() 返回的也是它），类型齐全又不用断言
      const trailedColor = this.trailPass.getTextureNode()

      // 后期乐器·径向模糊 + 色散（Phase C2）：都在 trail 纹理上做自定义 UV 采样
      // （TSL 只有 pass/afterImage 的 TextureNode 可 sample；表达式节点不可再采样）。
      // 两个量归零时偏移为 0，采样结果=原像素——常驻 8 次采样的固定成本，bloom 档位才有本类，可接受
      this.radialAmt = uniform(0)
      this.chromaAmt = uniform(0)
      // `ReturnType<typeof uniform>`（多重载函数类型）取 ReturnType 时 TS 恒选最后一条泛型重载，
      // 塌成 UniformNode<unknown, unknown>——字段类型够存 .value，但拿来做 .mul() 等运算会因
      // 泛型参数 unknown 报"缺少 toVar 等扩展方法"。用 TSL 官方的 float() 转换包一层，
      // 显式收窄回 Node<"float">，运算方法齐全（同一坑：particles.ts 里字面量也这么转）
      const radialAmt = float(this.radialAmt)
      const chromaAmt = float(this.chromaAmt)
      const dir = screenUV.sub(0.5)
      // drop 径向模糊：沿"像素→中心"方向 6 阶递进采样取均值，拉出爆发的速度感
      const blurTaps = [0.0, 0.15, 0.3, 0.45, 0.6, 0.75].map((k) =>
        this.trailPass!.getTextureNode().sample(screenUV.sub(dir.mul(radialAmt).mul(0.08).mul(k))))
      const blurred = blurTaps.reduce((a, b) => a.add(b)).div(blurTaps.length)
      const radial = mix(trailedColor, blurred, saturate(radialAmt))
      // 重拍/爆发色散：R/B 通道沿径向反向错位一帧撕裂（G 走模糊结果，无新色相引入）
      const chromaOff = dir.mul(chromaAmt).mul(0.006)
      const rC = this.trailPass!.getTextureNode().sample(screenUV.add(chromaOff)).r
      const bC = this.trailPass!.getTextureNode().sample(screenUV.sub(chromaOff)).b
      const withFx = vec3(
        mix(radial.r, rC, saturate(chromaAmt)),
        radial.g,
        mix(radial.b, bC, saturate(chromaAmt)),
      )

      // 锐核通透（#光效精修 ③·二版，用户反馈「糊」）：黑是奢侈品——收紧 bloom 让光核锐利、光晕小而透，
      // 不再把亮部晕成一团肉糊。radius 0.55→0.3（光晕收紧）、threshold 0.75→0.8（更少粒子参与辉光，去糊主刀）。
      // 吃 trailedColor 而非原始 color：光迹也要被辉光包裹（管线顺序：scenePass → afterImage → +bloom）
      this.bloomPass = bloom(trailedColor)
      this.bloomPass.threshold.value = 0.8
      this.bloomPass.strength.value = this.baseStrength
      this.bloomPass.radius.value = 0.3
      const withBloom = withFx.add(this.bloomPass) // bloom 输入仍是 trailedColor（亮度提取不吃模糊，防辉光糊化）

      // 暗部抖动必须接在色调映射之后：AgX 对暗部有非线性压缩，映射前叠加的线性 ±1/255 噪声
      // 到暗部会被压缩到不可见，起不到断色带的作用。RenderPipeline 默认在 outputNode 之后自动做
      // 色调映射+色彩空间转换，这里关掉默认转换（outputColorTransform=false），换成显式
      // renderOutput()（three 官方文档写法），dither 接在它之后
      this.pipeline.outputColorTransform = false
      const toned = renderOutput(withBloom)

      // v1 用 hash 白噪声（非设计稿标注的"蓝噪声"）：真蓝噪声需要预置纹理资产，本项目零资产、
      // 1/255 幅度下白噪声已经能断色带，做蓝噪声属于用不到的预置抽象——YAGNI 裁决，记入 M3-conclusions。
      // hash() 只接受标量种子（three/src/nodes/math/Hash.js），brief 骨架里 `hash(screenUV.mul(...))`
      // 直接塞 vec2 是笔误——用像素坐标线性化成标量，frame 计数器用内置 frameId（renderGroup 自动
      // 每帧递增，不必自己在 update() 里手动加一）防止噪声纹样逐帧静止
      const pixel = screenUV.mul(screenSize)
      const seed = pixel.y.mul(screenSize.x).add(pixel.x).add(frameId.toFloat())
      const dither = hash(seed).sub(0.5).mul(2 / 255)

      this.pipeline.outputNode = toned.add(dither)
    } else {
      this.pipeline.outputNode = color
    }
  }

  // drop 辉光增益 1.2→0.8（T5 复核）：M3 按"几乎不触发"的旧 drop 调的 2.2× 峰值；
  // 引擎标定后 drop 在真副歌触发（一首最多 3 次），且触发点 energy 0.65+——画面本就在
  // 全曲最亮段（软边界撑满、高速粒子偏 highlight），2.2× bloom 叠上去过曝奔白，收到 1.8×
  setDropGlow(v: number): void {
    this.glowDrop = v
    this.applyGlow()
  }

  /** drop 大脉冲 + 鼓点微脉冲合成到同一 bloom strength（后期乐器：鼓点 0.3× 微亮、drop 0.8× 主亮）；
   * 动态放大项整体受高潮亮度压档（#高潮亮度）：默认档峰值 1.8×→约 1.5× */
  private applyGlow(): void {
    if (this.bloomPass) this.bloomPass.strength.value = this.baseStrength * (1 + (this.glowDrop * 0.8 + this.glowKick * 0.3) * this.climaxGlow)
  }

  // drop 时光尾拉长（0.72→峰值 0.84；T5 复核从 0.18 收到 0.12——真副歌 drop 的径向高速
  // 粒子 + 长拖尾会把爆发核心抹成大片纯白，实测 zilaishui drop1 峰值帧近白占比 9.4%，
  // 收短拖尾保住爆发的方向感与色彩纵深），随 setDropGlow 一起每帧调用（同一个 uDrop 数值）
  setTrail(dropPulse: number): void {
    if (this.trailDamp) this.trailDamp.value = this.baseDamp + dropPulse * 0.12
  }

  /** 后期乐器（Phase C2）：MotionProgram 每帧产出，index 转交。低档无 post 时整组丢弃 */
  setInstrument(p: PostInstrument): void {
    this.glowKick = p.kickGlow
    this.climaxGlow = p.climaxGlow
    this.applyGlow()
    if (this.radialAmt) this.radialAmt.value = p.radialBlur
    if (this.chromaAmt) this.chromaAmt.value = p.chroma
  }

  render(): void {
    this.pipeline.render()
  }

  dispose(): void {
    // afterImage/bloom 各自持有独立 RenderTarget（拖尾 2 个 + bloom 亮度提取/上下采样各若干），
    // RenderPipeline.dispose() 只清自身的合成 quad 材质，不会级联到这些子效果节点——手动补上
    this.trailPass?.dispose()
    this.bloomPass?.dispose()
    this.pipeline.dispose()
  }
}
