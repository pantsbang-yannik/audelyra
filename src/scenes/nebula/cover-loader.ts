// 封面加载 + 调色过渡：Image → 离屏降采样 → getImageData → 采样点云 → setTargets，
// 并从封面主色 remap 出情绪三色对 uColorA/B/C 起过渡 Tween。
// 连续换歌用单调 token 防竞态：旧加载的异步结果绝不覆盖新的。
import * as THREE from 'three/webgpu'
import { Tween, easeStandard, quantizeToBeatGrid } from '../shared/motion'
import { extractDominant, remapToMood, type MoodPalette } from '../shared/palette'
import { sampleCoverPoints, type ShapePointCloud } from './cover-points'
import type { NebulaParticles } from './particles'

// 默认冷色骨架（无封面/unknown 归位色）：#5a6cff 经调色台铁律 remap
const DEFAULT_MOOD: MoodPalette = remapToMood({ r: 0.35, g: 0.42, b: 1.0 })
// Apple Music 常见 3000px 封面直接 getImageData 是 36MB，对采样毫无收益 → 先降采样
const MAX_COVER_PX = 512

/**
 * 封面加载失败时的分支裁决（T6 复审：失败路径必须区分「换歌」与「同曲重载」）：
 * - 换歌失败（新曲目键 ≠ 当前已显示键）→ 清空退化星云——旧封面是上一首的，留着就是显示错误内容
 * - 同曲重载失败（键相同，如封面通道抖动触发的重试）→ 保持现状——屏上的封面本就是这首歌的，清掉反而误伤
 */
export function shouldClearOnCoverFail(trackKey: string, shownKey: string | null): boolean {
  return trackKey !== shownKey
}

export class CoverController {
  private token = 0
  private _hasCover = false
  // 当前已显示封面归属的曲目键（title\0artist），null = 无封面在显示；失败分支据此裁决保留/清空
  private shownKey: string | null = null
  // 缓存当前生效的封面点云（Task 13 性能降级用）：粒子重建后编排层可原地 setTargets 恢复，
  // 不必重新解码/重采样（那会有一帧默认色闪烁 + 多余的图片 decode 开销）
  private lastCloud: ShapePointCloud | null = null

  // 调色源门控（#背景取色 ②）：自定义背景激活时置 true——换歌仍加载封面点云（形状不变），
  // 但跳过封面调色，让调色总线交给背景取色驱动。lastCoverMood 始终记着最新封面色，切回极光时 tween 回它。
  private colorSuppressed = false
  private lastCoverMood: MoodPalette = DEFAULT_MOOD

  private readonly colorTween = new Tween()
  private readonly fromA = new THREE.Color()
  private readonly fromB = new THREE.Color()
  private readonly fromC = new THREE.Color()
  private readonly toA = new THREE.Color()
  private readonly toB = new THREE.Color()
  private readonly toC = new THREE.Color()

  constructor(
    private particles: NebulaParticles,
    private count: number,
    /** onSettled：一次加减载「落定」（成功/清空/失败收尾）——场景解除换歌溶解锁；
     * onCloudChanged：lastCloud 变更（含变 null）——编排层重新仲裁（显示决定权不在本类，spec §4.3） */
    private readonly hooks: { onSettled: () => void; onCloudChanged: () => void }
  ) {
    this.applyMoodInstant(DEFAULT_MOOD) // 冷色骨架为初始与默认色
  }

  /** hasCover 定义：当前有已加载成功的封面目标 */
  get hasCover(): boolean {
    return this._hasCover
  }

  /** 仲裁的 coverCloud 输入：当前已加载成功的封面点云（未必在显示——那是仲裁的事） */
  get cloud(): ShapePointCloud | null {
    return this.lastCloud
  }

  /**
   * 粒子重建后重新绑定（Task 13 lowerParticles 降级）：换成新的 NebulaParticles/count，
   * 原地恢复当前封面颜色——不触发 loadCover 的异步解码流程，避免重建瞬间闪回默认色。
   * 目标恢复由编排层重新仲裁（新 count 需重新 generate，评审 I3），本方法不再 setTargets。
   */
  rebind(particles: NebulaParticles, count: number): void {
    const oldU = this.particles.uniforms
    this.particles = particles
    this.count = count
    const u = this.particles.uniforms
    u.uColorA.value.copy(oldU.uColorA.value)
    u.uColorB.value.copy(oldU.uColorB.value)
    u.uColorC.value.copy(oldU.uColorC.value)
    // 把 tween 的 from/to 基准也对齐到当前色，避免下次换色从旧默认值起跳
    this.fromA.copy(u.uColorA.value); this.toA.copy(u.uColorA.value)
    this.fromB.copy(u.uColorB.value); this.toB.copy(u.uColorB.value)
    this.fromC.copy(u.uColorC.value); this.toC.copy(u.uColorC.value)
  }

  /** 有封面：异步加载→采样→setTargets→三色过渡（token 防连续换歌竞态；trackKey = title\0artist，失败分支判别用） */
  loadCover(dataUrl: string, bpm: number | null, trackKey: string): void {
    const token = ++this.token
    void this.run(dataUrl, bpm, token, trackKey)
  }

