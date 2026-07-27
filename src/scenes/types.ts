import type { Signals } from '../engine/types'
import type { MappingValues } from './nebula/mapping/types'
import type { ShapeSettings } from './nebula/shapes/types'
import type { MotionSettings } from './nebula/motion/types'
import type { CameraSettings } from './nebula/camera-types'
import type { TitleSettings } from './nebula/title-fx'
import type { LyricsSettings } from './nebula/lyrics/lyrics-fx'
import type { BackgroundSettings } from './nebula/background-types'
import type { GalaxyView } from './nebula/galaxy/types'

export type SceneTrackEvent =
  | { kind: 'change'; title: string; artist: string; artworkDataUrl: string | null }
  | { kind: 'unknown' }

/** 播放进度事件（歌词二期 spec §3）：stream 事件流与 5s 轮询兜底共用同一形状 */
export interface ScenePlaybackProgress {
  elapsedTime: number
  duration: number | null
  playbackRate: number
  playing: boolean
}

/** 歌词文档（key = `title\0artist`，与 track 去重键同构；none = 双源未命中） */
export type SceneLyricsDoc =
  | { key: string; lines: Array<{ t: number; text: string }> }
  | { key: string; none: true }

/** 退台分级（A2）：'full' 调暗+退焦+镜头后拉三联动；'camera' 仅镜头后拉 */
export type UiFocusProfile = 'full' | 'camera'

/** 背景能力开关（虚空之镜 spec §性能分档；亲验 fb1 修订①：倒影整体退役，reflection 字段随之退役） */
export interface BackgroundCaps {
  auroraDetail: 'full' | 'simple'
  ripple: boolean
  nearDust: boolean
}

export interface QualityTier {
  name: 'ultra' | 'high' | 'mid' | 'low'
  particles: number
  dprCap: number
  bloom: boolean
  background: BackgroundCaps
}

export interface SceneContext {
  canvas: HTMLCanvasElement
  /** host 级默认档（placeholder 等简单场景直接使用）；重量级场景在 init 探明 backend 后自行 pickInitialTier，本值仅作兜底参考 */
  quality: QualityTier
  /** 手动档位（设置面板指定，M4 设计第 5 节）：给出则场景放弃 backend 自动选档，直接采用 */
  forcedTier?: QualityTier
  /** GPU 计时（性能基线）：仅 perf 入口传 true。必须在 renderer 构造期传入——
   * three 的 trackTimestamp 是 Backend 构造参数，构造后再赋值无效 */
  trackTimestamp?: boolean
}

export interface Scene {
  init(ctx: SceneContext): Promise<void> | void
  update(dt: number, signals: Signals | null): void
  onTrackChange(t: SceneTrackEvent): void
  resize?(width: number, height: number): void
  /** 快门（idea #6，可选）：所见即所得——回读画布当前呈现帧（含 bloom 等全部后期）。
   * fb1 用户拍板：RT 竖构图重渲退役（视角与屏幕不符=「拍的和看的不一样」）。
   * 返回 null = 场景未就绪/回读失败。 */
  snapshot?(): Promise<ImageData | null>
  /** UI 前置度 0..1（可选）：UI 打开时场景退台——相机后拉/退焦/调光（M4 设计 2.3 路线 C）；
   * profile 默认 'full'（三联动），'camera' 仅镜头后拉（A2 退台分级） */
  setUiFocus?(v: number, profile?: UiFocusProfile): void
  /** 实时注入音频→视觉映射配置（可选）：运行中场景热更映射规则，无需重建 */
  applyMapping?(m: MappingValues): void
  /** 实时注入形状选择（可选）：形状/封面优先变更即时仲裁生效，无需重建（Phase B1） */
  applyShape?(s: ShapeSettings): void
  /** 实时注入运动方言手感设置（可选）：运行中场景热更 MotionProgram 旋钮，无需重建（Phase C2） */
  applyMotion?(m: MotionSettings): void
  /** 实时注入镜头运镜设置（可选）：运行中场景热更活跃度旋钮，无需重建（Phase D） */
  applyCamera?(c: CameraSettings): void
  /** 注入「镜头设置提交」回调（可选）：场景内滚轮改默认距离时，冒泡出去落盘 + 广播（#镜头精修 ①） */
  setCameraCommit?(cb: (c: CameraSettings) => void): void
  /** 手动交互开关（可选）：小窗态禁运镜，拖拽让位给移窗（M4 设计第 4 节） */
  setInteractive?(on: boolean): void
  /** 切歌拼字设置（模式 off/timed/always + 大小，设置面板两行）；未实现的场景忽略 */
  applyTitle?(t: TitleSettings): void
  /** 播放进度事件（可选）：外插钟 mark 基准；未实现的场景忽略 */
  onProgress?(p: ScenePlaybackProgress): void
  /** 歌词文档到达（可选）：key 匹配当前歌才消费；未实现的场景忽略 */
  onLyrics?(d: SceneLyricsDoc): void
  /** 歌词设置（显示/大小/节奏动态/亮度，设置面板「歌词」分组）；未实现的场景忽略 */
  applyLyrics?(s: LyricsSettings): void
  /** 背景设置（极光/涟漪强度，调音台「背景」Tab）；未实现的场景忽略 */
  applyBackground?(b: BackgroundSettings): void
  /** 星系图鉴（idea #4）：进入/退出/视图更新一体（active 翻转=模式切换）；未实现的场景忽略 */
  applyGalaxy?(g: GalaxyView): void
  /** 试音模式进出：场景据此**隔离自适应状态**（滚动峰值归一等）。
   * 不隔离会双向出错——试音的定标压低退出后安静歌曲的反应（半衰期 30s，残留上百秒），
   * 而历史响歌又会让同一个 pad 的响应打折、破坏「精确可重复」。
   * @param resetPeaks 进入时把频段归一峰值**复位**到此量级（试音的标定值），使 pad 响应与听歌史无关；
   *                   退出时还原为进入前的快照。未实现的场景忽略 */
  setAuditionActive?(active: boolean, resetPeaks?: [number, number, number]): void
  /** 星系是否已完全退出（相位回到 live）。模式切换须据此**等待视觉状态真正结束**——
   * 星系是独立更新路径（跳过 mapper），退出时还有约 1s 的溶解动画；只翻布尔就开演，
   * 会得到「试音条与音效都正常、画面映射却无效」的假象。未实现的场景视为恒为 true */
  isGalaxyIdle?(): boolean
  dispose(): void
}
