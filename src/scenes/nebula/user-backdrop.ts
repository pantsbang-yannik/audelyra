// 用户上传图片背景（自定义背景 v1 spec §三）：全屏 quad 追踪相机——每帧摆到相机正前方
// BACKDROP_DIST 处、按 FOV 撑满视野（cover 裁切不拉伸，coverUv 纯函数可单测），renderOrder 与
// 穹顶同层(-3)。与 NebulaSky/NebulaMirror 互斥建拆（index.ts applyBackgroundSource），尘埃保留叠加。
// 亮度呼吸：0.85~1.05 随响度 + 沉睡压暗（亮度纪律同 sky.ts），防静态图在动态粒子后显得死板。
import * as THREE from 'three/webgpu'
import { texture, uniform, uv, vec3, mix } from 'three/tsl'
import { extractDominant, remapToMood, type MoodPalette } from '../shared/palette'

/** 图字节读取注入（先例 setCustomShapeFetcher）：渲染层不碰 IPC，main.ts 接线时注入 */
let fetchBackground: ((id: string) => Promise<Uint8Array>) | null = null
export function setCustomBackgroundFetcher(f: (id: string) => Promise<Uint8Array>): void {
  fetchBackground = f
}

/** cover 裁切 uv（纯函数）：图比视野宽→横向裁边居中，反之纵向；坏输入回恒等防除零 */
export function coverUv(imgAspect: number, viewAspect: number): { sx: number; sy: number; ox: number; oy: number } {
  if (!Number.isFinite(imgAspect) || !Number.isFinite(viewAspect) || imgAspect <= 0 || viewAspect <= 0)
    return { sx: 1, sy: 1, ox: 0, oy: 0 }
  if (imgAspect > viewAspect) {
    const sx = viewAspect / imgAspect
    return { sx, sy: 1, ox: (1 - sx) / 2, oy: 0 }
  }
  const sy = imgAspect / viewAspect
  return { sx: 1, sy, ox: 0, oy: (1 - sy) / 2 }
}

/** 背景取色（#背景取色 ②）：小画布降采样 → getImageData → 复用封面同款 extractDominant→remapToMood，
 * 保证背景与封面走同一调色台铁律、色调一致。source 支持 ImageBitmap / 视频元素；失败回 null（node 测试无 document 亦回 null）。 */
