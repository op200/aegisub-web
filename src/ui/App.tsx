import { Captions, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import {
  loadAutomationScript,
  runAutomationMacro,
  type AutomationMacroInfo,
  type LuaRow,
} from '../automation/luaEngine'
import {
  getOptionBool,
  getOptionInt,
  getOptionString,
  setOption,
  useOptionsVersion,
} from '../config/options'
import { CoreClient } from '../core/client'
import { createDocument } from '../core/defaults'
import { exportSubtitle } from '../core/format'
import type { CoreCommand, CoreState, SubtitleDocument } from '../core/types'
import {
  Framerate,
  lowerBoundIndex,
  parseKeyframes,
  parseTimecodes,
  serializeKeyframes,
  serializeTimecodes,
  serializeTimecodesKeepOffset,
} from '../core/vfr'
import { extractVideoKeyframes } from '../media/demux'
import { BrowserHostAdapter, MEDIA_FILE_TYPES, SUBTITLE_FILE_TYPES } from '../platform/browserHost'
import { createNativeHostAdapter } from '../platform/nativeHost'
import type { AppFileHandle, HostAdapter, MediaSource } from '../platform/types'
import {
  loadAutomationScripts,
  saveAutomationScripts,
  type StoredAutomationScript,
} from '../storage/automationStore'
import { importFontFiles } from '../storage/fontStore'
import { loadCachedKeyframes, storeCachedKeyframes } from '../storage/keyframeCacheStore'
import { loadLatestAutosave, saveAutosave, saveSubtitleBackup } from '../storage/projectStore'
import {
  loadRecentLists,
  pushRecent,
  RECENT_TYPES,
  type RecentLists,
  type RecentType,
} from '../storage/recentStore'
import { invertLightness } from './color'
import {
  COMMAND_REGISTRY,
  type AudioOptions,
  type AudioView,
  type CommandApi,
  type CommandContext,
  type DialogKind,
  type DisplayMode,
  type GridTagsMode,
} from './commandRegistry'
import { commandForShortcut, shortcutFromKeyboardEvent, type ShortcutContext } from './commands'
import { AudioPane } from './components/AudioPane'
import {
  AboutDialog,
  AttachmentDialog,
  AutomationManagerDialog,
  DummyVideoDialog,
  ExportSubtitlesDialog,
  FontCollectorDialog,
  JumpToDialog,
  LanguageDialog,
  ResampleDialog,
  ScriptPropertiesDialog,
  SelectLinesDialog,
  ShiftTimesDialog,
  StylingAssistantDialog,
  TimecodesOffsetDialog,
  TimingProcessorDialog,
  ToolInfoDialog,
  TranslationDialog,
  VideoDetailsDialog,
  VideoOffsetNoticeDialog,
  useEscapeClose,
  type ExportOptions,
  type SelectLinesSettings,
} from './components/dialogs'
import { EditPanel } from './components/EditPanel'
import { LogPanel } from './components/LogPanel'
import { MenuBar } from './components/MenuBar'
import { PreferencesDialog } from './components/PreferencesDialog'
import { PreviewPane, type VideoPlaybackMode } from './components/PreviewPane'
import { StyleManagerDialog } from './components/StyleManagerDialog'
import { SubtitleGrid } from './components/SubtitleGrid'
import { Toolbar } from './components/Toolbar'
import { initLocale, tPlain, useLocaleVersion } from './i18n'
import { calculateAttachedVideoLayout } from './layout/videoLayout'
import { installGlobalLogHandlers, logError, logInfo, getLogEntries, subscribeLogs } from './log'
import { useSystemTheme } from './theme'

const host: HostAdapter = createNativeHostAdapter() ?? new BrowserHostAdapter()

/** keyframe/open 的文件过滤器（keyframe.cpp：*.txt;*.pass;*.stats;*.log） */
const KEYFRAME_FILE_TYPES = [
  { description: 'Keyframes', accept: { 'text/plain': ['.txt', '.pass', '.stats', '.log'] } },
]
/** timecode/open 的文件过滤器（timecode.cpp：*.txt） */
const TIMECODES_FILE_TYPES = [{ description: 'Timecodes', accept: { 'text/plain': ['.txt'] } }]

/** 拖放分类扩展名表（project.cpp Project::LoadList） */
const DROP_VIDEO_EXTS = [
  '.asf',
  '.avi',
  '.avs',
  '.d2v',
  '.h264',
  '.hevc',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ogm',
  '.rm',
  '.rmvb',
  '.ts',
  '.webm',
  '.wmv',
  '.y4m',
  '.yuv',
]
const DROP_SUBS_EXTS = ['.ass', '.srt', '.ssa', '.sub', '.ttxt']
const DROP_AUDIO_EXTS = [
  '.aac',
  '.ac3',
  '.ape',
  '.dts',
  '.eac3',
  '.flac',
  '.m4a',
  '.mka',
  '.mp3',
  '.ogg',
  '.opus',
  '.w64',
  '.wav',
  '.wma',
]
/** LoadList 之外的 Web 扩展：字体文件拖入 → IndexedDB 字体缓存 */
const DROP_FONT_EXTS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2', '.fon']

/** FrameMain::StatusTimeout 默认超时（frame_main.h ms=10000，到期 OnStatusClear 清空右字段） */
const STATUS_TIMEOUT_MS = 10000

function decodeText(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data)
}

/** Web 版恒定帧率（DummyVideoProvider 与既有实现一致，24fps） */
const DEFAULT_FPS = 24

/** 已加载的 Automation 脚本（auto4_base Script 的 Web 版） */
interface LoadedAutomationEntry {
  key: string
  filename: string
  code: string
  stateId: number
  name: string
  description: string
  macros: AutomationMacroInfo[]
  error?: string
}

/** 文档 → Lua 全空间行（Info + Styles + Dialogue，auto4_lua_assfile.cpp 索引空间） */
function buildLuaRows(document: SubtitleDocument): LuaRow[] {
  const rows: LuaRow[] = []
  for (const [key, value] of Object.entries(document.scriptInfo)) {
    rows.push({ class: 'info', key, value, section: 'Script Info', raw: `${key}: ${value}` })
  }
  for (const style of document.styles) {
    rows.push({
      class: 'style',
      name: style.name,
      fontname: style.fontName,
      fontsize: style.fontSize,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      strikeout: style.strikeout,
      section: 'V4+ Styles',
      raw: '',
    })
  }
  for (const cue of document.cues) {
    rows.push({
      class: 'dialogue',
      layer: cue.layer,
      start_time: cue.startMs,
      end_time: cue.endMs,
      style: cue.style,
      actor: cue.actor,
      margin_l: cue.marginL,
      margin_r: cue.marginR,
      margin_t: cue.marginV,
      margin_b: cue.marginV,
      effect: cue.effect,
      comment: cue.comment,
      text: cue.text,
      section: 'Events',
      raw: '',
    })
  }
  return rows
}

function rowToCuePatch(row: LuaRow): Partial<Omit<import('../core/types').SubtitleCue, 'id'>> {
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    layer: number(row.layer),
    startMs: number(row.start_time),
    endMs: number(row.end_time),
    style: typeof row.style === 'string' ? row.style : 'Default',
    actor: typeof row.actor === 'string' ? row.actor : '',
    marginL: number(row.margin_l),
    marginR: number(row.margin_r),
    marginV: number(row.margin_t),
    effect: typeof row.effect === 'string' ? row.effect : '',
    comment: row.comment === true,
    text: typeof row.text === 'string' ? row.text : '',
  }
}

function toStoredAutomation(entry: LoadedAutomationEntry): StoredAutomationScript {
  return { id: entry.key, filename: entry.filename, code: entry.code }
}

function selectedOrActive(
  document: CoreState['document'],
  selected: Set<string>,
  activeId: string | null,
): string[] {
  if (selected.size) return [...selected]
  if (activeId) return [activeId]
  return document.cues[0] ? [document.cues[0].id] : []
}

/**
 * 设备像素比跟踪（video_display.cpp 的 GetContentScaleFactor）：
 * 监听 (resolution: Xdppx)，DPR 变化（跨显示器拖动/浏览器缩放）时更新。
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => setDpr(window.devicePixelRatio || 1)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [dpr])
  return dpr
}

/** 音频工具栏开关 → 持久化选项（AudioOptions 中 karaoke 为会话状态不持久化） */
const AUDIO_TOGGLE_OPTIONS: Record<string, string> = {
  autoCommit: 'Audio/Auto/Commit',
  autoNext: 'Audio/Next Line on Commit',
  autoScroll: 'Audio/Auto/Scroll',
  globalHotkeys: 'Audio/Medusa Timing Hotkeys',
  verticalLink: 'Audio/Link',
}

