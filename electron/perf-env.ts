// 性能基准的环境快照采集。取不到的字段一律 null——不猜、不填默认值，
// 否则跨版本对比会被假数据污染。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { app, screen, powerMonitor, type BrowserWindow } from 'electron'
import type { PerfEnv } from '../src/perf/report'

const execFileP = promisify(execFile)

/** 低电量模式无现成 Electron API，走 pmset 解析；取不到记 null */
async function readLowPowerMode(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileP('pmset', ['-g'], { timeout: 3000 })
    const m = /lowpowermode\s+(\d)/i.exec(stdout)
    return m ? m[1] === '1' : null
  } catch {
    return null
  }
}

/** dev 下从 git 读；打包版没有 .git，返回 null（打包版接入时改为 build 期注入） */
async function readCommitSha(): Promise<string | null> {
  if (app.isPackaged) return null
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: app.getAppPath(), timeout: 3000,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function readBatteryPercent(): number | null {
  // Electron 无电量百分比 API；powerMonitor 只给供电来源。留 null 而不是编一个数
  return null
}

export async function collectPerfEnv(win: BrowserWindow): Promise<PerfEnv> {
  const display = screen.getDisplayMatching(win.getBounds())
  const [lowPowerMode, commitSha] = await Promise.all([readLowPowerMode(), readCommitSha()])
  return {
    osVersion: `${os.platform()} ${os.release()}`,
    electronVersion: process.versions.electron,
    commitSha,
    buildType: app.isPackaged ? 'packaged' : 'dev',
    chip: os.cpus()[0]?.model ?? '未知',
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    // 判据来源：不用 rAF 实测反推（有自证循环——120Hz 屏上只跑 60fps 会把目标误判成 60Hz）
    displayHz: display.displayFrequency,
    powerSource: powerMonitor.onBatteryPower ? 'battery' : 'ac',
    batteryPercent: readBatteryPercent(),
    lowPowerMode,
  }
}
