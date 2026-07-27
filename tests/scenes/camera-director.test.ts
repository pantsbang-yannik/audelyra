import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three/webgpu'
import {
  CameraDirector, pickNextPreset, QUIET_POOL, ACTIVE_POOL, QUIET_ENERGY_MAX, orbitGain, FovPunch,
  clampPitchForFloor,
} from '../../src/scenes/nebula/camera-director'
import { MIRROR_Y } from '../../src/scenes/nebula/background-types'

/** CameraDirector 构造只用 dom/window 的事件挂卸——node 环境给最小桩 */
function fakeDom(): HTMLElement {
  return { addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLElement
}
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: () => {}, removeEventListener: () => {},
  }
})

describe('pickNextPreset（能量选池，替换全池随机——治「突然贴脸」）', () => {
  it('中高能量（≥阈值）只出远景池，且永不返回 INTIMATE(3)、不返回 current', () => {
    for (let seq = 1; seq <= 30; seq++) {
      const next = pickNextPreset(0, 0.8, seq)
      expect(ACTIVE_POOL).toContain(next)
      expect(next).not.toBe(3)
      expect(next).not.toBe(0)
    }
  })
  it('安静段落（<阈值）出安静池（可达 INTIMATE，不含 OVERLOOK）', () => {
    const seen = new Set<number>()
    for (let seq = 1; seq <= 60; seq++) {
      const next = pickNextPreset(0, QUIET_ENERGY_MAX - 0.1, seq)
      expect(QUIET_POOL).toContain(next)
      expect(next).not.toBe(0)
      seen.add(next)
    }
    expect(seen.has(3)).toBe(true) // 哈希序列扫 60 步，INTIMATE 必可达
  })
  it('确定性：同 (current, energy, seq) 恒同结果（可回放纪律）', () => {
    expect(pickNextPreset(1, 0.9, 7)).toBe(pickNextPreset(1, 0.9, 7))
  })
  it('current 不在当前池内（如高能时正处 INTIMATE）→ 仍从池内正常选', () => {
    const next = pickNextPreset(3, 0.8, 5)
    expect(ACTIVE_POOL).toContain(next)
  })
})

describe('drop 冲击方向反转：推近 → 拉远（spec §5.3）', () => {
  it('drop 脉冲期间相机距离大于无 drop 基线（拉远看炸开全貌）', () => {
    const camA = new THREE.PerspectiveCamera()
    const camB = new THREE.PerspectiveCamera()
    const a = new CameraDirector(camA, fakeDom())
    const b = new CameraDirector(camB, fakeDom())
    // 同步走 0.5s 建立相同基线，再给 b 注入 drop 上升沿并跟踪 0.2s
    for (let i = 0; i < 30; i++) { a.update(1 / 60, null, 0); b.update(1 / 60, null, 0) }
    for (let i = 0; i < 12; i++) { a.update(1 / 60, null, 0); b.update(1 / 60, null, 1) }
    expect(camB.position.length()).toBeGreaterThan(camA.position.length() + 0.05)
  })
})

describe('orbitGain（叙事 → 环绕转速门，spec §4/§5.1）', () => {
  it('burst=1、build=progress、steady/release=0', () => {
    expect(orbitGain({ phase: 'burst', progress: 0.4 })).toBe(1)
    expect(orbitGain({ phase: 'build', progress: 0.6 })).toBe(0.6)
    expect(orbitGain({ phase: 'steady', progress: 0 })).toBe(0)
    expect(orbitGain({ phase: 'release', progress: 0.8 })).toBe(0)
  })
})

