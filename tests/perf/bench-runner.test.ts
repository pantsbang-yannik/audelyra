import { describe, it, expect, vi } from 'vitest'
import { BenchRunner, SCENES, SUITE, WARMUP_SEC, STRESS_SHAPE_CYCLE } from '../../src/perf/bench-runner'
import type { BenchAction, BenchSceneDef, BenchSceneName } from '../../src/perf/bench-runner'

function makeHooks() {
  return {
    onSceneEnter: vi.fn<(d: BenchSceneDef) => void>(),
    onMeasureStart: vi.fn<(d: BenchSceneDef) => void>(),
    onAction: vi.fn<(d: BenchSceneDef, a: BenchAction) => void>(),
    onSceneExit: vi.fn<(d: BenchSceneDef) => void>(),
    onDone: vi.fn<() => void>(),
  }
}

/** 以 dt 步进推进 runner 直到 done 或超过 maxSec 保护 */
function run(r: BenchRunner, seconds: number, dt = 0.5): void {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) r.tick(dt)
}

describe('场景表', () => {
  it('一键流程是五个场景，总时长 265 秒', () => {
    expect(SUITE).toEqual(['idle', 'playback', 'stress-live', 'galaxy', 'engine-latency'])
    const total = SUITE.reduce((a, k) => a + SCENES[k].warmupSec + SCENES[k].measureSec, 0)
    expect(total).toBe(265)
  })

  it('power-playback 与 soak 不在一键流程里', () => {
    expect(SUITE).not.toContain('power-playback')
    expect(SUITE).not.toContain('soak')
  })

  it('每个场景 warmup 都是 5 秒', () => {
    for (const k of Object.keys(SCENES) as BenchSceneName[]) {
      expect(SCENES[k].warmupSec).toBe(WARMUP_SEC)
    }
  })

  it('只有 engine-latency 用 pcm 输入——它是唯一能测 engine 延迟的场景', () => {
    const pcmScenes = (Object.keys(SCENES) as BenchSceneName[]).filter((k) => SCENES[k].input === 'pcm')
    expect(pcmScenes).toEqual(['engine-latency'])
  })

  it('idle 场景无输入', () => {
    expect(SCENES.idle.input).toBe('none')
  })
})

describe('状态机推进', () => {
  it('按 pending → warmup → measure → done 推进', () => {
    const h = makeHooks()
    const r = new BenchRunner(['idle'], h)
    expect(r.phase).toBe('pending')
    r.tick(0.1)
    expect(r.phase).toBe('warmup')
    expect(h.onSceneEnter).toHaveBeenCalledOnce()
    expect(h.onMeasureStart).not.toHaveBeenCalled()

    run(r, WARMUP_SEC)
    expect(r.phase).toBe('measure')
    expect(h.onMeasureStart).toHaveBeenCalledOnce()

    run(r, SCENES.idle.measureSec + 1)
    expect(r.phase).toBe('done')
    expect(h.onSceneExit).toHaveBeenCalledOnce()
    expect(h.onDone).toHaveBeenCalledOnce()
  })

  it('多场景时 exit/enter 成对且顺序正确', () => {
    const h = makeHooks()
    const order: string[] = []
    h.onSceneEnter.mockImplementation((d) => order.push(`enter:${d.name}`))
    h.onSceneExit.mockImplementation((d) => order.push(`exit:${d.name}`))
    const r = new BenchRunner(['idle', 'playback'], h)
    run(r, 35 + 65 + 2)
    expect(order).toEqual(['enter:idle', 'exit:idle', 'enter:playback', 'exit:playback'])
    expect(h.onDone).toHaveBeenCalledOnce()
  })

  it('done 之后继续 tick 不再触发任何回调', () => {
    const h = makeHooks()
    const r = new BenchRunner(['idle'], h)
    run(r, 100)
    const doneCalls = h.onDone.mock.calls.length
    run(r, 50)
    expect(h.onDone.mock.calls.length).toBe(doneCalls)
  })
})

