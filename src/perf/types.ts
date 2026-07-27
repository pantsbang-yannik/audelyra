// 性能测量共享类型——纯类型声明，无运行时依赖。

/** 分位数摘要。全部用 nearest-rank 口径计算（见 stats.ts quantiles） */
export interface Quantiles {
  p50: number
  p95: number
  p99: number
  max: number
}

/** 单帧内 CPU 各段耗时（ms）。分段口径对应 nebula update() 的主要段落：
 * - signal：1) SignalRig 特征提取
 * - mapping：1.5)~1.8) mapper + motionProgram + dialect 映射与方言
 * - state：2)~4c) 状态机、边沿条件、苏醒窗口、uMorph、溶解落地、主体交接
 * - visual：5)~5.7) 调色过渡、背景三件套、拼字、歌词粒子
 * - camera：6) 导演层运镜
 * - submit：7) compute + render 提交
 *
 * 注：0) 粒子重建为条件触发罕见事件，不单列；8) 为 O(1) 降级监督，亦不单列。
 * 六段合计须覆盖 update() 全部主要开销，否则分段之和远小于 CPU 帧耗时，测了等于没测。*/
export interface PhaseMs {
  signal: number
  mapping: number
  state: number
  visual: number
  camera: number
  submit: number
}

/** 一帧的采样。intervalMs 是与上一帧起点的间隔（掉帧判据），cpuMs 是本帧内实际 CPU 耗时 */
export interface FrameSample {
  cpuMs: number
  intervalMs: number
  phases: PhaseMs
}

/** 内部延迟三段分解（ms）。engine=ingest→publish，wait=publish→帧起点，render=帧起点→提交完成 */
export interface LatencySample {
  engine: number
  wait: number
  render: number
  total: number
}

/** 采集档位。off 为默认且生产构建恒为此态；hud 不开 GPU 计时（有真实开销）；bench 全开 */
export type PerfMode = 'off' | 'hud' | 'bench'
