// 性能报告数据结构与人类可读摘要。纯逻辑，无 DOM 依赖。
//
// 结构留了历史对比的口子：本类型即为将来入库的记录单元，加对比时在外层套 { runs: PerfReport[] }
// 并写 diff 函数即可，本文件无需改动。
import { COVERAGE_WARN_THRESHOLD, type GpuTimingSummary, type GpuUnavailableReason } from './gpu-timing'
import type { PhaseMs, Quantiles } from './types'

/** 主进程环境快照。取不到的字段一律 null——不猜、不填默认值，否则跨版本对比会被假数据污染 */
export interface PerfEnv {
  osVersion: string
  electronVersion: string
  commitSha: string | null
  buildType: 'dev' | 'packaged'
  chip: string
  memoryGB: number
  displayHz: number
  powerSource: 'ac' | 'battery'
  batteryPercent: number | null
  lowPowerMode: boolean | null
}

export interface PerfReportMeta {
  appVersion: string
  commitSha: string | null
  buildType: 'dev' | 'packaged'
  osVersion: string
  electronVersion: string
  threeVersion: string
  hw: { chip: string; memoryGB: number }
  backend: 'webgpu' | 'webgl'
  /** 窗口与绘制缓冲尺寸差一倍 GPU 数字就不可比，必须记录 */
  windowSize: { w: number; h: number }
  drawingBufferSize: { w: number; h: number }
  devicePixelRatio: number
  /** 判据来源：主进程 screen API。掉帧率与及格线全按它归一化 */
  displayHz: number
  /** rAF 实测节奏，仅作交叉验证，不作判据（用实测反推目标有自证循环） */
  rafMedianMs: number
  powerSource: 'ac' | 'battery'
  batteryPercent: number | null
  lowPowerMode: boolean | null
  /** 恒为 'default'：bench 强制套用默认设置消除变量，而非记录用户现状 */
  settingsProfile: 'default'
  trackTimestamp: boolean
  traceSha256: string | null
  generatedAt: string
}

export interface LatencyQuantiles {
  engine: { p50: number; p95: number }
  wait: { p50: number; p95: number }
  render: { p50: number; p95: number }
  total: { p50: number; p95: number }
}

export interface SceneResult {
  name: string
  tier: string
  particles: number
  durationSec: number
  frames: number
  cpuFrameMs: Quantiles
  intervalMs: Quantiles
  jankEventRate: number
  missedVsyncRate: number
  hitchCount: number
  gpu: GpuTimingSummary | null
  gpuUnavailableReason: GpuUnavailableReason | null
  phasesMs: PhaseMs
  /** 仅引擎类基准有值；视觉基准恒为 null（trace 直接 publish，不经 engine.ingest） */
  latencyMs: LatencyQuantiles | null
}

/** 启动五里程碑（ms，相对进程启动）。timeOrigin 只覆盖 renderer 导航之后，
 * 主进程启动与建窗两段必须从主进程取，故本结构由两侧拼接而成 */
export interface StartupMarks {
  processStartMs: number
  windowCreatedMs: number
  rendererLoadedMs: number
  sceneInitDoneMs: number
  firstFrameSubmittedMs: number
}

export interface StartupResult {
  /** 每次冷启动的原始值。单次噪声过大，判据取中位数 */
  runs: StartupMarks[]
  medianToFirstFrameMs: number
}

export interface PerfReport {
  meta: PerfReportMeta
  scenes: SceneResult[]
  /** 冷启动测量单独触发（要重启应用），一键基准里为 null */
  startup: StartupResult | null
  /** 使用限制声明。dev 构建必须填，随 JSON 一同落盘——
   * 「dev 数字不可对外宣称」这条纪律不能只活在 formatSummary 的输出里，
   * 否则有人直接读 JSON 就看不到它。非 dev 为 null。 */
  disclaimer: string | null
}

/** dev 构建的使用限制文本。构造报告时按 buildType 填入 PerfReport.disclaimer */
export const DEV_DISCLAIMER =
  'dev 构建：数字仅供同环境下改动前后的相对对比，不可作 CPU 侧绝对值，禁止对外宣称'

const UNKNOWN = '未知'

function n(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? UNKNOWN : v.toFixed(digits)
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? UNKNOWN : `${(v * 100).toFixed(2)}%`
}

/** 百分比数值（0-100 口径，与 pct 的 0-1 口径区分） */
function pctRaw(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? UNKNOWN : `${v}%`
}

function str(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? UNKNOWN : v
}

function bool(v: boolean | null | undefined): string {
  return v === null || v === undefined ? UNKNOWN : v ? '是' : '否'
}

