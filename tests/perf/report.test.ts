import { describe, it, expect } from 'vitest'
import { formatSummary } from '../../src/perf/report'
import type { PerfReport, SceneResult } from '../../src/perf/report'

const META: PerfReport['meta'] = {
  appVersion: '0.1.1', commitSha: 'abc1234', buildType: 'dev',
  osVersion: 'darwin 25.5.0', electronVersion: '43.0.0', threeVersion: '0.183.2',
  hw: { chip: 'Apple M5', memoryGB: 32 }, backend: 'webgpu',
  windowSize: { w: 1280, h: 800 }, drawingBufferSize: { w: 1920, h: 1200 }, devicePixelRatio: 1.5,
  displayHz: 60, rafMedianMs: 16.7,
  powerSource: 'ac', batteryPercent: 88, lowPowerMode: false,
  settingsProfile: 'default', trackTimestamp: true, traceSha256: 'deadbeef',
  generatedAt: '2026-07-23T12:00:00.000Z',
}

function scene(over: Partial<SceneResult> = {}): SceneResult {
  return {
    name: 'playback', tier: 'ultra', particles: 450_000, durationSec: 60, frames: 3600,
    cpuFrameMs: { p50: 4, p95: 7, p99: 9, max: 20 },
    intervalMs: { p50: 16.7, p95: 17.2, p99: 25, max: 48 },
    jankEventRate: 0.004, missedVsyncRate: 0.002, hitchCount: 1,
    gpu: { batchAvgMs: { p50: 6, p95: 8, p99: 9, max: 11 }, batches: 120, framesCovered: 3400, coverage: 0.944, droppedBatches: 0 },
    gpuUnavailableReason: null,
    phasesMs: { signal: 0.4, mapping: 0.9, state: 0.5, visual: 1.2, camera: 0.3, submit: 1.8 },
    latencyMs: null,
    ...over,
  }
}

/** 报告构造 helper——避免每个用例重复写 startup / disclaimer */
function rep(over: Partial<PerfReport> = {}): PerfReport {
  return { meta: META, scenes: [scene()], startup: null, disclaimer: null, ...over }
}

describe('formatSummary', () => {
  it('输出含版本、硬件与场景名', () => {
    const out = formatSummary(rep())
    expect(out).toContain('0.1.1')
    expect(out).toContain('Apple M5')
    expect(out).toContain('playback')
  })

  it('gpu 为 null 时不崩，且打印不可用原因', () => {
    const out = formatSummary(rep({
      meta: { ...META, trackTimestamp: false },
      scenes: [scene({ gpu: null, gpuUnavailableReason: 'webgl-backend' })],
    }))
    expect(out).toContain('webgl-backend')
    expect(out).not.toContain('NaN')
  })

  it('覆盖率不足时给出显式警示', () => {
    const out = formatSummary(rep({
      scenes: [scene({ gpu: { batchAvgMs: { p50: 6, p95: 8, p99: 9, max: 11 }, batches: 5, framesCovered: 300, coverage: 0.083, droppedBatches: 2 } })],
    }))
    expect(out).toContain('GPU 采样覆盖不足')
  })

  it('分段六段和远小于 CPU 帧时警告不可当真（galaxy 类独立路径场景）', () => {
    const out = formatSummary(rep({
      scenes: [scene({
        name: 'galaxy',
        cpuFrameMs: { p50: 5, p95: 7, p99: 9, max: 20 },
        phasesMs: { signal: 0, mapping: 0, state: 0, visual: 0, camera: 0, submit: 0 },
      })],
    }))
    expect(out).toContain('分段覆盖不全')
  })

  it('分段六段和接近 CPU 帧时不误报警告（正常 live 场景）', () => {
    const out = formatSummary(rep({
      scenes: [scene({
        cpuFrameMs: { p50: 4, p95: 7, p99: 9, max: 20 },
        phasesMs: { signal: 0.4, mapping: 0.9, state: 0.5, visual: 1.2, camera: 0.3, submit: 1.0 },
      })],
    }))
    expect(out).not.toContain('分段覆盖不全')
  })

  it('meta 字段为 null 时呈现为「未知」而不是 null/undefined 字样', () => {
    const out = formatSummary(rep({
      meta: { ...META, lowPowerMode: null, batteryPercent: null, commitSha: null },
    }))
    expect(out).toContain('未知')
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('null')
  })

  // 下面三条按「字段名 + 未知」精确断言。笼统的 toContain('未知') 测不出单个兜底函数坏没坏——
  // 同一份报告里只要有任一字段产出「未知」，笼统断言就通过了（mutation test 实证过这个盲区）
  it('bool() 兜底：lowPowerMode 为 null 打印「低电量模式 未知」，不得当 falsy 打成「否」', () => {
    const out = formatSummary(rep({ meta: { ...META, lowPowerMode: null } }))
    expect(out).toContain('低电量模式 未知')
  })

  it('pctRaw() 兜底：batteryPercent 为 undefined 也不许漏出 undefined 字样', () => {
    // 上游若忘记把取不到的值归一化为 null，这里是最后一道防线
    const meta = { ...META, batteryPercent: undefined as unknown as number | null }
    const out = formatSummary(rep({ meta }))
    expect(out).toContain('电量 未知')
    expect(out).not.toContain('undefined')
  })

  it('n() 兜底：数值字段为 NaN/null 时打印「未知」而不是 NaN', () => {
    const out = formatSummary(rep({
      meta: { ...META, devicePixelRatio: NaN },
      scenes: [scene({ durationSec: null as unknown as number })],
    }))
    expect(out).toContain('DPR 未知')
    expect(out).not.toContain('NaN')
  })

  it('三个版本号必须打印——跨系统/Electron/three 版本对比时缺了无从归因', () => {
    const out = formatSummary(rep())
    expect(out).toContain('darwin 25.5.0')
    expect(out).toContain('43.0.0')
    expect(out).toContain('0.183.2')
  })

  it('dev 构建必须打印不可对外宣称的警告', () => {
    expect(formatSummary(rep({ meta: { ...META, buildType: 'dev' } }))).toContain('禁止对外宣称')
  })

  it('packaged 构建不打该警告', () => {
    expect(formatSummary(rep({ meta: { ...META, buildType: 'packaged' } }))).not.toContain('禁止对外宣称')
  })

  it('有延迟数据的场景打印三段分解', () => {
    const out = formatSummary(rep({
      scenes: [scene({ name: 'engine-latency', latencyMs: { engine: { p50: 21, p95: 31 }, wait: { p50: 8, p95: 15 }, render: { p50: 5, p95: 9 }, total: { p50: 34, p95: 52 } } })],
    }))
    expect(out).toContain('engine-latency')
    expect(out).toContain('34')
  })

  it('空场景列表不崩', () => {
    expect(() => formatSummary(rep({ scenes: [] }))).not.toThrow()
  })

  it('有 startup 数据时打印冷启动中位数与各里程碑', () => {
    const marks = { processStartMs: 0, windowCreatedMs: 120, rendererLoadedMs: 480, sceneInitDoneMs: 1100, firstFrameSubmittedMs: 1350 }
    const out = formatSummary(rep({
      startup: { runs: [marks, marks, marks], medianToFirstFrameMs: 1350 },
    }))
    expect(out).toContain('冷启动')
    expect(out).toContain('1350')
    expect(out).toContain('3 次')
  })

  it('startup 为 null 时不打印冷启动段落', () => {
    expect(formatSummary(rep())).not.toContain('冷启动')
  })
})
