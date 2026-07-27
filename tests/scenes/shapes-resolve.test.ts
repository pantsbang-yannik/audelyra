import { describe, it, expect, beforeAll } from 'vitest'
import { resolveShape, planShapeSwap, shapeSelectionChanged, planRefreshAction, isBackfillReveal, type ResolvedKind, type ResolvedShape } from '../../src/scenes/nebula/shapes/resolve'
import { generateShape } from '../../src/scenes/nebula/shapes'
import { SHAPE_IDS } from '../../src/scenes/nebula/shapes/types'
import { loadContourAssets, contourCloud } from '../../src/scenes/nebula/shapes/contour'
import type { ShapePointCloud } from '../../src/scenes/nebula/cover-points'

const coverCloud = { positions: new Float32Array(9), colors: new Float32Array(9) }

// 星球/晶体退役后，唯一的几何生成形状是 heart（异步轮廓）——几何路径用例统一用它当代表，
// 先加载 fake 轮廓资产让 generateShape('heart', n) 同步可得点云（布局同 shapes.test.ts）
beforeAll(async () => {
  if (contourCloud('heart', 1)) return
  const N = 200
  const buf = new Float32Array(N * 6)
  for (let i = 0; i < N * 3; i++) buf[i] = i * 0.001
  for (let i = N * 3; i < N * 6; i++) buf[i] = 1
  const fetchAsset = async (_id: string): Promise<Uint8Array> => new Uint8Array(buf.buffer)
  await new Promise<void>((resolve) => loadContourAssets(fetchAsset as never, (ready) => { if (ready === 'heart') resolve() }))
})

describe('resolveShape 全组合（4 形状 × 开关 × 有无封面，spec §5）', () => {
  it('coverPriority=on + 有封面 → 恒为 cover（骑在所有形状之上），planar/hasColor 全真', () => {
    for (const current of SHAPE_IDS) {
      const r = resolveShape({ current, coverPriority: true, coverCloud, custom: null, count: 100 })
      expect(r).toEqual({ target: coverCloud, kind: 'cover', planar: true, hasColor: true, dialect: 'none', body: 'particles' })
    }
  })
  it('coverPriority=off（即使有封面）→ 所选形状说了算；封面不劫持吸附目标', () => {
    const r = resolveShape({ current: 'heart', coverPriority: false, coverCloud, custom: null, count: 100 })
    expect(r.kind).toBe('geometry')
    expect(r.target).toBe(generateShape('heart', 100)) // 记忆化同引用
    expect(r.planar).toBe(false)
    expect(r.hasColor).toBe(false)
  })
  it('无封面 + 几何形状 → geometry；无封面 + 星云 → free（target null）', () => {
    expect(resolveShape({ current: 'heart', coverPriority: true, coverCloud: null, custom: null, count: 50 }).kind).toBe('geometry')
    const free = resolveShape({ current: 'nebula', coverPriority: true, coverCloud: null, custom: null, count: 50 })
    expect(free).toEqual({ target: null, kind: 'free', planar: false, hasColor: false, dialect: 'none', body: 'particles' })
  })
  it('coverPriority=on + 有封面 + 星云 → 仍是 cover（开关语义优先）', () => {
    expect(resolveShape({ current: 'nebula', coverPriority: true, coverCloud, custom: null, count: 50 })).toEqual({ target: coverCloud, kind: 'cover', planar: true, hasColor: true, dialect: 'none', body: 'particles' })
  })
  it('线条系仲裁：选 spectrum/waveform → kind=linework、target=null、body 传导；封面优先仍压过', () => {
    const s = resolveShape({ current: 'spectrum', coverPriority: false, coverCloud: null, custom: null, count: 100 })
    expect(s.kind).toBe('linework')
    expect(s.target).toBeNull()
    expect(s.body).toBe('spectrum')
    const w = resolveShape({ current: 'waveform', coverPriority: false, coverCloud: null, custom: null, count: 100 })
    expect(w.body).toBe('waveform')
    for (const id of ['eclipse', 'ledmatrix', 'laser'] as const) {
      const t = resolveShape({ current: id, coverPriority: false, coverCloud: null, custom: null, count: 100 })
      expect(t.kind).toBe('linework')
      expect(t.target).toBeNull()
      expect(t.body).toBe(id)
    }
    const cover = resolveShape({
      current: 'spectrum', coverPriority: true,
      coverCloud: { positions: new Float32Array(3) }, custom: null, count: 1,
    })
    expect(cover.kind).toBe('cover')
    expect(cover.body).toBe('particles')
  })
})