describe('环绕 orbit（burst 公转，steady 静止）', () => {
  /** 方位角：绕 y 轴的水平角，环绕的可观测量 */
  const azimuth = (cam: THREE.PerspectiveCamera): number => Math.atan2(cam.position.x, cam.position.z)

  it('burst 态持续公转：6s 后方位角偏移显著大于 steady 基线', () => {
    const camA = new THREE.PerspectiveCamera()
    const camB = new THREE.PerspectiveCamera()
    const a = new CameraDirector(camA, fakeDom()) // 默认 steady
    const b = new CameraDirector(camB, fakeDom())
    b.setNarrative({ phase: 'burst', progress: 1 })
    for (let i = 0; i < 400; i++) { a.update(1 / 60, null, 0); b.update(1 / 60, null, 0) }
    const drift = Math.abs(azimuth(camA)) // 手持漂移的量级（±0.02 rad Spring 内）
    expect(Math.abs(azimuth(camB))).toBeGreaterThan(drift + 0.1)
  })

  it('活跃度=0 时新手法全关：burst 也不公转（乘法门）', () => {
    const cam = new THREE.PerspectiveCamera()
    const d = new CameraDirector(cam, fakeDom())
    d.setLiveliness(0)
    d.setNarrative({ phase: 'burst', progress: 1 })
    for (let i = 0; i < 400; i++) d.update(1 / 60, null, 0)
    expect(Math.abs(Math.atan2(cam.position.x, cam.position.z))).toBeLessThan(0.05) // 只剩手持漂移量级
  })
  it('归位（setManualEnabled(false)→returnHome）同步折叠 orbitYaw 到最短弧，不留任意方位', () => {
    // 不断言 tween 完成后为 0——gsap ticker 在 node 测试里不接管全局 rAF，异步归位不可靠断言；
    // 折叠本身是 returnHome 内的同步语句（不依赖 ticker），可稳定断言「折叠已发生」。
    const cam = new THREE.PerspectiveCamera()
    const d = new CameraDirector(cam, fakeDom())
    d.setNarrative({ phase: 'burst', progress: 1 })
    // orbitDir 只在段落边沿翻转，signals=null → energy 恒 0 → SectionTracker 不产生边沿，
    // 全程同方向公转；6000 帧(100s)@ORBIT_SPEED_MAX=0.06rad/s 足以越过 π（180°）验证折叠生效
    for (let i = 0; i < 6000; i++) d.update(1 / 60, null, 0)
    const before = Reflect.get(d, 'orbitProxy').yaw
    expect(Math.abs(before)).toBeGreaterThan(Math.PI) // 确认真的越界了，测试才有意义
    d.setManualEnabled(false)
    const after = Reflect.get(d, 'orbitProxy').yaw
    expect(Math.abs(after)).toBeLessThanOrEqual(Math.PI + 1e-6)
  })
})

describe('FovPunch（重拍焦段冲击，spec §5.2 安全上限写死）', () => {
  const step = (p: FovPunch, n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = p.update(1 / 60)
    return v
  }
  it('armed + 强拍触发：attack 后出力，随后弹回', () => {
    const p = new FovPunch()
    p.onBeat(0.9, 120, true, 1)
    const peak = step(p, 3) // 3 帧 = 50ms > attack 30ms
    expect(peak).toBeGreaterThan(3)
    expect(step(p, 60)).toBeLessThan(peak * 0.05) // 1s 后基本归零（release ~0.3s 量级）
  })
  it('非 armed / 弱拍（strength<0.6）不触发', () => {
    const p = new FovPunch()
    p.onBeat(0.9, 120, false, 1)
    expect(step(p, 3)).toBe(0)
    const q = new FovPunch()
    q.onBeat(0.5, 120, true, 1)
    expect(step(q, 3)).toBe(0)
  })
  it('限频：最小间隔内的第二次触发被忽略', () => {
    const p = new FovPunch()
    p.onBeat(0.9, 120, true, 1)
    step(p, 30) // 0.5s < minGap(120bpm)=1.0s
    p.onBeat(0.95, 120, true, 1)
    const v = step(p, 2)
    // 若第二次生效会重回 attack 段猛升；被忽略则继续沿 release 衰减
    expect(v).toBeLessThan(3)
  })
  it('幅度上限写死 6°：strength/gain 顶格也不破（旋钮乘不破上限）', () => {
    const p = new FovPunch()
    p.onBeat(1, null, true, 2)
    expect(step(p, 3)).toBeLessThanOrEqual(6)
  })
  it('gain≤0（旋钮拧到 0）不消耗限频窗口：紧接着的正常触发不被吞', () => {
    const p = new FovPunch()
    p.onBeat(0.9, 120, true, 0) // 无输出，但修前会记账 lastTriggerAt，吞掉下一记强拍
    p.onBeat(0.9, 120, true, 1)
    expect(step(p, 3)).toBeGreaterThan(3)
  })
})

