import { describe, it, expect } from 'vitest'
import { SceneHost } from '../../src/scenes/host'
import { registerScene } from '../../src/scenes/registry'
import { SignalBus } from '../../src/engine/bus'
import type { Scene, SceneTrackEvent, SceneContext } from '../../src/scenes/types'
import { TIERS } from '../../src/scenes/shared/quality'
import { DEFAULT_MOTION_SETTINGS } from '../../src/scenes/nebula/motion/types'
import { DEFAULT_CAMERA_SETTINGS } from '../../src/scenes/nebula/camera-types'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/scenes/nebula/background-types'
import type { GalaxyView } from '../../src/scenes/nebula/galaxy/types'

const TIER = { name: 'low' as const, particles: 1000, dprCap: 1, bloom: false, background: { auroraDetail: 'simple' as const, ripple: false, nearDust: false } }

/** 手动泵：收集 rAF 回调，pump(ms) 逐帧派发 */
function makePump() {
  let cbs: FrameRequestCallback[] = []
  let now = 0
  return {
    raf: (cb: FrameRequestCallback) => (cbs.push(cb), cbs.length),
    caf: () => { cbs = [] },
    pump(ms: number) {
      now += ms
      const batch = cbs
      cbs = []
      batch.forEach((cb) => cb(now))
    }
  }
}

function recordingScene() {
  const calls = { updates: [] as number[], tracks: [] as SceneTrackEvent[], disposed: false }
  const scene: Scene = {
    init() {},
    update(dt) { calls.updates.push(dt) },
    onTrackChange(t) { calls.tracks.push(t) },
    dispose() { calls.disposed = true }
  }
  return { scene, calls }
}

function slowScene(delayMs: number) {
  const calls = { disposed: false, updates: 0 }
  const scene: Scene = {
    init: () => new Promise((r) => setTimeout(r, delayMs)),
    update() { calls.updates++ },
    onTrackChange() {},
    dispose() { calls.disposed = true }
  }
  return { scene, calls }
}

describe('SceneHost', () => {
  it('循环调 update（dt 秒、上限 0.1）、track 事件下一帧派发一次、stop 后停止并 dispose', async () => {
    const { scene, calls } = recordingScene()
    registerScene('rec', () => scene)
    const pump = makePump()
    const host = new SceneHost({} as HTMLCanvasElement, new SignalBus(), pump)
    await host.start('rec', TIER)

    pump.pump(16)   // 第一帧建基准
    pump.pump(16)
    expect(calls.updates.length).toBeGreaterThanOrEqual(1)
    expect(calls.updates.at(-1)!).toBeCloseTo(0.016, 2)

    pump.pump(500)  // 超长帧被钳制
    expect(calls.updates.at(-1)!).toBeLessThanOrEqual(0.1)

    host.notifyTrack({ kind: 'unknown' })
    pump.pump(16)
    expect(calls.tracks).toEqual([{ kind: 'unknown' }])
    pump.pump(16)
    expect(calls.tracks).toHaveLength(1) // 只派发一次

    host.stop()
    expect(calls.disposed).toBe(true)
    const n = calls.updates.length
    pump.pump(16)
    expect(calls.updates.length).toBe(n)
  })
})

describe('SceneHost 加固（M2 终审 triage）', () => {
  it('start 未完成即重入：旧场景被 dispose，只有一个循环在跑', async () => {
    const a = slowScene(30)
    const b = slowScene(0)
    registerScene('slow-a', () => a.scene)
    registerScene('slow-b', () => b.scene)
    const pump = makePump()
    const host = new SceneHost({} as HTMLCanvasElement, new SignalBus(), pump)
    const p1 = host.start('slow-a', TIER) // 不 await
    await host.start('slow-b', TIER)
    await p1
    expect(a.calls.disposed).toBe(true) // 旧的在途场景被丢弃并释放
    pump.pump(16)
    pump.pump(16)
    expect(a.calls.updates).toBe(0) // 旧场景循环没在跑
    expect(b.calls.updates).toBeGreaterThan(0)
    host.stop()
  })
  it('init 抛错的场景被 dispose 后才回退 placeholder', async () => {
    let disposed = false
    registerScene('boom', () => ({
      init() { throw new Error('boom') },
      update() {}, onTrackChange() {},
      dispose() { disposed = true }
    }))
    registerScene('placeholder', () => ({
      init() {}, update() {}, onTrackChange() {}, dispose() {}
    }))
    const pump = makePump()
    const host = new SceneHost({} as HTMLCanvasElement, new SignalBus(), pump)
    await host.start('boom', TIER)
    expect(disposed).toBe(true)
    host.stop()
  })
})

