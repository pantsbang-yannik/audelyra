// src/scenes/nebula/mapping/types.test.ts
import { describe, it, expect } from 'vitest'
import {
  AUDIO_FEATURES, BODY_PROPERTIES, ELEMENT_IDS, ELEMENT_LABELS, PROPERTY_CATALOG,
  addressKey, idleControls, isValidAddress, propertiesOf, propertySpecAt,
} from './types'

describe('mapping types 常量', () => {
  it('十类音频特征齐全', () => {
    expect(AUDIO_FEATURES).toEqual(['beat', 'downbeat', 'low', 'mid', 'high', 'energy', 'drop', 'loudness', 'silence', 'tempo'])
  })
  it('两个元素：主体与背景（R1-1 拍板范围）', () => {
    expect(ELEMENT_IDS).toEqual(['body', 'backdrop'])
    expect(ELEMENT_LABELS).toEqual({ body: '主体', backdrop: '背景' })
  })
  it('主体五属性齐全且顺序即调音台渲染顺序', () => {
    expect(BODY_PROPERTIES).toEqual(['speed', 'density', 'space', 'brightness', 'thickness'])
  })
  it('背景三属性齐全', () => {
    expect(propertiesOf('backdrop')).toEqual(['develop', 'brightness', 'saturation'])
  })
})

describe('属性目录完备性', () => {
  it('每个属性的白名单非空且只含合法音频特征', () => {
    for (const [el, props] of Object.entries(PROPERTY_CATALOG)) {
      for (const [p, spec] of Object.entries(props)) {
        expect(spec.allowedSources.length, `${el}.${p}`).toBeGreaterThan(0)
        for (const f of spec.allowedSources) expect(AUDIO_FEATURES, `${el}.${p}`).toContain(f)
      }
    }
  })
  it('每个属性都有中文名与简述（调音台直接渲染，缺了就是空标签）', () => {
    for (const [el, props] of Object.entries(PROPERTY_CATALOG)) {
      for (const [p, spec] of Object.entries(props)) {
        expect(spec.label.length, `${el}.${p} label`).toBeGreaterThan(0)
        expect(spec.desc.length, `${el}.${p} desc`).toBeGreaterThan(0)
      }
    }
  })
  it('主体属性的白名单与 spec §5.4 一致', () => {
    const sources = Object.fromEntries(
      BODY_PROPERTIES.map((p) => [p, [...PROPERTY_CATALOG.body[p].allowedSources]]))
    expect(sources).toEqual({
      speed: ['tempo', 'loudness', 'energy', 'beat', 'drop'],
      density: ['energy', 'loudness', 'silence', 'drop'],
      space: ['beat', 'downbeat', 'energy', 'drop', 'low'],
      brightness: ['high', 'beat', 'drop', 'energy', 'loudness'],
      thickness: ['low', 'energy', 'drop', 'tempo'],
    })
  })
  it('主体属性静止值全为 0（加性冲量），背景属性全为 1（乘性调制）', () => {
    for (const p of BODY_PROPERTIES) expect(PROPERTY_CATALOG.body[p].idle, `body.${p}`).toBe(0)
    for (const p of propertiesOf('backdrop')) expect(PROPERTY_CATALOG.backdrop[p].idle, `backdrop.${p}`).toBe(1)
  })
  it('背景属性一律 continuous——走 pulse 的弹簧过冲会让背景闪烁，违反「调制不解构」', () => {
    for (const p of propertiesOf('backdrop')) expect(PROPERTY_CATALOG.backdrop[p].smoothing, p).toBe('continuous')
  })
})

describe('地址工具', () => {
  it('合法地址通过，元素或属性任一不存在都不通过', () => {
    expect(isValidAddress({ element: 'body', property: 'space' })).toBe(true)
    expect(isValidAddress({ element: 'backdrop', property: 'develop' })).toBe(true)
    expect(isValidAddress({ element: 'body', property: 'develop' })).toBe(false) // 属性串元素
    expect(isValidAddress({ element: 'nope', property: 'space' })).toBe(false)
    expect(isValidAddress({ element: '', property: '' })).toBe(false)
  })
  it('同名属性分属不同元素时地址键不撞（backdrop.brightness ≠ body.brightness）', () => {
    expect(addressKey({ element: 'body', property: 'brightness' }))
      .not.toBe(addressKey({ element: 'backdrop', property: 'brightness' }))
  })
  it('propertySpecAt 取到的是该元素下的那一份', () => {
    expect(propertySpecAt({ element: 'body', property: 'brightness' })!.label).toBe('亮度')
    expect(propertySpecAt({ element: 'backdrop', property: 'brightness' })!.label).toBe('明暗')
    expect(propertySpecAt({ element: 'nope', property: 'x' })).toBeNull()
  })
  it('idleControls 覆盖目录全部属性且取各自静止值', () => {
    const c = idleControls()
    for (const p of BODY_PROPERTIES) expect(c.body[p]).toBe(0)
    expect(c.backdrop).toEqual({ develop: 1, brightness: 1, saturation: 1 })
  })
})
