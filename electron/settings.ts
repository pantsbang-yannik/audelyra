// 设置持久化（M4 设计 2.4：主进程是设置唯一权威）。纯 node 实现，零 electron 依赖以便单测。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { sanitizeMappingValues, defaultRhythmPreset } from '../src/scenes/nebula/mapping/spec'
import type { MappingValues } from '../src/scenes/nebula/mapping/types'
import { sanitizeShapeSettings, DEFAULT_SHAPE_SETTINGS, type ShapeSettings } from '../src/scenes/nebula/shapes/types'
import { sanitizeMotionSettings, DEFAULT_MOTION_SETTINGS, type MotionSettings } from '../src/scenes/nebula/motion/types'
import { sanitizeCameraSettings, DEFAULT_CAMERA_SETTINGS, type CameraSettings } from '../src/scenes/nebula/camera-types'
import { sanitizeTitleSettings, DEFAULT_TITLE_SETTINGS, type TitleSettings } from '../src/scenes/nebula/title-fx'
import { sanitizeLyricsSettings, DEFAULT_LYRICS_SETTINGS, type LyricsSettings } from '../src/scenes/nebula/lyrics/lyrics-fx'
import { sanitizeBackgroundSettings, DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from '../src/scenes/nebula/background-types'
import { sanitizeMacroKnobs, DEFAULT_MACRO_KNOBS, type MacroKnobs } from '../src/scenes/nebula/mapping/macro'
import { parseSemver } from './update/protocol'
import { bodyVisibilityLink, BUILTIN_BACKGROUND_ID } from '../src/scenes/nebula/body-visibility-link'

export type TierSetting = 'auto' | 'high' | 'mid' | 'low'

/** 更新检查（发布准备②）：enabled=自动检查开关（这是除歌词外唯一的主动网络请求，可关守隐私）；
 * skippedVersion=「跳过此版本」记账，更高版本出现时协议层自然重新提示 */
export interface UpdateCheckSettings { enabled: boolean; skippedVersion: string | null }

export const DEFAULT_UPDATE_CHECK: UpdateCheckSettings = { enabled: true, skippedVersion: null }

export function sanitizeUpdateCheck(v: unknown): UpdateCheckSettings {
  const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_UPDATE_CHECK.enabled,
    skippedVersion: parseSemver(r.skippedVersion) ? (r.skippedVersion as string) : null
  }
}

/** 普通窗的记忆大小/位置；null = 从未记忆过，首次用默认尺寸（=启动尺寸）并居中（两态模型拍板 2026-07-06） */
export interface WinBounds { x: number; y: number; width: number; height: number }

export interface AudelyraSettings {
  tier: TierSetting
  title: TitleSettings          // ← 粒子歌名（原切歌拼字）：模式 off/timed/always + 位置/大小/亮度
  launchAtLogin: boolean
  winBounds: WinBounds | null
  preventSleep: boolean
  onboarded: boolean
  mapping: MappingValues        // ← 新增：音频→视觉映射用户存档
  macroKnobs: MacroKnobs        // ← 二期标准层：风格档 + 劲儿/跟手两个标量，mapping 的「源」
  tuningAdvancedExpanded: boolean // ← 律动页「高级调整」折叠态：普通用户默认收起，玩家展开后跨重启记住
  shape: ShapeSettings          // ← Phase B1：形状选择 + 封面优先
  motion: MotionSettings        // ← Phase C2：主体 tab 的运动手感旋钮
  camera: CameraSettings        // ← Phase D：镜头运镜活跃度旋钮
  lyrics: LyricsSettings        // ← 歌词二期：显示/大小/节奏动态/亮度
  background: BackgroundSettings // ← 虚空之镜：极光/涟漪/尘埃密度
  updateCheck: UpdateCheckSettings // ← 发布准备②：自动检查更新开关 + 跳过版本记账
}

export const DEFAULT_SETTINGS: AudelyraSettings = {
  tier: 'auto',
  title: DEFAULT_TITLE_SETTINGS,
  launchAtLogin: false,
  winBounds: null,
  preventSleep: false,
  onboarded: false,
  mapping: defaultRhythmPreset(),  // ← 新增
  macroKnobs: DEFAULT_MACRO_KNOBS,
  tuningAdvancedExpanded: false,
  shape: DEFAULT_SHAPE_SETTINGS,
  motion: DEFAULT_MOTION_SETTINGS,
  camera: DEFAULT_CAMERA_SETTINGS,
  lyrics: DEFAULT_LYRICS_SETTINGS,
  background: DEFAULT_BACKGROUND_SETTINGS,
  updateCheck: DEFAULT_UPDATE_CHECK
}

const TIER_VALUES: readonly string[] = ['auto', 'high', 'mid', 'low']
const WIN_BOUNDS_MIN = 200
const WIN_BOUNDS_MAX = 8192

