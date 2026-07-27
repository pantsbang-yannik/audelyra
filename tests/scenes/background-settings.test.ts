import { describe, it, expect } from 'vitest'
import {
  sanitizeBackgroundSettings, DEFAULT_BACKGROUND_SETTINGS, BACKGROUND_LIMITS, MIRROR_Y,
  CUSTOM_BACKGROUNDS_MAX, CUSTOM_BG_ID_RE, BACKGROUND_VIDEO_EXTS, BACKGROUND_VIDEO_MAX_BYTES,
} from '../../src/scenes/nebula/background-types'

describe('sanitizeBackgroundSettings（惯例同 sanitizeLyricsSettings：坏数据回默认/出界钳限幅）', () => {
  it('非对象/缺字段回默认', () => {
    expect(sanitizeBackgroundSettings(undefined)).toEqual(DEFAULT_BACKGROUND_SETTINGS)
    expect(sanitizeBackgroundSettings('junk')).toEqual(DEFAULT_BACKGROUND_SETTINGS)
    expect(sanitizeBackgroundSettings({})).toEqual(DEFAULT_BACKGROUND_SETTINGS)
  })
  it('出界钳限幅、非法类型回默认', () => {
    const s = sanitizeBackgroundSettings({ aurora: 9, ripple: 'x', dust: -1 })
    expect(s.aurora).toBe(BACKGROUND_LIMITS.aurora.max)
    expect(s.ripple).toBe(DEFAULT_BACKGROUND_SETTINGS.ripple)
    expect(s.dust).toBe(BACKGROUND_LIMITS.dust.min)
  })
  it('合法值原样保留；NaN/Infinity 回默认', () => {
    // 未给出的字段一律回默认——引用常量而非字面量，调默认值不必改测试
    expect(sanitizeBackgroundSettings({ aurora: 0.3, ripple: 0, dust: 0.5, mirror: false }))
      .toEqual({ ...DEFAULT_BACKGROUND_SETTINGS, aurora: 0.3, ripple: 0, dust: 0.5, mirror: false })
    expect(sanitizeBackgroundSettings({ aurora: NaN, ripple: 0.5, dust: NaN }))
      .toEqual({ ...DEFAULT_BACKGROUND_SETTINGS, ripple: 0.5 })
  })
  it('dustSize/dustBright（尘埃改造）：缺失回默认、出界钳 [0.5, 2.5]、坏类型回默认', () => {
    const d = DEFAULT_BACKGROUND_SETTINGS
    expect(sanitizeBackgroundSettings({}).dustSize).toBe(d.dustSize)
    expect(sanitizeBackgroundSettings({}).dustBright).toBe(d.dustBright)
    const s = sanitizeBackgroundSettings({ dustSize: 9, dustBright: -1 })
    expect(s.dustSize).toBe(BACKGROUND_LIMITS.dustSize.max)
    expect(s.dustBright).toBe(BACKGROUND_LIMITS.dustBright.min)
    expect(sanitizeBackgroundSettings({ dustSize: 'x', dustBright: NaN }))
      .toMatchObject({ dustSize: d.dustSize, dustBright: d.dustBright })
  })
  // 亲验 fb1 修订②（用户拍板「上移贴镜」）：-3.4 → -2.2。静默态运动包络顶 mix(1.6,2.7,0)=1.6 +
  // 弹性脉冲 0.6 = 2.2，恰好不穿面；新阈值钉死在这条理性上，而非旧的「顶 2.7+0.6」全量高能包络
  // （高能段粒子「沾水」穿面已被用户拍板接受，见 mirror.ts 头部注释）
  it('MIRROR_Y 钉在静默态包络+弹性脉冲之上（mix(1.6,2.7,0)+0.6=2.2，高能段「沾水」是拍板接受的设计）', () => {
    expect(MIRROR_Y).toBeLessThanOrEqual(-(1.6 + 0.6))
  })
  it('镜面开关：缺键回默认 true（老档案平滑升级）、false 保留、非 boolean 回默认（#镜面开关）', () => {
    expect(sanitizeBackgroundSettings({}).mirror).toBe(true)
    expect(sanitizeBackgroundSettings({ mirror: false }).mirror).toBe(false)
    expect(sanitizeBackgroundSettings({ mirror: 0 }).mirror).toBe(true)
    expect(sanitizeBackgroundSettings({ mirror: 'off' }).mirror).toBe(true)
  })
})

