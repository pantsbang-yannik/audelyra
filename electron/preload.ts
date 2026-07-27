import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('audelyra', {
  onPcmFrame(cb: (frame: { sampleRate: number; channels: number; samples: Float32Array }) => void) {
    ipcRenderer.on('capture:pcm', (_e, msg) => {
      const buf: Uint8Array = msg.pcm
      cb({
        sampleRate: msg.sampleRate,
        channels: msg.channels,
        samples: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      })
    })
  },
  onCaptureStatus(cb: (s: 'running' | 'unavailable') => void) {
    ipcRenderer.on('capture:status', (_e, s) => cb(s))
  },
  onTrack(
    cb: (
      t:
        | { kind: 'change'; title: string; artist: string; artworkDataUrl: string | null }
        | { kind: 'unknown' }
    ) => void
  ) {
    ipcRenderer.on('track', (_e, t) => cb(t))
  },
  onProgress(
    cb: (p: { elapsedTime: number; duration: number | null; playbackRate: number; playing: boolean }) => void
  ) {
    ipcRenderer.on('progress', (_e, p) => cb(p))
  },
  onLyrics(
    cb: (
      d:
        | { key: string; lines: Array<{ t: number; text: string }> }
        | { key: string; none: true }
    ) => void
  ) {
    ipcRenderer.on('lyrics', (_e, d) => cb(d))
  },
  // 启动补发握手（#歌词冷启动）：did-finish-load ≠ 渲染层订阅就绪（boot 内 await 造成空窗，
  // 缓存命中的歌词会瞬发落空且同曲不重发）——渲染层三订阅挂完后报到，主进程此刻才补发缓存快照
  rendererReady() {
    ipcRenderer.send('renderer:ready')
  },
  // 星图海报（idea #6）：invoke 带回执（对齐 shapes:getAsset 二进制 req/resp 先例）——
  // 渲染层 await 结果做闪白/报错；写盘与系统通知在主进程
  savePoster(filename: string, png: Uint8Array): Promise<{ ok: boolean; path: string }> {
    return ipcRenderer.invoke('poster:save', { filename, png })
  },
  // 轻提示点击→Finder 定位（fb5；主进程只放行下载夹内路径）
  revealPoster(path: string) {
    ipcRenderer.send('poster:reveal', path)
  },
  // Drop 回放动图（idea #8）：与 savePoster 同款 invoke 回执；Finder 定位复用 revealPoster
  saveClip(filename: string, mp4: Uint8Array): Promise<{ ok: boolean; path: string }> {
    return ipcRenderer.invoke('clip:save', { filename, mp4 })
  },
  // 星系图鉴（idea #4）：播放历史 + 缩略封面读取（invoke 对齐 shapes:getAsset 先例）
  readHistory(): Promise<Array<{ title: string; artist: string; duration: number | null; listenedSeconds: number; endedAt: string; artworkKey: string | null }>> {
    return ipcRenderer.invoke('history:read')
  },
  readHistoryArtwork(key: string): Promise<Uint8Array | null> {
    return ipcRenderer.invoke('history:artwork', key)
  },
  // 本地音频 V2：本地播放报历史（fire-and-forget send，同 settings:set 先例）
  localTrackChange(p: { title: string; artist: string; duration: number | null; coverBytes: Uint8Array | null; coverMime: string | null }) {
    ipcRenderer.send('localHistory:track', p)
  },
  localTrackStop() {
    ipcRenderer.send('localHistory:stop')
  },
  localProgress(playing: boolean) {
    ipcRenderer.send('localHistory:progress', playing)
  },
  // 本地音频 V2：标签查词（invoke 回执，同 history:read 先例）
  lookupLyrics(title: string, artist: string, duration: number | null) {
    return ipcRenderer.invoke('lyrics:lookup', { title, artist, duration })
  },
  // ===== 更新体系 v1（发布准备②）：主进程推决策，渲染层呈现 + 回传动作 =====
  onUpdateStatus(
    cb: (
      d:
        | { kind: 'optional' | 'forced'; manual: boolean; manifest: { version: string; minVersion: string; publishedAt: string | null; notes: string | null; downloadUrl: string; mirrorUrl: string | null } }
        | { kind: 'none' | 'unreachable'; manual: true }
    ) => void
  ) {
    ipcRenderer.on('update:status', (_e, d) => cb(d))
  },
  openUpdateDownload(url: string) {
    ipcRenderer.send('update:openDownload', url)
  },
  skipUpdate(version: string) {
    ipcRenderer.send('update:skip', version)
  },
  // 设置面板版本行（fb1）：版本号展示 + 手动检查（与托盘同语义，结果经 update:status 回流）
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:getVersion')
  },
  checkUpdate() {
    ipcRenderer.send('update:check')
  },
  // ===== 导出诊断（发布准备③）：本地文本报告落下载夹，用户主动点击才产出（零上报）=====
  exportDiagnostics(): Promise<{ ok: boolean; path: string }> {
    return ipcRenderer.invoke('diagnostics:export')
  },
  // 渲染层诊断事件上行（WebGPU 初始化失败/未捕获错误）：fire-and-forget，同 settings:set 先例
  logDiag(source: string, message: string) {
    ipcRenderer.send('diag:event', { source, message })
  },
  // ===== M4 壳层通道（设置/窗口形态，M4 设计 2.4）=====
  getSettings() {
    return ipcRenderer.invoke('settings:get')
  },
  setSettings(patch: Record<string, unknown>) {
    ipcRenderer.send('settings:set', patch)
  },
  onSettingsChanged(cb: (s: Record<string, unknown>) => void) {
    ipcRenderer.on('settings:changed', (_e, s) => cb(s))
  },
  // mapping 预览/落盘双通道（Task 8）：preview 绕开 settings:set，只广播不落盘；commit 复用 settings:set 落盘
  previewMapping(m: unknown) {
    ipcRenderer.send('mapping:preview', m)
  },
  commitMapping(m: unknown) {
    ipcRenderer.send('settings:set', { mapping: m })
  },
  onMappingChanged(cb: (m: unknown) => void) {
    ipcRenderer.on('mapping:preview', (_e, m) => cb(m))
  },
  // motion 预览/落盘双通道（Phase C2 T1）：镜像 mapping 三行写法
  previewMotion(m: unknown) {
    ipcRenderer.send('motion:preview', m)
  },
  commitMotion(m: unknown) {
    ipcRenderer.send('settings:set', { motion: m })
  },
  onMotionChanged(cb: (m: unknown) => void) {
    ipcRenderer.on('motion:preview', (_e, m) => cb(m))
  },
  // camera 预览/落盘双通道（Phase D）：镜像 motion 三行写法
  previewCamera(c: unknown) {
    ipcRenderer.send('camera:preview', c)
  },
  commitCamera(c: unknown) {
    ipcRenderer.send('settings:set', { camera: c })
  },
  onCameraChanged(cb: (c: unknown) => void) {
    ipcRenderer.on('camera:preview', (_e, c) => cb(c))
  },
  getWindowMode() {
    return ipcRenderer.invoke('window:getMode')
  },
  setWindowMode(m: 'fullscreen' | 'windowed') {
    ipcRenderer.send('window:setMode', m)
  },
  onWindowMode(cb: (m: 'fullscreen' | 'windowed') => void) {
    ipcRenderer.on('window:mode', (_e, m) => cb(m))
  },
  onOpenSettingsRequest(cb: () => void) {
    ipcRenderer.on('ui:openSettings', () => cb())
  },
  // ===== 模态仲裁 / 捕获重启 / 系统设置深链（M4 计划② T3）=====
  setModalOpen(open: boolean) {
    ipcRenderer.send('ui:modalOpen', open)
  },
  restartCapture() {
    ipcRenderer.send('capture:restart')
  },
  openAudioCapturePrefs() {
    ipcRenderer.send('system:openAudioPrefs')
  },
  getShapeAsset(id: string): Promise<Uint8Array> {
    return ipcRenderer.invoke('shapes:getAsset', id) // 白名单校验在主进程 shape-assets（序幕形体已入列）
  },
  saveCustomShape(id: string, png: Uint8Array): Promise<void> {
    return ipcRenderer.invoke('customShapes:save', { id, png })
  },
  readCustomShape(id: string): Promise<Uint8Array> {
    return ipcRenderer.invoke('customShapes:read', id)
  },
  deleteCustomShape(id: string): Promise<void> {
    return ipcRenderer.invoke('customShapes:delete', id)
  },
  convertImageToPng(bytes: Uint8Array): Promise<Uint8Array> {
    return ipcRenderer.invoke('customShapes:convert', bytes)
  },
  saveCustomBackground(id: string, jpeg: Uint8Array): Promise<void> {
    return ipcRenderer.invoke('customBackgrounds:save', { id, jpeg })
  },
  readCustomBackground(id: string): Promise<Uint8Array> {
    return ipcRenderer.invoke('customBackgrounds:read', id)
  },
  deleteCustomBackground(id: string): Promise<void> {
    return ipcRenderer.invoke('customBackgrounds:delete', id)
  },
  saveCustomBackgroundVideo(id: string, path: string): Promise<void> {
    return ipcRenderer.invoke('customBackgrounds:saveVideo', { id, path })
  },
  saveCustomBackgroundThumb(id: string, jpeg: Uint8Array): Promise<void> {
    return ipcRenderer.invoke('customBackgrounds:saveThumb', { id, jpeg })
  },
  readCustomBackgroundThumb(id: string): Promise<Uint8Array> {
    return ipcRenderer.invoke('customBackgrounds:readThumb', id)
  },
  // 拖入文件 → 真实路径（webUtils，Electron 32+）：视频 500MB 走路径直拷，绝不整包过 IPC
  getPathForFile(f: File): string {
    return webUtils.getPathForFile(f)
  },
  // 性能基准（性能基线）：仅 dev 主进程注册对应 handler，打包版调用会 reject
  perfGetEnv() {
    return ipcRenderer.invoke('perf:getEnv')
  },
  perfStandardizeWindow() {
    return ipcRenderer.invoke('perf:standardizeWindow')
  },
  perfRestoreWindow(size: { w: number; h: number }) {
    return ipcRenderer.invoke('perf:restoreWindow', size)
  },
  perfGetStartupMarks() {
    return ipcRenderer.invoke('perf:getStartupMarks')
  }
})