describe('planShapeSwap（spec §4.3 N1：跨 cover 边界必须溶解，uniform 二值瞬跳=单帧爆闪）', () => {
  // 语义等价映射（旧 kind 判据 → 新标志位判据）：'cover' → {planar:true,hasColor:true}，其余 → {planar:false,hasColor:false}
  const F = { planar: false, hasColor: false }
  const T = { planar: true, hasColor: true }
  const cases: Array<[typeof F, typeof F, 'immediate' | 'dissolve']> = [
    [T, F, 'dissolve'],
    [F, T, 'dissolve'],
    [T, F, 'dissolve'],
    [F, T, 'dissolve'], // free 时 morph≈0，编排层溶解即刻完成，无额外代价
    [F, F, 'immediate'], // 点卡片当场变形：弹簧直接飞
    [F, F, 'immediate'], // uniform 值相同，morph 自然归零
    [F, F, 'immediate'],
    [T, T, 'immediate'], // 换歌同为封面：溶解由 reloading 锁负责，不归 swap 管
    [F, F, 'immediate'],
  ]
  for (const [a, b, want] of cases) {
    it(`${JSON.stringify(a)} → ${JSON.stringify(b)} = ${want}`, () => expect(planShapeSwap(a, b)).toBe(want))
  }
})

describe('shapeSelectionChanged（spec §4.6 防误唤醒铁律）', () => {
  const a = { current: 'nebula' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true }
  const b = { current: 'heart' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true }
  it('未播种（启动/重建重放）永不触发，即使值不同', () => {
    expect(shapeSelectionChanged(a, b, false)).toBe(false)
  })
  it('已播种 + 值相同（无关设置广播回流）不触发', () => {
    expect(shapeSelectionChanged(a, { ...a }, true)).toBe(false)
  })
  it('已播种 + 换形状触发', () => {
    expect(shapeSelectionChanged(a, b, true)).toBe(true)
  })
  it('已播种 + 只拨封面优先也触发（同样需要预览封面↔形状的切换）', () => {
    expect(shapeSelectionChanged(a, { ...a, coverPriority: false }, true)).toBe(true)
  })
})

