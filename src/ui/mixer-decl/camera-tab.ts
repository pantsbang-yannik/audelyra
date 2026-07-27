// 镜头 tab 声明表（mixer v2 契约化）：文案/量程与原 buildCameraSection 硬编码逐字一致，
// 量程唯一事实源仍是 CAMERA_LIMITS（只引用不复制）。
import { CAMERA_LIMITS, type CameraSettings } from '../../scenes/nebula/camera-types'
import type { MixerSectionDef } from '../mixer-schema'

export const CAMERA_SECTIONS: Array<MixerSectionDef<CameraSettings>> = [{
  title: '镜头',
  desc: '自动运镜的手感：站位远近、环绕、重拍冲击、爆发拉远',
  controls: [
    {
      kind: 'range', label: '运镜活跃度',
      help: '左=纪录片式沉稳（环绕/冲击/拉远全关），右=MV 式活跃；不影响呼吸与手持漂移',
      min: CAMERA_LIMITS.liveliness.min, max: CAMERA_LIMITS.liveliness.max, step: CAMERA_LIMITS.liveliness.step,
      get: (d) => d.liveliness, set: (d, v) => { d.liveliness = v },
    },
    {
      kind: 'range', label: '默认距离',
      help: '镜头站位的远近偏好：左=贴近细看，右=远观全貌（所有机位等比缩放，滚轮临时缩放不受影响）',
      min: CAMERA_LIMITS.distScale.min, max: CAMERA_LIMITS.distScale.max, step: CAMERA_LIMITS.distScale.step,
      get: (d) => d.distScale, set: (d, v) => { d.distScale = v },
    },
  ],
}]