function extractMood(source: CanvasImageSource, w: number, h: number): MoodPalette | null {
  try {
    if (typeof document === 'undefined' || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null
    const S = 64 // 取色只需主色相，64px 足够且极廉价
    const scale = Math.min(1, S / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(source, 0, 0, cw, ch)
    return remapToMood(extractDominant(ctx.getImageData(0, 0, cw, ch)))
  } catch {
    return null // 跨域污染/首帧未就绪等：静默回落封面色
  }
}

const BACKDROP_DIST = 30 // 相机前方距离：运镜半径 ~13.8 之外、穹顶半径 40 之内（虽互斥不共存，量级对齐）
const MARGIN = 1.06      // 6% 出血：防 FOV 边缘浮点误差露黑边（镜头推拉时铺满是本模块唯一硬指标）
const FADE_SEC = 0.5     // 贴图就绪后的淡入时长（spec §二：切换短淡入不闪黑）
const DIR = new THREE.Vector3() // update 每帧临时量（免分配）

/** 亮度合成（纯函数，v2 spec §三公式）：透明度×呼吸×沉睡压暗×淡入。
 * 呼吸关=因子恒1（纯静态党）；透明度是「往纯黑底压暗」的核心控件 */
export function backdropBrightness(p: { opacity: number; breathe: boolean; energy: number; sleep: number; fade: number }): number {
  const breath = p.breathe ? 0.85 + 0.2 * p.energy : 1
  return p.opacity * breath * (1 - p.sleep * 0.35) * p.fade
}

export class UserBackdrop {
  readonly mesh: THREE.Mesh
  private readonly geo = new THREE.PlaneGeometry(1, 1)
  private readonly mat: THREE.MeshBasicNodeMaterial
  private tex: THREE.Texture | null = null
  private video: HTMLVideoElement | null = null
  // uniform 字段禁止显式类型注解（ReturnType<typeof uniform> 塌 unknown 泛型坑，见 sky.ts:17）
  private readonly uUvScale = uniform(new THREE.Vector2(1, 1))
  private readonly uUvOffset = uniform(new THREE.Vector2(0, 0))
  private readonly uBright = uniform(0)
  private readonly uSat = uniform(1)
  private fade = 0
  private imgAspect = 1
  private gen = 0 // 代际守卫：连点多卡时迟到的加载不覆盖新选择
  // 背景主色调（#背景取色 ②）：上传背景激活时，尘埃/歌词/主体光的调色总线改由此驱动，而非专辑封面。
  // 与封面同一套取色算法（extractDominant→remapToMood），色调统一；解码失败/无源为 null（调用侧回落封面色）
  private _mood: MoodPalette | null = null

  constructor() {
    this.mat = new THREE.MeshBasicNodeMaterial({ depthWrite: false })
    this.mesh = new THREE.Mesh(this.geo, this.mat)
    this.mesh.renderOrder = -3 // 最底层（与穹顶同层，互斥不共存）：镜面 -2、尘埃 0、主粒子最上
    this.mesh.frustumCulled = false
    this.mesh.name = 'user-backdrop'
    this.mesh.visible = false // 贴图就绪前不画：防未初始化材质闪帧
  }

  /** 读源→解码→换贴图→重置淡入。kind 判别两路：图片走 v1 IPC 字节，视频走 audelyra-bg 流式。
   * false = 失败或已被更新的 show 替代（调用侧据此回落极光） */
  async show(id: string, kind: 'image' | 'video' = 'image'): Promise<boolean> {
    if (kind === 'video') return this.showVideoUrl(`audelyra-bg://${id}`)
    const myGen = ++this.gen
    if (!fetchBackground) return false
    try {
      const bytes = await fetchBackground(id)
      if (myGen !== this.gen) return false // 迟到的加载：换源/dispose 已发生，省解码浪费（同 custom-shapes token 检查位置）
      // IPC 传回的 Uint8Array 泛型标注为 ArrayBufferLike（TS 5.7+ 已知冲突，shape-picker 同款处理）：
      // 裁剪出精确字节范围再断言 ArrayBuffer
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const bitmap = await createImageBitmap(new Blob([buf]))
      if (myGen !== this.gen) { bitmap.close(); return false } // 迟到的加载：自弃
      const tex = new THREE.CanvasTexture(bitmap)
      tex.colorSpace = THREE.SRGBColorSpace
      this.releaseVideo() // 图片替换视频时释放解码器（图片/视频互斥展示，同一时刻只留一路资源）
      this.tex?.dispose()
      this.tex = tex
      this.imgAspect = bitmap.width / Math.max(1, bitmap.height)
      this._mood = extractMood(bitmap, bitmap.width, bitmap.height) // 背景取色（#背景取色 ②）
      this.rebuildColorNode(tex)
      this.fade = 0
      this.mesh.visible = true
      return true
    } catch {
      return false
    }
  }

  /** 换贴图统一收口：cover 裁切 uv + 饱和度（luminance mix）+ 亮度。图片/视频两路共用 */
  private rebuildColorNode(tex: THREE.Texture): void {
    const c = texture(tex, uv().mul(this.uUvScale).add(this.uUvOffset))
    const lum = c.rgb.dot(vec3(0.2126, 0.7152, 0.0722))
    this.mat.colorNode = mix(vec3(lum), c.rgb, this.uSat).mul(this.uBright)
    this.mat.needsUpdate = true
  }

  /** 视频背景（v2）：<video muted loop> + VideoFrameTexture + requestVideoFrameCallback 泵帧。
   * 不用 VideoTexture——其每帧 copyExternalImageToTexture(video元素) 对硬解 H.264 帧在 WebGPU 下
   * 逐帧失败（"fails extracting valid resource"，亲验黑屏第三根因）；rvfc 时刻 new VideoFrame(video)
   * 走 WebCodecs 帧拷贝路径，硬解帧可上屏。canplay 才算就绪（代际守卫检查点，字节到达≠可播放）；
   * 失败/迟到自弃并释放元素。强制静音无开关（spec §三：防与音乐打架）。 */
  async showVideoUrl(url: string): Promise<boolean> {
    const myGen = ++this.gen
    const video = document.createElement('video')
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.crossOrigin = 'anonymous' // CORS 模式请求：配协议侧 ACAO 头去 taint，否则 VideoFrame 抽帧被拒
    video.src = url
    const ok = await new Promise<boolean>((res) => {
      video.addEventListener('canplay', () => res(true), { once: true })
      video.addEventListener('error', () => res(false), { once: true })
    })
    if (!ok || myGen !== this.gen) {
      video.removeAttribute('src')
      video.load() // 释放解码器资源（Chromium 惯例：置空 src 后 load 才真正释放）
      return false
    }
    void video.play().catch(() => undefined)
    const tex = new THREE.VideoFrameTexture()
    tex.colorSpace = THREE.SRGBColorSpace
    this.releaseVideo() // 换源必先摘旧监听（下方对称重挂），防图片切视频残留解码器
    this.tex?.dispose()
    this.tex = tex
    this.video = video
    document.addEventListener('visibilitychange', this.onVisibility)
    this.imgAspect = video.videoWidth / Math.max(1, video.videoHeight)
    this._mood = extractMood(video, video.videoWidth, video.videoHeight) // 背景取色（#背景取色 ②）：canplay 后首帧 drawImage 尽力取
    this.rebuildColorNode(tex)
    this.fade = 0
    this.mesh.visible = true
    this.pumpFrames(video, tex)
    return true
  }

  /** rvfc 泵帧环：每个视频呈现帧抓 VideoFrame 喂纹理；上一帧在新帧落定后 close（届时已上屏）。
   * 退出条件看 this.video 身份（releaseVideo/换源后自停并收尾关帧，防 GPU 帧句柄泄漏） */
  private pumpFrames(video: HTMLVideoElement, tex: THREE.VideoFrameTexture): void {
    let prev: VideoFrame | null = null
    const step = (): void => {
      if (this.video !== video) { prev?.close(); return } // 已换源/释放：自停
      try {
        const frame = new VideoFrame(video)
        tex.setFrame(frame)
        prev?.close()
        prev = frame
      } catch { /* 个别时刻无可用帧（如刚 seek）：跳过本帧，环不断 */ }
      video.requestVideoFrameCallback(step)
    }
    video.requestVideoFrameCallback(step)
  }

  /** 窗口隐藏暂停解码（spec §三：省电）。监听随 video 生命周期走，不进构造器（node 测试无 document） */
  private onVisibility = (): void => {
    if (!this.video) return
    if (document.hidden) this.video.pause()
    else void this.video.play().catch(() => undefined)
  }

  private releaseVideo(): void {
    if (!this.video) return
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.video = null
  }

  /** 每帧：追踪相机撑满视野 + cover 裁切 uniform + 亮度合成（透明度×呼吸×沉睡压暗×淡入，公式见 backdropBrightness） */
  update(dt: number, camera: THREE.PerspectiveCamera,
    s: { energy: number; sleep: number; opacity: number; saturation: number; breathe: boolean }): void {
    if (!this.mesh.visible) return
    camera.getWorldDirection(DIR)
    this.mesh.position.copy(camera.position).addScaledVector(DIR, BACKDROP_DIST)
    this.mesh.quaternion.copy(camera.quaternion)
    const h = 2 * BACKDROP_DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    this.mesh.scale.set(h * camera.aspect * MARGIN, h * MARGIN, 1)
    const c = coverUv(this.imgAspect, camera.aspect)
    this.uUvScale.value.set(c.sx, c.sy)
    this.uUvOffset.value.set(c.ox, c.oy)
    this.fade = Math.min(1, this.fade + dt / FADE_SEC)
    this.uSat.value = s.saturation
    this.uBright.value = backdropBrightness({ opacity: s.opacity, breathe: s.breathe, energy: s.energy, sleep: s.sleep, fade: this.fade })
  }

  /** 背景主色调（#背景取色 ②）：调用侧（index.ts applyBackgroundSource）读它驱动调色总线；
   * null = 解码失败/无源，调用侧回落封面色 */
  get mood(): MoodPalette | null {
    return this._mood
  }

  /** 只读测试口（惯例同 sky.stateForTest） */
  get stateForTest(): { bright: number; visible: boolean; imgAspect: number; sat: number; hasVideo: boolean } {
    return {
      bright: this.uBright.value as number,
      visible: this.mesh.visible,
      imgAspect: this.imgAspect,
      sat: this.uSat.value as number,
      hasVideo: this.video !== null,
    }
  }

  dispose(): void {
    this.gen++ // 在途加载全部作废
    this.releaseVideo()
    this.geo.dispose()
    this.mat.dispose()
    this.tex?.dispose()
    this.tex = null
  }
}
