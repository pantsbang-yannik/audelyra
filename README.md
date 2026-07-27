# Audelyra — 让声音显形

> Audelyra turns whatever is playing on your Mac into a living particle nebula.

Audelyra 是一款 macOS 音乐可视化应用：监听系统正在播放的任何音乐（Apple Music、网易云、浏览器……），实时化作会呼吸的粒子星云——不挑播放器，不用导入，放歌即显形。

https://github.com/user-attachments/assets/f387edf0-d041-4885-85bf-46f9fe34e4f1

## 功能

- **实时可视化**：系统音频实时特征提取（响度/节拍/能量叙事）驱动粒子星云，WebGPU 渲染
- **歌词粒子**：自动识别正在播放的歌，歌词以粒子形态融入画面（可一键关闭，关闭后歌词服务零网络请求）
- **形状**：内置形状 + 拖入图片/输入文字生成自定义粒子形状
- **本地播放**：拖入本地音频多首连播（队列/循环/标签/封面/歌词），无损接入同一套可视化
- **星系图鉴**：听歌历史长成你的专属星系——每首听过的歌是一颗星，听得越多越亮
- **星图海报 & Drop 回放**：一键把此刻的画面拍成海报（⌘⇧S），或导出最近 5 秒的动图回放（⌘⇧R）

## 运行

**要求**：macOS + Node.js ≥ 20 + [Homebrew](https://brew.sh)

```bash
brew install media-control   # 读取「正在播放」元数据（歌名/歌手/封面）
npm install
npm run dev
```

首次运行需授权**系统音频录制**权限（用于监听正在播放的音频，音频数据不出本机）。

## 隐私

- 音频捕获、特征提取、听歌历史全部在本机完成，**音频数据与听歌记录绝不上传**
- 应用仅有两类主动网络请求，且都不携带任何个人标识：
  1. **歌词查询**（lrclib.net / music.163.com）——设置中可一键关闭，关闭后零请求
  2. **更新检查**（GitHub / jsDelivr 上的静态 `latest.json`，纯 GET）——设置中可关闭

常用脚本：`npm run test`（全量测试）/ `npm run build`（打包构建）。

## 安装（分发版）

系统要求：Apple Silicon Mac，macOS 14.2 及以上。

1. 打开 DMG，把 Audelyra 拖入「应用程序」，双击启动（应用已经过 Apple 公证）
2. 首次可视化系统音频时，按系统弹窗授权「系统音频录制」；错过弹窗可到
   系统设置 → 隐私与安全性 → 系统音频录制 中手动开启

## 技术栈一瞥

Electron · three.js（WebGPU/TSL）· meyda（音频特征）· WebCodecs（回放硬编码）· 原生 Swift 音频 tap

渲染层技术探针笔记（three.js WebGPU/TSL 实战坑清单等）见 [docs/tech-notes/](docs/tech-notes/)。

## 免责声明

Audelyra 是独立项目，与 Apple、LRCLIB、网易云音乐及任何音乐平台**无隶属、授权或合作关系**。歌词数据来自 LRCLIB 与网易云音乐的公开接口，仅用于向用户实时展示其正在播放歌曲的歌词，本地缓存、不作任何再分发；该功能可在设置中完全关闭。所有商标归其各自所有者。

## 第三方声明

内置形状点云烘焙自 Sketchfab 上的 CC-BY-4.0 模型（心脏、留声机、卡带、耳机、麦克风），序幕配乐为 *Neonscapes* by e s c p（CC-BY-4.0）；「正在播放」元数据读取依赖 [media-control](https://github.com/ungive/media-control)（BSD-3-Clause，vendored 随包分发）。

完整署名与协议清单见 [NOTICE.md](NOTICE.md)，应用内「关于」面板亦有展示。

## 致谢

- 感谢 [LRCLIB](https://lrclib.net) 提供开放的歌词数据服务

## 许可

代码以 **[GPL-3.0](LICENSE)** 协议开源。

**附加许可（GPL §7 additional permission）**：作为版权持有人，特此额外允许本程序与 [GSAP](https://gsap.com)（依其 Standard License 分发）链接并组合分发，组合作品中 GSAP 部分不受 GPL 条款约束。

**商标声明**：GPL 协议仅覆盖代码。「Audelyra」名称与应用图标/标识**保留所有权利**——fork 与再分发的版本请使用自己的名称与图标，不得暗示与本项目官方相关。

## English

**Audelyra** is a macOS music visualizer that turns whatever is playing on your Mac — Apple Music, Spotify, browser, anything — into a living particle nebula in real time. No importing, no player lock-in: just play music and watch it take shape. Features include lyric particles, custom shapes from your own images/text, local playback, a personal "galaxy" grown from your listening history, and one-key poster/replay export.

Built with Electron, three.js (WebGPU/TSL), meyda, WebCodecs, and a native Swift audio tap. Requires an Apple Silicon Mac on macOS 14.2+. To run from source: `brew install media-control && npm install && npm run dev` (Node.js ≥ 20).

**Privacy**: audio capture and analysis never leave your machine. The only network requests are lyrics lookup and update checks — both anonymous and both can be turned off in settings.

Licensed under [GPL-3.0](LICENSE) (with a GSAP linking exception). The "Audelyra" name and logo are not covered by the license — all rights reserved. Audelyra is an independent project, not affiliated with any music platform; see [NOTICE.md](NOTICE.md) for third-party attributions and disclaimers.
