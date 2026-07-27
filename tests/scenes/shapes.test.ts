import { describe, it, expect } from 'vitest'
import { SHAPES, shapeById, generateShape } from '../../src/scenes/nebula/shapes'
import { SHAPE_IDS, sanitizeShapeSettings, DEFAULT_SHAPE_SETTINGS, selectedCustomMeta, CUSTOM_SHAPES_MAX } from '../../src/scenes/nebula/shapes/types'
import { loadContourAssets, contourCloud } from '../../src/scenes/nebula/shapes/contour'

describe('形状注册表', () => {
  it('注册表 = 卡片序（statue/星球/晶体 退役后阵容7卡：星云/心脏/频谱环/波形线/日食/点阵/激光）；序幕形体 demoOnly 不进卡片列', () => {
    const cards = SHAPES.filter((s) => !s.demoOnly)
    expect(cards.map((s) => s.id)).toEqual(['nebula', 'heart', 'spectrum', 'waveform', 'eclipse', 'ledmatrix', 'laser'])
    expect(cards.map((s) => s.label)).toEqual(['星云', '心脏', '频谱环', '波形线', '日食', '点阵', '激光'])
    // 序幕四形体（发布准备③）：全部 demoOnly + contour 方言；不可持久化（SHAPE_IDS 白名单外）
    const demos = SHAPES.filter((s) => s.demoOnly)
    expect(demos.map((s) => s.id)).toEqual(['demo-gramophone', 'demo-cassette', 'demo-headphones', 'demo-mic'])
    for (const d of demos) {
      expect(d.dialect).toBe('contour')
      expect(SHAPE_IDS.includes(d.id)).toBe(false)
    }
    expect(sanitizeShapeSettings({ current: 'demo-gramophone' }).current).toBe('nebula') // 落盘的 demo 选择被打回默认
  })
  it('星云 = 自由态：generate 为 null，generateShape 返回 null', () => {
    expect(shapeById('nebula').generate).toBeNull()
    expect(generateShape('nebula', 100)).toBeNull()
  })
  it('几何形状均非 planar（planar 只属于封面薄板，spec §4.4）', () => {
    for (const s of SHAPES) expect(s.planar).toBe(false)
  })
  it('线条系卡：generate=null、body 标注、dialect none（body 缺省=particles 只有两张线条卡例外）', () => {
    expect(shapeById('spectrum').body).toBe('spectrum')
    expect(shapeById('waveform').body).toBe('waveform')
    expect(shapeById('spectrum').generate).toBeNull()
    expect(shapeById('waveform').generate).toBeNull()
    expect(shapeById('heart').body).toBeUndefined() // 缺省=粒子，不强制补字段
    expect(generateShape('spectrum', 100)).toBeNull()
  })
  it('图形三连（日食/点阵/激光）：generate=null、body 传导、身份即形状', () => {
    for (const id of ['eclipse', 'ledmatrix', 'laser'] as const) {
      expect(shapeById(id).body).toBe(id)
      expect(shapeById(id).generate).toBeNull()
      expect(generateShape(id, 100)).toBeNull()
    }
  })
})

describe('sanitizeShapeSettings', () => {
  it('坏枚举/缺字段/非对象 → 回默认 {nebula, coverPriority:true}（= 现状行为）', () => {
    expect(sanitizeShapeSettings(undefined)).toEqual(DEFAULT_SHAPE_SETTINGS)
    expect(sanitizeShapeSettings({ current: 'donut', coverPriority: 'yes' })).toEqual(DEFAULT_SHAPE_SETTINGS)
  })
  it('合法值原样保留；SHAPE_IDS 为白名单', () => {
    expect(sanitizeShapeSettings({ current: 'heart', coverPriority: false })).toEqual({ current: 'heart', customCurrent: null, customShapes: [], coverPriority: false, showBody: true })
    expect(SHAPE_IDS).toEqual(['nebula', 'heart', 'spectrum', 'waveform', 'eclipse', 'ledmatrix', 'laser'])
  })
  it('退役形状 sphere/crystal（用户拍板删卡）→ 旧存档打回星云', () => {
    expect(sanitizeShapeSettings({ current: 'sphere', coverPriority: false }).current).toBe('nebula')
    expect(sanitizeShapeSettings({ current: 'crystal', coverPriority: true }).current).toBe('nebula')
  })
  it('S1 迁移：老落盘值 wave/ring/halo 不再合法 → 回默认星云（coverPriority 保留）', () => {
    expect(sanitizeShapeSettings({ current: 'wave', coverPriority: false })).toEqual({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: false, showBody: true })
    expect(sanitizeShapeSettings({ current: 'ring', coverPriority: true })).toEqual({ current: 'nebula', customCurrent: null, customShapes: [], coverPriority: true, showBody: true })
    expect(sanitizeShapeSettings({ current: 'galaxy', coverPriority: true }).current).toBe('nebula')
    expect(sanitizeShapeSettings({ current: 'halo', coverPriority: true }).current).toBe('nebula')
  })
})

