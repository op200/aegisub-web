import { useCallback, useEffect, useRef, useState } from 'react'

import { getOptionInt, setOption } from '../../config/options'
import type { SubtitleCue } from '../../core/types'
import { WebCodecsAudioPlayer } from '../../media/webcodecsAudio'
import type { MediaSource } from '../../platform/types'
import { aegisubIconUrl, commandIcon } from '../aegisubIcons'
import { AEGISUB_TOOLBARS } from '../aegisubToolbar'
import type { AudioOptions } from '../commandRegistry'
import { commandTooltip } from '../commands'
import { tPlain } from '../i18n'
import { KaraokeBar, type KaraokeBarHandle } from './KaraokeBar'
import { Waveform } from './Waveform'

interface AudioPaneProps {
  media: MediaSource | null
  durationMs: number
  currentTimeMs: number
  videoTimeMs: number | null
  selectedCue: SubtitleCue | null
  /** 全部行（Audio/Inactive Lines Display Mode 的非活动行绘制） */
  cues: SubtitleCue[]
  /** 关键帧列表（Audio/Display/Draw/Keyframes in * Mode） */
  keyframes: number[]
  /** 视频帧率（关键帧帧号 → 时间换算） */
  fps: number
  /** audio/karaoke 开关（卡拉OK模式关键帧用独立开关控制） */
  karaokeMode: boolean
  view: 'waveform' | 'spectrum'
  options: AudioOptions
  playing: boolean
  onViewChange: (view: 'waveform' | 'spectrum') => void
  onPlayingChange: (playing: boolean) => void
  isCommandEnabled: (id: string) => boolean
  isCommandChecked: (id: string) => boolean
  onSeek: (timeMs: number) => void
  onVideoSeek: (timeMs: number) => void
  mediaAction: { sequence: number; type: string }
  /** 双击网格行的 ScrollToActiveLine 请求（App nonce，Waveform 无条件滚到活动行） */
  scrollToActiveLine: number
  onDurationChange: (durationMs: number) => void
  onPatchCue: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void
  onCommand: (id: string) => void
}

/** 音频工具栏中的开关型按钮 */
const TOGGLES = new Set([
  'audio/opt/autocommit',
  'audio/opt/autonext',
  'audio/opt/autoscroll',
  'audio/opt/spectrum',
  'audio/opt/vertical_link',
  'audio/karaoke',
  'app/toggle/global_hotkeys',
])