  /** 无封面/unknown：退化星云 + 调色渐回冷色骨架 */
  clear(bpm: number | null): void {
    this.token++ // 作废在途加载
    this.lastCloud = null
    this.shownKey = null
    this._hasCover = false
    this.lastCoverMood = DEFAULT_MOOD // 无封面归位色；供切回极光时 reapply
    if (!this.colorSuppressed) this.startColorTween(DEFAULT_MOOD, bpm) // 背景接管调色期间不碰总线
    this.hooks.onCloudChanged()
    this.hooks.onSettled()
  }

  /** 每帧推进调色过渡，写回三色 uniform */
  update(dt: number): void {
    const p = this.colorTween.update(dt)
    const u = this.particles.uniforms
    u.uColorA.value.copy(this.fromA).lerp(this.toA, p)
    u.uColorB.value.copy(this.fromB).lerp(this.toB, p)
    u.uColorC.value.copy(this.fromC).lerp(this.toC, p)
  }

  /**
   * 最新请求加载失败时的收尾：换歌失败 → clear() 退化星云（旧封面是上一首的，不能装作没事）；
   * 同曲重载失败 → 只释放溶解锁，morph 拉回旧目标（屏上的封面本就是这首歌的，保持现状）
   */
  private settleFailure(trackKey: string, bpm: number | null): void {
    if (shouldClearOnCoverFail(trackKey, this.shownKey)) {
      this.clear(bpm)
    } else {
      this.hooks.onSettled()
    }
  }

  private async run(dataUrl: string, bpm: number | null, token: number, trackKey: string): Promise<void> {
    let imageData: ImageData
    try {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      if (token !== this.token) return // 解码期间已被更新的换歌取代
      const scale = Math.min(1, MAX_COVER_PX / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        if (token === this.token) this.settleFailure(trackKey, bpm)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      imageData = ctx.getImageData(0, 0, w, h)
    } catch (err) {
      console.warn('[nebula] 封面加载失败', err)
      // stale（有更新的 run 在途）什么都不做，锁归新请求管；只有最新请求失败才收尾
      if (token === this.token) this.settleFailure(trackKey, bpm)
      return
    }
    if (token !== this.token) return // 采样落地前又换歌 → 丢弃
    const cloud = sampleCoverPoints(imageData, this.count)
    this.lastCloud = cloud
    this.shownKey = trackKey
    this._hasCover = true
    this.lastCoverMood = remapToMood(extractDominant(imageData)) // 记着封面色（换歌也更新），供切回极光时 reapply
    if (!this.colorSuppressed) this.startColorTween(this.lastCoverMood, bpm) // 背景接管调色期间只加载形状、不改色
    this.hooks.onCloudChanged()
    this.hooks.onSettled()
  }

  /** 调色源门控（#背景取色 ②）：on=自定义背景激活，换歌不再用封面色改总线（形状照常加载）。
   * 关闭门控本身不改色——切回极光的复色由 reapplyCoverColor 显式驱动，两步分离语义清晰。 */
  setColorSuppressed(on: boolean): void {
    this.colorSuppressed = on
  }

  /** 背景取色写入调色总线（#背景取色 ②）：index.ts 切到自定义背景、取到背景 mood 后调用。 */
  applyExternalMood(mood: MoodPalette, bpm: number | null): void {
    this.startColorTween(mood, bpm)
  }

  /** 切回极光时把颜色 tween 回当前封面色（#背景取色 ②）：lastCoverMood 在换歌时持续更新，恒为最新。 */
  reapplyCoverColor(bpm: number | null): void {
    this.startColorTween(this.lastCoverMood, bpm)
  }

  private startColorTween(mood: MoodPalette, bpm: number | null): void {
    const u = this.particles.uniforms
    this.fromA.copy(u.uColorA.value); this.toA.setRGB(mood.primary.r, mood.primary.g, mood.primary.b)
    this.fromB.copy(u.uColorB.value); this.toB.setRGB(mood.deep.r, mood.deep.g, mood.deep.b)
    this.fromC.copy(u.uColorC.value); this.toC.setRGB(mood.highlight.r, mood.highlight.g, mood.highlight.b)
    this.colorTween.start(0, 1, quantizeToBeatGrid(3, bpm), easeStandard) // 时长同 uMorph
  }

  private applyMoodInstant(mood: MoodPalette): void {
    const u = this.particles.uniforms
    u.uColorA.value.setRGB(mood.primary.r, mood.primary.g, mood.primary.b)
    u.uColorB.value.setRGB(mood.deep.r, mood.deep.g, mood.deep.b)
    u.uColorC.value.setRGB(mood.highlight.r, mood.highlight.g, mood.highlight.b)
    this.fromA.copy(u.uColorA.value); this.toA.copy(u.uColorA.value)
    this.fromB.copy(u.uColorB.value); this.toB.copy(u.uColorB.value)
    this.fromC.copy(u.uColorC.value); this.toC.copy(u.uColorC.value)
  }
}