describe('ShapeSettings：显示主体 showBody', () => {
  it('默认显示主体（true）', () => {
    expect(DEFAULT_SHAPE_SETTINGS.showBody).toBe(true)
    expect(sanitizeShapeSettings({}).showBody).toBe(true)
  })

  it('非布尔回退默认', () => {
    expect(sanitizeShapeSettings({ showBody: 'yes' }).showBody).toBe(true)
    expect(sanitizeShapeSettings({ showBody: 0 }).showBody).toBe(true)
  })

  it('合法布尔原样采用', () => {
    expect(sanitizeShapeSettings({ showBody: false }).showBody).toBe(false)
  })
})

describe('sanitizeShapeSettings · 自定义形状（idea #12）', () => {
  const uid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

  it('旧设置文件（无 custom 字段）→ 空收藏 + 无选中', () => {
    const s = sanitizeShapeSettings({ current: 'nebula', coverPriority: false })
    expect(s.customShapes).toEqual([])
    expect(s.customCurrent).toBeNull()
  })

  it('合法条目通过：text 带非空文字、image 只留 id/kind', () => {
    const s = sanitizeShapeSettings({
      current: 'nebula', coverPriority: true, customCurrent: uid(1),
      customShapes: [
        { id: uid(1), kind: 'text', text: '你好' },
        { id: uid(2), kind: 'image', junk: 1 },
      ],
    })
    expect(s.customShapes).toEqual([
      { id: uid(1), kind: 'text', text: '你好' },
      { id: uid(2), kind: 'image' },
    ])
    expect(s.customCurrent).toBe(uid(1))
  })

  it('坏条目丢弃：非 uuid id / 空文字 text / 未知 kind / 重复 id', () => {
    const s = sanitizeShapeSettings({
      current: 'nebula', coverPriority: true,
      customShapes: [
        { id: '../evil', kind: 'image' },
        { id: uid(1), kind: 'text', text: '  ' },
        { id: uid(2), kind: 'video' },
        { id: uid(3), kind: 'image' },
        { id: uid(3), kind: 'image' },
      ],
    })
    expect(s.customShapes).toEqual([{ id: uid(3), kind: 'image' }])
  })

  it('超上限截断到 9 条', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: uid(i + 1), kind: 'image' }))
    expect(sanitizeShapeSettings({ current: 'nebula', coverPriority: true, customShapes: many }).customShapes).toHaveLength(CUSTOM_SHAPES_MAX)
  })

  it('customCurrent 不在收藏里 → 归 null（孤儿选中不进仲裁）', () => {
    const s = sanitizeShapeSettings({ current: 'nebula', coverPriority: true, customCurrent: uid(9), customShapes: [] })
    expect(s.customCurrent).toBeNull()
  })

  it('selectedCustomMeta：命中返回条目，null 选中返回 null', () => {
    const s = sanitizeShapeSettings({
      current: 'nebula', coverPriority: true, customCurrent: uid(1),
      customShapes: [{ id: uid(1), kind: 'text', text: 'hi' }],
    })
    expect(selectedCustomMeta(s)).toEqual({ id: uid(1), kind: 'text', text: 'hi' })
    expect(selectedCustomMeta({ ...s, customCurrent: null })).toBeNull()
  })
})

