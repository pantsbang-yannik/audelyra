// 形状注册表 + (id,count) 记忆化生成（spec N4：仲裁在设置变更/换歌/重建时反复调用，
// 高档位是十几万点的 Float32Array 分配；count 只在降级减半时变化，缓存天然有界）。
import type { ShapePointCloud } from '../cover-points'
import type { ShapeDef, ShapeId } from './types'
import { contourCloud } from './contour'

/** 数组序 = B2 卡片序 */
export const SHAPES: readonly ShapeDef[] = [
  { id: 'nebula', label: '星云', planar: false, generate: null, dialect: 'none' },
  { id: 'heart', label: '心脏', planar: false, generate: (c) => contourCloud('heart', c), dialect: 'heart' },
  { id: 'spectrum', label: '频谱环', planar: false, generate: null, dialect: 'none', body: 'spectrum' },
  { id: 'waveform', label: '波形线', planar: false, generate: null, dialect: 'none', body: 'waveform' },
  { id: 'eclipse', label: '日食', planar: false, generate: null, dialect: 'none', body: 'eclipse' },
  { id: 'ledmatrix', label: '点阵', planar: false, generate: null, dialect: 'none', body: 'ledmatrix' },
  { id: 'laser', label: '激光', planar: false, generate: null, dialect: 'none', body: 'laser' },
  // 序幕专属形体（发布准备③「声音的形状进化史」）：demoOnly 不进选择器；资产按需加载（引导期才 fetch）
  { id: 'demo-gramophone', label: '留声机', planar: false, generate: (c) => contourCloud('demo-gramophone', c), dialect: 'contour', demoOnly: true },
  { id: 'demo-cassette', label: '卡带', planar: false, generate: (c) => contourCloud('demo-cassette', c), dialect: 'contour', demoOnly: true },
  { id: 'demo-headphones', label: '耳机', planar: false, generate: (c) => contourCloud('demo-headphones', c), dialect: 'contour', demoOnly: true },
  { id: 'demo-mic', label: '麦克风', planar: false, generate: (c) => contourCloud('demo-mic', c), dialect: 'contour', demoOnly: true },
]

export function shapeById(id: ShapeId): ShapeDef {
  return SHAPES.find((s) => s.id === id)!
}

const cache = new Map<string, ShapePointCloud>()

/** 记忆化缓存逐出（序幕形体收尾专用，与 unloadContourAssets 配套）：防生成态点云终身滞留 */
export function evictShapeCache(ids: readonly ShapeId[]): void {
  for (const key of [...cache.keys()]) {
    const id = key.slice(0, key.lastIndexOf(':'))
    if ((ids as readonly string[]).includes(id)) cache.delete(key)
  }
}

/** null = 自由态（星云）。确定性生成 + 记忆化：同 (id,count) 返回同一引用（编排层靠引用判等短路） */
export function generateShape(id: ShapeId, count: number): ShapePointCloud | null {
  const def = shapeById(id)
  if (!def.generate) return null
  const key = `${id}:${count}`
  let cloud = cache.get(key)
  if (!cloud) {
    const produced = def.generate(count)
    if (!produced) return null // 异步资产未就绪：不缓存，就绪后重试自然命中
    cloud = produced
    cache.set(key, cloud)
  }
  return cloud
}