/** 合法 WinBounds：对象、四字段均为有限数、width/height 落在 [200, 8192]，否则回退 null */
function sanitizeWinBounds(v: unknown): WinBounds | null {
  if (typeof v !== 'object' || v === null) return null
  const b = v as Record<string, unknown>
  const { x, y, width, height } = b
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if ((width as number) < WIN_BOUNDS_MIN || (width as number) > WIN_BOUNDS_MAX) return null
  if ((height as number) < WIN_BOUNDS_MIN || (height as number) > WIN_BOUNDS_MAX) return null
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** 逐字段校验：非法/缺失字段回退默认值（设置文件损坏不崩，M4 设计第 8 节），多余字段丢弃 */
export function sanitizeSettings(raw: unknown): AudelyraSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const background = sanitizeBackgroundSettings(r.background)
  const shape = sanitizeShapeSettings(r.shape)
  // 老存档迁移：旧版该开关是 background.bgShowBodies（默认 false，仅自定义背景下有效），
  // 新语义默认 true。直接翻转会让正在用自定义背景的老用户突然冒出主体 → 按升级前的观感推导。
  // 只在新字段缺失时生效，故迁移过一次后不再干预用户选择。
  const rawShape = (typeof r.shape === 'object' && r.shape !== null ? r.shape : {}) as Record<string, unknown>
  const rawBg = (typeof r.background === 'object' && r.background !== null ? r.background : {}) as Record<string, unknown>
  if (typeof rawShape.showBody !== 'boolean') {
    const usingCustomBg = background.current !== BUILTIN_BACKGROUND_ID
    shape.showBody = !(usingCustomBg && rawBg.bgShowBodies !== true)
  }
  return {
    tier: TIER_VALUES.includes(r.tier as string) ? (r.tier as TierSetting) : DEFAULT_SETTINGS.tier,
    // 旧字段 showParticleTitle（本功能首版布尔）作迁移输入：false → mode 'off'
    title: sanitizeTitleSettings(r.title, r.showParticleTitle),
    launchAtLogin: bool(r.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    winBounds: sanitizeWinBounds(r.winBounds),
    preventSleep: bool(r.preventSleep, DEFAULT_SETTINGS.preventSleep),
    onboarded: bool(r.onboarded, DEFAULT_SETTINGS.onboarded),
    mapping: sanitizeMappingValues(r.mapping),  // ← 新增
    macroKnobs: sanitizeMacroKnobs(r.macroKnobs),
    tuningAdvancedExpanded: bool(r.tuningAdvancedExpanded, DEFAULT_SETTINGS.tuningAdvancedExpanded),
    shape,
    motion: sanitizeMotionSettings(r.motion),
    camera: sanitizeCameraSettings(r.camera),
    lyrics: sanitizeLyricsSettings(r.lyrics),
    background,
    updateCheck: sanitizeUpdateCheck(r.updateCheck)
  }
}

export class SettingsStore {
  private current: AudelyraSettings
  private listeners: Array<(s: AudelyraSettings) => void> = []

  constructor(private filePath: string) {
    this.current = this.load()
  }

  get(): AudelyraSettings {
    // winBounds/mapping 是嵌套对象，浅拷贝也要防外部改动污染内部状态；mapping 更深一层，用 JSON 往返深拷贝
    return {
      ...this.current,
      winBounds: this.current.winBounds ? { ...this.current.winBounds } : null,
      mapping: JSON.parse(JSON.stringify(this.current.mapping)),
      macroKnobs: { ...this.current.macroKnobs },
      shape: { ...this.current.shape, customShapes: this.current.shape.customShapes.map((m) => ({ ...m })) },
      motion: { ...this.current.motion },
      camera: { ...this.current.camera },
      title: { ...this.current.title },
      lyrics: { ...this.current.lyrics },
      background: { ...this.current.background },
      updateCheck: { ...this.current.updateCheck }
    }
  }

  /** patch 合并 → 全量校验 → 原子落盘 → 通知订阅者
   * winBounds/mapping/shape 每次 sanitize 都会生成新对象引用，逐键 !== 比较对它们必然误判为"变了"——
   * 这些对象字段改按值比较（JSON），其余标量字段仍用 !== */
  set(patch: Partial<AudelyraSettings>): AudelyraSettings {
    const merged = sanitizeSettings({ ...this.current, ...patch })
    // 主体显隐联动（判定在纯函数里，此处只接线）：背景在内置↔自定义间跨越 ⇒ 关/开主体；
    // 换形状 ⇒ 开主体。与本次写入同一轮 sanitize/落盘/广播，避免二次写入引发回声
    const linked = bodyVisibilityLink(
      { backgroundCurrent: this.current.background.current, shapeCurrent: this.current.shape.current, shapeCustomCurrent: this.current.shape.customCurrent },
      { backgroundCurrent: merged.background.current, shapeCurrent: merged.shape.current, shapeCustomCurrent: merged.shape.customCurrent },
    )
    const next = linked === null ? merged : { ...merged, shape: { ...merged.shape, showBody: linked } }
    // shape 与 winBounds/mapping 同罪：sanitize 每次生成新引用，逐键 !== 必然误判（评审 I4）
    const OBJECT_KEYS = new Set<keyof AudelyraSettings>(['winBounds', 'mapping', 'macroKnobs', 'shape', 'motion', 'camera', 'title', 'lyrics', 'background', 'updateCheck'])
    const changed = (Object.keys(next) as Array<keyof AudelyraSettings>).some((k) => {
      if (OBJECT_KEYS.has(k)) return JSON.stringify(next[k]) !== JSON.stringify(this.current[k])
      return next[k] !== this.current[k]
    })
    if (!changed) return this.get() // 无变化短路：不落盘不广播（防设置面板回写回声）
    this.current = next
    this.persist()
    for (const l of [...this.listeners]) l(this.get())
    return this.get()
  }

  subscribe(l: (s: AudelyraSettings) => void): () => void {
    this.listeners.push(l)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }

  private load(): AudelyraSettings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch {
      return { ...DEFAULT_SETTINGS } // 不存在/损坏都回退默认；首次 set 时才写盘
    }
  }

  /** tmp + rename 原子写：进程在写一半崩溃也不会留下损坏的 settings.json */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.current, null, 2))
    renameSync(tmp, this.filePath)
  }
}