describe('planRefreshAction（B1 终审记账：决策核抽纯函数，C1/N1 接线用例）', () => {
  const geomA = { positions: new Float32Array(3) }
  const geomB = { positions: new Float32Array(3) }
  const mk = (kind: ResolvedKind, target: typeof geomA | null): ResolvedShape =>
    ({ target, kind, planar: kind === 'cover', hasColor: kind === 'cover', dialect: 'none', body: 'particles' })

  it('skip：kind 与 target 引用均未变（无关设置广播/悔棋）', () => {
    expect(planRefreshAction({ appliedKind: 'geometry', appliedPlanar: false, appliedHasColor: false, appliedBody: 'particles', appliedTarget: geomA, next: mk('geometry', geomA), morph: 1, snap: false })).toBe('skip')
  })
  it('重建后哨兵 undefined ≠ null：free 稳态也强制重传（评审 I3）', () => {
    expect(planRefreshAction({ appliedKind: 'free', appliedPlanar: false, appliedHasColor: false, appliedBody: 'particles', appliedTarget: undefined, next: mk('free', null), morph: 0, snap: false })).toBe('immediate')
  })
  it('N1 跨 cover 边界 + morph 高 → dissolve；morph 已趴 0 → immediate（溶解即刻完成）', () => {
    expect(planRefreshAction({ appliedKind: 'cover', appliedPlanar: true, appliedHasColor: true, appliedBody: 'particles', appliedTarget: geomA, next: mk('geometry', geomB), morph: 1, snap: false })).toBe('dissolve')
    expect(planRefreshAction({ appliedKind: 'cover', appliedPlanar: true, appliedHasColor: true, appliedBody: 'particles', appliedTarget: geomA, next: mk('geometry', geomB), morph: 0.01, snap: false })).toBe('immediate')
  })
  it('C1 接线：priority=off 换形状（geometry↔geometry 非 snap）→ immediate 弹簧直飞', () => {
    expect(planRefreshAction({ appliedKind: 'geometry', appliedPlanar: false, appliedHasColor: false, appliedBody: 'particles', appliedTarget: geomA, next: mk('geometry', geomB), morph: 1, snap: false })).toBe('immediate')
  })
  it('snap（用户主动切换）强制溶解：即使 geometry↔geometry、morph 高——碎散聚需要散相', () => {
    expect(planRefreshAction({ appliedKind: 'geometry', appliedPlanar: false, appliedHasColor: false, appliedBody: 'particles', appliedTarget: geomA, next: mk('geometry', geomB), morph: 1, snap: true })).toBe('dissolve')
  })
  it('snap 但 morph≈0（沉睡/自由态）→ immediate（无需散，编排层直接快聚）', () => {
    expect(planRefreshAction({ appliedKind: 'free', appliedPlanar: false, appliedHasColor: false, appliedBody: 'particles', appliedTarget: null, next: mk('geometry', geomB), morph: 0, snap: true })).toBe('immediate')
  })
  it('planRefreshAction：spectrum↔waveform 切换不得 skip（target 同为 null 靠 body 判别）', () => {
    const next = resolveShape({ current: 'waveform', coverPriority: false, coverCloud: null, custom: null, count: 100 })
    const action = planRefreshAction({
      appliedKind: 'linework', appliedPlanar: false, appliedHasColor: false, appliedBody: 'spectrum',
      appliedTarget: null, next, morph: 0, snap: false,
    })
    expect(action).toBe('immediate')
  })
})

describe('方言家族传导（方言期批1）', () => {
  it('geometry：家族来自注册表（heart=heart；contour 家族由序幕 demo 形体沿用；星球/晶体已退役）', () => {
    const r = resolveShape({ current: 'heart', coverPriority: false, coverCloud: null, custom: null, count: 100 })
    expect(r.kind).toBe('geometry') // beforeAll 已加载轮廓资产
    expect(r.dialect).toBe('heart')
  })
  it('cover / free 一律 none（封面走 uTargetPlanar 既有约束，自由态无方言）', () => {
    const cover = resolveShape({
      current: 'heart', coverPriority: true,
      coverCloud: { positions: new Float32Array(3) }, custom: null, count: 1,
    })
    expect(cover.dialect).toBe('none')
    const free = resolveShape({ current: 'nebula', coverPriority: false, coverCloud: null, custom: null, count: 1 })
    expect(free.kind).toBe('free')
    expect(free.dialect).toBe('none')
  })
})

// 调用点语义（Task 9 边界修复）：编排层传入的 seeded 参数不是闭包 shapeSeeded，而是资格位
// backfillEligible = 「已播种后的 applyShape 重放」快照（在 applyShape 置位 shapeSeeded 之前取）——
// 启动播种（首个 applyShape）与 rebuild/onCloudChanged 直调 refreshShape 均传 false，不会误触发仪式
describe('补切仪式感识别（S2 回账：就绪补切从静默直换升级为成形仪式）', () => {
  it('已播种 + 非用户切换 + free→geometry = 补切（资产迟到就绪的唯一路径签名）', () => {
    expect(isBackfillReveal('free', 'geometry', true, false)).toBe(true)
  })
  it('反例矩阵：播种前/用户主动切换（自有碎散聚）/cover 参与/geometry↔geometry 均不是补切', () => {
    expect(isBackfillReveal('free', 'geometry', false, false)).toBe(false) // 启动播种/无资格重放（backfillEligible=false）
    expect(isBackfillReveal('free', 'geometry', true, true)).toBe(false)  // 用户切换走 snap 编排
    expect(isBackfillReveal('cover', 'geometry', true, false)).toBe(false)
    expect(isBackfillReveal('free', 'cover', true, false)).toBe(false)
    expect(isBackfillReveal('geometry', 'geometry', true, false)).toBe(false)
  })
})

