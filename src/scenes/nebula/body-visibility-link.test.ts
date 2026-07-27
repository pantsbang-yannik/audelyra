import { describe, it, expect } from 'vitest'
import { bodyVisibilityLink, isBodyConcealed, type BodyVisibilityInputs } from './body-visibility-link'

const AURORA = 'aurora'
const CUSTOM_A = '11111111-1111-4111-8111-111111111111'
const CUSTOM_B = '22222222-2222-4222-8222-222222222222'

/** 造一组输入；不传的字段取稳定默认（避免误触发另一条规则） */
const inp = (over: Partial<BodyVisibilityInputs> = {}): BodyVisibilityInputs => ({
  backgroundCurrent: AURORA, shapeCurrent: 'nebula', shapeCustomCurrent: null, ...over,
})

describe('bodyVisibilityLink（主体显隐联动判定）', () => {
  it('规则A：内置 → 自定义背景 ⇒ 关主体', () => {
    expect(bodyVisibilityLink(inp(), inp({ backgroundCurrent: CUSTOM_A }))).toBe(false)
  })

  it('规则A：自定义 → 另一张自定义 ⇒ 不动（用户手动开的要保住）', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp({ backgroundCurrent: CUSTOM_B })))
      .toBeNull()
  })

  it('规则A：自定义 → 内置 ⇒ 开主体', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp())).toBe(true)
  })

  it('规则A：背景没变 ⇒ 不动', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp({ backgroundCurrent: CUSTOM_A })))
      .toBeNull()
  })

  it('规则B：换内置形状 ⇒ 开主体', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp({ backgroundCurrent: CUSTOM_A, shapeCurrent: 'torus' })))
      .toBe(true)
  })

  it('规则B：换自定义形状（customCurrent 变）⇒ 开主体', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp({ backgroundCurrent: CUSTOM_A, shapeCustomCurrent: 'shape-x' })))
      .toBe(true)
  })

  it('规则B：删掉当前自定义形状回落（customCurrent → null）也算换形状 ⇒ 开主体', () => {
    expect(bodyVisibilityLink(inp({ shapeCustomCurrent: 'shape-x' }), inp({ shapeCustomCurrent: null })))
      .toBe(true)
  })

  it('两个 id 都没变 ⇒ 不动（拨封面优先等只改其它字段的写入不许误开主体）', () => {
    expect(bodyVisibilityLink(inp({ backgroundCurrent: CUSTOM_A }), inp({ backgroundCurrent: CUSTOM_A })))
      .toBeNull()
  })

  it('两条规则同时命中时 B 优先（换形状 = 更直接的「我要看主体」信号）', () => {
    // 背景切到自定义（A 要关）+ 同时换了形状（B 要开）
    expect(bodyVisibilityLink(inp(), inp({ backgroundCurrent: CUSTOM_A, shapeCurrent: 'heart' })))
      .toBe(true)
  })
})

describe('isBodyConcealed（引擎判据：含防黑屏自愈纪律）', () => {
  // 六个场景对应设计稿 §4 那张表。第 3、4 条是本次最容易被「简化」掉的分支——
  // 它们守的是「自定义背景没真正上屏时不许隐藏主体」，去掉会黑屏
  it('内置背景 + 开关开 ⇒ 显示', () => {
    expect(isBodyConcealed(true, AURORA, true)).toBe(false)
  })

  it('内置背景 + 开关关 ⇒ 隐藏（通用化后的新能力）', () => {
    expect(isBodyConcealed(false, AURORA, true)).toBe(true)
  })

  it('自定义背景加载中（sky 还在）+ 开关关 ⇒ 仍显示（防黑屏瞬间）', () => {
    expect(isBodyConcealed(false, CUSTOM_A, true)).toBe(false)
  })

  it('自定义背景加载失败（sky 保留自愈）+ 开关关 ⇒ 仍显示（防永久黑屏）', () => {
    expect(isBodyConcealed(false, CUSTOM_A, true)).toBe(false)
  })

  it('自定义背景已上屏 + 开关关 ⇒ 隐藏', () => {
    expect(isBodyConcealed(false, CUSTOM_A, false)).toBe(true)
  })

  it('自定义背景已上屏 + 开关开 ⇒ 显示', () => {
    expect(isBodyConcealed(true, CUSTOM_A, false)).toBe(false)
  })
})
