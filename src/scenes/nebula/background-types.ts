// 背景设置（虚空之镜 spec §设置契约）：BackgroundSettings + sanitize——本文件被 electron/settings.ts 复用，
// 零 DOM/零 three 依赖纪律同 lyrics-fx.ts。MIRROR_Y 也住这里：mirror.ts 与 camera-director.ts 共同消费，
// 放零依赖文件避免「镜头模块 import 镜面模块」的倒挂。

/** name = 上传时的原文件名（去扩展名，亲验反馈：卡片显示名，多卡可辨）；v2 前存量无此字段回落「图片/视频」 */
export interface CustomBackgroundMeta { id: string; kind: 'image' | 'video'; name?: string }
export const CUSTOM_BACKGROUNDS_MAX = 6
/** uuid 白名单：id 会拼进主进程文件路径，正则是路径穿越的唯一防线（custom-shapes 同哲学） */
export const CUSTOM_BG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ===== 视频背景 v2（spec 2026-07-22-video-background-v2-design）=====
/** 视频容器白名单（Chromium 硬解范围）：主进程落盘分流与渲染层类型判别共用（单一事实源） */
export const BACKGROUND_VIDEO_EXTS = ['mp4', 'mov', 'webm'] as const
/** 视频大小上限：拷原件策略（用户拍板），超限拒收 */
export const BACKGROUND_VIDEO_MAX_BYTES = 500 * 1024 * 1024

export interface BackgroundSettings {
  aurora: number  // 极光强度 0..1；0=天空退回近黑（星野保留）
  ripple: number  // 涟漪强度 0..1；0=永不起圈
  // 尘埃密度 0..1（亲验 fb1 修订④）：远/中两壳的实例绘制配额比例——近壳是点缀不受此控，
  // 仍单独归 nearDust 开关管；0=远/中两壳几乎不画，只剩近壳（若可见）零星点缀
  dust: number
  // 尘埃粒径/亮度倍率（亲验 fb3：存在感改造）：乘在 shader uniform 上，拖动零重建。
  // 量程即防线——加色混合+bloom 下 2.5 倍拉满仍不炸白斑
  dustSize: number
  dustBright: number
  // 镜面总开关（#镜面开关）：false=暗底平面+拍点涟漪圈整块隐藏（部分形状无镜更空灵）
  mirror: boolean
  // ===== 自定义背景 v1（spec 2026-07-22-custom-background-design）=====
  /** 上传背景收藏（≤CUSTOM_BACKGROUNDS_MAX）；文件在 userData/backgrounds/<id>.jpg，settings 是权威 */
  customBackgrounds: CustomBackgroundMeta[]
  /** 背景源：'aurora'=默认星空极光（极光+涟漪+镜面组合）；否则为收藏中的 uuid（互斥判别字段） */
  current: string
  // ===== 视频背景 v2：自定义背景观感控制组（全局一套，用户拍板）=====
  bgOpacity: number      // 透明度 0..1：往纯黑底压暗背景，1=原样 0=全黑（过亮素材保主体可读的核心控件）
  bgSaturation: number   // 饱和度 0..1：0=黑白
  bgBreathe: boolean     // 响度明暗呼吸开关（v1 强制开 → 可关）
}

// 首启观感调优（2026-07-23 用户复调）：尘埃走「少而亮」——密度大降、粒径收小、亮度拉满，
// 换取疏朗有呼吸的星野而非糊成一片；涟漪大幅收敛，让镜面拍点成为点缀而非主角
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings =
  { aurora: 1, ripple: 0.2, dust: 0.15, dustSize: 0.6, dustBright: 2, mirror: true, customBackgrounds: [], current: 'aurora', bgOpacity: 0.8, bgSaturation: 1, bgBreathe: true }