describe('FOV 冲击组装：burst 重拍时相机 fov 低于机位基准', () => {
  const mkSignals = (onBeat: boolean, strength: number) => ({
    t: 0, loudness: { instant: 0.5, smooth: 0.5 },
    bands: { low: 0.5, mid: 0.5, high: 0.5 }, spectrum: new Float32Array(0),
    beat: { onBeat, strength }, bpm: 120, energy: 0.8, drop: false, silence: false,
  })
  it('steady 不打；burst 打（fov 明显低于 HOME 基准 58）', () => {
    const camA = new THREE.PerspectiveCamera()
    const a = new CameraDirector(camA, fakeDom())
    a.update(1 / 60, mkSignals(true, 0.9), 0)
    for (let i = 0; i < 3; i++) a.update(1 / 60, mkSignals(false, 0), 0)
    expect(camA.fov).toBeCloseTo(58, 1)

    const camB = new THREE.PerspectiveCamera()
    const b = new CameraDirector(camB, fakeDom())
    b.setNarrative({ phase: 'burst', progress: 1 })
    b.update(1 / 60, mkSignals(true, 0.9), 0)
    for (let i = 0; i < 3; i++) b.update(1 / 60, mkSignals(false, 0), 0)
    expect(camB.fov).toBeLessThan(56)
  })
})

describe('默认距离偏好 distScale（站位远近等比缩放，用户拍板追加）', () => {
  it('0.7 贴近 / 1.3 远观：静息距离按倍率缩放（HOME 基准 ~3.0 → ~2.1 / ~3.9）', () => {
    const camA = new THREE.PerspectiveCamera()
    const camB = new THREE.PerspectiveCamera()
    const a = new CameraDirector(camA, fakeDom())
    const b = new CameraDirector(camB, fakeDom())
    a.setDistScale(0.7)
    b.setDistScale(1.3)
    // 0.5s 静息：呼吸 ±3% 量级，远不足以模糊两档差异
    for (let i = 0; i < 30; i++) { a.update(1 / 60, null, 0); b.update(1 / 60, null, 0) }
    expect(camA.position.length()).toBeLessThan(2.3)
    expect(camB.position.length()).toBeGreaterThan(3.6)
  })
  it('默认 1 不改变现状距离（~3.0，等价旋钮不存在）', () => {
    const cam = new THREE.PerspectiveCamera()
    const d = new CameraDirector(cam, fakeDom())
    for (let i = 0; i < 30; i++) d.update(1 / 60, null, 0)
    expect(cam.position.length()).toBeGreaterThan(2.8)
    expect(cam.position.length()).toBeLessThan(3.2)
  })
  it('滚轮改默认距离 distScale：调到哪粘到哪（不飘回）+ 冒泡新值给持久化，钳到 [0.5,3]', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const dom = {
      addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f },
      removeEventListener: () => {},
    } as unknown as HTMLElement
    const cam = new THREE.PerspectiveCamera()
    const d = new CameraDirector(cam, dom)
    const emitted: number[] = []
    d.setOnDistScaleChange((v) => emitted.push(v))
    // 每帧注入闭包源（复刻 index.ts:setDistScale 每帧覆写）：滚轮回调把新值写回源，才不被下一帧冲掉
    let src = 1
    d.setDistScale(src)

    // 向下滚（拉远）：distScale 应升、冒泡一次新值
    listeners['wheel']({ deltaY: 200, preventDefault: () => {} })
    expect(emitted.length).toBe(1)
    src = emitted[emitted.length - 1]
    expect(src).toBeGreaterThan(1)

    // 静息 5s：无飘回——滚轮改的是永久默认距离，不是 4s 后归零的临时偏移
    const farScale = src
    for (let i = 0; i < 300; i++) { d.setDistScale(src); d.update(1 / 60, null, 0) }
    expect(src).toBeCloseTo(farScale) // 源未被自动归位改动

    // 滚轮拉满仍钳在上限 3（不越界）
    listeners['wheel']({ deltaY: 1e6, preventDefault: () => {} })
    src = emitted[emitted.length - 1]
    expect(src).toBeLessThanOrEqual(3 + 1e-9)
    expect(src).toBeGreaterThan(2.9)
    d.dispose()
  })
  it('量程两端不被安全钳压平：0.5→~1.5（钳位随倍率缩放，非压到 1.6）/ 3→~9.0（非压到 4.6）', () => {
    const camA = new THREE.PerspectiveCamera()
    const camB = new THREE.PerspectiveCamera()
    const a = new CameraDirector(camA, fakeDom())
    const b = new CameraDirector(camB, fakeDom())
    a.setDistScale(0.5)
    b.setDistScale(3)
    for (let i = 0; i < 30; i++) { a.update(1 / 60, null, 0); b.update(1 / 60, null, 0) }
    expect(camA.position.length()).toBeLessThan(1.58) // 若被固定下限 1.6 压平则 ≥1.6，此断言即失败
    expect(camB.position.length()).toBeGreaterThan(8.5) // 若被固定上限 4.6 压平则 ≤4.6
  })
})

