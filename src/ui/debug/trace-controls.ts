import { TraceRecorder, TracePlayer } from '../../engine/trace'
import type { SignalBus } from '../../engine/bus'

/** @returns stopReplay——供装配层在抢占 bus 直灌权时停掉正在回放的 trace
 * （trace 与试音都直接 publish，同时活跃会逐帧竞态） */
export function installTraceControls(opts: {
  bus: SignalBus
  onReplayStart: () => void
  onReplayEnd: () => void
}): { stopReplay: () => void } {
  const recorder = new TraceRecorder()
  let recording = false
  let rafId = 0
  let player: TracePlayer | null = null

  function stopReplay(): void {
    if (!player) return
    cancelAnimationFrame(rafId)
    player = null
    opts.onReplayEnd()
    console.log('[trace] 回放结束，恢复实时信号')
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      if (!recording) {
        recorder.start(opts.bus)
        recording = true
        console.log('[trace] 录制中…（再按 R 停止并下载）')
      } else {
        recording = false
        const jsonl = recorder.stop()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([jsonl], { type: 'application/jsonl' }))
        a.download = `audelyra-trace-${Date.now()}.jsonl`
        a.click()
        URL.revokeObjectURL(a.href)
        console.log('[trace] 已下载')
      }
    }
    if (e.key === 'Escape') stopReplay()
  })

  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file || !file.name.endsWith('.jsonl')) return
    stopReplay()
    player = new TracePlayer(await file.text())
    opts.onReplayStart()
    console.log(`[trace] 回放 ${file.name}（${player.duration.toFixed(1)}s 循环，Esc 退出）`)
    let last = performance.now()
    const tick = (now: number): void => {
      if (!player) return
      player.step(Math.min((now - last) / 1000, 0.1), (s) => opts.bus.publish(s))
      last = now
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  })

  return { stopReplay }
}
