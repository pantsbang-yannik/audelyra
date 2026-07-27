// 镜头运镜设置（Phase D）：调音台「镜头」tab 的旋钮，electron settings.camera 字段持久化。
// liveliness 只乘新运镜手法（环绕/FOV 冲击/drop 拉远），不碰呼吸/漂移/微震——它们已有 calm 门控，双重缩放会语义混乱（spec §6）。
// distScale 是站位远近的个人偏好：等比缩放所有机位距离，机位间比例关系/呼吸幅度自然跟随。
export interface CameraSettings {
  liveliness: number // 运镜活跃度：0=纪录片式（新手法全关），1=设计默认，2=MV 式双倍
  distScale: number // 默认距离倍率：0.5=钻进粒子云里，1=设计默认，3=远眺全景（钳位/滚轮窗口随倍率等比缩放）
}

// 发布默认（发布准备① 用户终稿定调）：远机位低活跃——首印象求稳，爱动的用户自己往上调
export const DEFAULT_CAMERA_SETTINGS: CameraSettings = { liveliness: 0.3, distScale: 1.5 }

/** 滑块量程单一事实源：sanitize 与调音台共用，防两处数字漂移（惯例同 MOTION_LIMITS） */
export const CAMERA_LIMITS = {
  liveliness: { min: 0, max: 2, step: 0.05 },
  distScale: { min: 0.5, max: 3, step: 0.05 },
} as const

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

/** 坏数据回默认/出界钳限幅，惯例同 sanitizeMotionSettings */
export function sanitizeCameraSettings(raw: unknown): CameraSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_CAMERA_SETTINGS
  const L = CAMERA_LIMITS
  return {
    liveliness: num(r.liveliness, d.liveliness, L.liveliness.min, L.liveliness.max),
    distScale: num(r.distScale, d.distScale, L.distScale.min, L.distScale.max),
  }
}