export function App() {
  const optionsVersion = useOptionsVersion() // Preferences 提交后触发全应用重渲染
  const theme = useSystemTheme() // 自动主题：跟随系统深浅色
  const coreRef = useRef<CoreClient | null>(null)
  const anchorRef = useRef<string | null>(null)
  const executeRef = useRef<(id: string) => void>(() => undefined)
  const [core, setCore] = useState<CoreState | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [videoMedia, setVideoMedia] = useState<MediaSource | null>(null)
  const [audioMedia, setAudioMedia] = useState<MediaSource | null>(null)
  const [videoDurationMs, setVideoDurationMs] = useState(0)
  // Video/Default Zoom：预设 0..23 → 缩放 (n+1)/8（7 → 100%）
  const [videoWindowZoom, setVideoWindowZoom] = useState(
    () => (getOptionInt('Video/Default Zoom') + 1) / 8,
  )
  // 设备像素比（源码 GetContentScaleFactor）：视频缩放按物理设备像素计
  const devicePixelRatioValue = useDevicePixelRatio()
  const prevDprRef = useRef(devicePixelRatioValue)
  useEffect(() => {
    // wxEVT_DPI_CHANGED：new_zoom = zoom × 新scale/旧scale，保持视频表观尺寸不跳变
    const prev = prevDprRef.current
    if (prev === devicePixelRatioValue) return
    prevDprRef.current = devicePixelRatioValue
    if (prev > 0)
      setVideoWindowZoom((zoom) =>
        Math.max(0.125, Math.min(3, (zoom * devicePixelRatioValue) / prev)),
      )
  }, [devicePixelRatioValue])
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState({ width: 1280, height: 720 })
  // AudioBox（wxSashWindow）底边 sash：SetSashVisible(wxSASH_BOTTOM) + OnSashDrag 改变
  // 音频栏高度（SetMinSize → 父 Layout），OPT_SET("Audio/Display Height") 持久化
  const [audioBoxHeight, setAudioBoxHeight] = useState(() => getOptionInt('Audio/Display Height'))
  // 播放音量增益（audio_box.cpp 三次方曲线）：AudioPane 计算并上报，视频播放出声共用
  // （源码唯一 audio player 同时供视频/音频出声，Volume 滑条对两者都生效）
  const [playbackGain, setPlaybackGain] = useState(() =>
    Math.pow(Math.max(1, Math.min(100, getOptionInt('Audio/Volume'))) / 50, 3),
  )
  const audioSashDragRef = useRef<{
    startY: number
    startHeight: number
    maxHeight: number
    current: number
  } | null>(null)
  // 稳定标识 + 值不变时返回原对象，避免 PreviewPane 的媒体 effect 依赖抖动造成重渲染循环。
  // 注意：源码 FitClientSizeToVideo 只按 video×windowZoom 定住显示框（SetMin/MaxClientSize），
  // 从不因窗口放不下而降档缩放；放不下时由窗口裁剪，与原版一致
  const setIntrinsicSizeStable = useCallback((width: number, height: number) => {
    setVideoIntrinsicSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    )
  }, [])
  // 本地字体授权次数：递增触发 PreviewPane 重建 jassub 实例（libass 用新权限重新匹配字体）
  const [localFontsEpoch, setLocalFontsEpoch] = useState(0)
  // Log window（View → app/log 的独立弹窗，dialog_log）；底部状态栏不承载它
  const [logWindowOpen, setLogWindowOpen] = useState(false)
  const [audioDurationMs, setAudioDurationMs] = useState(0)
  const [videoTimeMs, setVideoTimeMs] = useState(0)
  const [audioTimeMs, setAudioTimeMs] = useState(0)
  // 状态栏解码器指示与切换：videoPlaybackMode 为当前生效通道；override 为用户手动
  // 选择（true=强制 WebCodecs，false=强制原生，null=自动：原生失败才切 WebCodecs）
  const [videoPlaybackMode, setVideoPlaybackMode] = useState<VideoPlaybackMode | null>(null)
  const [videoDecoderOverride, setVideoDecoderOverride] = useState<boolean | null>(null)
  const [videoAction, setVideoAction] = useState({ sequence: 0, type: '' })
  const [audioAction, setAudioAction] = useState({ sequence: 0, type: '' })
  // 双击网格行的音频 ScrollToActiveLine 请求（audio_box.cpp，nonce 递增触发 Waveform 滚动）
  const [audioScrollRequest, setAudioScrollRequest] = useState(0)
  // 状态栏消息（CreateStatusBar(2) 右字段 = field 1）。Aegisub 所有临时消息都走
  // FrameMain::StatusTimeout(text, ms=10000)：显示后由 ID_APP_TIMER_STATUSCLEAR 定时器
  // 清空（OnStatusClear → SetStatusText("", 1)）；左字段（field 0）源码从不写入
  const [status, setStatusState] = useState('Ready')
  const statusClearTimer = useRef<number | undefined>(undefined)
  const setStatus = useCallback((message: string, ms = STATUS_TIMEOUT_MS) => {
    setStatusState(message)
    window.clearTimeout(statusClearTimer.current)
    if (ms > 0) statusClearTimer.current = window.setTimeout(() => setStatusState(''), ms)
  }, [])
  const [busy, setBusy] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(() => getOptionBool('App/Show Toolbar'))
  const [showStyleManager, setShowStyleManager] = useState(false)
  // 编辑框 Edit 按钮直达样式编辑（源码 DialogStyleEditor），菜单入口仍是样式管理器
  const [styleManagerAutoEdit, setStyleManagerAutoEdit] = useState(false)
  const [findMode, setFindMode] = useState<'find' | 'replace' | null>(null)
  // 查找/替换弹窗 ESC 关闭（不响应点击外部关闭）
  useEscapeClose(() => setFindMode(null), findMode !== null)
  const [findQuery, setFindQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  // Audio/Spectrum 选项决定音频默认显示模式
  const [audioView, setAudioView] = useState<AudioView>(() =>
    getOptionBool('Audio/Spectrum') ? 'spectrum' : 'waveform',
  )
  // 音频工具栏开关持久化到对应选项（audio.cpp 各 toggle 命令的 OPT_SET）
  const [audioOptions, setAudioOptions] = useState<AudioOptions>(() => ({
    autoCommit: getOptionBool('Audio/Auto/Commit'),
    autoNext: getOptionBool('Audio/Next Line on Commit'),
    autoScroll: getOptionBool('Audio/Auto/Scroll'),
    globalHotkeys: getOptionBool('Audio/Medusa Timing Hotkeys'),
    karaoke: false,
    verticalLink: getOptionBool('Audio/Link'),
  }))
  const [audioPlaying, setAudioPlaying] = useState(false)
  // Video/Subtitle Sync 默认 true（源码 default_config.json）
  const [videoAutoScroll, setVideoAutoScroll] = useState(() => getOptionBool('Video/Subtitle Sync'))
  // Subtitle/Grid/Hide Overrides：0 显示 → 1 简化(☀) → 2 隐藏
  const [gridTags, setGridTags] = useState<GridTagsMode>(() => {
    const value = getOptionInt('Subtitle/Grid/Hide Overrides')
    return value === 2 ? 'hide' : value === 0 ? 'show' : 'simplify'
  })
  const [displayMode, setDisplayMode] = useState<DisplayMode>('full')
  // ≤900px 走移动端堆叠布局（styles.css @media），视频面板为固定高度预览，不应用挂靠锁定尺寸
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => window.matchMedia('(max-width: 900px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const onChange = (event: MediaQueryListEvent) => setIsNarrowViewport(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [videoOverscan, setVideoOverscan] = useState(false) // Video/Overscan Mask 默认 false
  const [aspectOverride, setAspectOverride] = useState<number | null>(null) // video/aspect/*
  const [dirty, setDirty] = useState(false) // 标题 * 前缀（FrameMain::UpdateTitle）
  // keyframes / timecodes 状态机（project.cpp：文件加载 > 视频自带 > 无）
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [keyframesFromFile, setKeyframesFromFile] = useState(false)
  // 视频自带关键帧（ms；解复用扫描/WebCodecs 读流上报，帧号随帧率派生）
  const [videoKeyframeTimes, setVideoKeyframeTimes] = useState<number[]>([])
  const keyframeScanIdRef = useRef(0) // 换视频/关视频时作废旧的后台扫描
  // 后台扫描的追踪句柄：保存时间码/关键帧前必须等它完成（Aegisub 保存的是 provider
  // 逐帧表，CFR 回退与 WC 渐进关键帧都不是完整索引，保存值必然与源码不一致）
  const videoScanRef = useRef<{
    id: number
    promise: Promise<void>
    done: boolean
    keyframeTimes: number[]
    frameTimes: number[] | null
  } | null>(null)
  const [timecodes, setTimecodes] = useState<Framerate | null>(null)
  const [timecodesFromFile, setTimecodesFromFile] = useState(false)
  // 视频自带逐帧时间码表（ms；FFMS2 TimecodesVector 语义，解复用扫描上报）
  const [videoFrameTimes, setVideoFrameTimes] = useState<number[] | null>(null)
  // 首帧偏移感知 UI：载入提醒（每视频一次）+ 导出时间码时保留偏移选择
  const [videoOffsetNotice, setVideoOffsetNotice] = useState<{
    offsetMs: number
    frameDurationMs: number
  } | null>(null)
  const offsetNoticeShownRef = useRef<File | undefined>(undefined)
  const [timecodesOffsetAsk, setTimecodesOffsetAsk] = useState<number | null>(null)
  const [frameMode, setFrameMode] = useState(false) // 网格/编辑框帧号模式
  // 最近文件（mru.cpp）与探测到的真实视频帧率
  const [recentLists, setRecentLists] = useState<RecentLists>(() => ({
    subtitle: [],
    video: [],
    audio: [],
    timecodes: [],
    keyframes: [],
  }))
  const [detectedFps, setDetectedFps] = useState<number | null>(null)
  // Lua Automation（auto4_base ScriptManager）
  const [automationScripts, setAutomationScripts] = useState<LoadedAutomationEntry[]>([])
  const loadedRef = useRef(false)
  // autosaved_commit_id 对应物：最近一次自动保存/文档替换时的 revision
  const lastAutosaveRevisionRef = useRef(0)

  // 多语言引导（app.cpp wxLocale 初始化语义）：App/Language 或浏览器语言 →
  // 异步拉取 po → i18n 版本号通知整树重渲染；切换语言时同样经 useLocaleVersion 刷新
  useLocaleVersion()
  useEffect(() => {
    void initLocale()
  }, [])

  // 日志 → 状态栏单行消息。Aegisub 的诊断出口是 agi::log（Log window 查看），
  // 用户可见反馈走 StatusTimeout；Web 版把日志条目同步显示到状态栏：
  // info 10 秒自动清除，warning/error 保持到下一条消息（如 Local Font 不可用提示）
  useEffect(() => {
    installGlobalLogHandlers()
    // 渲染器创建发生在子组件 effect（早于本订阅），补读缓冲里最近一条
    const entries = getLogEntries()
    const last = entries[entries.length - 1]
    if (last && Date.now() - last.time < 5000)
      // oxlint-disable-next-line react/set-state-in-effect
      setStatus(last.message, last.level === 'info' ? STATUS_TIMEOUT_MS : 0)
    return subscribeLogs((entry) => {
      setStatus(entry.message, entry.level === 'info' ? STATUS_TIMEOUT_MS : 0)
    })
  }, [setStatus])

  useEffect(() => {
    const client = new CoreClient()
    coreRef.current = client
    let cancelled = false
    void (async () => {
      let initial = await client.state()
      try {
        const saved = await loadLatestAutosave()
        if (saved?.document && Date.now() - saved.savedAt < 30 * 24 * 60 * 60 * 1000)
          initial = await client.restore(saved.document)
      } catch {
        // IndexedDB is optional in private browsing and embedded WebViews.
      }
      const recents = await loadRecentLists()
      if (cancelled) return
      setRecentLists(recents)
      setCore(initial)
      const first = initial.document.cues[0]?.id ?? null
      setActiveId(first)
      if (first) setSelectedIds(new Set([first]))
      loadedRef.current = true
    })()
    return () => {
      cancelled = true
      client.close()
    }
  }, [])

  // Limits/Undo Levels 下发到文档运行时（WASM 核心由 C++ 侧管理，仅 TS 回退生效）
  useEffect(() => {
    coreRef.current?.configure({ undoLevels: getOptionInt('Limits/Undo Levels') })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重读配置
  }, [optionsVersion])

  // 自动保存（SubsController::AutoSave：仅当存在未自动保存的修改——autosaved_commit_id
  // 语义用 document.revision 追踪；Save on Every Change 优先，其次定时 App/Auto/Save）
  useEffect(() => {
    if (!core || !loadedRef.current) return
    const document = core.document
    const save = () => {
      if (document.revision === lastAutosaveRevisionRef.current) return
      lastAutosaveRevisionRef.current = document.revision
      const name = document.sourceName || 'Untitled'
      void saveAutosave(name, document)
        .then((fileName) => setStatus(`File backup saved as "${fileName}".`))
        .catch(() => undefined)
    }
    if (getOptionBool('App/Auto/Save on Every Change')) {
      // 源码：仅已有文件名（非新建未命名）的文档才每次修改后保存
      if (document.sourceName && document.sourceName !== 'untitled.ass') {
        const timer = window.setTimeout(save, 700)
        return () => window.clearTimeout(timer)
      }
      return undefined
    }
    if (getOptionBool('App/Auto/Save')) {
      const ms = Math.max(1, getOptionInt('App/Auto/Save Every Seconds')) * 1000
      const timer = window.setInterval(save, ms)
      return () => window.clearInterval(timer)
    }
    return undefined
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重建定时器
  }, [core, optionsVersion, setStatus])

  // 网格配色 → CSS 变量（Colour/Subtitle Grid，Preferences → Interface → Colors）
  // dark 主题下这些 Aegisub 亮色向配色按 HSL 亮度反相适配：背景抬升下限、前景压低上限
  useEffect(() => {
    const root = document.documentElement
    const dark = theme === 'dark'
    const adaptBg = (value: string) => (dark ? invertLightness(value, { min: 0.07 }) : value)
    const adaptFg = (value: string) => (dark ? invertLightness(value, { max: 0.93 }) : value)
    const setVar = (name: string, value: string) => root.style.setProperty(name, value)
    setVar('--grid-fg', adaptFg(getOptionString('Colour/Subtitle Grid/Standard')))
    setVar('--grid-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Background')))
    setVar('--grid-sel-fg', adaptFg(getOptionString('Colour/Subtitle Grid/Selection')))
    setVar('--grid-sel-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Selection')))
    setVar('--grid-comment-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Comment')))
    setVar(
      '--grid-sel-comment-bg',
      adaptBg(getOptionString('Colour/Subtitle Grid/Background/Selected Comment')),
    )
    setVar('--grid-inframe-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Inframe')))
    setVar('--grid-header-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Header')))
    setVar('--grid-left-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Left Column')))
    setVar('--grid-active-border', adaptBg(getOptionString('Colour/Subtitle Grid/Active Border')))
    setVar('--grid-line', adaptBg(getOptionString('Colour/Subtitle Grid/Lines')))
    setVar('--grid-cps-error', adaptFg(getOptionString('Colour/Subtitle Grid/CPS Error')))
    // Subtitle/Grid/Font Size：wxWidgets pt → CSS px（9pt → 12px）
    const gridSize = getOptionInt('Subtitle/Grid/Font Size')
    setVar('--grid-font-size', `${Math.round((gridSize * 4) / 3)}px`)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重读配置
  }, [theme, optionsVersion])

  // 窗口标题：与 FrameMain::UpdateTitle 一致（未保存时 "* " 前缀 + 文件名 + " - Aegisub"）
  useEffect(() => {
    if (!core) return
    const name = core.document.sourceName || 'untitled'
    document.title = `${dirty ? '* ' : ''}${name} - Aegisub`
  }, [core, dirty])

  const selectedCue = useMemo(
    () => core?.document.cues.find((cue) => cue.id === activeId) ?? null,
    [activeId, core],
  )
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // subs_edit_box.cpp PopulateList：全文档 Actor/Effect 去重排序，供编辑框 datalist
  const actorValues = useMemo(() => {
    if (!core) return []
    return [...new Set(core.document.cues.map((cue) => cue.actor).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [core])
  const effectValues = useMemo(() => {
    if (!core) return []
    return [...new Set(core.document.cues.map((cue) => cue.effect).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [core])
  // 视觉工具 SetSelectedOverride 的目标集合：选中行（无选中时回退活动行）
  const selectedCues = useMemo(() => {
    if (!core) return []
    return selectedOrActive(core.document, selectedSet, activeId)
      .map((id) => core.document.cues.find((cue) => cue.id === id))
      .filter((cue) => cue !== undefined)
  }, [core, selectedSet, activeId])
  const videoLayout = useMemo(
    () =>
      calculateAttachedVideoLayout(
        videoIntrinsicSize,
        videoWindowZoom,
        aspectOverride ?? videoIntrinsicSize.width / Math.max(1, videoIntrinsicSize.height),
        devicePixelRatioValue,
      ),
    [aspectOverride, videoIntrinsicSize, videoWindowZoom, devicePixelRatioValue],
  )

  // JumpToTime(ms, START)（video_controller.cpp）：FrameAtTime(start, START) 定帧后
  // 落到该帧 EXACT 时间。直接用原始行首 ms 会落到"包含行首的那一帧"（≤ 行首），
  // 与源码"第一个 ≥ 行首的帧"差一帧，且时间框相对值符号相反（对不上字幕时间戳）
  const seekVideoToLineStart = (startMs: number) => {
    if (!videoMedia || !frameRate.isLoaded()) return
    setVideoTimeMs(frameRate.timeAtFrame(frameRate.frameAtTime(startMs, 'start'), 'exact'))
  }

  // 活动行切换标记：仅行变化时 seek（源码 OnActiveLineChanged 只由行切换触发，
  // 字幕内容/时间编辑不改活动行，不应错误跳转）
  const activeLineIdRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const lineChanged = activeLineIdRef.current !== activeId
    activeLineIdRef.current = activeId
    // 视频自动跟随选中行（video_controller.cpp OnActiveLineChanged：Stop() + JumpToTime）
    // oxlint-disable-next-line react/set-state-in-effect
    if (lineChanged && videoAutoScroll && videoMedia && selectedCue) {
      sendVideoAction('stop')
      seekVideoToLineStart(selectedCue.startMs)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selectedCue, videoAutoScroll, videoMedia])

  // 帧率状态机（project.cpp）：timecodes 文件 > 视频自带逐帧时间码表（FFMS2
  // TimecodesVector）> 视频自带 CFR（探测帧率或 24，表不可得时的回退）> 未加载
  const frameRate = useMemo(() => {
    if (timecodes) return timecodes
    if (videoFrameTimes && videoFrameTimes.length >= 2)
      return Framerate.fromTimecodes(videoFrameTimes)
    if (videoMedia) return Framerate.cfr(detectedFps ?? DEFAULT_FPS)
    return Framerate.empty()
  }, [timecodes, videoFrameTimes, videoMedia, detectedFps])
  const currentFrame = useMemo(
    () => (frameRate.isLoaded() ? frameRate.frameAtTime(videoTimeMs) : 0),
    [frameRate, videoTimeMs],
  )
  const frameCount = useMemo(() => {
    // 源码 project.cpp：timecodes 文件只改时间↔帧映射，帧数仍是视频 provider 的
    // （GetFrameCount 不随加载的 timecodes 变；滑块长度、Save Timecodes 外推长度同理）
    if (videoFrameTimes && videoFrameTimes.length >= 2) return videoFrameTimes.length
    // 回退：provider GetFrameCount 语义按探测帧率而非固定 24（否则滑块游标错位）
    if (videoDurationMs > 0)
      return Math.max(1, Math.round((videoDurationMs * (detectedFps ?? DEFAULT_FPS)) / 1000))
    if (timecodes) return timecodes.frameCount()
    return 1
  }, [timecodes, videoFrameTimes, videoDurationMs, detectedFps])
  // 视频关键帧 ms→帧号：关键帧时间为视频流原始 PTS。帧号 = 在原始逐帧时间码表中的
  // 下界序号（FFMS2 索引按 PTS 升序排帧，keyframe 帧号即排序后位置）——不能用归一化
  // 后的 frameRate.frameAtTime（首帧 PTS ≠ 0 时整体偏移 N 帧；加载 timecodes 文件后
  // 时间线也换掉），视频自身帧序号不随这些变
  const videoKeyframes = useMemo(() => {
    if (!videoKeyframeTimes.length) return []
    if (videoFrameTimes && videoFrameTimes.length >= 2)
      return videoKeyframeTimes.map((ms) => lowerBoundIndex(videoFrameTimes, ms))
    // 无表（CFR 回退）：帧号按探测帧率时间线外推
    return videoKeyframeTimes.map((ms) => frameRate.frameAtTime(ms))
  }, [videoKeyframeTimes, videoFrameTimes, frameRate])
  // keyframes 文件优先（project.cpp：文件加载 > 视频自带）
  const activeKeyframes = keyframesFromFile ? keyframes : videoKeyframes

  useEffect(() => {
    // 启动时恢复持久化的 Automation 脚本（LocalScriptManager 语义）
    void (async () => {
      const stored = await loadAutomationScripts()
      if (!stored.length) return
      const entries = await Promise.all(
        stored.map(async (script) => {
          try {
            const loaded = await loadAutomationScript(script.code, script.filename)
            return {
              key: script.id,
              filename: script.filename,
              code: script.code,
              ...loaded,
              error: undefined,
            }
          } catch (error) {
            return {
              key: script.id,
              filename: script.filename,
              code: script.code,
              stateId: -1,
              name: script.filename,
              description: '',
              macros: [],
              error: error instanceof Error ? error.message : tPlain('Failed to load script'),
            }
          }
        }),
      )
      setAutomationScripts(entries)
    })()
  }, [])

  const addAutomationScript = async () => {
    const file = await host.openFile([
      { description: 'Lua scripts', accept: { 'text/plain': ['.lua'] } },
    ])
    if (!file) return
    const code = decodeText(await host.readFile(file))
    try {
      const loaded = await loadAutomationScript(code, file.name)
      const entry: LoadedAutomationEntry = {
        key: `${file.name}-${Date.now()}`,
        filename: file.name,
        code,
        ...loaded,
      }
      setAutomationScripts((current) => {
        const next = [...current, entry]
        void saveAutomationScripts(next.map(toStoredAutomation))
        return next
      })
      setStatus(`Automation: ${loaded.name} loaded (${loaded.macros.length} macros)`)
    } catch (error) {
      setStatus(
        `Automation load failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  const removeAutomationScript = (key: string) => {
    setAutomationScripts((current) => {
      const next = current.filter((script) => script.key !== key)
      void saveAutomationScripts(next.map(toStoredAutomation))
      return next
    })
  }

  const reloadAutomationScript = async (key: string) => {
    const script = automationScripts.find((item) => item.key === key)
    if (!script) return
    try {
      const loaded = await loadAutomationScript(script.code, script.filename)
      setAutomationScripts((current) =>
        current.map((item) => (item.key === key ? { ...item, ...loaded, error: undefined } : item)),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : tPlain('Failed to load script')
      setAutomationScripts((current) =>
        current.map((item) =>
          item.key === key ? { ...item, stateId: -1, macros: [], error: message } : item,
        ),
      )
    }
  }

  /** 宏命令入口：整表重放 + 以宏名为 undo描述（auto4_lua.cpp ProcessingComplete） */
  const runAutomationMacroById = async (id: string) => {
    if (!core || !coreRef.current) return
    const entry = automationScripts.find((script) => script.macros.some((macro) => macro.id === id))
    const macro = entry?.macros.find((item) => item.id === id)
    if (!entry || !macro || entry.stateId < 0) {
      setStatus(tPlain('Automation macro is not loaded'))
      return
    }
    const rows = buildLuaRows(core.document)
    const offset = rows.length - core.document.cues.length
    const cueIndex = (cueId: string) => core.document.cues.findIndex((cue) => cue.id === cueId)
    const selectedIndexes = selectedOrActive(core.document, selectedSet, activeId)
      .map((cueId) => cueIndex(cueId))
      .filter((index) => index >= 0)
    const activeIndex = activeId ? cueIndex(activeId) : -1
    try {
      const result = runAutomationMacro(
        entry.stateId,
        macro.name,
        rows,
        selectedIndexes,
        activeIndex,
        {
          width: Number(core.document.scriptInfo.PlayResX) || 640,
          height: Number(core.document.scriptInfo.PlayResY) || 480,
        },
      )
      const finalDialogues = result.rows
        .filter((row) => row.class === 'dialogue')
        .map(rowToCuePatch)
      const next = await apply([{ type: 'replaceCues', cues: finalDialogues }], macro.name)
      if (!next) return
      const toDialogueIndex = (full: number) => full - offset - 1
      if (result.selected?.length) {
        const ids = result.selected
          .map(toDialogueIndex)
          .filter((index) => index >= 0 && index < next.document.cues.length)
          .map((index) => next.document.cues[index].id)
        if (ids.length) setSelectedIds(new Set(ids))
      }
      if (result.active !== null) {
        const active = toDialogueIndex(result.active)
        if (active >= 0 && active < next.document.cues.length)
          setActiveId(next.document.cues[active].id)
      }
      setStatus(`Automation: ${macro.name}`)
    } catch (error) {
      setStatus(`Automation error: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const apply = useCallback(
    async (commands: CoreCommand[], label: string): Promise<CoreState | null> => {
      if (!coreRef.current) return null
      setBusy(true)
      try {
        const next = await coreRef.current.apply(commands, label)
        setCore(next)
        setDirty(true)
        // label 为源码 msgid（小写），经 tPlain 命中 po 翻译显示
        setStatus(tPlain(label))
        return next
      } catch (error) {
        setStatus(error instanceof Error ? error.message : tPlain('Edit failed'))
        return null
      } finally {
        setBusy(false)
      }
    },
    [setStatus],
  )

  useEffect(() => {
    if (!core || (activeId && core.document.cues.some((cue) => cue.id === activeId))) return
    const first = core.document.cues[0]?.id ?? null
    // 活动行被删除后回退到首行（文档结构变化同步）
    // oxlint-disable-next-line react/set-state-in-effect
    setActiveId(first)
    setSelectedIds(first ? new Set([first]) : new Set())
    anchorRef.current = first
  }, [activeId, core])

  const selectOnly = (id: string) => {
    setActiveId(id)
    setSelectedIds(new Set([id]))
    anchorRef.current = id
  }

  const moveSelection = (direction: number) => {
    if (!core || !activeId) return
    const index = core.document.cues.findIndex((cue) => cue.id === activeId)
    const next =
      core.document.cues[Math.max(0, Math.min(core.document.cues.length - 1, index + direction))]
    if (next) selectOnly(next.id)
  }

  const moveSelectionOrCreate = async () => {
    if (!core || !activeId) return
    const index = core.document.cues.findIndex((cue) => cue.id === activeId)
    const next = core.document.cues[index + 1]
    if (next) {
      selectOnly(next.id)
      return
    }
    const active = core.document.cues[index]
    if (!active) return
    const before = new Set(core.document.cues.map((cue) => cue.id))
    const state = await apply(
      [
        {
          type: 'addCue',
          afterId: active.id,
          cue: {
            startMs: active.endMs,
            endMs: active.endMs + getOptionInt('Timing/Default Duration'),
            style: active.style,
          },
        },
      ],
      tPlain('line insertion'),
    )
    const inserted = state?.document.cues.find((cue) => !before.has(cue.id))
    if (inserted) selectOnly(inserted.id)
  }

  // base_grid.cpp OnMouseEvent 对齐：
  // - ctrl+单击 = 切换勾选（若该行是唯一选中行则不动，避免空选），锚点行随活动行更新
  // - shift+单击 = 块选 anchor..row（活动行移到点击行，锚点保持）
  // - ctrl+shift = 现有选中 ∪ 块选
  const selectCue = (id: string, modifiers: { toggle: boolean; range: boolean }) => {
    if (!core) return
    if (modifiers.range && anchorRef.current) {
      const from = core.document.cues.findIndex((cue) => cue.id === anchorRef.current)
      const to = core.document.cues.findIndex((cue) => cue.id === id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        const block = core.document.cues.slice(start, end + 1).map((cue) => cue.id)
        setSelectedIds((current) => {
          if (!modifiers.toggle) return new Set(block)
          const next = new Set(current)
          for (const cueId of block) next.add(cueId)
          return next
        })
      }
      setActiveId(id)
    } else if (modifiers.toggle) {
      setSelectedIds((current) => {
        if (current.has(id) && current.size === 1) return current
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setActiveId(id)
      anchorRef.current = id
    } else selectOnly(id)
  }

  // 块选（拖动/shift 范围）：同 base_grid.cpp 块选分支——SetActiveLine 后把锚点恢复为 fromId
  const selectRange = (fromId: string, toId: string, union: boolean) => {
    if (!core) return
    const from = core.document.cues.findIndex((cue) => cue.id === fromId)
    const to = core.document.cues.findIndex((cue) => cue.id === toId)
    if (from < 0 || to < 0) return
    const [start, end] = from < to ? [from, to] : [to, from]
    const block = core.document.cues.slice(start, end + 1).map((cue) => cue.id)
    setSelectedIds((current) => {
      if (!union) return new Set(block)
      const next = new Set(current)
      for (const cueId of block) next.add(cueId)
      return next
    })
    setActiveId(toId)
    anchorRef.current = fromId
  }

  // ---- 最近文件（mru.cpp：打开即记录，可从 Recent 子菜单重新打开）----
  const recordRecent = async (type: RecentType, handle: AppFileHandle) => {
    const lists = await pushRecent(type, { name: handle.name, file: handle.file })
    setRecentLists(lists)
  }

  const openRecent = async (type: string, index: number) => {
    const recentType = RECENT_TYPES.includes(type as RecentType) ? (type as RecentType) : null
    if (!recentType) return
    const entry = recentLists[recentType][index]
    if (!entry) return
    if (!entry.file) {
      setStatus(`"${entry.name}" is no longer available`)
      return
    }
    const handle: AppFileHandle = { name: entry.name, file: entry.file }
    switch (recentType) {
      case 'subtitle':
        await openSubtitleHandle(handle)
        break
      case 'video':
        await openVideoHandle(handle)
        break
      case 'audio':
        await openAudioHandle(handle)
        break
      case 'timecodes':
        await openTimecodesHandle(handle)
        break
      case 'keyframes':
        await openKeyframesHandle(handle)
        break
    }
  }

  const openSubtitleHandle = async (file: AppFileHandle): Promise<boolean> => {
    if (!coreRef.current) return false
    setBusy(true)
    try {
      const bytes = await host.readFile(file)
      const state = await coreRef.current.open(bytes, file.name)
      setCore(state)
      setDirty(false)
      // Load()：新载入文档视为已自动保存（autosaved_commit_id = commit_id）
      lastAutosaveRevisionRef.current = state.document.revision
      const id = state.document.cues[0]?.id ?? null
      setActiveId(id)
      setSelectedIds(id ? new Set([id]) : new Set())
      anchorRef.current = id
      setVideoTimeMs(0)
      // App/Auto/Backup：打开成功后把原始文件备份为 .ORIGINAL（subs_controller.cpp Load）
      if (getOptionBool('App/Auto/Backup') && file.file) {
        void saveSubtitleBackup(file.name, decodeText(bytes)).catch(() => undefined)
      }
      setStatus(`Opened ${file.name}`)
      void recordRecent('subtitle', file)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not open subtitles'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const openSubtitles = async () => {
    const file = await host.openFile(SUBTITLE_FILE_TYPES)
    if (!file) return
    await openSubtitleHandle(file)
  }

  const newSubtitles = async () => {
    if (!coreRef.current) return
    // Subtitle/Default Resolution：Auto = 首个视频的分辨率，否则用选项宽高
    const auto = getOptionBool('Subtitle/Default Resolution/Auto')
    const resolution =
      auto && videoMedia
        ? { width: videoIntrinsicSize.width, height: videoIntrinsicSize.height }
        : {
            width: getOptionInt('Subtitle/Default Resolution/Width'),
            height: getOptionInt('Subtitle/Default Resolution/Height'),
          }
    const state = await coreRef.current.restore(createDocument('untitled.ass', resolution))
    setCore(state)
    setDirty(false)
    lastAutosaveRevisionRef.current = state.document.revision
    selectOnly(state.document.cues[0].id)
    setStatus(tPlain('New subtitles'))
  }

  const restoreAutosave = async () => {
    if (!coreRef.current) return
    try {
      const saved = await loadLatestAutosave()
      if (!saved?.document) {
        setStatus(tPlain('No autosave found'))
        return
      }
      const state = await coreRef.current.restore(saved.document)
      setCore(state)
      setDirty(true)
      const id = state.document.cues[0]?.id ?? null
      setActiveId(id)
      setSelectedIds(id ? new Set([id]) : new Set())
      setStatus(tPlain('Autosaved subtitles restored'))
    } catch {
      setStatus(tPlain('Could not restore autosave'))
    }
  }

  const saveSubtitles = async (format = core?.document.format) => {
    if (!coreRef.current || !core) return
    const output = await coreRef.current.export(format)
    const base = core.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'untitled'
    const extension = format === 'srt' ? 'srt' : 'ass'
    await host.saveFile(`${base}.${extension}`, output, {
      description: 'Subtitle',
      accept: { 'text/plain': [`.${extension}`] },
    })
    setDirty(false)
    // Save()：手动保存后视为已自动保存（autosaved_commit_id = saved_commit_id）
    lastAutosaveRevisionRef.current = core.document.revision
    // 保存后打断撤销合并链（subs_controller.cpp：saved_commit_id 使下一次提交不合并）
    coreRef.current.markSaved()
    setStatus(`Saved ${base}.${extension}`)
  }

  const openVideoHandle = async (file: AppFileHandle) => {
    const source = await host.openMedia(file)
    if (source.kind === 'audio') {
      URL.revokeObjectURL(source.url)
      setStatus(tPlain('The selected file does not contain video'))
      return
    }
    const previousVideo = videoMedia
    // Video/Open Audio（Preferences → Video → Options）：打开视频时是否自动挂载音轨
    const openAudio = getOptionBool('Video/Open Audio')
    if (openAudio) {
      const previousAudio = audioMedia
      setAudioMedia(source)
      setAudioTimeMs(0)
      setAudioDurationMs(0)
      if (previousAudio && previousAudio !== previousVideo) URL.revokeObjectURL(previousAudio.url)
    }
    setVideoMedia(source)
    setVideoTimeMs(0)
    setVideoDurationMs(0)
    setDetectedFps(null) // 新视频重新探测帧率
    setVideoFrameTimes(null) // 新视频重新扫描逐帧时间码表
    // 关键帧后台扫描（project.cpp：视频 provider 建索引提供 keyframes——是文件属性，
    // 与解码路径无关；原生 <video> 拿不到 chunk 类型，必须独立解复用扫描）。
    // ffindex 索引缓存对应物：同 crc32_大小_修改时间 的文件命中 IndexedDB 缓存免扫描
    keyframeScanIdRef.current += 1
    const scanId = keyframeScanIdRef.current
    const scanFile = file.file
    // 载入偏移提醒：偏移 > 每帧时长(1000/fps)的 1/5（如 24fps → 8.33ms）时弹窗，
    // 每次载入最多一次；本项目按主线语义归一化（首帧记 0），弹窗指引导出可保留偏移
    const maybeNoticeVideoOffset = (table: number[]) => {
      if (offsetNoticeShownRef.current === scanFile) return
      offsetNoticeShownRef.current = scanFile
      if (table.length < 2) return
      const offsetMs = table[0]
      if (offsetMs <= 0) return
      const fps = Framerate.fromTimecodes(table).fps()
      if (Number.isFinite(fps) && fps > 0 && offsetMs > 1000 / fps / 5)
        setVideoOffsetNotice({ offsetMs, frameDurationMs: 1000 / fps })
    }
    if (scanFile) {
      const scan: NonNullable<typeof videoScanRef.current> = {
        id: scanId,
        promise: null as unknown as Promise<void>,
        done: false,
        keyframeTimes: [],
        frameTimes: null,
      }
      videoScanRef.current = scan
      scan.promise = (async () => {
        let latest: number[] = []
        let latestFrames: number[] | null = null
        const cached = await loadCachedKeyframes(scanFile)
        if (keyframeScanIdRef.current !== scanId) return
        if (cached) {
          latest = cached.keyframeTimesMs ?? []
          // v2 条目附带逐帧时间码表；v1 旧条目（undefined）继续走扫描补全
          if (cached.frameTimesMs && cached.frameTimesMs.length >= 2)
            latestFrames = cached.frameTimesMs
          setVideoKeyframeTimes(latest)
          if (latestFrames) {
            setVideoFrameTimes(latestFrames)
            maybeNoticeVideoOffset(latestFrames)
            scan.done = true
            scan.keyframeTimes = latest
            scan.frameTimes = latestFrames
            return
          }
        }
        await extractVideoKeyframes(
          scanFile,
          (times) => {
            latest = times
            if (keyframeScanIdRef.current === scanId) setVideoKeyframeTimes(times)
          },
          () => keyframeScanIdRef.current !== scanId,
          (frames) => {
            latestFrames = frames
            if (keyframeScanIdRef.current === scanId) {
              setVideoFrameTimes(frames)
              maybeNoticeVideoOffset(frames)
            }
          },
        ).catch((error: unknown) => {
          // 容器打不开（罕见封装）时保持无关键帧/无表，不影响视频播放；日志便于诊断
          console.error('keyframe scan failed:', error)
        })
        if (keyframeScanIdRef.current !== scanId) return
        if (latest.length > 0) void storeCachedKeyframes(scanFile, latest, latestFrames ?? [])
        scan.done = true
        scan.keyframeTimes = latest
        scan.frameTimes = latestFrames
      })()
    }
    // 旧视频 URL 若仍被保留的音频引用（Video/Open Audio 关闭时）不能释放
    if (previousVideo && previousVideo !== audioMedia) URL.revokeObjectURL(previousVideo.url)
    setStatus(`Video: ${file.name}`)
    void recordRecent('video', file)
  }

  const openVideo = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES)
    if (!file) return
    await openVideoHandle(file)
  }

  const closeVideo = () => {
    if (videoMedia && videoMedia !== audioMedia) URL.revokeObjectURL(videoMedia.url)
    setVideoMedia(null)
    setVideoDurationMs(0)
    setVideoTimeMs(0)
    keyframeScanIdRef.current += 1 // 作废后台扫描
    setVideoKeyframeTimes([])
    setVideoFrameTimes(null)
    // project.cpp DoCloseVideo：无外部文件时回退为空关键帧/未加载 timecodes
    if (!keyframesFromFile) setKeyframes([])
    if (!timecodesFromFile) {
      setTimecodes(null)
      setFrameMode(false) // UpdateFrameTiming：fps 未加载时强制回退 Time 模式
    }
    setStatus(tPlain('Video closed'))
  }

  // ---- keyframes / timecodes 文件命令（command/keyframe.cpp、timecode.cpp）----
  const openKeyframesHandle = async (file: AppFileHandle) => {
    try {
      const list = parseKeyframes(decodeText(await host.readFile(file)))
      setKeyframes(list)
      setKeyframesFromFile(true)
      setStatus(`Keyframes: ${file.name} (${list.length} keyframes)`)
      void recordRecent('keyframes', file)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not parse keyframes'))
    }
  }

  const openKeyframes = async () => {
    const file = await host.openFile(KEYFRAME_FILE_TYPES)
    if (!file) return
    await openKeyframesHandle(file)
  }

  /** 保存时间码/关键帧前确保逐帧索引就绪：后台扫描对大文件可能要数十秒，未完成时
   *  同步等一次（源码 ffms2 打开视频即建全量索引，保存时必然可用）。返回 null 表示
   *  无视频文件或无关联扫描（保存走现有回退路径）。 */
  const ensureVideoIndex = async (): Promise<{
    keyframeTimes: number[]
    frameTimes: number[] | null
  } | null> => {
    const scan = videoScanRef.current
    if (!scan || scan.id !== keyframeScanIdRef.current) return null
    if (!scan.done) setStatus(tPlain('Indexing video...'))
    await scan.promise
    return { keyframeTimes: scan.keyframeTimes, frameTimes: scan.frameTimes }
  }

  const saveKeyframes = async () => {
    const base = core?.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'keyframes'
    let frames = activeKeyframes
    if (!keyframesFromFile) {
      // 源码关键帧帧号来自 provider 全量索引：等扫描完成后按逐帧表换算（ms→下界序号），
      // CFR 回退换算的帧号会整体错位（扫描未完成时 WC 上报的也只是已读流的部分列表）
      const index = await ensureVideoIndex()
      if (index) {
        const table = index.frameTimes
        frames =
          table && table.length >= 2
            ? index.keyframeTimes.map((ms) => lowerBoundIndex(table, ms))
            : index.keyframeTimes.map((ms) => frameRate.frameAtTime(ms))
      }
    }
    const data = new TextEncoder().encode(serializeKeyframes(frames))
    await host.saveFile(`${base}.key.txt`, data, {
      description: 'Keyframes',
      accept: { 'text/plain': ['.txt'] },
    })
    setStatus(tPlain('Keyframes saved'))
  }

  const closeKeyframes = () => {
    // project.cpp CloseKeyframes：回退到视频自带（activeKeyframes 派生自动切换）
    setKeyframesFromFile(false)
    setStatus(tPlain('Keyframes closed'))
  }

  const openTimecodesHandle = async (file: AppFileHandle) => {
    try {
      const rate = parseTimecodes(decodeText(await host.readFile(file)))
      setTimecodes(rate)
      setTimecodesFromFile(true)
      setStatus(`Timecodes: ${file.name} (${rate.frameCount()} frames)`)
      void recordRecent('timecodes', file)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not parse timecodes'))
    }
  }

  const openTimecodes = async () => {
    const file = await host.openFile(TIMECODES_FILE_TYPES)
    if (!file) return
    await openTimecodesHandle(file)
  }

  const doSaveTimecodes = async (keepOffset: boolean) => {
    setTimecodesOffsetAsk(null)
    const base = core?.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'timecodes'
    // 源码 timecode.cpp：provider ? provider->GetFrameCount() : -1——有视频就传帧数
    // （CFR 时 timecodes 表仅 [0] 哨兵，缺帧数会导出只含 1 行的废文件）
    // 保存值 = provider 逐帧表（FFMS2 TimecodesVector）：表未就绪先等扫描——CFR 回退
    // 的 numerator/2 四舍五入值与逐帧截断表必然不一致（如 24fps 表为 0,41,83,125…），
    // 是"保存时间码与 Aegisub 不一致"的根因
    const index = await ensureVideoIndex()
    const table = index?.frameTimes
    const rate = timecodes
      ? timecodes
      : table && table.length >= 2
        ? Framerate.fromTimecodes(table)
        : frameRate
    const providerFrameCount = videoMedia ? (table ? table.length : frameCount) : -1
    // 保留偏移 = 写原始 PTS 表（arch1t3cht fork b7d228c0ce 语义）；默认归一化到 0（主线）
    const data = new TextEncoder().encode(
      keepOffset && table && table.length >= 2
        ? serializeTimecodesKeepOffset(table, providerFrameCount)
        : serializeTimecodes(rate, providerFrameCount),
    )
    await host.saveFile(`${base}.timecodes.txt`, data, {
      description: 'Timecodes',
      accept: { 'text/plain': ['.txt'] },
    })
    setStatus(tPlain('Timecodes saved'))
  }

  const saveTimecodes = async () => {
    // 仅视频自带逐帧表可能带首帧偏移（外部 timecodes 文件与 CFR 回退在解析/构造时已定形）
    const index = await ensureVideoIndex()
    const table = index?.frameTimes
    if (!timecodes && table && table.length >= 2 && table[0] > 0) {
      setTimecodesOffsetAsk(table[0])
      return
    }
    await doSaveTimecodes(false)
  }

  const closeTimecodes = () => {
    setTimecodes(null)
    setTimecodesFromFile(false)
    setFrameMode(false)
    setStatus(tPlain('Timecodes closed'))
  }

  // ---- 拖放打开（frame_main.cpp AegisubFileDropTarget → project.cpp LoadList：
  // 按扩展名分类为字幕/视频/音频/timecodes/keyframes，各取第一个依次加载；
  // .txt/.log 依次尝试 timecodes → keyframes → 字幕。Web 扩展：字体文件缓存进
  // IndexedDB 字体库，渲染端立即可用）----
  const tryLoadTimecodesFile = async (file: File): Promise<boolean> => {
    try {
      const rate = parseTimecodes(decodeText(new Uint8Array(await file.arrayBuffer())))
      setTimecodes(rate)
      setTimecodesFromFile(true)
      setStatus(`Timecodes: ${file.name} (${rate.frameCount()} frames)`)
      void recordRecent('timecodes', { name: file.name, file })
      return true
    } catch {
      return false
    }
  }

  const tryLoadKeyframesFile = async (file: File): Promise<boolean> => {
    try {
      const list = parseKeyframes(decodeText(new Uint8Array(await file.arrayBuffer())))
      setKeyframes(list)
      setKeyframesFromFile(true)
      setStatus(`Keyframes: ${file.name} (${list.length} keyframes)`)
      void recordRecent('keyframes', { name: file.name, file })
      return true
    } catch {
      return false
    }
  }

  const handleDroppedFiles = async (fileList: FileList | File[]) => {
    if (busy) return
    const files = [...fileList]
    const extension = (file: File) => (/\.[^.]+$/.exec(file.name)?.[0] ?? '').toLowerCase()

    let subs: File | undefined
    let video: File | undefined
    let audio: File | undefined
    const fonts: File[] = []
    const plain: File[] = []
    for (const file of files) {
      const ext = extension(file)
      if (DROP_FONT_EXTS.includes(ext)) {
        fonts.push(file)
      } else if (ext === '.txt' || ext === '.log') {
        plain.push(file)
      } else {
        if (!subs && DROP_SUBS_EXTS.includes(ext)) subs = file
        if (!video && DROP_VIDEO_EXTS.includes(ext)) video = file
        if (!audio && DROP_AUDIO_EXTS.includes(ext)) audio = file
      }
    }

    // .txt/.log 可能是三者之一：依次尝试 timecodes → keyframes → 字幕
    // （LoadList 的顺序尝试语义，无法并行）
    for (const file of plain) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      if (await tryLoadTimecodesFile(file)) continue
      // oxlint-disable-next-line eslint/no-await-in-loop
      if (await tryLoadKeyframesFile(file)) continue
      if (!subs && extension(file) === '.txt') subs = file
    }

    if (fonts.length) {
      try {
        const added = await importFontFiles(fonts)
        logInfo('fonts', `Imported ${added} font face(s) from ${fonts.length} dropped file(s)`)
        setStatus(
          added
            ? `Imported ${added} font face${added === 1 ? '' : 's'}`
            : tPlain('Fonts already imported'),
        )
        // 重建渲染器：供给器重新扫描缓存，新字体经 addFonts 注册进 libass
        if (added) setLocalFontsEpoch((epoch) => epoch + 1)
      } catch (cause) {
        logError('fonts', `Font import failed: ${cause instanceof Error ? cause.message : cause}`)
      }
    }

    // 加载顺序对齐 LoadList：字幕 → 视频 → 音频（timecodes/keyframes 已在上面加载）
    if (subs) await openSubtitleHandle({ name: subs.name, file: subs })
    if (video) await openVideoHandle({ name: video.name, file: video })
    if (audio) await openAudioHandle({ name: audio.name, file: audio })
  }

  // ---- Select Lines（dialog_selection.cpp process + OnOK）----
  const applySelectLines = (settings: SelectLinesSettings, close: boolean) => {
    if (!core) return
    const { matchText, matchCase, mode, field, invert, dialogue, comments, action } = settings
    let matcher: (value: string) => boolean
    if (mode === 'regexp') {
      const regex = new RegExp(matchText, matchCase ? '' : 'i')
      matcher = (value) => regex.test(value)
    } else if (mode === 'exact') {
      matcher = matchCase
        ? (value) => value === matchText
        : (value) => value.toLowerCase() === matchText.toLowerCase()
    } else {
      matcher = matchCase
        ? (value) => value.includes(matchText)
        : (value) => value.toLowerCase().includes(matchText.toLowerCase())
    }
    const matches = new Set(
      core.document.cues
        .filter((cue) => (cue.comment ? comments : dialogue))
        .filter((cue) => matcher(cue[field]) !== invert)
        .map((cue) => cue.id),
    )
    // Action：SET / ADD / SUB / INTERSECT（活动行保持不变）
    let nextSelection: Set<string>
    if (action === 'set') nextSelection = matches
    else if (action === 'add') nextSelection = new Set([...selectedSet, ...matches])
    else if (action === 'sub')
      nextSelection = new Set([...selectedSet].filter((id) => !matches.has(id)))
    else nextSelection = new Set([...selectedSet].filter((id) => matches.has(id)))
    setSelectedIds(nextSelection)
    if (close) setDialog(null)
    setStatus(`Selected ${nextSelection.size} line${nextSelection.size === 1 ? '' : 's'}`)
  }

  // ---- Export Subtitles（dialog_export.cpp 的 Web 版子集）----
  const applyExport = (options: ExportOptions) => {
    if (!core) return
    const doc = options.includeComments
      ? core.document
      : { ...core.document, cues: core.document.cues.filter((cue) => !cue.comment) }
    const output = exportSubtitle(doc, options.format)
    const base = core.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'untitled'
    const extension = options.format === 'srt' ? 'srt' : 'ass'
    void host.saveFile(`${base}.${extension}`, new TextEncoder().encode(output), {
      description: 'Subtitle',
      accept: { 'text/plain': [`.${extension}`] },
    })
    setDialog(null)
    setStatus(`Exported ${base}.${extension}`)
  }

  const openAudioHandle = async (file: AppFileHandle) => {
    // 音频命令可以打开含音轨的视频文件（<audio> 元素可播视频容器的音轨）
    const source = await host.openMedia(file)
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(source)
    setAudioTimeMs(0)
    setAudioDurationMs(0)
    setStatus(`Audio: ${file.name}`)
    void recordRecent('audio', file)
  }

  const openAudio = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES)
    if (!file) return
    await openAudioHandle(file)
  }

  const openAudioFromVideo = () => {
    if (!videoMedia) {
      setStatus(tPlain('Open a video first'))
      return
    }
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(videoMedia)
    setAudioTimeMs(0)
    setAudioDurationMs(videoDurationMs)
    setStatus(tPlain('Audio loaded from video'))
  }

  const closeAudio = () => {
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(null)
    setAudioDurationMs(0)
    setAudioTimeMs(0)
    setStatus(tPlain('Audio closed'))
  }

  const sendVideoAction = (type: string) =>
    setVideoAction((current) => ({ sequence: current.sequence + 1, type }))
  const sendAudioAction = (type: string) =>
    setAudioAction((current) => ({ sequence: current.sequence + 1, type }))

  const findNext = async () => {
    if (!core || !findQuery.trim()) {
      setFindMode('find')
      return
    }
    try {
      const matches = (await coreRef.current?.search({ find: findQuery, field: 'text' })) ?? []
      if (!matches.length) {
        setStatus(`Not found: ${findQuery}`)
        return
      }
      const currentIndex = core.document.cues.findIndex((cue) => cue.id === activeId)
      let next = matches.find((match) => {
        const index = core.document.cues.findIndex((cue) => cue.id === match.id)
        return index >= 0 && index > currentIndex
      })
      if (!next) next = matches[0]
      const found = core.document.cues.find((cue) => cue.id === next?.id)
      if (found) {
        selectOnly(found.id)
        setStatus(`Found in line ${core.document.cues.indexOf(found) + 1}`)
      }
    } catch {
      setStatus(tPlain('Search failed'))
    }
  }

  const replaceCurrent = async () => {
    if (!selectedCue || !findQuery) return
    try {
      const matches = (await coreRef.current?.search({ find: findQuery, field: 'text' })) ?? []
      const match = matches.find((item) => item.id === selectedCue.id)
      if (match) {
        const text =
          selectedCue.text.slice(0, match.start) + replaceQuery + selectedCue.text.slice(match.end)
        void apply([{ type: 'updateCue', id: selectedCue.id, patch: { text } }], tPlain('replace'))
      } else {
        setStatus(tPlain('No match in current line'))
      }
    } catch {
      setStatus(tPlain('Replace failed'))
    }
  }

  const replaceAll = async () => {
    if (!core || !findQuery.trim()) return
    try {
      const count =
        (await coreRef.current?.replaceAll({
          find: findQuery,
          replaceWith: replaceQuery,
          field: 'text',
        })) ?? 0
      setStatus(`Replaced ${count} occurrence${count === 1 ? '' : 's'}`)
      const next = await coreRef.current?.state()
      if (next) setCore(next)
    } catch {
      setStatus(tPlain('Replace all failed'))
    }
  }

  const api: CommandApi = {
    apply,
    undo: async () => {
      const next = await coreRef.current?.undo()
      if (next) setCore(next)
    },
    redo: async () => {
      const next = await coreRef.current?.redo()
      if (next) setCore(next)
    },
    openSubtitles,
    newSubtitles,
    saveSubtitles: (format) => saveSubtitles(format),
    openVideo,
    closeVideo,
    openAudio,
    openAudioFromVideo,
    closeAudio,
    openDummyVideo: (options) => {
      if (videoMedia && videoMedia !== audioMedia) URL.revokeObjectURL(videoMedia.url)
      setVideoMedia({ name: 'Dummy Video', url: '', kind: 'video', dummy: options })
      setVideoDurationMs(options.lengthMs)
      setVideoTimeMs(0)
      keyframeScanIdRef.current += 1 // 作废旧视频扫描；dummy 无关键帧
      setVideoKeyframeTimes([])
      setStatus(`Dummy video ${options.width}×${options.height}`)
    },
    openSyntheticAudio: (kind) => {
      if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url)
      // Aegisub audio.cpp：150 分钟（ln=396900000 @ 44100Hz）
      const lengthMs = 9_000_000
      setAudioMedia({
        name: kind === 'blank' ? 'Blank Audio' : 'Noise Audio',
        url: '',
        kind: 'audio',
        syntheticAudio: { kind, durationMs: lengthMs },
      })
      setAudioDurationMs(lengthMs)
      setAudioTimeMs(0)
      setStatus(
        kind === 'blank' ? tPlain('2h30 blank audio loaded') : tPlain('2h30 noise audio loaded'),
      )
    },
    setVideoTime: setVideoTimeMs,
    setAudioTime: setAudioTimeMs,
    setStatus,
    sendVideoAction,
    sendAudioAction,
    moveSelection,
    moveSelectionOrCreate: () => void moveSelectionOrCreate(),
    selectLines: (ids) => {
      setActiveId(ids[0] ?? null)
      setSelectedIds(new Set(ids))
      anchorRef.current = ids[0] ?? null
    },
    openFind: (mode) => setFindMode(mode),
    findNext,
    replaceCurrent,
    replaceAll,
    openStyleManager: () => setShowStyleManager(true),
    openDialog: (kind) => setDialog(kind),
    setToolbarVisible: (value) => {
      setToolbarVisible(value)
      setOption('App/Show Toolbar', value)
    },
    setAudioView: (view) => {
      setAudioView(view)
      setOption('Audio/Spectrum', view === 'spectrum')
    },
    // 音频开关同时持久化（audio.cpp 各 toggle 命令写 OPT_SET；karaoke 为会话状态）
    setAudioOption: (option, value) => {
      setAudioOptions((current) => ({ ...current, [option]: value }))
      const optionName = AUDIO_TOGGLE_OPTIONS[option]
      if (optionName) setOption(optionName, value)
    },
    setVideoAutoScroll: (value) => {
      setVideoAutoScroll(value)
      setOption('Video/Subtitle Sync', value)
    },
    setGridTags: (mode) => {
      setGridTags(mode)
      setOption('Subtitle/Grid/Hide Overrides', mode === 'hide' ? 2 : mode === 'show' ? 0 : 1)
    },
    setDisplayMode,
    setVideoOverscan,
    setAspectOverride,
    restoreAutosave: () => void restoreAutosave(),
    toggleLog: () => setLogWindowOpen((open) => !open),
    openKeyframes: () => void openKeyframes(),
    saveKeyframes: () => void saveKeyframes(),
    closeKeyframes,
    openTimecodes: () => void openTimecodes(),
    saveTimecodes: () => void saveTimecodes(),
    closeTimecodes,
    setFrameMode,
    openRecent: (type, index) => void openRecent(type, index),
    saveBinary: (name, data, description, extension) => {
      void host.saveFile(name, data, {
        description,
        accept: { 'application/octet-stream': [extension] },
      })
    },
  }

  const commandContext = (): CommandContext | null => {
    if (!core) return null
    return {
      core,
      selected: selectedOrActive(core.document, selectedSet, activeId),
      activeCue: selectedCue,
      videoMedia,
      audioMedia,
      videoTimeMs,
      videoDurationMs,
      audioTimeMs,
      audioDurationMs,
      audioView,
      audioOptions,
      audioPlaying,
      videoAutoScroll,
      gridTags,
      displayMode,
      toolbarVisible,
      videoOverscan,
      aspectOverride,
      frameRate,
      currentFrame,
      frameCount,
      keyframes: activeKeyframes,
      keyframesFromFile,
      timecodesFromFile,
      frameMode: frameMode && frameRate.isLoaded(),
    }
  }

  const executeCommand = (id: string) => {
    // Automation 宏命令（automation/lua/<脚本>/<宏名>）
    if (id.startsWith('automation/lua/')) {
      void runAutomationMacroById(id)
      return
    }
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    if (!ctx || !def) {
      setStatus(tPlain('This command is not available in the web build'))
      return
    }
    if (def.enabled && !def.enabled(ctx)) return
    void def.run(ctx, api)
  }
  // 键盘事件处理器经 ref 读取最新命令实现（渲染后同步）
  useEffect(() => {
    executeRef.current = executeCommand
  })

  const isCommandEnabled = (id: string) => {
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    return Boolean(ctx && def && (!def.enabled || def.enabled(ctx)))
  }

  const isCommandChecked = (id: string) => {
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    return Boolean(ctx && def?.checked?.(ctx))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement
      // 编辑守卫只拦文本输入类（源码 wxTextCtrl 全消费）；range/checkbox/radio 在
      // wxSLIDER/wxCHKBUTTON 语义下仅消费自身导航键、其余键向上传播（wx 事件 Skip）
      const editing = target.matches(
        'input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"]), textarea, select, [contenteditable="true"]',
      )
      const isRangeSlider = target.matches('input[type="range"]')
      const contextElement = target.closest<HTMLElement>('[data-shortcut-context]')
      const context = (contextElement?.dataset.shortcutContext ?? 'Default') as ShortcutContext
      const shortcut = shortcutFromKeyboardEvent(event)
      // 滑条聚焦时导航键由原生控件消费（源码 wxSlider 先吃掉方向键再传播）
      if (
        isRangeSlider &&
        (shortcut === 'Left' ||
          shortcut === 'Right' ||
          shortcut === 'Up' ||
          shortcut === 'Down' ||
          shortcut === 'Home' ||
          shortcut === 'End' ||
          shortcut === 'PageUp' ||
          shortcut === 'PageDown')
      )
        return
      const command = commandForShortcut(shortcut, context)
      const isSubtitleEditor = context === 'Subtitle Edit Box'
      const nativeEditingCommands = new Set([
        'edit/line/cut',
        'edit/line/copy',
        'edit/line/paste',
        'edit/undo',
        'edit/redo',
        'subtitle/select/all',
      ])
      if (command && (!editing || (isSubtitleEditor && !nativeEditingCommands.has(command)))) {
        event.preventDefault()
        executeRef.current(command)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!core)
    return (
      <main className="loading-screen">
        <Captions size={30} />
        <span>{tPlain('Loading Aegisub Web')}</span>
      </main>
    )

  return (
    <main
      className={`app-shell${toolbarVisible ? '' : ' toolbar-hidden'}`}
      style={{ '--icon-size': `${getOptionInt('App/Toolbar Icon Size')}px` } as CSSProperties}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer?.files?.length) void handleDroppedFiles(event.dataTransfer.files)
      }}
    >
      <MenuBar
        projectName={core.document.sourceName}
        recentLists={recentLists}
        automationMacros={automationScripts.flatMap((script) =>
          script.error ? [] : script.macros.map((macro) => ({ id: macro.id, name: macro.name })),
        )}
        undoLabel={core.undoLabel}
        redoLabel={core.redoLabel}
        onCommand={executeCommand}
        isCommandEnabled={isCommandEnabled}
        isCommandChecked={isCommandChecked}
      />
      {toolbarVisible && (
        <Toolbar
          onCommand={executeCommand}
          isCommandEnabled={isCommandEnabled}
          isCommandChecked={isCommandChecked}
        />
      )}
      <div
        className="workspace"
        style={
          displayMode === 'full' || displayMode === 'video_subs'
            ? {
                // video_box.cpp 挂靠 TopSizer proportion 0：视频栏高度=精确最小高（display+56），
                // 多余空间全给 Grid（proportion 1）；窗口放不下时整体被窗口裁剪（wx 布局子项
                // 永不小于 min size）。无视频的占位面板与移动端仍按视口钳制以保持紧凑
                gridTemplateRows:
                  videoMedia && !isNarrowViewport
                    ? `${videoLayout.panelHeight}px minmax(120px, 1fr)`
                    : `min(${videoLayout.panelHeight}px, calc(100dvh - 194px)) minmax(120px, 1fr)`,
              }
            : undefined
        }
      >
        <div className="top-workspace">
          {(displayMode === 'full' || displayMode === 'video_subs') && (
            <PreviewPane
              document={core.document}
              media={videoMedia}
              currentTimeMs={videoTimeMs}
              activeCue={selectedCue}
              onTimeChange={setVideoTimeMs}
              onDurationChange={setVideoDurationMs}
              onOpenMedia={() => void openVideo()}
              mediaAction={videoAction}
              onCommand={executeCommand}
              onPatchCue={(id, patch, label) => apply([{ type: 'updateCue', id, patch }], label)}
              onPatchCues={(patches, label) =>
                apply(
                  patches.map(({ id, patch }) => ({ type: 'updateCue', id, patch })),
                  label,
                )
              }
              selectedCues={selectedCues}
              onPatchStyle={(id, patch, label) =>
                void apply([{ type: 'updateStyle', id, patch }], label)
              }
              isCommandEnabled={isCommandEnabled}
              isCommandChecked={isCommandChecked}
              windowZoom={videoWindowZoom}
              devicePixelRatio={devicePixelRatioValue}
              onWindowZoomChange={setVideoWindowZoom}
              onIntrinsicSizeChange={setIntrinsicSizeStable}
              localFontsEpoch={localFontsEpoch}
              onLocalFontsAuthorize={() => setLocalFontsEpoch((epoch) => epoch + 1)}
              intrinsicWidth={videoIntrinsicSize.width}
              intrinsicHeight={videoIntrinsicSize.height}
              overscan={videoOverscan}
              keyframes={activeKeyframes}
              currentFrame={currentFrame}
              frameRate={frameRate}
              frameCount={frameCount}
              onDetectedFps={setDetectedFps}
              onPlaybackModeChange={setVideoPlaybackMode}
              decoderOverride={videoDecoderOverride}
              playbackGain={playbackGain}
              onKeyframesChange={(list) => {
                // WebCodecs 读流上报的也是时间（ms）；统一走派生换算，文件关键帧优先。
                // 后台解复用扫描是全量索引（ffms2 语义）：进行中或已有完整结果时，
                // 不得被 WebCodecs 渐进列表（只覆盖已读流片段）覆盖——扫描失败才作回退
                if (keyframesFromFile) return
                const scan = videoScanRef.current
                if (scan && scan.id === keyframeScanIdRef.current) {
                  if (!scan.done || scan.keyframeTimes.length > 0) return
                }
                setVideoKeyframeTimes(list)
                // 写入关键帧缓存（覆盖解复用扫描未覆盖的 WebCodecs-only 路径）
                if (videoMedia?.file && list.length > 0)
                  void storeCachedKeyframes(videoMedia.file, list)
              }}
              // video_display.cpp FitClientSizeToVideo：SetMinClientSize = SetMaxClientSize =
              // video×zoom → 显示框锁定尺寸，窗口变窄也不收缩（flex-shrink: 0），溢出由窗口裁剪。
              // 无视频的占位面板保持可收缩（basis 撑开、shrink 挤压）；移动端走 styles.css 的
              // 固定高度预览布局（@media 覆盖），不传内联尺寸
              style={
                isNarrowViewport
                  ? undefined
                  : videoMedia
                    ? { flexBasis: `${videoLayout.panelWidth}px`, flexShrink: 0 }
                    : { flexBasis: `${videoLayout.panelWidth}px` }
              }
            />
          )}
          <div
            className="right-workspace"
            style={
              // 源码 AudioBox 恒有底边 sash（SetSashVisible(wxSASH_BOTTOM, true)），
              // 与是否加载音频无关；video_subs 布局无音频框才没有
              !isNarrowViewport && displayMode !== 'video_subs'
                ? { gridTemplateRows: `${audioBoxHeight}px 4px minmax(0, 1fr)` }
                : undefined
            }
          >
            {(displayMode === 'full' || displayMode === 'audio_subs') && (
              <AudioPane
                media={audioMedia}
                durationMs={audioDurationMs}
                currentTimeMs={audioTimeMs}
                videoTimeMs={videoMedia ? videoTimeMs : null}
                selectedCue={selectedCue}
                cues={core.document.cues}
                keyframes={activeKeyframes}
                fps={frameRate.isLoaded() ? frameRate.fps() : DEFAULT_FPS}
                karaokeMode={audioOptions.karaoke}
                view={audioView}
                options={audioOptions}
                playing={audioPlaying}
                onViewChange={setAudioView}
                onPlayingChange={setAudioPlaying}
                isCommandEnabled={isCommandEnabled}
                isCommandChecked={isCommandChecked}
                onSeek={setAudioTimeMs}
                onVideoSeek={setVideoTimeMs}
                mediaAction={audioAction}
                scrollToActiveLine={audioScrollRequest}
                onDurationChange={setAudioDurationMs}
                onCommand={executeCommand}
                onPlaybackGainChange={setPlaybackGain}
                onPatchCue={(id, patch, label) => apply([{ type: 'updateCue', id, patch }], label)}
              />
            )}
            {!isNarrowViewport && displayMode !== 'video_subs' && (
              <div
                className="audio-sash"
                role="separator"
                aria-orientation="horizontal"
                aria-label={tPlain('Audio box resize sash')}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  // OnSashDrag：new_height = min(dragRect.height, 父窗口高 - 1)；
                  // 上限按 EditPanel 保留 150px（源码 sizer min size 防挤没）
                  const workspace = event.currentTarget.parentElement
                  audioSashDragRef.current = {
                    startY: event.clientY,
                    startHeight: audioBoxHeight,
                    maxHeight: Math.max(120, (workspace?.clientHeight ?? 600) - 154),
                    current: audioBoxHeight,
                  }
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                  const drag = audioSashDragRef.current
                  if (!drag) return
                  const height = Math.round(
                    Math.max(
                      80,
                      Math.min(drag.startHeight + event.clientY - drag.startY, drag.maxHeight),
                    ),
                  )
                  drag.current = height
                  setAudioBoxHeight(height)
                }}
                onPointerUp={() => {
                  const drag = audioSashDragRef.current
                  if (!drag) return
                  audioSashDragRef.current = null
                  // OPT_SET("Audio/Display Height")：拖动结束后持久化
                  setOption('Audio/Display Height', drag.current)
                }}
                onPointerCancel={() => {
                  audioSashDragRef.current = null
                }}
              />
            )}
            <EditPanel
              cue={selectedCue}
              styles={core.document.styles}
              actors={actorValues}
              effects={effectValues}
              frameRate={frameRate}
              frameMode={frameMode && frameRate.isLoaded()}
              onFrameModeChange={setFrameMode}
              onCommit={(patch, label) => {
                if (selectedCue)
                  void apply([{ type: 'updateCue', id: selectedCue.id, patch }], label)
              }}
              onCommand={executeCommand}
              isCommandEnabled={isCommandEnabled}
              onEditStyle={() => {
                setStyleManagerAutoEdit(true)
                setShowStyleManager(true)
              }}
            />
          </div>
        </div>
        <SubtitleGrid
          cues={core.document.cues}
          activeId={activeId}
          selectedIds={selectedSet}
          currentTimeMs={videoTimeMs}
          textMode={gridTags}
          frameRate={frameRate}
          frameMode={frameMode && frameRate.isLoaded()}
          hasVideo={!!videoMedia}
          onSelect={selectCue}
          onSelectRange={selectRange}
          getAnchorId={() => anchorRef.current}
          onActivate={(cue) => {
            selectOnly(cue.id)
            // base_grid.cpp 双击：audioBox->ScrollToActiveLine()（无条件，不受
            // Audio/Auto/Scroll 开关限制）+ videoController->JumpToTime(dlg->Start)
            // （START 帧语义）
            setAudioScrollRequest((n) => n + 1)
            seekVideoToLineStart(cue.startMs)
          }}
          // alt+方向键仅移活动行：锚点行随活动行更新（OnActiveLineChanged → extendRow）
          onSetActive={(id) => {
            setActiveId(id)
            anchorRef.current = id
          }}
          onCommand={executeCommand}
          isCommandEnabled={isCommandEnabled}
        />
      </div>
      {logWindowOpen && <LogPanel onClose={() => setLogWindowOpen(false)} />}

      <footer className="app-footer">
        {/* Aegisub CreateStatusBar(2)：field 0（左）源码从不写入，field 1（右）承载
            StatusTimeout 的临时消息（到点 OnStatusClear 清空） */}
        <span className={`status-indicator${busy ? ' busy' : ''}`} />
        <span className="status-info">
          {core.runtime === 'wasm' ? tPlain('Aegisub core') : tPlain('Web core')}
        </span>
        {/* 视频解码器指示（可点击切换：原生 ↔ WebCodecs） */}
        {videoPlaybackMode && (
          <button
            type="button"
            className="status-decoder"
            title="点击切换视频解码器（原生 ↔ WebCodecs）"
            onClick={() => setVideoDecoderOverride(videoPlaybackMode !== 'webcodecs')}
          >
            {tPlain('Decoder: ')}
            {videoPlaybackMode === 'native' ? tPlain('Native') : 'WebCodecs'}
          </button>
        )}
        <span className="status-message">{status === 'Ready' ? tPlain('Ready') : status}</span>
      </footer>

      {showStyleManager && (
        <StyleManagerDialog
          styles={core.document.styles}
          activeStyleName={selectedCue?.style ?? core.document.styles[0]?.name ?? ''}
          autoEdit={styleManagerAutoEdit}
          onClose={() => {
            setShowStyleManager(false)
            setStyleManagerAutoEdit(false)
          }}
          onUpdate={(id, patch, label) =>
            void apply([{ type: 'updateStyle', id, patch }], tPlain(label ?? 'style change'))
          }
          onAdd={(style, label) =>
            void apply([{ type: 'addStyle', style }], tPlain(label ?? 'style change'))
          }
          onDelete={(ids) =>
            ids.forEach((id) => void apply([{ type: 'deleteStyle', id }], tPlain('style delete')))
          }
          onReorder={(ids) => void apply([{ type: 'reorderStyles', ids }], tPlain('style move'))}
        />
      )}

      {findMode && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="app-dialog find-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={findMode === 'replace' ? tPlain('Find and Replace') : tPlain('Find')}
            onSubmit={(event) => {
              event.preventDefault()
              findNext()
            }}
          >
            <header>
              <strong>
                {findMode === 'replace' ? tPlain('Find and Replace') : tPlain('Find')}
              </strong>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setFindMode(null)}
                title={tPlain('Close')}
                aria-label={tPlain('Close')}
              >
                <X size={16} />
              </button>
            </header>
            <div className="dialog-fields">
              <label>
                {tPlain('Find what:')}
                <input
                  autoFocus
                  value={findQuery}
                  onChange={(event) => setFindQuery(event.target.value)}
                />
              </label>
              {findMode === 'replace' && (
                <label>
                  {tPlain('Replace with:')}
                  <input
                    value={replaceQuery}
                    onChange={(event) => setReplaceQuery(event.target.value)}
                  />
                </label>
              )}
            </div>
            <footer>
              {findMode === 'replace' && (
                <>
                  <button type="button" onClick={replaceCurrent}>
                    {tPlain('Replace')}
                  </button>
                  <button type="button" onClick={replaceAll}>
                    {tPlain('Replace all')}
                  </button>
                </>
              )}
              <button type="submit">{tPlain('Find Next')}</button>
              <button type="button" onClick={() => setFindMode(null)}>
                {tPlain('Cancel')}
              </button>
            </footer>
          </form>
        </div>
      )}

      {dialog === 'shift' && core && (
        <ShiftTimesDialog
          cues={core.document.cues}
          selectedIds={selectedOrActive(core.document, selectedSet, activeId)}
          onClose={() => setDialog(null)}
          onApply={(commands, label) => void apply(commands, label)}
        />
      )}
      {dialog === 'jump' && (
        <JumpToDialog
          currentTimeMs={videoTimeMs}
          durationMs={videoDurationMs}
          onClose={() => setDialog(null)}
          onJump={setVideoTimeMs}
        />
      )}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog === 'video-details' && videoMedia && (
        <VideoDetailsDialog
          media={videoMedia}
          durationMs={videoDurationMs}
          fps={frameRate.isLoaded() ? frameRate.fps() : null}
          frameCount={frameCount}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'dummy-video' && core && (
        <DummyVideoDialog
          onClose={() => setDialog(null)}
          onApply={(options) => api.openDummyVideo(options)}
        />
      )}
      {dialog === 'properties' && core && (
        <ScriptPropertiesDialog
          scriptInfo={core.document.scriptInfo}
          onClose={() => setDialog(null)}
          onApply={(patch) =>
            void apply([{ type: 'updateScriptInfo', patch }], tPlain('property changes'))
          }
        />
      )}
      {dialog === 'styling-assistant' && selectedCue && (
        <StylingAssistantDialog
          cue={selectedCue}
          styles={core.document.styles}
          onClose={() => setDialog(null)}
          onApply={(style, next) => {
            void apply(
              [{ type: 'updateCue', id: selectedCue.id, patch: { style } }],
              tPlain('styling assistant'),
            )
            if (next) moveSelection(1)
          }}
          onPrevious={() => moveSelection(-1)}
          onPlay={() => {
            setVideoTimeMs(selectedCue.startMs)
            sendVideoAction('play')
          }}
        />
      )}
      {dialog === 'attachments' && <AttachmentDialog onClose={() => setDialog(null)} />}
      {dialog === 'font-collector' && core && (
        <FontCollectorDialog
          styles={core.document.styles}
          text={core.document.cues.map((cue) => cue.text).join('\n')}
          onLocalFontsAuthorized={() => setLocalFontsEpoch((epoch) => epoch + 1)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'translation' && selectedCue && (
        <TranslationDialog
          cue={selectedCue}
          onApply={(text) =>
            void apply(
              [{ type: 'updateCue', id: selectedCue.id, patch: { text } }],
              tPlain('translation assistant'),
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'select-lines' && (
        <SelectLinesDialog onClose={() => setDialog(null)} onApply={applySelectLines} />
      )}
      {dialog === 'export' && (
        <ExportSubtitlesDialog onClose={() => setDialog(null)} onApply={applyExport} />
      )}
      {dialog === 'resample' && core && (
        <ResampleDialog
          scriptInfo={core.document.scriptInfo}
          onApply={(patch) =>
            void apply([{ type: 'updateScriptInfo', patch }], tPlain('resolution resampling'))
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'automation' && (
        <AutomationManagerDialog
          scripts={automationScripts.map((script) => ({
            id: script.key,
            name: script.name,
            description: script.description,
            filename: script.filename,
            macros: script.macros.map((macro) => macro.name),
            error: script.error,
          }))}
          onAdd={() => void addAutomationScript()}
          onRemove={removeAutomationScript}
          onReload={(key) => void reloadAutomationScript(key)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'timing-postprocess' && core && (
        <TimingProcessorDialog
          cues={core.document.cues}
          styles={core.document.styles.map((style) => style.name)}
          selectedIds={[...selectedSet]}
          keyframes={activeKeyframes}
          frameCount={frameCount}
          hasVideo={!!videoMedia}
          frameRate={frameRate}
          onClose={() => setDialog(null)}
          onApply={(commands, label) => void apply(commands, label)}
        />
      )}
      {dialog === 'kanji-timer' && (
        <ToolInfoDialog
          title={tPlain('Kanji Timer')}
          message={tPlain(
            'Kanji timing requires paired source and destination karaoke lines. Select the lines in Aegisub desktop for the complete matcher workflow.',
          )}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'spellcheck' && (
        <ToolInfoDialog
          title={tPlain('Spell Checker')}
          message={tPlain(
            'Browser spell checking is enabled directly in the subtitle edit box. Right-click a misspelled word to use the browser dictionary.',
          )}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'options' && <PreferencesDialog onClose={() => setDialog(null)} />}
      {dialog === 'language' && <LanguageDialog onClose={() => setDialog(null)} />}
      {videoOffsetNotice && (
        <VideoOffsetNoticeDialog
          offsetMs={videoOffsetNotice.offsetMs}
          frameDurationMs={videoOffsetNotice.frameDurationMs}
          onClose={() => setVideoOffsetNotice(null)}
        />
      )}
      {timecodesOffsetAsk !== null && (
        <TimecodesOffsetDialog
          offsetMs={timecodesOffsetAsk}
          onChoice={(keep) => void doSaveTimecodes(keep)}
          onClose={() => setTimecodesOffsetAsk(null)}
        />
      )}
    </main>
  )
}