describe('轮廓形状（S2）', () => {
  /** 自足加载（审查 Important 修复）：单跑/重排后面的 it 也成立。已就绪时 loadContourAssets
   * 被 loaded.has 短路（不重复请求、也不再回调 onReady）——故先查 contourCloud，
   * 未就绪才等待；且只在指定 id 就绪时 resolve（onReady 每 id 各回调一次） */
  async function ensureContourLoaded(id: 'heart'): Promise<void> {
    if (contourCloud(id, 1)) return
    const N = 200
    const buf = new Float32Array(N * 6)
    for (let i = 0; i < N * 3; i++) buf[i] = i * 0.001
    for (let i = N * 3; i < N * 6; i++) buf[i] = 1 // 法线块确定性非零（方言期批1：aux 消费）
    const fetchAsset = async (_id: string) => new Uint8Array(buf.buffer)
    await new Promise<void>((resolve) =>
      loadContourAssets(fetchAsset as never, (ready) => { if (ready === id) resolve() }),
    )
  }

  it('字节数不符布局 v1 的资产 → 加载失败回退（loaded 不落，contourCloud 仍 null）', async () => {
    // 顺序敏感（同区块注释纪律同上）：本用例须在本文件内任何 ensureContourLoaded/loadContourAssets
    // 调用之前执行，heart 还是模块新鲜态，loadContourAssets 才会真正发起请求触发 parse 防御。
    const fetchBad = async (_id: string) => new Uint8Array(25) // 25 % 24 ≠ 0
    let readyCalled = false
    loadContourAssets(fetchBad as never, () => { readyCalled = true })
    await new Promise((r) => setTimeout(r, 0)) // 让 rejection 走完 catch
    expect(readyCalled).toBe(false)
    expect(contourCloud('heart', 1)).toBeNull() // loaded 不落的显式验证（终审 Minor 补强判别力）
  })

  it('未就绪：generateShape 返回 null 且不落缓存；就绪后同 (id,count) 返回点云并可记忆化', async () => {
    expect(generateShape('heart', 100)).toBeNull()
    // 构造 v1 布局假资产：N=200 点（pos 600 f32 + norm 600 f32）
    const N = 200
    const buf = new Float32Array(N * 6)
    for (let i = 0; i < N * 3; i++) buf[i] = i * 0.001
    for (let i = N * 3; i < N * 6; i++) buf[i] = 1 // 法线块确定性非零（方言期批1：aux 消费）
    const fetchAsset = async (_id: string) => new Uint8Array(buf.buffer)
    await new Promise<void>((resolve) => loadContourAssets(fetchAsset as never, () => resolve()))
    const c = generateShape('heart', 100)!
    expect(c.positions.length).toBe(100 * 3)
    expect(c.positions[3]).toBeCloseTo(0.003, 6) // 前缀取点=烘焙序
    expect(generateShape('heart', 100)).toBe(c) // 就绪后记忆化生效
  })
  it('count 超过资产点数时钳制到资产点数（防越界）', async () => {
    await ensureContourLoaded('heart')
    const c = contourCloud('heart', 999_999)!
    expect(c.positions.length).toBeLessThanOrEqual(200 * 3)
  })
  it('心脏最小覆盖：就绪后 contourCloud 返回点云', async () => {
    await ensureContourLoaded('heart')
    const c = contourCloud('heart', 50)!
    expect(c.positions.length).toBe(50 * 3)
  })
  it('法线块进 aux（方言期批1）：aux.xyz=烘焙法线、w=0，与 positions 同序', async () => {
    await ensureContourLoaded('heart') // fake 资产法线块由本任务改为非零（见 ensureContourLoaded 改造）
    const c = contourCloud('heart', 10)!
    expect(c.aux).toBeDefined()
    expect(c.aux!.length).toBe(10 * 4)
    expect(c.aux![0]).toBeCloseTo(1, 5)
    expect(c.aux![3]).toBe(0) // w 备用位恒 0
  })
})