export function AudioPane(props: AudioPaneProps) {
  const {
    currentTimeMs,
    durationMs,
    media,
    mediaAction,
    onPlayingChange,
    onSeek,
    options,
    playing,
    selectedCue,
    view,
    onViewChange,
  } = props
  // 滑块初值来自 Options（audio_box.cpp 构造时 OPT_GET），拖动时防抖写回（OPT_SET）
  const [hZoom, setHZoom] = useState(() => getOptionInt('Audio/Zoom/Horizontal')) // 0 → -50..30 滑块
  const [vZoom, setVZoom] = useState(() => getOptionInt('Audio/Zoom/Vertical')) // 0..100
  const [volume, setVolume] = useState(() => getOptionInt('Audio/Volume'))
  const linked = props.options.verticalLink
  const displayedVolume = linked ? vZoom : volume
  const audioRef = useRef<HTMLAudioElement>(null)
  const playEndRef = useRef<number | null>(null)
  const syntheticContextRef = useRef<AudioContext | null>(null)
  const syntheticSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const syntheticGainRef = useRef<GainNode | null>(null)
  const syntheticGenerationRef = useRef(0)
  const handledAudioActionRef = useRef(0)
  // <audio> 解码失败（mkv 等）→ WebCodecs 分段播放器回退
  const [wcAudioMode, setWcAudioMode] = useState(false)
  // 媒体更换时在渲染期复位回退模式（render-phase state adjustment）
  const [wcAudioMedia, setWcAudioMedia] = useState(media)
  if (wcAudioMedia !== media) {
    setWcAudioMedia(media)
    setWcAudioMode(false)
  }
  const wcPlayerRef = useRef<WebCodecsAudioPlayer | null>(null)
  const wcEpochRef = useRef(0)
  // 卡拉OK条（audio/karaoke toggle 显示；audio/commit 提交未提交修改）
  const karaokeRef = useRef<KaraokeBarHandle>(null)
  const [karaokePending, setKaraokePending] = useState(false)

  const stopSyntheticAudio = useCallback(() => {
    syntheticGenerationRef.current += 1
    const source = syntheticSourceRef.current
    syntheticSourceRef.current = null
    if (source) {
      try {
        source.stop()
      } catch {
        // The source may already have stopped at a range boundary.
      }
      source.disconnect()
    }
    syntheticGainRef.current?.disconnect()
    syntheticGainRef.current = null
  }, [])

  const startSyntheticAudio = useCallback(
    async (kind: 'blank' | 'noise', volumePercent: number) => {
      stopSyntheticAudio()
      const generation = syntheticGenerationRef.current
      const previousContext = syntheticContextRef.current
      const context =
        !previousContext || previousContext.state === 'closed'
          ? new AudioContext()
          : previousContext
      syntheticContextRef.current = context
      if (context.state === 'suspended') await context.resume()
      if (generation !== syntheticGenerationRef.current) return false
      const sampleRate = context.sampleRate
      const buffer = context.createBuffer(1, sampleRate * 2, sampleRate)
      const samples = buffer.getChannelData(0)
      if (kind === 'noise') {
        // DummyAudioProvider 按需产生白噪声；短循环缓冲避免分配 150 分钟 PCM。
        let state = 0x6d2b79f5
        for (let index = 0; index < samples.length; index++) {
          state ^= state << 13
          state ^= state >>> 17
          state ^= state << 5
          samples[index] = ((state >>> 0) / 0x80000000 - 1) * 0.35
        }
      }
      const source = context.createBufferSource()
      const gain = context.createGain()
      syntheticGainRef.current = gain
      gain.gain.value = Math.max(0, Math.min(1, volumePercent / 100))
      source.buffer = buffer
      source.loop = true
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
      syntheticSourceRef.current = source
      return true
    },
    [stopSyntheticAudio],
  )

  useEffect(() => {
    stopSyntheticAudio()
    // WebCodecs 播放器随媒体更换重建（epoch 失效异步回调；模式复位在渲染期完成）
    wcEpochRef.current += 1
    wcPlayerRef.current?.destroy()
    wcPlayerRef.current = null
    onPlayingChange(false)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- media 仅为触发销毁重建播放器
  }, [media, onPlayingChange, stopSyntheticAudio])

  useEffect(
    () => () => {
      stopSyntheticAudio()
      const context = syntheticContextRef.current
      syntheticContextRef.current = null
      syntheticGainRef.current = null
      if (context) void context.close()
      wcEpochRef.current += 1
      wcPlayerRef.current?.destroy()
      wcPlayerRef.current = null
    },
    [stopSyntheticAudio],
  )

  // WebCodecs 分段播放器创建（<audio> onError 后）
  useEffect(() => {
    if (!wcAudioMode || !media?.file || wcPlayerRef.current) return
    const epoch = wcEpochRef.current
    void WebCodecsAudioPlayer.create(media.file, {
      onTime: (timeMs) => {
        if (epoch === wcEpochRef.current) onSeek(timeMs)
      },
      onEnd: () => {
        if (epoch === wcEpochRef.current) onPlayingChange(false)
      },
      onError: () => {
        if (epoch === wcEpochRef.current) onPlayingChange(false)
      },
    }).then((player) => {
      if (epoch !== wcEpochRef.current) {
        player?.destroy()
        return
      }
      if (player) wcPlayerRef.current = player
    })
  }, [wcAudioMode, media, onSeek, onPlayingChange])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !playing || wcAudioMode) return
    let frame = 0
    const update = () => {
      const next = audio.currentTime * 1000
      if (playEndRef.current !== null && next >= playEndRef.current) {
        audio.pause()
        audio.currentTime = playEndRef.current / 1000
        onSeek(playEndRef.current)
        playEndRef.current = null
        return
      }
      onSeek(next)
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [onSeek, playing, wcAudioMode])

  useEffect(() => {
    const audio = audioRef.current
    if (
      audio &&
      !playing &&
      !wcAudioMode &&
      Math.abs(audio.currentTime * 1000 - currentTimeMs) > 40
    )
      audio.currentTime = currentTimeMs / 1000
  }, [currentTimeMs, playing, wcAudioMode])

  useEffect(() => {
    if (!mediaAction.sequence || handledAudioActionRef.current === mediaAction.sequence) return
    handledAudioActionRef.current = mediaAction.sequence
    const audio = audioRef.current
    const wc = wcPlayerRef.current
    const cue = selectedCue
    const setWcVolume = () => {
      wc?.setVolume(Math.max(0, Math.min(1, (linked ? vZoom : volume) / 100)))
    }
    const wcEndMs = (startMs: number, endMs: number | null) => {
      const target = endMs ?? (durationMs > startMs ? durationMs : startMs + 600000)
      return Math.max(startMs, Math.min(durationMs || target, target))
    }
    const play = (startMs: number, endMs: number | null) => {
      const clamped = Math.max(0, Math.min(durationMs || startMs, startMs))
      playEndRef.current =
        endMs === null ? null : Math.max(clamped, Math.min(durationMs || endMs, endMs))
      onSeek(clamped)
      if (wc) {
        setWcVolume()
        wc.play(clamped, wcEndMs(clamped, endMs))
        onPlayingChange(true)
      } else if (audio) {
        audio.currentTime = clamped / 1000
        void audio.play()
      } else if (media?.syntheticAudio) {
        void startSyntheticAudio(media.syntheticAudio.kind, linked ? vZoom : volume)
          .then((started) => {
            if (started) onPlayingChange(true)
          })
          .catch(() => onPlayingChange(false))
      }
    }
    switch (mediaAction.type) {
      case 'toggle':
        if (wc) {
          if (playing) {
            wc.stop()
            onPlayingChange(false)
          } else {
            setWcVolume()
            wc.play(currentTimeMs, wcEndMs(currentTimeMs, null))
            onPlayingChange(true)
          }
        } else if (audio) {
          if (audio.paused) void audio.play()
          else audio.pause()
        } else if (media?.syntheticAudio) {
          if (playing) {
            stopSyntheticAudio()
            onPlayingChange(false)
          } else {
            void startSyntheticAudio(media.syntheticAudio.kind, linked ? vZoom : volume)
              .then((started) => {
                if (started) onPlayingChange(true)
              })
              .catch(() => onPlayingChange(false))
          }
        }
        break
      case 'play-selection':
      case 'play-line':
        if (cue) play(cue.startMs, cue.endMs)
        break
      case 'play-before':
        if (cue) play(Math.max(0, cue.startMs - 500), cue.startMs)
        break
      case 'play-after':
        if (cue) play(cue.endMs, cue.endMs + 500)
        break
      case 'play-begin':
        if (cue) play(cue.startMs, Math.min(cue.endMs, cue.startMs + 500))
        break
      case 'play-end':
        if (cue) play(Math.max(cue.startMs, cue.endMs - 500), cue.endMs)
        break
      case 'play-to-end':
        play(currentTimeMs, durationMs)
        break
      case 'stop':
        wc?.stop()
        audio?.pause()
        stopSyntheticAudio()
        playEndRef.current = null
        onPlayingChange(false)
        break
    }
  }, [
    currentTimeMs,
    durationMs,
    linked,
    media,
    mediaAction,
    onPlayingChange,
    onSeek,
    playing,
    selectedCue,
    startSyntheticAudio,
    stopSyntheticAudio,
    volume,
    vZoom,
  ])

  useEffect(() => {
    if (!playing || !media?.syntheticAudio) return
    let frame = 0
    let previous = performance.now()
    const tick = (now: number) => {
      const next = currentTimeMs + now - previous
      previous = now
      const end = playEndRef.current ?? durationMs
      if (next >= end) {
        stopSyntheticAudio()
        onSeek(end)
        onPlayingChange(false)
        playEndRef.current = null
        return
      }
      onSeek(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [currentTimeMs, durationMs, media, onPlayingChange, onSeek, playing, stopSyntheticAudio])

  const toggleValue = (id: string) => {
    if (id === 'audio/opt/spectrum') return view === 'spectrum'
    return props.isCommandChecked(id)
  }

  const onToggle = (id: string) => {
    if (id === 'audio/opt/spectrum') onViewChange(view === 'spectrum' ? 'waveform' : 'spectrum')
    else if (id === 'audio/opt/vertical_link') {
      if (!props.options.verticalLink) setVolume(vZoom)
      props.onCommand(id)
    } else props.onCommand(id)
  }

  const renderButton = (command: string) => {
    const isToggle = TOGGLES.has(command)
    const label = commandTooltip(command, 'Audio')
    const icon = commandIcon(command, 16)
    const intercepted = command === 'audio/commit' && karaokePending
    return (
      <button
        className={`audio-tool${isToggle && toggleValue(command) ? ' pressed' : ''}`}
        key={command}
        onClick={() => {
          if (intercepted && karaokeRef.current?.commitIfPending()) return
          if (isToggle) onToggle(command)
          else props.onCommand(command)
        }}
        title={label}
        aria-label={label}
        aria-pressed={isToggle ? toggleValue(command) : undefined}
        disabled={!props.isCommandEnabled(command) && !intercepted}
      >
        {icon ? <img src={icon} alt="" width={16} height={16} draggable={false} /> : null}
      </button>
    )
  }

  // AudioBox：SetZoomLevel(-HorizontalZoom->GetValue())；SetAmplitudeScale(pow(mid(1,VerticalZoom,100)/50,3))
  const zoomLevel = -hZoom
  const amplitude = Math.pow(Math.max(1, Math.min(100, vZoom)) / 50, 3)

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, displayedVolume / 100))
    if (syntheticGainRef.current)
      syntheticGainRef.current.gain.value = Math.max(0, Math.min(1, displayedVolume / 100))
    wcPlayerRef.current?.setVolume(Math.max(0, Math.min(1, displayedVolume / 100)))
  }, [displayedVolume])

  // 滑块值写回 Options（audio_box.cpp OnXXXScroll 的 OPT_SET；防抖避免拖动期高频持久化）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOption('Audio/Zoom/Horizontal', Math.round(hZoom))
      setOption('Audio/Zoom/Vertical', Math.round(vZoom))
      setOption('Audio/Volume', Math.round(displayedVolume))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [hZoom, vZoom, displayedVolume])

  return (
    <section
      className="audio-panel"
      aria-label={tPlain('Audio timing')}
      tabIndex={0}
      data-shortcut-context="Audio"
      onPointerDown={(event) => event.currentTarget.focus()}
    >
      {props.media?.url && (
        <audio
          ref={audioRef}
          src={props.media.url}
          preload="metadata"
          onError={() => setWcAudioMode(true)}
          onLoadedMetadata={(event) =>
            props.onDurationChange(
              Number.isFinite(event.currentTarget.duration)
                ? event.currentTarget.duration * 1000
                : 0,
            )
          }
          onPlay={() => props.onPlayingChange(true)}
          onPause={() => props.onPlayingChange(false)}
          onEnded={() => props.onPlayingChange(false)}
        />
      )}
      <div className="audio-main">
        <Waveform
          media={props.media}
          durationMs={props.durationMs}
          currentTimeMs={props.currentTimeMs}
          videoTimeMs={props.videoTimeMs}
          selectedCue={props.selectedCue}
          cues={props.cues}
          keyframes={props.keyframes}
          fps={props.fps}
          karaokeMode={props.karaokeMode}
          playing={props.playing}
          autoScroll={options.autoScroll}
          scrollToActiveLine={props.scrollToActiveLine}
          view={view}
          zoomLevel={zoomLevel}
          amplitude={amplitude}
          onWheelZoom={(delta) =>
            setHZoom((current) => Math.max(-50, Math.min(30, current + delta)))
          }
          onVideoSeek={props.onVideoSeek}
          onDurationChange={props.onDurationChange}
          onPatchCue={props.onPatchCue}
        />
        <div className="audio-vert" aria-label={tPlain('Audio zoom and volume')}>
          <input
            type="range"
            className="vert-slider"
            min={-50}
            max={30}
            value={hZoom}
            onChange={(event) => setHZoom(Number(event.target.value))}
            aria-label={tPlain('Audio horizontal zoom')}
            title={tPlain('Horizontal zoom')}
          />
          <div className="audio-vertvol-area">
            <div className="audio-vertvol">
              <input
                type="range"
                className="vert-slider"
                min={0}
                max={100}
                value={vZoom}
                onChange={(event) => setVZoom(Number(event.target.value))}
                aria-label={tPlain('Audio vertical zoom')}
                title={tPlain('Vertical zoom')}
              />
              <input
                type="range"
                className="vert-slider"
                min={0}
                max={100}
                value={displayedVolume}
                disabled={linked}
                onChange={(event) => setVolume(Number(event.target.value))}
                aria-label={tPlain('Audio volume')}
                title={tPlain('Audio volume')}
              />
            </div>
            <button
              className={`audio-tool${linked ? ' pressed' : ''}`}
              onClick={() => onToggle('audio/opt/vertical_link')}
              title={tPlain('Link vertical zoom')}
              aria-label={tPlain('Link vertical zoom')}
              aria-pressed={linked}
            >
              <img
                src={aegisubIconUrl('toggle_audio_link', 16)}
                alt=""
                width={16}
                height={16}
                draggable={false}
              />
            </button>
          </div>
        </div>
      </div>
      <div className="audio-toolbar" aria-label={tPlain('Audio tools')}>
        {AEGISUB_TOOLBARS['audio']?.map((group, groupIndex) => (
          <div className="audio-toolbar-group" key={groupIndex}>
            {group.buttons.map((button) => renderButton(button.command))}
          </div>
        ))}
      </div>
      {options.karaoke && props.selectedCue && (
        <KaraokeBar
          key={props.selectedCue.id}
          ref={karaokeRef}
          cue={props.selectedCue}
          currentTimeMs={props.currentTimeMs}
          autoCommit={options.autoCommit}
          onPatchText={(text, label) => {
            if (props.selectedCue) props.onPatchCue(props.selectedCue.id, { text }, label)
          }}
          onPendingChange={setKaraokePending}
        />
      )}
    </section>
  )
}
