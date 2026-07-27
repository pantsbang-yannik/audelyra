// 运动方言设置（Phase C2）：调音台"主体"tab 的 5 个手感旋钮，electron settings.motion 字段持久化。
// 精选旋钮铁律（用户拍板甲案）：只露最影响观感的少数旋钮，其余走代码强默认。
export interface MotionSettings {
  bombIntensity: number // 轰炸强度：持续层总幅度（鼓包/波纹/波前）
  detailDensity: number // 细节密度：碎光闪烁幅度（fb1 后高频运动毛刺已退役，只剩亮度语义）
  waveSpeed: number // 波前速度：打击涟漪的扩张速率倍率
  buildDepth: number // 蓄力深度：drop 前向心收缩多狠
  strobeEnabled: boolean // 频闪开关：爆发/重拍闪白（光敏安全上限之外的总闸）
  climaxBrightness: number // 高潮亮度：辉光/闪白/全场脉冲提亮的总量缩放（1=舒服档，1.5≈压档前旧强度）
  lineBrightness: number // 线条系亮度：频谱环/波形线整体亮度乘子（线条系五类共享）
  lineBarHeight: number // 线条系柱高：频谱条最大长度倍率（环条与波形条同乘）
  eclipseWaveLen: number // 日食线条长度：锯齿波形向两端铺展的距离
  eclipseWaveGap: number // 日食波段间隙：频段条之间的缝隙宽度（0=贴紧）
  eclipseCorona: number // 日冕浓度：黑盘外光晕的厚度与亮度
  ledDensity: number // 点阵格子密度：越大格子越小越密
  ledWaveSpeed: number // 点阵环波速度：鼓点环波扩散的快慢
  ledCross: number // 点阵十字亮度：中心十字光束强度（0=关闭十字）
  ledWaveThick: number // 点阵环波粗细：鼓点扩散环波光带的厚度（高斯包络宽度乘子）
  ledWaveBright: number // 点阵环波亮度：只调环波这一层的亮度（不影响其他方块，点阵整体亮度固定）
  waveWidth: number // 波形线横向宽度：波形线左右铺展的幅度（半宽乘子，波形线专属）
  laserSpread: number // 激光扇面开角：激光扇张开的最大角度
  laserSpeed: number // 激光扫动速度：光束扫动的快慢
  laserChaos: number // 激光乱度：0=规律扫动，1=无序漂移与随机跳位
  laserMaxCount: number // 光束数量上限：束数随能量在 2..上限 间浮动+鼓点瞬增（#激光动态束）
}

// lineBrightness 首启观感调优（2026-07-23 用户复调）：1 → 0.6，线条系五类共享此值，
// 压暗后线条退为骨架、不与主粒子抢光
export const DEFAULT_MOTION_SETTINGS: MotionSettings = {
  bombIntensity: 1, detailDensity: 1, waveSpeed: 1, buildDepth: 0.6, strobeEnabled: true, climaxBrightness: 1,
  lineBrightness: 0.6, lineBarHeight: 1,
  eclipseWaveLen: 1, eclipseWaveGap: 0.3, eclipseCorona: 1,
  ledDensity: 1, ledWaveSpeed: 1, ledCross: 1, ledWaveThick: 1, ledWaveBright: 1,
  laserSpread: 1, laserSpeed: 1, laserChaos: 0.6, laserMaxCount: 8,
  waveWidth: 1,
}

/** 滑块量程单一事实源：sanitize 与调音台共用，防两处数字漂移 */
export const MOTION_LIMITS = {
  bombIntensity: { min: 0, max: 2, step: 0.05 },
  detailDensity: { min: 0, max: 2, step: 0.05 },
  waveSpeed: { min: 0.5, max: 2, step: 0.05 },
  buildDepth: { min: 0, max: 1, step: 0.05 },
  climaxBrightness: { min: 0.3, max: 1.5, step: 0.05 },
  lineBrightness: { min: 0.3, max: 2, step: 0.05 },
  lineBarHeight: { min: 0.4, max: 2, step: 0.05 },
  eclipseWaveLen: { min: 0.5, max: 1.5, step: 0.05 },
  eclipseWaveGap: { min: 0, max: 0.6, step: 0.05 },
  eclipseCorona: { min: 0.4, max: 2, step: 0.05 },
  ledDensity: { min: 0.6, max: 2, step: 0.05 },
  ledWaveSpeed: { min: 0.5, max: 2, step: 0.05 },
  ledCross: { min: 0, max: 1.5, step: 0.05 },
  ledWaveThick: { min: 0.2, max: 2, step: 0.05 },
  ledWaveBright: { min: 0, max: 2, step: 0.05 },
  laserSpread: { min: 0.5, max: 1.5, step: 0.05 },
  laserSpeed: { min: 0.5, max: 2, step: 0.05 },
  laserChaos: { min: 0, max: 1, step: 0.05 },
  laserMaxCount: { min: 4, max: 14, step: 1 },
  waveWidth: { min: 0.5, max: 3, step: 0.05 },
} as const

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