describe('clampPitchForFloor（虚空之镜：钳俯仰不钳高度）', () => {
  const yOf = (dirY: number, dirZ: number, dist: number, p: number): number =>
    dist * (dirY * Math.cos(p) - dirZ * Math.sin(p))
  const FLOOR = MIRROR_Y + 0.25

  it('网格扫描：全部机位方向 × 距离 × 俯仰，钳后 y 永不低于地板（可达时）', () => {
    // 四个旧机位 + SKIM 的归一方向 (dirY, dirZ)
    const dirs = [
      [0.0665, 0.9973], [-0.1122, 0.9937], [0.2860, 0.9438], [0.0624, 0.9979], [-0.3305, 0.9438],
    ]
    for (const [dy, dz] of dirs) {
      for (let dist = 1.6; dist <= 13.8; dist += 0.4) {
        for (let p = -0.8; p <= 0.8; p += 0.05) {
          const cp = clampPitchForFloor(p, dy, dz, dist, FLOOR)
          const reachable = dist * Math.hypot(dy, dz) >= Math.abs(FLOOR) || FLOOR <= 0
          // FLOOR 为负值：只要该 dist 下存在合法 pitch（最优 f=+C·dist ≥ FLOOR 恒成立），钳后必达标
          expect(yOf(dy, dz, dist, cp)).toBeGreaterThanOrEqual(FLOOR - 1e-9)
          expect(reachable).toBe(true) // 用例自检：本网格内不存在不可达组合
        }
      }
    }
  })
  it('安全俯仰不被干预（近距小俯仰原样通过）', () => {
    expect(clampPitchForFloor(0.3, 0.0665, 0.9973, 3.0, FLOOR)).toBeCloseTo(0.3)
  })
  it('TIDAL 极端（评审场景）：dist=13.8 pitch=+0.8 被钳到 y≈地板', () => {
    const cp = clampPitchForFloor(0.8, -0.1122, 0.9937, 13.8, FLOOR)
    expect(yOf(-0.1122, 0.9937, 13.8, cp)).toBeGreaterThanOrEqual(FLOOR - 1e-9)
    expect(cp).toBeLessThan(0.8)
  })
})

describe('SKIM 贴镜机位入活跃池', () => {
  it('ACTIVE_POOL 含 SKIM(4)，QUIET_POOL 不变', () => {
    expect(ACTIVE_POOL).toContain(4)
    expect(QUIET_POOL).toEqual([0, 1, 3])
  })
})

describe('手动极限拖拽集成：相机永不穿镜面', () => {
  it('HOME 机位 distScale=3 + 滚轮拉满 + pitch 拖到顶格，逐帧 y ≥ MIRROR_Y+0.15', () => {
    const listeners: Record<string, (e: unknown) => void> = {}
    const dom = {
      addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f },
      removeEventListener: () => {},
    } as unknown as HTMLElement
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
    const d = new CameraDirector(cam, dom)
    d.setDistScale(3)
    listeners['wheel']({ deltaY: 1e6, preventDefault: () => {} })
    listeners['pointerdown']({ clientX: 0, clientY: 0 })
    listeners['pointermove']({ clientX: 0, clientY: 1e6 }) // pitch 顶到 +PITCH_LIMIT
    // 不派发 pointerup：它注册在 window（camera-director.ts）而非 dom 桩；
    // dragging 悬置不影响断言——distScale 顶格（滚轮拉满）+ manualProxy.pitch 到极值即为被测状态
    for (let i = 0; i < 120; i++) {
      d.update(1 / 60, null, 0)
      expect(cam.position.y).toBeGreaterThanOrEqual(MIRROR_Y + 0.15 - 1e-6)
    }
    d.dispose()
  })
})
