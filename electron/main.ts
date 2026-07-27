import { app, BrowserWindow, ipcMain, nativeImage, powerSaveBlocker, protocol, shell } from 'electron'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { DiagnosticsLog, renderDiagnostics, redactSettings, type DiagFileStat } from './diagnostics'
import { resolveCustomBackgroundFile, parseByteRange } from './custom-backgrounds'
import { startMacTap, type MacTapEvents } from './capture/mac-tap'
import { startMacNowPlaying, resolveBinary } from './nowplaying/mac'
import { resolveArtworkMime } from './nowplaying/artwork'
import { SettingsStore, type AudelyraSettings, type WinBounds } from './settings'
import { WindowManager, type WinAdapter } from './windows'
import { createTray } from './tray'
import { applySettingsEffects } from './effects'
import { wireIpc } from './ipc'
import { LyricsService } from './lyrics/service'
import { createProgressPoller, readNowPlayingOnce, POLL_INTERVAL_MS } from './lyrics/poller'
import { HistoryTracker, appendPlayRecord, artworkKeyFor } from './history'
import { UpdateChecker, startUpdateSchedule } from './update/checker'
import { decideUpdate, reduceDecision, canOpenUrl, settleSkip, type ActiveDecision } from './update/protocol'
import { localChangeEventFrom } from './local-history'
import { ageProgress, type PlaybackProgress } from './nowplaying/progress'
import type { TrackMeta } from './nowplaying/types'
import { collectPerfEnv } from './perf-env'

/** 封面 128px 缩略落盘（idea 批0）：nativeImage 薄壳留在接线侧，history.ts 纯逻辑零 electron 依赖。
 * 已存在跳过=按歌去重；解码失败/写失败只 warn 不阻断（封面是增强不是主体） */
function saveArtworkThumb(dir: string, meta: TrackMeta): string | null {
  if (!meta.artworkPng) return null
  const key = artworkKeyFor(meta.title, meta.artist)
  const file = join(dir, key)
  if (existsSync(file)) return key
  try {
    const img = nativeImage.createFromBuffer(meta.artworkPng)
    if (img.isEmpty()) return null // HEIC 等 nativeImage 解不了的格式：无缩略，记录仍落
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, img.resize({ width: 128 }).toJPEG(80))
    return key
  } catch (err) {
    console.warn('[history] 封面缩略失败', err)
    diagLog.push('warn', 'history', `封面缩略失败: ${String(err)}`)
    return null
  }
}

