/** 滚动峰值相对化（loudness/energy/频段共用；曾在仓库内重复实现三处，M2 终审收口） */
export class RollingPeak {
  private _peak = 0
  constructor(private halfLifeSec = 30, private floor = 1e-4) {}
  seed(v: number): void {
    this._peak = Math.max(this._peak, v)
  }
  update(v: number, dt: number): number {
    this._peak = Math.max(v, this._peak * Math.pow(0.5, dt / this.halfLifeSec))
    return Math.min(1, v / Math.max(this._peak, this.floor))
  }
  get peak(): number {
    return this._peak
  }
  /** 直接置峰值——信号源切换时保存/恢复自适应状态用。
   * 不能用 seed 代替：seed 只会抬高（`max`），无法还原到更低的值。 */
  setPeak(v: number): void {
    this._peak = Math.max(0, v)
  }
}