/** 坏数据回默认/出界钳限幅，惯例同 sanitizeShapeSettings */
export function sanitizeMotionSettings(raw: unknown): MotionSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_MOTION_SETTINGS
  const L = MOTION_LIMITS
  return {
    bombIntensity: num(r.bombIntensity, d.bombIntensity, L.bombIntensity.min, L.bombIntensity.max),
    detailDensity: num(r.detailDensity, d.detailDensity, L.detailDensity.min, L.detailDensity.max),
    waveSpeed: num(r.waveSpeed, d.waveSpeed, L.waveSpeed.min, L.waveSpeed.max),
    buildDepth: num(r.buildDepth, d.buildDepth, L.buildDepth.min, L.buildDepth.max),
    strobeEnabled: typeof r.strobeEnabled === 'boolean' ? r.strobeEnabled : d.strobeEnabled,
    climaxBrightness: num(r.climaxBrightness, d.climaxBrightness, L.climaxBrightness.min, L.climaxBrightness.max),
    lineBrightness: num(r.lineBrightness, d.lineBrightness, L.lineBrightness.min, L.lineBrightness.max),
    lineBarHeight: num(r.lineBarHeight, d.lineBarHeight, L.lineBarHeight.min, L.lineBarHeight.max),
    eclipseWaveLen: num(r.eclipseWaveLen, d.eclipseWaveLen, L.eclipseWaveLen.min, L.eclipseWaveLen.max),
    eclipseWaveGap: num(r.eclipseWaveGap, d.eclipseWaveGap, L.eclipseWaveGap.min, L.eclipseWaveGap.max),
    eclipseCorona: num(r.eclipseCorona, d.eclipseCorona, L.eclipseCorona.min, L.eclipseCorona.max),
    ledDensity: num(r.ledDensity, d.ledDensity, L.ledDensity.min, L.ledDensity.max),
    ledWaveSpeed: num(r.ledWaveSpeed, d.ledWaveSpeed, L.ledWaveSpeed.min, L.ledWaveSpeed.max),
    ledCross: num(r.ledCross, d.ledCross, L.ledCross.min, L.ledCross.max),
    ledWaveThick: num(r.ledWaveThick, d.ledWaveThick, L.ledWaveThick.min, L.ledWaveThick.max),
    ledWaveBright: num(r.ledWaveBright, d.ledWaveBright, L.ledWaveBright.min, L.ledWaveBright.max),
    laserSpread: num(r.laserSpread, d.laserSpread, L.laserSpread.min, L.laserSpread.max),
    laserSpeed: num(r.laserSpeed, d.laserSpeed, L.laserSpeed.min, L.laserSpeed.max),
    laserChaos: num(r.laserChaos, d.laserChaos, L.laserChaos.min, L.laserChaos.max),
    laserMaxCount: num(r.laserMaxCount, d.laserMaxCount, L.laserMaxCount.min, L.laserMaxCount.max),
    waveWidth: num(r.waveWidth, d.waveWidth, L.waveWidth.min, L.waveWidth.max),
  }
}

/** 高潮提亮压档（#高潮亮度）：默认档=压档前的 0.65 倍；旋钮拉满 1.5×0.65≈0.975≈旧强度。
 * 三层提亮（bloom 动态放大/闪白幅度/全场脉冲 uPulseBright）共用此缩放，系数只写这一处 */
export const CLIMAX_DAMP = 0.65
export const climaxScale = (climaxBrightness: number): number => CLIMAX_DAMP * climaxBrightness
