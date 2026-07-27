import { describe, it, expect, vi } from 'vitest'
import {
  deriveFlags, shouldIngestSystemPcm, shouldIngestLocalPcm, isSyntheticInjector,
  SignalSourceArbiter,
  INJECTORS, PCM_SOURCES, type Injector, type SourceFlags, type SourceSwitchHooks,
} from '../../src/audio/signal-source'

// 本节按「所有组合」枚举断言，目的就是让「新增信号源忘了补条件」当场失败——
// 此前分散在装配层的布尔与或连续三轮漏掉了不同的源（trace、序幕 demo、性能基准）。
describe('信号源仲裁：任一时刻只有一路信号灌引擎', () => {
  it('穷举所有组合：两条 ingest 判定不得同时为真', () => {
    for (const pcm of PCM_SOURCES) {
      for (const inj of INJECTORS) {
        const sys = shouldIngestSystemPcm(pcm, inj)
        const local = shouldIngestLocalPcm(pcm, inj)
        expect(sys && local, `${pcm}/${inj} 两路 PCM 同时进引擎`).toBe(false)
      }
    }
  })

  it('任何直灌源活跃时，两路 PCM 一律让路', () => {
    for (const pcm of PCM_SOURCES) {
      for (const inj of INJECTORS.filter((i) => i !== 'none')) {
        expect(shouldIngestSystemPcm(pcm, inj), `${inj} 期间系统捕获未让路`).toBe(false)
        expect(shouldIngestLocalPcm(pcm, inj), `${inj} 期间本地 PCM 未让路`).toBe(false)
        expect(deriveFlags(pcm, inj).liveMuted).toBe(true)
      }
    }
  })

  it('无直灌源时按 PCM 来源二选一（本地优先）', () => {
    expect(shouldIngestSystemPcm('live', 'none')).toBe(true)
    expect(shouldIngestLocalPcm('live', 'none')).toBe(false)
    expect(shouldIngestSystemPcm('local', 'none')).toBe(false)
    expect(shouldIngestLocalPcm('local', 'none')).toBe(true)
  })

  it('本地播放 + 直灌源结束 → 本地自动恢复（两个维度不能压成单一枚举的理由）', () => {
    expect(shouldIngestLocalPcm('local', 'replay')).toBe(false) // 回放期间让路
    expect(shouldIngestLocalPcm('local', 'none')).toBe(true) // 回放结束即恢复，无需额外记账
    expect(deriveFlags('local', 'replay').localActive, '回放期间本地仍在后台播着').toBe(true)
  })

  it('派生布尔与各源一一对应', () => {
    expect(deriveFlags('live', 'replay')).toMatchObject({ replayActive: true, demoActive: false, auditionActive: false })
    expect(deriveFlags('live', 'demo')).toMatchObject({ replayActive: false, demoActive: true, auditionActive: false })
    expect(deriveFlags('live', 'audition')).toMatchObject({ replayActive: false, demoActive: false, auditionActive: true })
    // bench 自行 ingest 合成 PCM，不占用 replay/demo/audition 任一语义，但同样静音系统捕获
    expect(deriveFlags('live', 'bench')).toMatchObject({
      replayActive: false, demoActive: false, auditionActive: false, liveMuted: true,
    })
  })

  it('liveMuted 与旧的「或」语义等价（回归钉：改写时不许放宽）', () => {
    for (const pcm of PCM_SOURCES) {
      for (const inj of INJECTORS) {
        const f = deriveFlags(pcm, inj)
        const legacy = f.replayActive || f.localActive || f.demoActive || f.auditionActive || inj === 'bench'
        expect(f.liveMuted, `${pcm}/${inj}`).toBe(legacy)
      }
    }
  })

  it('只有 audition 是人造信号——其余源的量级本就真实，不该被隔离', () => {
    expect(isSyntheticInjector('audition')).toBe(true)
    for (const inj of INJECTORS.filter((i) => i !== 'audition')) {
      expect(isSyntheticInjector(inj as Injector), `${inj} 被误判为人造源`).toBe(false)
    }
  })
})

// —— 切换编排 ——
// 上面那组穷举的是「条件」，本组穷举的是「顺序与重入」。
// 分开测是因为它们是两类 bug：条件错 → 漏源（栽过三次）；顺序错 → 递归爆栈（栽过一次，
// 表现为试音模式退不出，而当时 1368 条测试一条都没抓住——那时编排还在装配层，测不到）。

/** 记录钩子调用次序的探针；flagsAt 记下**每次钩子被调用当时**的派生布尔快照 */
function probe(over: Partial<SourceSwitchHooks> = {}): {
  hooks: SourceSwitchHooks
  calls: string[]
  flagsAt: Map<string, SourceFlags>
  latest: () => SourceFlags
} {
  const calls: string[] = []
  const flagsAt = new Map<string, SourceFlags>()
  let latest: SourceFlags = deriveFlags('live', 'none')
  const hooks: SourceSwitchHooks = {
    onFlags: (f) => { latest = f; calls.push('flags') },
    clearFrame: () => calls.push('clearFrame'),
    stopInjector: (which) => { calls.push(`stop:${which}`); flagsAt.set(`stop:${which}`, latest) },
    onSyntheticChange: (on) => { calls.push(`synthetic:${on}`); flagsAt.set(`synthetic:${on}`, latest) },
    ...over,
  }
  return { hooks, calls, flagsAt, latest: () => latest }
}