describe('resolveShape · 自定义形状注入（idea #12）', () => {
  const cloud = { positions: new Float32Array(3) }

  it('选中自定义图片：kind=custom，薄板+像素色（与封面同标定）', () => {
    const r = resolveShape({ current: 'heart', coverPriority: true, coverCloud: null, custom: { cloud, kind: 'image' }, count: 8 })
    expect(r).toMatchObject({ target: cloud, kind: 'custom', planar: true, hasColor: true, dialect: 'none' })
  })

  it('选中自定义文字：薄板鼓面（fb1：与图片同标定，阅读性=封面同款）+情绪三色', () => {
    const r = resolveShape({ current: 'heart', coverPriority: true, coverCloud: null, custom: { cloud, kind: 'text' }, count: 8 })
    expect(r).toMatchObject({ kind: 'custom', planar: true, hasColor: false })
  })

  it('封面优先仍压过自定义（规则不特殊化）', () => {
    const coverCloud = { positions: new Float32Array(3) }
    const r = resolveShape({ current: 'heart', coverPriority: true, coverCloud, custom: { cloud, kind: 'image' }, count: 8 })
    expect(r.kind).toBe('cover')
    expect(r.target).toBe(coverCloud)
  })

  it('选中自定义但点云未就绪（加载中/失败）→ free 回退，就绪后重仲裁自然补切', () => {
    const r = resolveShape({ current: 'heart', coverPriority: false, coverCloud: null, custom: { cloud: null, kind: 'image' }, count: 8 })
    expect(r.kind).toBe('free')
  })

  it('未选自定义（custom=null）→ 走内置 generate 老路', () => {
    const r = resolveShape({ current: 'heart', coverPriority: false, coverCloud: null, custom: null, count: 8 })
    expect(r.kind).toBe('geometry')
  })
})

describe('planShapeSwap · 标志位判据（cover 边界语义的忠实推广）', () => {
  const F = { planar: false, hasColor: false }
  const T = { planar: true, hasColor: true }
  it('标定 uniform 要翻转（薄板/像素色任一变）→ dissolve，防单帧爆闪', () => {
    expect(planShapeSwap(F, T)).toBe('dissolve')
    expect(planShapeSwap(T, F)).toBe('dissolve')
    expect(planShapeSwap(F, { planar: false, hasColor: true })).toBe('dissolve')
  })
  it('标定不变（cover↔cover 换歌、geometry↔geometry）→ immediate；custom 文字 fb1 后 planar:true 与 geometry 不再同标定，走 dissolve', () => {
    expect(planShapeSwap(T, T)).toBe('immediate')
    expect(planShapeSwap(F, F)).toBe('immediate')
    expect(planShapeSwap(F, { planar: true, hasColor: false })).toBe('dissolve') // geometry → custom 文字
  })
})

// 真实调用点：src/scenes/nebula/index.ts custom 建造点的 onCloudChanged 直调
// （`backfillEligible = shapeSeeded; refreshShape(); backfillEligible = false`）——
// 图片点云异步就绪不经 applyShape 重放，直调 refreshShape 前须手动补资格位，
// 否则该分支恒为 seeded=false 永不可达（终审 Finding 1）。编排层依赖 three/webgpu，
// 在 node 下不可单测，此处只能覆盖纯函数本身，调用点正确性靠人工核对+人工验收兜底。
describe('isBackfillReveal · custom 迟到就绪也享补切仪式', () => {
  it('free→custom 且已播种非用户切换 → 命中', () => {
    expect(isBackfillReveal('free', 'custom', true, false)).toBe(true)
  })
})

describe('shapeSelectionChanged · customCurrent 纳入变更判定', () => {
  const base = { current: 'nebula' as const, customCurrent: null, customShapes: [], coverPriority: true, showBody: true }
  it('只改 customCurrent 也算用户切换', () => {
    expect(shapeSelectionChanged(base, { ...base, customCurrent: '00000000-0000-4000-8000-000000000000' }, true)).toBe(true)
  })
})