describe('stress-live 动作脚本', () => {
  it('在 measure 内 10/20/30/40 秒各切一次形状，顺序固定', () => {
    const h = makeHooks()
    const r = new BenchRunner(['stress-live'], h)
    run(r, WARMUP_SEC + SCENES['stress-live'].measureSec + 1)
    const shapeActions = h.onAction.mock.calls.map(([, a]) => a).filter((a) => a.kind === 'shape-switch')
    expect(shapeActions.map((a) => a.atSec)).toEqual([10, 20, 30, 40])
    expect(shapeActions.map((a) => a.shapeId)).toEqual(STRESS_SHAPE_CYCLE)
  })

  it('warmup 期间不产出任何动作', () => {
    const h = makeHooks()
    const r = new BenchRunner(['stress-live'], h)
    run(r, WARMUP_SEC - 0.5)
    expect(h.onAction).not.toHaveBeenCalled()
  })

  it('每个动作只触发一次', () => {
    const h = makeHooks()
    const r = new BenchRunner(['stress-live'], h)
    run(r, WARMUP_SEC + SCENES['stress-live'].measureSec + 1, 0.1) // 更细的步进
    expect(h.onAction.mock.calls.length).toBe(4)
  })
})

describe('galaxy 三阶段', () => {
  it('measure 起点进入、30 秒退出', () => {
    const h = makeHooks()
    const r = new BenchRunner(['galaxy'], h)
    run(r, WARMUP_SEC + SCENES.galaxy.measureSec + 1)
    const kinds = h.onAction.mock.calls.map(([, a]) => `${a.kind}@${a.atSec}`)
    expect(kinds).toEqual(['galaxy-enter@0', 'galaxy-exit@30'])
  })
})

describe('totalSec', () => {
  it('等于所有场景 warmup+measure 之和', () => {
    const r = new BenchRunner(['idle', 'galaxy'], makeHooks())
    expect(r.totalSec).toBe(35 + 45)
  })
})

// 下面三条不留时间缓冲，精确卡在边界上。带缓冲的用例测不出 <= 写成 < 这类手滑
//（mutation test 实证：把动作派发的 <= 改成 <、把场景结束的 >= 改成 >，带缓冲的
// 14 条用例全都照过）。bench 时序是所有场景时长的地基，边界语义必须有测试锚定。
describe('边界精度（不留缓冲）', () => {
  it('measure 恰好走满即结束，不多等一拍', () => {
    const h = makeHooks()
    const r = new BenchRunner(['idle'], h)
    const dt = 0.5
    const steps = Math.round((WARMUP_SEC + SCENES.idle.measureSec) / dt) + 1 // +1 为 pending→warmup 那拍
    for (let i = 0; i < steps; i++) r.tick(dt)
    expect(r.phase).toBe('done')
    expect(h.onSceneExit).toHaveBeenCalledOnce()
  })

  it('少走一拍则尚未结束——证明上一条不是靠多余步数蒙对的', () => {
    const h = makeHooks()
    const r = new BenchRunner(['idle'], h)
    const dt = 0.5
    const steps = Math.round((WARMUP_SEC + SCENES.idle.measureSec) / dt) // 少一拍
    for (let i = 0; i < steps; i++) r.tick(dt)
    expect(r.phase).toBe('measure')
    expect(h.onSceneExit).not.toHaveBeenCalled()
  })

  it('动作在 elapsedInPhase 恰好达到 atSec 的那一拍派发，不推迟', () => {
    const h = makeHooks()
    const r = new BenchRunner(['stress-live'], h)
    const dt = 1
    // pending→warmup 一拍，再走满 warmup，此后每拍 elapsedInPhase 增 1
    r.tick(dt)
    for (let i = 0; i < WARMUP_SEC; i++) r.tick(dt)
    expect(r.phase).toBe('measure')
    // 首个动作在 atSec=10；走到 elapsedInPhase=10 的那一拍必须已派发
    for (let i = 0; i < 10; i++) r.tick(dt)
    expect(h.onAction).toHaveBeenCalledOnce()
    expect(h.onAction.mock.calls[0][1].atSec).toBe(10)
  })
})