/** 滑块量程单一事实源：sanitize 与调音台共用（惯例同 CAMERA_LIMITS） */
export const BACKGROUND_LIMITS = {
  aurora: { min: 0, max: 1, step: 0.05 },
  ripple: { min: 0, max: 1, step: 0.05 },
  dust: { min: 0, max: 1, step: 0.05 },
  dustSize: { min: 0.5, max: 2.5, step: 0.05 },
  dustBright: { min: 0.5, max: 2.5, step: 0.05 },
  bgOpacity: { min: 0, max: 1, step: 0.05 },
  bgSaturation: { min: 0, max: 1, step: 0.05 },
} as const

/** 镜面世界高度（亲验 fb1 修订②：用户拍板「上移贴镜」，-3.4 → -2.2）：倒影已整体退役
 * （见 mirror.ts），镜面现在是「暗面 + 拍点涟漪画布」，抬高到贴近模型才能让涟漪在默认机位
 * （y≈0.2 望向原点）可感。粒子静默态运动包络 mix(1.6,2.7,0)+弹性脉冲 0.6 = 2.2，恰好不穿面；
 * 高能段粒子随包络顶到 2.7+0.6=3.3 会「沾水」（部分粒子穿过镜面）——用户拍板接受，天然读作
 * 「入水」，若亲验穿帮再补软地板（particles.ts:394 bound 公式）。CAM_FLOOR 随本常量自动收紧。
 * 亲验 fb2：用户指定 -2.2 → -2.5（沾水余量多留 0.3，仍贴模型保涟漪可感）。 */
export const MIRROR_Y = -2.5

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

function sanitizeCustomBackgrounds(raw: unknown): CustomBackgroundMeta[] {
  if (!Array.isArray(raw)) return []
  const out: CustomBackgroundMeta[] = []
  const seen = new Set<string>() // 重复 id 跳过：否则 UI 卡片 Map 以 id 为键会冲突，产生清不掉的孤儿 DOM 卡
  for (const item of raw) {
    if (out.length >= CUSTOM_BACKGROUNDS_MAX) break
    const m = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    if (typeof m.id !== 'string' || !CUSTOM_BG_ID_RE.test(m.id)) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const kind = m.kind === 'video' ? 'video' as const : 'image' as const
    // name 只收非空字符串并截 80 字符（防超长文件名撑爆存档）；无效则整个省略键，旧断言/旧存档语义不变
    const name = typeof m.name === 'string' && m.name.trim() !== '' ? m.name.trim().slice(0, 80) : null
    out.push(name ? { id: m.id, kind, name } : { id: m.id, kind })
  }
  return out
}

/** 坏数据回默认/出界钳限幅，惯例同 sanitizeCameraSettings */
export function sanitizeBackgroundSettings(raw: unknown): BackgroundSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_BACKGROUND_SETTINGS
  const L = BACKGROUND_LIMITS
  const customBackgrounds = sanitizeCustomBackgrounds(r.customBackgrounds)
  // current 回落纪律：不是 'aurora' 且不在清洗后的收藏里 → 回落（防孤儿引用/路径注入）
  const current = typeof r.current === 'string' &&
    (r.current === 'aurora' || customBackgrounds.some((m) => m.id === r.current)) ? r.current : 'aurora'
  return {
    aurora: num(r.aurora, d.aurora, L.aurora.min, L.aurora.max),
    ripple: num(r.ripple, d.ripple, L.ripple.min, L.ripple.max),
    dust: num(r.dust, d.dust, L.dust.min, L.dust.max),
    dustSize: num(r.dustSize, d.dustSize, L.dustSize.min, L.dustSize.max),
    dustBright: num(r.dustBright, d.dustBright, L.dustBright.min, L.dustBright.max),
    mirror: typeof r.mirror === 'boolean' ? r.mirror : d.mirror,
    customBackgrounds,
    current,
    bgOpacity: num(r.bgOpacity, d.bgOpacity, L.bgOpacity.min, L.bgOpacity.max),
    bgSaturation: num(r.bgSaturation, d.bgSaturation, L.bgSaturation.min, L.bgSaturation.max),
    bgBreathe: typeof r.bgBreathe === 'boolean' ? r.bgBreathe : d.bgBreathe,
  }
}
