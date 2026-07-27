// 形状层类型（Phase B spec §4.1）：轻量 ShapeProvider——由形状选择器真实用例逼出，不预造多余方法。
import type { ShapePointCloud } from '../cover-points'

/** 序幕专属形体（发布准备③「声音的形状进化史」）：只在首启引导期由编排层瞬态 apply，
 * 不进图鉴卡、不可持久化（SHAPE_IDS 白名单不含，sanitize 会把落盘的 demo 选择打回星云） */
export type DemoShapeId = 'demo-gramophone' | 'demo-cassette' | 'demo-headphones' | 'demo-mic'
export const DEMO_SHAPE_IDS: readonly DemoShapeId[] = ['demo-gramophone', 'demo-cassette', 'demo-headphones', 'demo-mic']

export type ShapeId = 'nebula' | 'heart' | 'spectrum' | 'waveform' | 'eclipse' | 'ledmatrix' | 'laser' | DemoShapeId
/** 用户可选/可持久化的形状白名单（sanitize 口径）——序幕形体故意不在此列；
 * statue/sphere(星球)/crystal(晶体) 已退役（用户拍板删卡）：旧存档选中它们由 sanitize 打回星云 */
export const SHAPE_IDS: readonly ShapeId[] = ['nebula', 'heart', 'spectrum', 'waveform', 'eclipse', 'ledmatrix', 'laser']

/** 主体类型（线条系 spec §④+图形三连 spec）：particles=粒子点云（缺省），其余=SDF 线条画板。
 * 选线条卡时粒子主体退场、线条主体登场（编排层 crossfade），歌词/背景/镜头不感知 */
export type BodyKind = 'particles' | 'spectrum' | 'waveform' | 'eclipse' | 'ledmatrix' | 'laser'

/** 方言家族（方言期批1+批2）：kernel 家族权重门控的 CPU 侧标识。
 * 'contour'=表面法线约束（雕像/序幕形体）；'heart'=法线约束+泵动；
 * 'crystal'=晶体（形状已退役，家族与 uDialCrystal 着色保留为休眠态，恒不触发） */
export type DialectFamily = 'none' | 'contour' | 'heart' | 'crystal'

/** 自定义形状元数据（idea #12）：只存源数据不存点云——文字存字符串、图片存 userData/custom-shapes/<id>.png，
 * 运行期现场重采样（换粒子档位自动适配）。image 的文件名由 id 推导，不另存字段（少一个可污染面） */
export interface CustomShapeMeta {
  id: string // uuid v4：文件名的唯一来源，IPC 白名单校验同源此正则
  kind: 'image' | 'text'
  text?: string // kind=text：原文，运行期重新光栅化
}

export const CUSTOM_SHAPES_MAX = 9
export const CUSTOM_SHAPE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ShapeDef {
  id: ShapeId
  /** 中文名，仅显示层（底层一律英文枚举，同 mapping 铁律） */
  label: string
  /** 封面式薄板标定挂钩（uTargetPlanar）：亮度补偿/打击站位 z 压平只对 planar 目标生效（spec §4.4）。
   * 几何形状均 false；封面在仲裁层视为 planar=true（它不在本注册表里） */
  planar: boolean
  /** 生成目标点云；count = 当前粒子数（quality.particles，随降级变）。
   * generate 本身为 null = 自由态（星云无吸附目标）；调用返回 null = 异步资产未就绪，仲裁按自由态回退（S2） */
  generate: ((count: number) => ShapePointCloud | null) | null
  /** 方言家族归属（注册表是家族的单一事实源） */
  dialect: DialectFamily
  /** 线条系主体标注（缺省 undefined=粒子）；resolveShape 早于 generate 判定 */
  body?: BodyKind
  /** 序幕专属（发布准备③）：true = 不出现在形状选择器卡片列 */
  demoOnly?: boolean
}

/** 用户持久化的形状选择（spec §4.5，electron settings.shape 字段） */
export interface ShapeSettings {
  current: ShapeId
  /** 非 null = 选中的是自定义形状（优先于 current）；点内置卡时归 null */
  customCurrent: string | null
  customShapes: CustomShapeMeta[]
  coverPriority: boolean
  /** 显示主体：false=隐藏五路主体（星尘/歌词/歌名不受影响）。选中自定义背景时联动置 false，用户可再打开 */
  showBody: boolean
}

// coverPriority 默认关（发布准备③ 用户复调）：首装主角是星云本体，封面接管改为用户主动开启
export const DEFAULT_SHAPE_SETTINGS: ShapeSettings = { current: 'nebula', customCurrent: null, customShapes: [], coverPriority: false, showBody: true }

function sanitizeCustomShapes(raw: unknown): CustomShapeMeta[] {
  if (!Array.isArray(raw)) return []
  const out: CustomShapeMeta[] = []
  for (const v of raw) {
    if (out.length >= CUSTOM_SHAPES_MAX) break
    if (typeof v !== 'object' || v === null) continue
    const m = v as Record<string, unknown>
    if (typeof m.id !== 'string' || !CUSTOM_SHAPE_ID_RE.test(m.id)) continue
    if (out.some((x) => x.id === m.id)) continue
    if (m.kind === 'text' && typeof m.text === 'string' && m.text.trim() !== '') {
      out.push({ id: m.id, kind: 'text', text: m.text })
    } else if (m.kind === 'image') {
      out.push({ id: m.id, kind: 'image' })
    }
  }
  return out
}

/** 坏数据回默认（= 现状行为：星云+封面优先），惯例同 sanitizeMappingValues */
export function sanitizeShapeSettings(raw: unknown): ShapeSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const customShapes = sanitizeCustomShapes(r.customShapes)
  const cc = typeof r.customCurrent === 'string' && customShapes.some((m) => m.id === r.customCurrent) ? r.customCurrent : null
  return {
    current: SHAPE_IDS.includes(r.current as ShapeId) ? (r.current as ShapeId) : DEFAULT_SHAPE_SETTINGS.current,
    customCurrent: cc,
    customShapes,
    coverPriority: typeof r.coverPriority === 'boolean' ? r.coverPriority : DEFAULT_SHAPE_SETTINGS.coverPriority,
    showBody: typeof r.showBody === 'boolean' ? r.showBody : DEFAULT_SHAPE_SETTINGS.showBody,
  }
}

/** 当前选中的自定义形状条目（仲裁/加载共用的唯一取值口径） */
export function selectedCustomMeta(s: ShapeSettings): CustomShapeMeta | null {
  return s.customCurrent ? s.customShapes.find((m) => m.id === s.customCurrent) ?? null : null
}