describe('自定义背景字段（自定义背景 v1）：customBackgrounds + current', () => {
  const ID_A = '11111111-2222-3333-4444-555555555555'
  const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  it('缺字段回默认：空收藏 + current=aurora（老档案平滑升级）', () => {
    const s = sanitizeBackgroundSettings({})
    expect(s.customBackgrounds).toEqual([])
    expect(s.current).toBe('aurora')
  })
  it('收藏列表：非法 id/非对象项被过滤，超上限截断到 CUSTOM_BACKGROUNDS_MAX', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      ({ id: `${String(i).repeat(8)}-2222-3333-4444-555555555555` }))
    const s = sanitizeBackgroundSettings({ customBackgrounds: [...many, { id: '../evil' }, 'junk', null] })
    expect(s.customBackgrounds.length).toBe(CUSTOM_BACKGROUNDS_MAX)
    expect(s.customBackgrounds.every((m) => CUSTOM_BG_ID_RE.test(m.id))).toBe(true)
  })
  it('重复 id 只保留第一个（去重防 UI 卡片 Map 键冲突产生孤儿 DOM 卡）', () => {
    const s = sanitizeBackgroundSettings({ customBackgrounds: [{ id: ID_A }, { id: ID_B }, { id: ID_A }] })
    expect(s.customBackgrounds).toEqual([{ id: ID_A, kind: 'image' }, { id: ID_B, kind: 'image' }])
  })
  it('current 指向收藏中的 id 保留；不在列表/坏类型回落 aurora', () => {
    expect(sanitizeBackgroundSettings({ customBackgrounds: [{ id: ID_A }], current: ID_A }).current).toBe(ID_A)
    expect(sanitizeBackgroundSettings({ customBackgrounds: [{ id: ID_A }], current: ID_B }).current).toBe('aurora')
    expect(sanitizeBackgroundSettings({ current: 42 }).current).toBe('aurora')
  })
  it('current 引用被删的收藏（列表被截断/过滤后）也回落 aurora', () => {
    expect(sanitizeBackgroundSettings({ customBackgrounds: [{ id: '../evil' }], current: '../evil' }).current).toBe('aurora')
  })
})

describe('背景 v2 契约（视频背景 spec §四）', () => {
  it('新三字段默认值：bgOpacity 0.8 / bgSaturation 1 / bgBreathe true', () => {
    const d = DEFAULT_BACKGROUND_SETTINGS
    expect(d.bgOpacity).toBe(0.8)
    expect(d.bgSaturation).toBe(1)
    expect(d.bgBreathe).toBe(true)
  })
  it('sanitize 钳幅回默认：出界钳限、坏类型回默认', () => {
    const s = sanitizeBackgroundSettings({ bgOpacity: 9, bgSaturation: -1, bgBreathe: 'x' })
    expect(s.bgOpacity).toBe(1)
    expect(s.bgSaturation).toBe(0)
    expect(s.bgBreathe).toBe(true)
  })
  it('收藏元数据 kind：缺失/坏值补 image（v1 存量迁移），video 保留', () => {
    const id1 = '11111111-2222-3333-4444-555555555555'
    const id2 = '11111111-2222-3333-4444-666666666666'
    const s = sanitizeBackgroundSettings({ customBackgrounds: [{ id: id1 }, { id: id2, kind: 'video' }] })
    expect(s.customBackgrounds).toEqual([{ id: id1, kind: 'image' }, { id: id2, kind: 'video' }])
  })
  it('收藏元数据 name（亲验反馈：卡片显示名）：非空保留(trim+截80)；空串/非字符串省略键（旧存档语义不变）', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const s = sanitizeBackgroundSettings({ customBackgrounds: [{ id, kind: 'video', name: '  月夜 ' }] })
    expect(s.customBackgrounds[0]).toEqual({ id, kind: 'video', name: '月夜' })
    const s2 = sanitizeBackgroundSettings({ customBackgrounds: [{ id, kind: 'image', name: '' }] })
    expect(s2.customBackgrounds[0]).toEqual({ id, kind: 'image' })
    const s3 = sanitizeBackgroundSettings({ customBackgrounds: [{ id, name: 123 }] })
    expect(s3.customBackgrounds[0]).toEqual({ id, kind: 'image' })
    const s4 = sanitizeBackgroundSettings({ customBackgrounds: [{ id, kind: 'video', name: 'x'.repeat(100) }] })
    expect((s4.customBackgrounds[0] as { name?: string }).name).toHaveLength(80)
  })
  it('视频常量：三容器白名单 + 500MB 上限', () => {
    expect(BACKGROUND_VIDEO_EXTS).toEqual(['mp4', 'mov', 'webm'])
    expect(BACKGROUND_VIDEO_MAX_BYTES).toBe(500 * 1024 * 1024)
  })
})