describe('SignalSourceArbiter：切换编排', () => {
  // 反向验证（2026-07-27 实做）：把 setInjector 里「更新状态」与「停旧源」两步对调回旧写法，
  // 本节有三条精准变红——递归这条、派生布尔时序这条、次序断言这条。测试确实咬得住。
  it('🔴 停演钩子里重入 setInjector 不会无限递归（试音退不出的回归钉）', () => {
    // 复刻出事时 exitAudition 的写法：钩子里带着守卫再切一次直灌权。
    // 顺序修正后，钩子读到的 injector 已是新值 ⇒ 守卫失效 ⇒ 递归自然终止。
    let arb!: SignalSourceArbiter
    const p = probe({
      stopInjector: (which) => {
        if (which === 'audition' && arb.injector === 'audition') arb.setInjector('none') // 旧写法
      },
    })
    arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('audition')
    expect(() => arb.setInjector('none')).not.toThrow() // 旧实现在此爆 Maximum call stack
    expect(arb.injector).toBe('none')
    expect(arb.flags.auditionActive).toBe(false)
  })

  it('🔴 停演钩子被调用时，派生布尔已经是切换后的值（递归的根因就是这一条不成立）', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('audition')
    p.calls.length = 0
    arb.setInjector('none')
    // 收摊钩子要按新状态重算压制（读到旧值会算出「试音还在演」，播放条永远弹不回来）
    expect(p.flagsAt.get('stop:audition')!.auditionActive).toBe(false)
  })

  it('钩子里无条件切直灌权（真·重入）抛出可读错误，而不是静默爆栈', () => {
    let arb!: SignalSourceArbiter
    // 收摊时无条件再切一次直灌权——没有守卫兜底，这才是真正的误用
    const p = probe({ stopInjector: (which) => { if (which === 'audition') arb.setInjector('replay') } })
    arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('audition')
    expect(() => arb.setInjector('none')).toThrow(/停演钩子内不得调用 setInjector/)
  })

  it('切换次序固定为：更新状态 → 停旧源 → 清残留帧 → 通知人造源进出', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    p.calls.length = 0
    arb.setInjector('audition')
    expect(p.calls).toEqual(['flags', 'stop:none', 'clearFrame', 'synthetic:true'])
  })

  it('停旧源只对上一路调用一次，且不会误停新源', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('replay')
    p.calls.length = 0
    arb.setInjector('audition') // trace 被试音抢占
    expect(p.calls.filter((c) => c.startsWith('stop:'))).toEqual(['stop:replay'])
  })

  it('人造源进出只在真正翻转时各通知一次（重复切换非人造源不打扰场景）', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('audition') // → true
    arb.setInjector('replay')   // → false（audition 走了）
    arb.setInjector('demo')     // 仍非人造，不该再通知
    arb.setInjector('none')
    expect(p.calls.filter((c) => c.startsWith('synthetic:'))).toEqual(['synthetic:true', 'synthetic:false'])
  })

  it('切到相同值是空操作：不停源、不清帧、不刷布尔', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    arb.setInjector('replay')
    p.calls.length = 0
    arb.setInjector('replay')
    arb.setPcmSource('live') // 初始就是 live
    expect(p.calls).toEqual([])
  })

  it('两个维度正交：本地播放中途插 trace，回放结束后本地自动恢复', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    arb.setPcmSource('local')
    expect(shouldIngestLocalPcm(arb.pcmSource, arb.injector)).toBe(true)

    arb.setInjector('replay') // 回放抢占，本地让路但仍在后台播着
    expect(arb.flags.localActive, '「本地仍在播」这一信息不许丢').toBe(true)
    expect(shouldIngestLocalPcm(arb.pcmSource, arb.injector)).toBe(false)

    arb.setInjector('none') // 回放结束
    expect(shouldIngestLocalPcm(arb.pcmSource, arb.injector), '本地须自动恢复').toBe(true)
  })

  it('换 PCM 来源同样清残留帧（不清则上一路的连续量滞留画面）', () => {
    const p = probe()
    const arb = new SignalSourceArbiter(p.hooks)
    p.calls.length = 0
    arb.setPcmSource('local')
    expect(p.calls).toEqual(['flags', 'clearFrame'])
  })

  it('构造即播种一次派生布尔（装配层的 let 不必自己初始化）', () => {
    const onFlags = vi.fn()
    new SignalSourceArbiter({ onFlags, clearFrame: () => {} })
    expect(onFlags).toHaveBeenCalledWith(deriveFlags('live', 'none'))
  })

  it('穷举全部切换对：任何一步之后，状态与派生布尔都自洽', () => {
    for (const from of INJECTORS) {
      for (const to of INJECTORS) {
        const p = probe()
        const arb = new SignalSourceArbiter(p.hooks)
        arb.setInjector(from)
        arb.setInjector(to)
        expect(arb.injector, `${from}→${to}`).toBe(to)
        expect(arb.flags, `${from}→${to}`).toEqual(deriveFlags('live', to))
      }
    }
  })
})
