// 背景 tab 声明表（mixer v2 契约化）：文案/量程/data-role 与原 buildBackgroundSection 逐字一致。
// 互斥语义（自定义背景 v1 spec §二）：current!=='aurora' 时水镜组置灰、反之自定义组置灰——
// 恰有一组可调，由两组相反的 lockWhen 表达。
import { BACKGROUND_LIMITS, type BackgroundSettings } from '../../scenes/nebula/background-types'
import type { MixerSectionDef, RangeControlDef } from '../mixer-schema'

const range = (
  key: 'aurora' | 'ripple' | 'bgOpacity' | 'bgSaturation' | 'dust' | 'dustSize' | 'dustBright',
  label: string, help: string,
): RangeControlDef<BackgroundSettings> => ({
  kind: 'range', label, help,
  min: BACKGROUND_LIMITS[key].min, max: BACKGROUND_LIMITS[key].max, step: BACKGROUND_LIMITS[key].step,
  get: (d) => d[key], set: (d, v) => { d[key] = v },
})

export const BACKGROUND_SECTIONS: Array<MixerSectionDef<BackgroundSettings>> = [
  {
    title: '深空水镜', desc: '极光天空与镜面涟漪的强度；任一滑到 0 即完全关闭该效果',
    rowRole: 'bg-fx-row',
    lockWhen: (d) => d.current !== 'aurora',
    lockedNote: '使用自定义背景中——切回「星空极光」后可调', noteRole: 'bg-locked-note',
    controls: [
      range('aurora', '极光强度', '天空极光的亮度与呼吸幅度；0=近黑深空（星野保留）'),
      range('ripple', '涟漪强度', '重拍敲在镜面上的涟漪；只响应强拍，0=永不起圈'),
      {
        kind: 'toggle', label: '镜面', help: '地面镜面与拍点涟漪圈的总开关；部分形状关闭更空灵',
        get: (d) => d.mirror, set: (d, v) => { d.mirror = v },
      },
    ],
  },
  {
    title: '自定义背景', desc: '上传图片/视频背景的观感调节；选中自定义背景后可调',
    rowRole: 'bg-custom-row',
    lockWhen: (d) => d.current === 'aurora',
    lockedNote: '上传并选中自定义背景后可调', noteRole: 'bg-custom-note',
    controls: [
      range('bgOpacity', '透明度', '往纯黑底压暗背景；1=原样、0=全黑。素材过亮时调低，保主体与歌词可读'),
      range('bgSaturation', '饱和度', '背景色彩浓度；0=黑白'),
      {
        kind: 'toggle', label: '呼吸', help: '背景随音乐响度轻微明暗起伏；关=纯静态',
        get: (d) => d.bgBreathe, set: (d, v) => { d.bgBreathe = v },
      },
    ],
  },
  {
    title: '尘埃', desc: '漂浮星尘的密度/大小/亮度；密度 0=只剩零星点缀',
    controls: [
      range('dust', '尘埃密度', '漂浮星尘的数量；鼓点会让星尘加速掠过，0=只剩零星点缀'),
      range('dustSize', '尘埃大小', '每颗星尘的粒径倍率；调大后星尘更醒目'),
      range('dustBright', '尘埃亮度', '星尘的发光强度；量程有安全上限，拉满不至于抢主体的戏'),
    ],
  },
]