/** 优先信任系统上报的封面 MIME，未上报时才按魔数兜底嗅探（见 nowplaying/artwork.ts） */
function artworkToDataUrl(bytes: Buffer, reportedMime: string | null): string {
  const mime = resolveArtworkMime(bytes, reportedMime)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

let win: BrowserWindow | null = null
let quitting = false

// 启动里程碑（性能基线）：timeOrigin 只覆盖 renderer 导航之后，
// 主进程启动/建窗这两段必须在主进程侧打点，经 IPC 下发给渲染层拼接
const perfProcessStartMs = performance.now()
let perfWindowCreatedMs = 0

// 导出诊断（发布准备③）：环形事件日志，纯内存零落盘；模块级单例——saveArtworkThumb 等
// app.whenReady 之外的函数也要埋点
const diagLog = new DiagnosticsLog()

function createWindow(bounds: WinBounds | null): BrowserWindow {
  const win = new BrowserWindow({
    // 亲验 fb7：启动普通窗（推翻 M4「启动即全屏沉浸」拍板）；有记忆按记忆恢复大小与位置
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    frame: false, // 两态形态统一无边框（frameless 只能创建时定，M4 设计第 4 节）
    // 亲验 fb7 要普通窗启动 → 靠"不传 fullscreen"实现（默认即 false）。
    // 铁律（fb3 探针实锤）：绝不显式写 fullscreen:false——macOS 上 Electron 会把它理解成
    // fullscreenable=false，setFullScreen(true) 永久无效（fb2/fb3「点不了全屏」的真根因）
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // 被遮挡继续渲染；降载走渲染层主动策略（母设计第 6 节）
      devTools: !app.isPackaged // 生产包禁开发者工具（防翻源码/改状态）
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    // 性能基线便利：AUDELYRA_PERF=1（npm run dev:perf）时启动直落 #perf 入口，免去手动改 hash。
    // 仅 dev（loadURL 分支）生效；打包版无此环境变量，不受影响
    const perfHash = process.env['AUDELYRA_PERF'] === '1' ? '#perf' : ''
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + perfHash)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  perfWindowCreatedMs = performance.now()
  return win
}

/** 窗口可能已关闭/销毁（macOS 关窗后 app 留在 Dock），发送前必须守卫 */
function sendToRenderer(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function createWinAdapter(w: BrowserWindow): WinAdapter {
  return {
    isFullScreen: () => w.isFullScreen(),
    setFullScreen: (on) => w.setFullScreen(on),
    onLeaveFullScreen: (cb) => { w.on('leave-full-screen', cb) },
    onEnterFullScreen: (cb) => { w.on('enter-full-screen', cb) },
    setAlwaysOnTop: (on) => w.setAlwaysOnTop(on, 'floating'),
    setResizable: (on) => w.setResizable(on),
    setSize: (width, height) => w.setSize(width, height, true),
    setPosition: (x, y) => w.setPosition(x, y),
    center: () => w.center(),
    show: () => w.show(),
    hide: () => w.hide(),
    isVisible: () => w.isVisible()
  }
}

// 视频背景流式协议（v2 spec §二路线A）：scheme 特权注册必须先于 app ready；
// stream 特权是 <video> 走 fetch 型自定义协议的前提
// standard+secure 缺一不可（亲验黑屏第二根因）：非 standard 的自定义 scheme 在渲染层不被当
// 正经资源源，<video> 判 SRC_NOT_SUPPORTED、fetch 直接 Failed——仅 stream:true 不够
protocol.registerSchemesAsPrivileged([
  { scheme: 'audelyra-bg', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
])

app.whenReady().then(() => {
  // store 提前到建窗之前（亲验 fb7）：普通窗启动要在创建时就恢复记忆的 bounds，免得先默认后跳位
  const store = new SettingsStore(join(app.getPath('userData'), 'settings.json'))

  // audelyra-bg://<uuid> → userData/backgrounds/ 流式读（图片/视频通吃；v1 的 IPC 字节路线不动）。
  // uuid 白名单在 resolve 内（非法/缺文件回 null → 404）。range 语义手工实现（亲验黑屏根治）：
  // net.fetch(file://) 会无视 Range 头回 200 无长度流，mp4 在媒体栈直接判 SRC_NOT_SUPPORTED——
  // 必须 stat 出总长、按 parseByteRange 回 206+Content-Range，fs 流切片零内存过手
  const backgroundsDir = join(app.getPath('userData'), 'backgrounds')
  protocol.handle('audelyra-bg', async (req) => {
    try {
      const id = new URL(req.url).hostname
      const f = await resolveCustomBackgroundFile(backgroundsDir, id)
      if (!f) return new Response('not found', { status: 404 })
      const size = (await stat(f.path)).size
      const r = parseByteRange(req.headers.get('range'), size)
      const body = Readable.toWeb(
        createReadStream(f.path, r ? { start: r.start, end: r.end } : {})
      ) as unknown as ReadableStream
      // ACAO 必带（亲验黑屏第三根因）：协议对页面是跨源，无 CORS 头则媒体被 taint——能播但
      // VideoFrame/canvas 抽帧全被 SecurityError 拒（配渲染层 crossOrigin='anonymous' 成对生效）
      if (!r) {
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': f.contentType, 'content-length': String(size),
            'accept-ranges': 'bytes', 'access-control-allow-origin': '*',
          },
        })
      }
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': f.contentType,
          'content-length': String(r.end - r.start + 1),
          'content-range': `bytes ${r.start}-${r.end}/${size}`,
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
        },
      })
    } catch (e) {
      // resolve/stat/流建立之间文件被删等意外——不吃异常，留日志否则打包版排障无从下手
      console.warn('[audelyra-bg] 协议请求失败', e)
      return new Response('error', { status: 500 })
    }
  })

  win = createWindow(store.get().winBounds)
  win.on('closed', () => {
    win = null
  })
  // 托盘常驻：点关闭是隐藏不是退出（真正退出走托盘菜单/Cmd+Q）
  win.on('close', (e) => {
    if (quitting || !win) return
    e.preventDefault()
    win.hide()
  })
  app.on('before-quit', () => {
    quitting = true
  })

  // ===== M4 壳层装配（设置 → 窗口 → 托盘 → IPC → 副作用；store 已在建窗前创建，fb7）=====
  let trayRef: { refresh: () => void; destroy: () => void } | null = null // createTray 后赋值（wm 回调先于 tray 创建，避免 TDZ）
  let manualUpdateCheck: () => void = () => {} // 更新装配块内赋真值（restartTap 同款前向引用）
  const wm = new WindowManager(
    createWinAdapter(win),
    () => store.get().winBounds,
    (m) => {
      sendToRenderer('window:mode', m)
      trayRef?.refresh()
    }
  )
  trayRef = createTray(() => wm.getMode(), {
    onShowHide: () => wm.toggleVisible(),
    onFullscreen: () => wm.setMode('fullscreen'),
    onWindowed: () => wm.setMode('windowed'),
    onSettings: () => {
      win?.show()
      // 乐观置位堵 Esc 竞态窗口：打开请求发自主进程，等渲染层 setModalOpen 回报会留几毫秒空窗；
      // 若实际是 toggle 关闭，渲染层的 setModalOpen(false) 随后校正，期间 Esc 被忽略无害
      uiModalOpen = true
      sendToRenderer('ui:openSettings', null)
    },
    onCheckUpdate: () => {
      win?.show() // 结果经渲染层 UI 呈现，窗口藏着会看不到反馈
      manualUpdateCheck()
    },
    onQuit: () => app.quit()
  })
  let uiModalOpen = false
  let restartTap: () => void = () => {} // darwin 块内赋真值（捕获段在装配之后）
  // 普通窗大小/位置记忆：resized（边缘拖拽调整大小结束）+ moved（OS 原生拖拽条移窗完成）都落盘；
  // 两者都是低频的"动作结束"事件（不同于已退役的手动拖拽泵按 16ms 一帧程序化 setPosition 的高频写场景），
  // set() 的无变化短路足以兜住重复调用
  const persistWinBounds = (): void => {
    if (!win || win.isDestroyed() || wm.getMode() !== 'windowed') return
    const [width, height] = win.getSize()
    const [x, y] = win.getPosition()
    store.set({ winBounds: { x, y, width, height } }) // set 无变化短路，重复调用零成本
  }
  win.on('resized', persistWinBounds)
  win.on('moved', persistWinBounds)
  // ===== 导出诊断（发布准备③）：报告拼装——环境/捕获状态/数据文件体检/设置快照/事件日志 =====
  // 隐私：全部字段零曲目数据；文件体检只报存在性与大小，不读内容
  let lastCaptureStatus = 'unknown'
  const userDataDir = app.getPath('userData')
  const fileStat = (rel: string): DiagFileStat => {
    const p = join(userDataDir, rel)
    try {
      if (!existsSync(p)) return { name: rel, exists: false, bytes: null, entries: null }
      const st = statSync(p)
      return st.isDirectory()
        ? { name: rel, exists: true, bytes: null, entries: readdirSync(p).length }
        : { name: rel, exists: true, bytes: st.size, entries: null }
    } catch {
      return { name: rel, exists: false, bytes: null, entries: null }
    }
  }
  const buildDiagnostics = (): string =>
    renderDiagnostics({
      env: {
        appVersion: app.getVersion(),
        os: `macOS ${process.getSystemVersion()} (${process.arch})`,
        runtime: `Electron ${process.versions.electron} / Chrome ${process.versions.chrome} / Node ${process.versions.node}`,
        locale: app.getLocale()
      },
      captureStatus: lastCaptureStatus,
      settings: redactSettings(store.get()), // 自定义文字形状原文脱敏（审②P1-4）
      files: ['settings.json', 'history/plays.jsonl', 'history/artwork', 'lyrics-cache', 'custom-shapes'].map(fileStat),
      log: diagLog.entries(),
      generatedAt: new Date(),
      homeDir: app.getPath('home') // 路径里的用户名缩写为 ~（审②P2-6）
    })

  wireIpc(store, wm, {
    setModalOpen: (open) => { uiModalOpen = open },
    restartCapture: () => restartTap(),
    openAudioPrefs: () => {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture')
    },
    buildDiagnostics,
    logDiag: (source, message) => diagLog.push('error', `renderer:${source}`, message)
  })

  // mapping 预览通道（Task 8，spec §7）：绕开 store.set，原样广播回渲染层——不 persist、不跑 applySettingsEffects。
  // wireIpc 内没有 sendToRenderer，故直接挂在这里复用本函数作用域内的实例
  ipcMain.on('mapping:preview', (_e, m) => sendToRenderer('mapping:preview', m))

  // motion 预览通道（Phase C2 T1）：与 mapping:preview 同样的窗口广播语义——不 persist、不跑 applySettingsEffects
  ipcMain.on('motion:preview', (_e, m) => sendToRenderer('motion:preview', m))

  // camera 预览通道（Phase D）：与 motion:preview 同样的窗口广播语义——不 persist、不跑 applySettingsEffects
  ipcMain.on('camera:preview', (_e, c) => sendToRenderer('camera:preview', c))

  // 渲染层 reload（dev ⌘R 或崩溃恢复）后主进程状态不残留：旧页面来不及发 setModalOpen(false) 就被换掉，
  // uiModalOpen 会卡在 reload 前一刻——did-start-loading 比 did-finish-load 更早，覆盖整个导航过程
  win.webContents.on('did-start-loading', () => {
    uiModalOpen = false
  })

  // Esc 退全屏 / ⌃⌘F 切全屏 / ⌘, 打开设置（主进程侧统一处理，渲染层无需监听键盘）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    // Esc 双响仲裁：before-input-event 先于渲染层收到按键，仲裁只靠这里的 uiModalOpen 门控——
    // 面板开着（uiModalOpen === true）时主进程不调用 handleEsc 直接让路；渲染层的 capture+stopPropagation
    // 不跨进程，只负责拦渲染层内部其它 keydown 监听器
    if (input.key === 'Escape' && !uiModalOpen) wm.handleEsc()
    // ⌃⌘F 是 macOS 原生全屏快捷键：preventDefault 拦下原生路径（会绕过状态机致 mode 脱钩），改走 WindowManager
    if (input.control && input.meta && input.key.toLowerCase() === 'f') {
      e.preventDefault()
      wm.toggleFullscreen()
    }
    // ⌘, 打开设置（macOS 惯例），与托盘「设置…」同一条通知通道
    if (input.meta && !input.control && input.key === ',') {
      e.preventDefault()
      win?.show()
      // 乐观置位堵 Esc 竞态窗口：打开请求发自主进程，等渲染层 setModalOpen 回报会留几毫秒空窗；
      // 若实际是 toggle 关闭，渲染层的 setModalOpen(false) 随后校正，期间 Esc 被忽略无害
      uiModalOpen = true
      sendToRenderer('ui:openSettings', null)
    }
  })

  // 设置副作用：启动全量应用一次 + 每次变更差异应用；广播给渲染层
  let blockerId: number | null = null
  const effectsDeps = {
    setLoginItem: (open: boolean) => app.setLoginItemSettings({ openAtLogin: open }),
    startPowerBlocker: () => powerSaveBlocker.start('prevent-display-sleep'),
    stopPowerBlocker: (id: number) => powerSaveBlocker.stop(id)
  }
  blockerId = applySettingsEffects(null, store.get(), blockerId, effectsDeps)
  let prevSettings: AudelyraSettings = store.get()
  store.subscribe((s) => {
    blockerId = applySettingsEffects(prevSettings, s, blockerId, effectsDeps)
    prevSettings = s
    sendToRenderer('settings:changed', s)
  })

  // ===== 更新体系 v1（发布准备② spec）：启动 15s + 每 24h 检查 latest.json，结果推渲染层 UI =====
  // 隐私：自动检查可被 updateCheck.enabled 关闭；手动检查（托盘）无视开关与 skip
  const updateChecker = new UpdateChecker()
  let lastUpdateDecision: ActiveDecision | null = null
  let updateCheckInFlight = false // 并发去重（审①M1）：只拦自动检查——手动必须有回音，宁可偶发双查也不静默吞点击（终审）
  const runUpdateCheck = async (manual: boolean): Promise<void> => {
    if (!manual && !store.get().updateCheck.enabled) return
    if (!manual && updateCheckInFlight) return
    updateCheckInFlight = true
    try {
      const manifest = await updateChecker.fetchManifest()
      const decision = decideUpdate(app.getVersion(), manifest, store.get().updateCheck.skippedVersion, manual)
      diagLog.push(manifest ? 'info' : 'warn', 'update', manifest ? `检查完成 kind=${decision.kind}${manual ? ' (手动)' : ''}` : '检查失败: latest.json 不可达')
      // 失败/none 不冲帐（审修 C1）：屏上未结算的卡片/阻断层按钮全指着这份记账，语义见 reduceDecision
      lastUpdateDecision = reduceDecision(lastUpdateDecision, decision)
      if (decision.kind !== 'none') sendToRenderer('update:status', { ...decision, manual })
      // 手动检查必须有回音（无更新/检查失败要区分，不然断网会谎报"已是最新"）；自动检查无事发生保持沉默
      else if (manual) sendToRenderer('update:status', { kind: manifest ? 'none' : 'unreachable', manual: true })
    } finally {
      updateCheckInFlight = false
    }
  }
  manualUpdateCheck = () => { void runUpdateCheck(true) }
  // 设置面板「检查更新」（fb1）：与托盘同一条手动语义（无视开关与 skip、必有回音）；窗口已在前台无需 show
  ipcMain.on('update:check', () => { void runUpdateCheck(true) })
  const stopUpdateSchedule = startUpdateSchedule(() => { void runUpdateCheck(false) })
  app.on('before-quit', stopUpdateSchedule)
  ipcMain.on('update:openDownload', (_e, url: unknown) => {
    const u = String(url ?? '')
    if (canOpenUrl(lastUpdateDecision, u)) void shell.openExternal(u)
  })
  ipcMain.on('update:skip', (_e, version: unknown) => {
    const settled = settleSkip(lastUpdateDecision, String(version ?? ''))
    if (settled === null) return
    store.set({ updateCheck: { ...store.get().updateCheck, skippedVersion: settled } })
    lastUpdateDecision = null // skip 是决策的唯一结算出口（reduceDecision 语义配套）
  })
  // 渲染层 reload 后补发未结算的决策（renderer:ready 握手先例；forced 尤其不能因 reload 丢失）
  ipcMain.on('renderer:ready', () => {
    if (lastUpdateDecision) sendToRenderer('update:status', { ...lastUpdateDecision, manual: false })
  })

  // ===== 以下捕获 + NowPlaying 段落 = 现 main.ts 45-79 行原样保留，不改任何行为 =====
  if (process.platform === 'darwin') {
    const tapEvents: MacTapEvents = {
      onHeader: () => {},
      onStatus: (s) => {
        if (s !== lastCaptureStatus) diagLog.push('info', 'capture', `状态: ${s}`) // 只记迁移，PCM 稳态不刷日志
        lastCaptureStatus = s
        sendToRenderer('capture:status', s)
      },
      onError: (msg) => diagLog.push('warn', 'capture', msg),
      onPcm: (chunk, header) => {
        // Buffer → 传输给渲染进程（结构化克隆，渲染侧按 Uint8Array 收）
        sendToRenderer('capture:pcm', {
          sampleRate: header.sampleRate,
          channels: header.channels,
          pcm: chunk
        })
      }
    }
    let stopTap = startMacTap(tapEvents)
    restartTap = () => {
      stopTap()
      stopTap = startMacTap(tapEvents)
    }
    // before-quit 挂箭头包装而非旧引用——restartCapture 会重新赋值 stopTap，直接挂旧引用会在重启后杀错代际
    app.on('before-quit', () => stopTap())

    // NowPlaying 首条快照可能早于渲染进程订阅（启动竞态），且通道按曲目去重不会重发——
    // 缓存最近事件，页面每次加载完成后补发，否则第一首歌永远收不到封面
    let lastTrackMsg: unknown = null
    // 进度同因补发（#歌词冷启动取证实锤）：中途冷启动时 stream 首帧 progress 先于渲染层加载发出即丢，
    // 稳态播放 stream 静默不再推——歌词进场被 position===null 卡住，最好情况也要等 5s 轮询兜底。
    // 缓存最近进度+时刻，补发前按缓存龄外推（ageProgress）；一切进度发送必须走 sendProgress 保缓存新鲜
    let lastProgressMsg: PlaybackProgress | null = null
    let lastProgressAtMs = 0
    const sendProgress = (p: PlaybackProgress): void => {
      lastProgressMsg = p
      lastProgressAtMs = Date.now()
      sendToRenderer('progress', p)
    }

    // ===== 播放历史（idea 批0）：有效聆听 ≥30s 静默落盘，纯本地零网络 =====
    // 只吃 stream 流（onEvent + stream onProgress，不受歌词门控）；poller 那条不喂——
    // stream 的 play/pause 转变事件已够暂停检测（计划评审第6条）
    const historyDir = join(app.getPath('userData'), 'history')
    const historyTracker = new HistoryTracker({
      now: () => Date.now(),
      onRecord: (r) => {
        try {
          appendPlayRecord(join(historyDir, 'plays.jsonl'), r)
        } catch (err) {
          console.warn('[history] 记录写盘失败', err) // 历史写盘失败不影响主流程
          diagLog.push('warn', 'history', `记录写盘失败: ${String(err)}`)
        }
      }
    })
    app.on('before-quit', () => historyTracker.flush())

    // ===== 本地播放历史（V2）：渲染层报事件，第二只聆听钟同规则入史（≥30s 门槛/暂停钟/宽限全复用） =====
    const localHistoryTracker = new HistoryTracker({
      now: () => Date.now(),
      onRecord: (r) => {
        try {
          appendPlayRecord(join(historyDir, 'plays.jsonl'), r)
        } catch (err) {
          console.warn('[history] 本地记录写盘失败', err)
          diagLog.push('warn', 'history', `本地记录写盘失败: ${String(err)}`)
        }
      }
    })
    app.on('before-quit', () => localHistoryTracker.flush())
    ipcMain.on('localHistory:track', (_e, p) => {
      const ev = localChangeEventFrom(p)
      if (!ev || ev.kind !== 'change') return // 垃圾载荷丢弃（stop 有独立通道）
      localHistoryTracker.onTrack(ev, saveArtworkThumb(join(historyDir, 'artwork'), ev.meta))
    })
    ipcMain.on('localHistory:stop', () => localHistoryTracker.flush())
    ipcMain.on('localHistory:progress', (_e, playing) => {
      if (typeof playing === 'boolean') localHistoryTracker.onProgress(playing)
    })

    // ===== 歌词二期（spec §3/§4）：抓词 + 进度轮询兜底 =====
    // 门控铁律：lyrics.enabled=false ⇒ 不 lookup、不轮询、零网络请求（隐私语义，spec §6）
    const lyricsService = new LyricsService(join(app.getPath('userData'), 'lyrics-cache'))
    // 本地音频 V2：渲染层按标签查词（同一服务同一缓存；隐私门控与系统链路同一铁律——关闭歌词零网络）
    ipcMain.handle('lyrics:lookup', async (_e, p) => {
      if (!store.get().lyrics.enabled) return null
      if (typeof p !== 'object' || p === null) return null
      const r = p as Record<string, unknown>
      if (typeof r['title'] !== 'string' || typeof r['artist'] !== 'string') return null
      const duration = typeof r['duration'] === 'number' && Number.isFinite(r['duration']) ? r['duration'] : null
      return lyricsService.lookup(r['title'], r['artist'], duration)
    })

    // 性能基准环境（性能基线）：仅 dev 注册，打包版第二步再开。
    // collectPerfEnv 静态 import（顶部）——handler 同步注册，杜绝渲染层早于动态 import 完成而撞空 handler
    if (!app.isPackaged) {
      /** bench 期间强制标准窗口消除尺寸变量；返回原尺寸供跑完恢复。
       * 两个坑（本仓 windows.ts 有血泪先例）：
       * ① 全屏态下 getSize() 返回的是全屏分辨率，不是用户的窗口尺寸——用 getNormalBounds()
       *    取「恢复态」尺寸，它天然排除全屏/最大化，无论当前什么状态都拿到真实窗口大小。
       * ② setFullScreen(false) 在 macOS 是异步过渡：必须等 leave-full-screen 再 setSize，
       *    否则 1280×800 会被转场吞掉（windows.ts 的 pendingAfterLeave 同款教训）。
       * 故 handler 为 async——调用方本就 await 它。 */
      ipcMain.handle('perf:standardizeWindow', async () => {
        if (!win) return null
        const normal = win.getNormalBounds() // 全屏态也能拿到真实恢复尺寸
        const prev = { w: normal.width, h: normal.height }
        if (win.isFullScreen()) {
          const w = win
          await new Promise<void>((resolve) => {
            // 超时兜底：leave-full-screen 在窗口非前台/快速连切等情况下已知可能延迟或不触发，
            // macOS 不做「必定触发」的保证。一次性 Promise 无「下次纠偏」机会，不兜底就永久挂起、
            // 「跑基准」按钮无声卡死。3s 后无论如何放行并摘掉陈旧监听器（否则它会在未来某次
            // 无关的全屏切换里被误触发，把窗口尺寸改乱）。
            const onLeave = (): void => { clearTimeout(timer); resolve() }
            const timer = setTimeout(() => { w.removeListener('leave-full-screen', onLeave); resolve() }, 3000)
            w.once('leave-full-screen', onLeave)
            w.setFullScreen(false)
          })
        }
        // await 期间窗口可能被销毁（Cmd+Q 走 closed → win=null）：重新守卫，同 sendToRenderer 风格
        if (!win || win.isDestroyed()) return null
        win.setSize(1280, 800)
        return prev
      })
      ipcMain.handle('perf:restoreWindow', (_e, size: { w: number; h: number }) => {
        if (!win || !size) return
        win.setSize(size.w, size.h)
      })
      ipcMain.handle('perf:getEnv', async () => (win ? collectPerfEnv(win) : null))
      ipcMain.handle('perf:getStartupMarks', () => ({
        processStartMs: perfProcessStartMs,
        windowCreatedMs: perfWindowCreatedMs,
        // 时钟桥：主进程与渲染层的 performance.now() 零点不同源，
        // 靠墙钟换算才能把两侧里程碑放进同一坐标系
        mainNowMs: performance.now(),
        mainWallMs: Date.now(),
      }))
    }

    let lastLyricsMsg: unknown = null // 与 lastTrackMsg 同因：did-finish-load 补发
    let lastLyricsKey: string | null = null
    let lyricsHit = false // 当前歌命中歌词才值得轮询进度
    const poller = createProgressPoller({
      intervalMs: POLL_INTERVAL_MS,
      readOnce: () => readNowPlayingOnce(resolveBinary()),
      onProgress: sendProgress
    })
    const refreshPolling = (): void => {
      const enabled = store.get().lyrics.enabled
      // 关闭歌词时顺手清零 lyricsHit（终审M1）：否则残留 true，下次热切回开时轮询立即恢复，
      // 但渲染层 doc 已被清掉（spec：设置下一首才生效）——poller 白跑，execFile 空转到下一首 key 变化
      if (!enabled) lyricsHit = false
      if (enabled && lyricsHit) poller.start()
      else poller.stop()
    }
    store.subscribe(refreshPolling) // 设置热切（含面板关闭歌词）即时启停
    app.on('before-quit', () => poller.stop())

    const stopNp = startMacNowPlaying(
      (e) => {
        // 历史：change 顺手落封面缩略（existsSync 去重，同曲封面晚到的二次 change 补 key 不重置钟）
        historyTracker.onTrack(e, e.kind === 'change' ? saveArtworkThumb(join(historyDir, 'artwork'), e.meta) : null)
        lastTrackMsg =
          e.kind === 'change'
            ? {
                kind: 'change',
                title: e.meta.title,
                artist: e.meta.artist,
                artworkDataUrl: e.meta.artworkPng
                  ? artworkToDataUrl(e.meta.artworkPng, e.meta.artworkMime)
                  : null
              }
            : { kind: 'unknown' }
        sendToRenderer('track', lastTrackMsg)
        // 抓词：key 变化才查（同曲封面补发 change 不重查）；结果晚到时 key 对不上即丢弃
        if (e.kind === 'change') {
          const key = `${e.meta.title}\0${e.meta.artist}`
          if (key !== lastLyricsKey) {
            lastLyricsKey = key
            lyricsHit = false
            lastLyricsMsg = null // 切歌清缓存（终审M2）：防 did-finish-load 补发旧歌词（渲染层 key 门控已兜底，此为纵深）
            refreshPolling()
            if (store.get().lyrics.enabled) {
              void lyricsService.lookup(e.meta.title, e.meta.artist, e.meta.duration).then((lines) => {
                if (key !== lastLyricsKey) return // 已切歌，过期结果丢弃
                lastLyricsMsg = lines ? { key, lines } : { key, none: true }
                lyricsHit = lines !== null
                refreshPolling()
                sendToRenderer('lyrics', lastLyricsMsg)
              })
            }
          }
        } else {
          lastLyricsKey = null
          lyricsHit = false
          lastLyricsMsg = null // unknown 同样清缓存（终审M2），语义同上
          lastProgressMsg = null // 会话消失：旧进度作废，防 reload 补发拿死会话进度驱动时钟
          refreshPolling()
        }
      },
      (p) => {
        historyTracker.onProgress(p.playing) // 聆听钟的暂停/恢复（stream 转变事件驱动）
        sendProgress(p)
      }
    )
    // 补发触发改为渲染层报到（#歌词冷启动根治）：did-finish-load ≠ 订阅就绪——boot 内 await
    // 造成空窗，缓存命中的歌词瞬发落空且同曲 key 去重永不重发（= 该歌整首无词）。
    // renderer:ready 由渲染层在三订阅挂完后发出，每次加载/reload 都会报到一次。
    // 补发序固定 track → lyrics → progress：渲染层收 track 会 reset 歌词时钟，进度必须垫后 mark
    ipcMain.on('renderer:ready', () => {
      if (lastTrackMsg) sendToRenderer('track', lastTrackMsg)
      if (lastLyricsMsg) sendToRenderer('lyrics', lastLyricsMsg)
      if (lastProgressMsg) sendToRenderer('progress', ageProgress(lastProgressMsg, (Date.now() - lastProgressAtMs) / 1000))
      // 捕获状态同因补发（审②P1-2）：tap 二进制缺失/spawn 失败的 unavailable 在 whenReady 同步发出，
      // 早于渲染层订阅即丢且此后无新事件——首启即坏时权限出路（idle-hint 快路）会整个失效
      if (lastCaptureStatus !== 'unknown') sendToRenderer('capture:status', lastCaptureStatus)
    })
    app.on('before-quit', stopNp)
  }
})

app.on('activate', () => {
  win?.show() // 关窗即隐藏的配套：点 Dock 图标召回窗口
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