describe('UI 信号转发缓存（计划②T4）', () => {
  interface UiFakeScene {
    scene: Scene
    uiFocus: number[]
    interactive: boolean[]
    ctxSeen: SceneContext[]
  }
  const makeUiFake = (withOptional: boolean): UiFakeScene => {
    const rec: UiFakeScene = { uiFocus: [], interactive: [], ctxSeen: [], scene: null as unknown as Scene }
    rec.scene = {
      init: (ctx) => { rec.ctxSeen.push(ctx) },
      update: () => {},
      onTrackChange: () => {},
      dispose: () => {},
      ...(withOptional
        ? {
            setUiFocus: (v: number) => rec.uiFocus.push(v),
            setInteractive: (on: boolean) => rec.interactive.push(on)
          }
        : {})
    }
    return rec
  }
  const canvas = {} as HTMLCanvasElement
  const bus = { latest: null, takeFrame: () => null } as unknown as SignalBus
  const pump = makePump()

  it('转发给实现了可选方法的场景', async () => {
    const fake = makeUiFake(true)
    registerScene('ui-fake-1', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    await host.start('ui-fake-1', TIERS.low)
    host.setUiFocus(0.7)
    host.setInteractive(false)
    expect(fake.uiFocus).toEqual([0.7])
    expect(fake.interactive).toEqual([false])
    host.stop()
  })

  it('场景未实现可选方法时静默跳过（不抛）', async () => {
    const fake = makeUiFake(false)
    registerScene('ui-fake-2', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    await host.start('ui-fake-2', TIERS.low)
    expect(() => { host.setUiFocus(1); host.setInteractive(false) }).not.toThrow()
    host.stop()
  })

  it('重建后重放：start 前设的值，落地后新场景收到', async () => {
    const fake = makeUiFake(true)
    registerScene('ui-fake-3', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.setUiFocus(1)
    host.setInteractive(false)
    await host.start('ui-fake-3', TIERS.low)
    expect(fake.uiFocus).toEqual([1])
    expect(fake.interactive).toEqual([false])
    host.stop()
  })

  it('forcedTier 透传进 ctx；缺省时为 undefined', async () => {
    const fake = makeUiFake(true)
    registerScene('ui-fake-4', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    await host.start('ui-fake-4', TIERS.high, TIERS.low)
    expect(fake.ctxSeen[0].forcedTier).toEqual(TIERS.low)
    host.stop()
  })

  it('applyShape 缓存重放（Phase B1 T9）：start 重建后新场景自动收到最近一次形状设置', async () => {
    const applied: unknown[] = []
    const fake = makeUiFake(true)
    fake.scene.applyShape = (s) => applied.push(s)
    registerScene('ui-fake-5', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.applyShape({ current: 'heart', coverPriority: false, customCurrent: null, customShapes: [], showBody: true })
    await host.start('ui-fake-5', TIERS.high)
    expect(applied).toContainEqual({ current: 'heart', coverPriority: false, customCurrent: null, customShapes: [], showBody: true })
    host.stop()
  })

  it('applyMotion 缓存重放：start 重建后自动补发最后一次 motion（C2，语义同 applyMapping）', async () => {
    const applied: unknown[] = []
    const fake = makeUiFake(true)
    fake.scene.applyMotion = (m) => applied.push(m)
    registerScene('ui-fake-6', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.applyMotion({ ...DEFAULT_MOTION_SETTINGS, bombIntensity: 1.5 })
    await host.start('ui-fake-6', TIERS.high)
    expect(applied).toContainEqual({ ...DEFAULT_MOTION_SETTINGS, bombIntensity: 1.5 })
    host.stop()
  })

  it('applyCamera 缓存重放：start 重建后自动补发最后一次 camera（Phase D，语义同 applyMotion）', async () => {
    const applied: unknown[] = []
    const fake = makeUiFake(true)
    fake.scene.applyCamera = (c) => applied.push(c)
    registerScene('ui-fake-7', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.applyCamera({ ...DEFAULT_CAMERA_SETTINGS, liveliness: 1.5 })
    await host.start('ui-fake-7', TIERS.high)
    expect(applied).toContainEqual({ ...DEFAULT_CAMERA_SETTINGS, liveliness: 1.5 })
    host.stop()
  })

  it('applyBackground 缓存并在场景重建后重放（契约同 applyLyrics）', async () => {
    const applied: unknown[] = []
    const fake = makeUiFake(true)
    fake.scene.applyBackground = (b) => applied.push(b)
    registerScene('ui-fake-9', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.applyBackground({ ...DEFAULT_BACKGROUND_SETTINGS, aurora: 0.5, ripple: 0 })
    await host.start('ui-fake-9', TIERS.high)
    expect(applied).toContainEqual({ ...DEFAULT_BACKGROUND_SETTINGS, aurora: 0.5, ripple: 0 })
    host.stop()
  })

  it('applyGalaxy 缓存重放：start 后补发最近一次视图（档位重建回星系）', async () => {
    const applied: GalaxyView[] = []
    const fake = makeUiFake(true)
    fake.scene.applyGalaxy = (g: GalaxyView) => applied.push(g)
    registerScene('ui-fake-10', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    const view: GalaxyView = { active: true, stars: [], filterView: null, selectedKey: null }
    host.applyGalaxy(view)
    await host.start('ui-fake-10', TIERS.high)
    expect(applied).toEqual([view])
    expect(applied[0]).toBe(view)
    host.stop()
  })

  it('notifyLyrics 直转发；notifyProgress 队列化到下一帧；start 后重放最近值；applyLyrics 缓存重放（歌词二期 Task 10 + 终审I1/T10）', async () => {
    const progressLog: unknown[] = []
    const lyricsLog: unknown[] = []
    const lyricsSettingsLog: unknown[] = []
    const fake = makeUiFake(true)
    fake.scene.onProgress = (p) => progressLog.push(p)
    fake.scene.onLyrics = (d) => lyricsLog.push(d)
    fake.scene.applyLyrics = (s) => lyricsSettingsLog.push(s)
    registerScene('ui-fake-8', () => fake.scene)
    const host = new SceneHost(canvas, bus, pump)
    host.notifyProgress({ elapsedTime: 5, duration: 200, playbackRate: 1, playing: true })
    host.notifyLyrics({ key: 'a\0b', lines: [{ t: 1, text: 'x' }] })
    host.applyLyrics({ enabled: true, position: 1.35, scale: 1, dynamics: true, brightness: 1, dynamicsGain: 1 })
    await host.start('ui-fake-8', TIERS.high)
    // 词与设置在 start 里直调重放；进度重放也走队列（终审复核残留）：首帧 onTrackChange 清场后才 mark
    expect(lyricsLog).toEqual([{ key: 'a\0b', lines: [{ t: 1, text: 'x' }] }])
    expect(lyricsSettingsLog).toEqual([{ enabled: true, position: 1.35, scale: 1, dynamics: true, brightness: 1, dynamicsGain: 1 }])
    expect(progressLog).toHaveLength(0) // 尚未泵帧，重放的进度还在队列里
    pump.pump(16)
    expect(progressLog).toEqual([{ elapsedTime: 5, duration: 200, playbackRate: 1, playing: true }])
    // 运行中：notifyProgress 不再直转发（终审I1），排队到下一帧才喂给场景
    host.notifyProgress({ elapsedTime: 6, duration: 200, playbackRate: 1, playing: true })
    expect(progressLog).toHaveLength(1) // 尚未泵帧，队列里还没吐出来
    pump.pump(16)
    expect(progressLog).toEqual([
      { elapsedTime: 5, duration: 200, playbackRate: 1, playing: true },
      { elapsedTime: 6, duration: 200, playbackRate: 1, playing: true }
    ])
    // notifyLyrics 仍是直转发，不受 progress 队列化影响
    host.notifyLyrics({ key: 'c\0d', none: true })
    expect(lyricsLog).toEqual([
      { key: 'a\0b', lines: [{ t: 1, text: 'x' }] },
      { key: 'c\0d', none: true }
    ])
    host.stop()
  })
})