export function formatSummary(report: PerfReport): string {
  const m = report.meta
  const lines: string[] = []
  lines.push('=== Audelyra 性能报告 ===')
  lines.push(`版本 ${str(m.appVersion)} · commit ${str(m.commitSha)} · 构建 ${m.buildType}`)
  if (m.buildType === 'dev') {
    lines.push(`⚠️  ${DEV_DISCLAIMER}`)
  }
  lines.push(`硬件 ${str(m.hw?.chip)} / ${n(m.hw?.memoryGB, 0)}GB · 后端 ${str(m.backend)}`)
  // 三个版本号必须打印：跨系统/跨 Electron/跨 three 版本对比时，缺了它们数字无从归因
  lines.push(`系统 ${str(m.osVersion)} · Electron ${str(m.electronVersion)} · three ${str(m.threeVersion)}`)
  lines.push(`窗口 ${m.windowSize.w}×${m.windowSize.h} · 缓冲 ${m.drawingBufferSize.w}×${m.drawingBufferSize.h} · DPR ${n(m.devicePixelRatio, 2)}`)
  lines.push(`刷新率 ${n(m.displayHz, 0)}Hz（rAF 实测 ${n(m.rafMedianMs)}ms）· 目标间隔 ${n(1000 / m.displayHz)}ms`)
  // 电量走统一兜底：手写 === null 三目会漏掉 undefined，让 "undefined%" 泄进输出
  lines.push(`供电 ${str(m.powerSource)} · 电量 ${pctRaw(m.batteryPercent)} · 低电量模式 ${bool(m.lowPowerMode)}`)
  lines.push(`设置档 ${m.settingsProfile} · GPU 计时 ${bool(m.trackTimestamp)} · trace ${str(m.traceSha256).slice(0, 12)}`)
  lines.push('')

  for (const s of report.scenes) {
    lines.push(`--- ${s.name}（${s.tier} / ${s.particles} 粒子 / ${n(s.durationSec, 0)}s / ${s.frames} 帧）---`)
    lines.push(`  帧间隔  p50 ${n(s.intervalMs.p50)} · p95 ${n(s.intervalMs.p95)} · p99 ${n(s.intervalMs.p99)} · max ${n(s.intervalMs.max)} ms`)
    lines.push(`  CPU帧   p50 ${n(s.cpuFrameMs.p50)} · p95 ${n(s.cpuFrameMs.p95)} · p99 ${n(s.cpuFrameMs.p99)} ms`)
    lines.push(`  慢帧率 ${pct(s.jankEventRate)} · 错过vsync ${pct(s.missedVsyncRate)} · 卡顿 ${s.hitchCount} 次`)
    if (s.gpu) {
      lines.push(`  GPU批均 p50 ${n(s.gpu.batchAvgMs.p50)} · max ${n(s.gpu.batchAvgMs.max)} ms（${s.gpu.batches} 批 / 覆盖 ${pct(s.gpu.coverage)}${s.gpu.droppedBatches > 0 ? ` / 丢弃 ${s.gpu.droppedBatches} 批` : ''}）`)
      if (s.gpu.coverage < COVERAGE_WARN_THRESHOLD) {
        lines.push(`  ⚠️  GPU 采样覆盖不足（${pct(s.gpu.coverage)}），该数字参考价值有限`)
      }
    } else {
      lines.push(`  GPU     不可用（${str(s.gpuUnavailableReason)}）`)
    }
    const p = s.phasesMs
    lines.push(`  分段p50 信号 ${n(p.signal)} · 映射 ${n(p.mapping)} · 状态 ${n(p.state)} · 画面 ${n(p.visual)} · 相机 ${n(p.camera)} · 提交 ${n(p.submit)} ms`)
    // 分段覆盖诚实兜底（对称于 GPU coverage<0.5 警告）：galaxy 等走独立更新路径的场景在分段打点块
    // 之前就 return，六段全 0——不加警告的话报告「分段全 0.00」会被误读为「每段零开销」。
    // 六段 p50 之和明显小于 CPU 帧 p50 即说明大量帧未被分段覆盖，此数不可当真。
    const phaseSum = p.signal + p.mapping + p.state + p.visual + p.camera + p.submit
    if (s.cpuFrameMs.p50 > 0.1 && phaseSum < s.cpuFrameMs.p50 * 0.5) {
      lines.push(`  ⚠️  分段覆盖不全（六段和 ${n(phaseSum)} ≪ CPU帧 ${n(s.cpuFrameMs.p50)} ms）——该场景含独立渲染路径，分段数字不可当真`)
    }
    if (s.latencyMs) {
      const l = s.latencyMs
      lines.push(`  内部延迟 总 p50 ${n(l.total.p50)} / p95 ${n(l.total.p95)} ms（引擎 ${n(l.engine.p50)} · 等待 ${n(l.wait.p50)} · 渲染 ${n(l.render.p50)}）`)
      lines.push('  注：内部延迟不含音频驱动与显示器延迟，不等于端到端延迟')
    }
    lines.push('')
  }

  if (report.startup) {
    const su = report.startup
    lines.push(`--- 冷启动（${su.runs.length} 次取中位数）---`)
    lines.push(`  进程启动 → 首帧提交：${n(su.medianToFirstFrameMs, 0)} ms`)
    for (const [i, r] of su.runs.entries()) {
      lines.push(
        `  第${i + 1}次  建窗 ${n(r.windowCreatedMs, 0)} · renderer ${n(r.rendererLoadedMs, 0)}` +
        ` · 场景就绪 ${n(r.sceneInitDoneMs, 0)} · 首帧 ${n(r.firstFrameSubmittedMs, 0)} ms`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}
