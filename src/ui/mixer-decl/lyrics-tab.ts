// 歌词歌名 tab 声明表（mixer v2 契约化）：文案/量程与原 buildLyricsSection 逐字一致。
// 两 draft（title/lyrics）各一张表，渲染时 lyrics 批传 continued=true 保组间分隔线。
import {
  TITLE_SCALE_MIN, TITLE_SCALE_MAX, TITLE_BRIGHTNESS_MIN, TITLE_BRIGHTNESS_MAX,
  POS_Y_MAX, POSITION_SNAP_NODES, snapToNodes, type TitleSettings,
} from '../../scenes/nebula/title-fx'
import {
  LYRICS_SCALE_MIN, LYRICS_SCALE_MAX, LYRICS_BRIGHTNESS_MIN, LYRICS_BRIGHTNESS_MAX,
  LYRICS_DYNAMICS_GAIN_MIN, LYRICS_DYNAMICS_GAIN_MAX, type LyricsSettings,
} from '../../scenes/nebula/lyrics/lyrics-fx'
import type { MixerSectionDef } from '../mixer-schema'

export const TITLE_SECTIONS: Array<MixerSectionDef<TitleSettings>> = [{
  title: '粒子歌名',
  desc: '切歌时的粒子拼字（不是左下角的歌名角标）',
  controls: [
    {
      kind: 'choice', label: '展示', help: '切歌时拼出歌名的展示方式',
      options: [{ text: '5秒', value: 'timed' }, { text: '常驻', value: 'always' }, { text: '关', value: 'off' }],
      get: (d) => d.mode, set: (d, v) => { d.mode = v as TitleSettings['mode'] },
    },
    {
      kind: 'range', label: '位置',
      help: '悬浮高度：负=下方、正=上方、0=画面中心；两端可能贴画面边缘，拖动实时看效果',
      min: -POS_Y_MAX, max: POS_Y_MAX, step: 0.01, snap: snapToNodes, ticks: POSITION_SNAP_NODES,
      get: (d) => d.position, set: (d, v) => { d.position = v },
    },
    {
      kind: 'range', label: '大小', min: TITLE_SCALE_MIN, max: TITLE_SCALE_MAX, step: 0.05,
      get: (d) => d.scale, set: (d, v) => { d.scale = v },
    },
    {
      kind: 'range', label: '亮度', min: TITLE_BRIGHTNESS_MIN, max: TITLE_BRIGHTNESS_MAX, step: 0.05,
      get: (d) => d.brightness, set: (d, v) => { d.brightness = v },
    },
  ],
}]

export const LYRICS_SECTIONS: Array<MixerSectionDef<LyricsSettings>> = [{
  title: '歌词',
  desc: '逐行同步歌词（需要系统正在播放且抓得到词）',
  controls: [
    {
      kind: 'toggle', label: '显示', help: '关 = 不抓词不联网，整条歌词链路休眠；重新打开从下一首歌生效',
      get: (d) => d.enabled, set: (d, v) => { d.enabled = v },
    },
    {
      kind: 'range', label: '位置', help: '悬浮高度：负=下方、正=上方、0=画面中心；调低可避开主形状遮挡',
      min: -POS_Y_MAX, max: POS_Y_MAX, step: 0.01, snap: snapToNodes, ticks: POSITION_SNAP_NODES,
      get: (d) => d.position, set: (d, v) => { d.position = v },
    },
    {
      kind: 'range', label: '大小', min: LYRICS_SCALE_MIN, max: LYRICS_SCALE_MAX, step: 0.05,
      get: (d) => d.scale, set: (d, v) => { d.scale = v },
    },
    {
      kind: 'toggle', label: '节奏动态', help: '歌词跟着音乐呼吸、鼓点闪烁、爆点冲击；关 = 纯静态逐行拼字',
      get: (d) => d.dynamics, set: (d, v) => { d.dynamics = v },
    },
    {
      kind: 'range', label: '动态强度', help: '节奏三层动效的整体幅度；0≈纯静态，1=标准，调低可提高可读性',
      min: LYRICS_DYNAMICS_GAIN_MIN, max: LYRICS_DYNAMICS_GAIN_MAX, step: 0.05,
      get: (d) => d.dynamicsGain, set: (d, v) => { d.dynamicsGain = v },
    },
    {
      kind: 'range', label: '亮度', min: LYRICS_BRIGHTNESS_MIN, max: LYRICS_BRIGHTNESS_MAX, step: 0.05,
      get: (d) => d.brightness, set: (d, v) => { d.brightness = v },
    },
  ],
}]
