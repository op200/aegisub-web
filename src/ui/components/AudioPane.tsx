import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubtitleCue } from '../../core/types';
import type { MediaSource } from '../../platform/types';
import type { AudioOptions } from '../commandRegistry';
import { aegisubIconUrl, commandIcon } from '../aegisubIcons';
import { AEGISUB_TOOLBARS } from '../aegisubToolbar';
import { COMMANDS } from '../commands';
import { Waveform } from './Waveform';

interface AudioPaneProps {
  media: MediaSource | null;
  durationMs: number;
  currentTimeMs: number;
  videoTimeMs: number | null;
  selectedCue: SubtitleCue | null;
  view: 'waveform' | 'spectrum';
  options: AudioOptions;
  playing: boolean;
  onViewChange: (view: 'waveform' | 'spectrum') => void;
  onPlayingChange: (playing: boolean) => void;
  isCommandEnabled: (id: string) => boolean;
  isCommandChecked: (id: string) => boolean;
  onSeek: (timeMs: number) => void;
  onVideoSeek: (timeMs: number) => void;
  mediaAction: { sequence: number; type: string };
  onDurationChange: (durationMs: number) => void;
  onPatchCue: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void;
  onCommand: (id: string) => void;
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
]);

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
  } = props;
  const [hZoom, setHZoom] = useState(0); // Audio/Zoom/Horizontal: 0 → -50..30 滑块
  const [vZoom, setVZoom] = useState(50); // Audio/Zoom/Vertical: 0..100
  const [volume, setVolume] = useState(50); // Audio/Volume
  const linked = props.options.verticalLink;
  const displayedVolume = linked ? vZoom : volume;
  const audioRef = useRef<HTMLAudioElement>(null);
  const playEndRef = useRef<number | null>(null);
  const syntheticContextRef = useRef<AudioContext | null>(null);
  const syntheticSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const syntheticGainRef = useRef<GainNode | null>(null);
  const syntheticGenerationRef = useRef(0);
  const handledAudioActionRef = useRef(0);

  const stopSyntheticAudio = useCallback(() => {
    syntheticGenerationRef.current += 1;
    const source = syntheticSourceRef.current;
    syntheticSourceRef.current = null;
    if (source) {
      try {
        source.stop();
      } catch {
        // The source may already have stopped at a range boundary.
      }
      source.disconnect();
    }
    syntheticGainRef.current?.disconnect();
    syntheticGainRef.current = null;
  }, []);

  const startSyntheticAudio = useCallback(
    async (kind: 'blank' | 'noise', volumePercent: number) => {
      stopSyntheticAudio();
      const generation = syntheticGenerationRef.current;
      const previousContext = syntheticContextRef.current;
      const context = !previousContext || previousContext.state === 'closed' ? new AudioContext() : previousContext;
      syntheticContextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      if (generation !== syntheticGenerationRef.current) return false;
      const sampleRate = context.sampleRate;
      const buffer = context.createBuffer(1, sampleRate * 2, sampleRate);
      const samples = buffer.getChannelData(0);
      if (kind === 'noise') {
        // DummyAudioProvider 按需产生白噪声；短循环缓冲避免分配 150 分钟 PCM。
        let state = 0x6d2b79f5;
        for (let index = 0; index < samples.length; index++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          samples[index] = ((state >>> 0) / 0x80000000 - 1) * 0.35;
        }
      }
      const source = context.createBufferSource();
      const gain = context.createGain();
      syntheticGainRef.current = gain;
      gain.gain.value = Math.max(0, Math.min(1, volumePercent / 100));
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      gain.connect(context.destination);
      source.start();
      syntheticSourceRef.current = source;
      return true;
    },
    [stopSyntheticAudio],
  );

  useEffect(() => {
    stopSyntheticAudio();
    onPlayingChange(false);
  }, [media, onPlayingChange, stopSyntheticAudio]);

  useEffect(
    () => () => {
      stopSyntheticAudio();
      const context = syntheticContextRef.current;
      syntheticContextRef.current = null;
      syntheticGainRef.current = null;
      if (context) void context.close();
    },
    [stopSyntheticAudio],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !playing) return;
    let frame = 0;
    const update = () => {
      const next = audio.currentTime * 1000;
      if (playEndRef.current !== null && next >= playEndRef.current) {
        audio.pause();
        audio.currentTime = playEndRef.current / 1000;
        onSeek(playEndRef.current);
        playEndRef.current = null;
        return;
      }
      onSeek(next);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [onSeek, playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && !playing && Math.abs(audio.currentTime * 1000 - currentTimeMs) > 40)
      audio.currentTime = currentTimeMs / 1000;
  }, [currentTimeMs, playing]);

  useEffect(() => {
    if (!mediaAction.sequence || handledAudioActionRef.current === mediaAction.sequence) return;
    handledAudioActionRef.current = mediaAction.sequence;
    const audio = audioRef.current;
    const cue = selectedCue;
    const play = (startMs: number, endMs: number | null) => {
      const clamped = Math.max(0, Math.min(durationMs || startMs, startMs));
      playEndRef.current = endMs === null ? null : Math.max(clamped, Math.min(durationMs || endMs, endMs));
      onSeek(clamped);
      if (audio) {
        audio.currentTime = clamped / 1000;
        void audio.play();
      } else if (media?.syntheticAudio) {
        void startSyntheticAudio(media.syntheticAudio.kind, linked ? vZoom : volume)
          .then((started) => {
            if (started) onPlayingChange(true);
          })
          .catch(() => onPlayingChange(false));
      }
    };
    switch (mediaAction.type) {
      case 'toggle':
        if (audio) {
          if (audio.paused) void audio.play();
          else audio.pause();
        } else if (media?.syntheticAudio) {
          if (playing) {
            stopSyntheticAudio();
            onPlayingChange(false);
          } else {
            void startSyntheticAudio(media.syntheticAudio.kind, linked ? vZoom : volume)
              .then((started) => {
                if (started) onPlayingChange(true);
              })
              .catch(() => onPlayingChange(false));
          }
        }
        break;
      case 'play-selection':
      case 'play-line':
        if (cue) play(cue.startMs, cue.endMs);
        break;
      case 'play-before':
        if (cue) play(Math.max(0, cue.startMs - 500), cue.startMs);
        break;
      case 'play-after':
        if (cue) play(cue.endMs, cue.endMs + 500);
        break;
      case 'play-begin':
        if (cue) play(cue.startMs, Math.min(cue.endMs, cue.startMs + 500));
        break;
      case 'play-end':
        if (cue) play(Math.max(cue.startMs, cue.endMs - 500), cue.endMs);
        break;
      case 'play-to-end':
        play(currentTimeMs, durationMs);
        break;
      case 'stop':
        audio?.pause();
        stopSyntheticAudio();
        playEndRef.current = null;
        onPlayingChange(false);
        break;
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
  ]);

  useEffect(() => {
    if (!playing || !media?.syntheticAudio) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const next = currentTimeMs + now - previous;
      previous = now;
      const end = playEndRef.current ?? durationMs;
      if (next >= end) {
        stopSyntheticAudio();
        onSeek(end);
        onPlayingChange(false);
        playEndRef.current = null;
        return;
      }
      onSeek(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [currentTimeMs, durationMs, media, onPlayingChange, onSeek, playing, stopSyntheticAudio]);

  const toggleValue = (id: string) => {
    if (id === 'audio/opt/spectrum') return view === 'spectrum';
    return props.isCommandChecked(id);
  };

  const onToggle = (id: string) => {
    if (id === 'audio/opt/spectrum') onViewChange(view === 'spectrum' ? 'waveform' : 'spectrum');
    else if (id === 'audio/opt/vertical_link') {
      if (!props.options.verticalLink) setVolume(vZoom);
      props.onCommand(id);
    } else props.onCommand(id);
  };

  const renderButton = (command: string) => {
    const isToggle = TOGGLES.has(command);
    const label = COMMANDS[command]?.label ?? command;
    const icon = commandIcon(command, 16);
    return (
      <button
        className={`audio-tool${isToggle && toggleValue(command) ? ' pressed' : ''}`}
        key={command}
        onClick={() => (isToggle ? onToggle(command) : props.onCommand(command))}
        title={label}
        aria-label={label}
        aria-pressed={isToggle ? toggleValue(command) : undefined}
        disabled={!props.isCommandEnabled(command)}
      >
        {icon ? <img src={icon} alt="" width={16} height={16} draggable={false} /> : null}
      </button>
    );
  };

  // AudioBox：SetZoomLevel(-HorizontalZoom->GetValue())；SetAmplitudeScale(pow(mid(1,VerticalZoom,100)/50,3))
  const zoomLevel = -hZoom;
  const amplitude = Math.pow(Math.max(1, Math.min(100, vZoom)) / 50, 3);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, displayedVolume / 100));
    if (syntheticGainRef.current) syntheticGainRef.current.gain.value = Math.max(0, Math.min(1, displayedVolume / 100));
  }, [displayedVolume]);

  return (
    <section
      className="audio-panel"
      aria-label="Audio timing"
      tabIndex={0}
      data-shortcut-context="Audio"
      onPointerDown={(event) => event.currentTarget.focus()}
    >
      {props.media?.url && (
        <audio
          ref={audioRef}
          src={props.media.url}
          preload="metadata"
          onLoadedMetadata={(event) =>
            props.onDurationChange(
              Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration * 1000 : 0,
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
          autoScroll={options.autoScroll}
          view={view}
          zoomLevel={zoomLevel}
          amplitude={amplitude}
          onWheelZoom={(delta) => setHZoom((current) => Math.max(-50, Math.min(30, current + delta)))}
          onVideoSeek={props.onVideoSeek}
          onDurationChange={props.onDurationChange}
          onPatchCue={props.onPatchCue}
        />
        <div className="audio-vert" aria-label="Audio zoom and volume">
          <input
            type="range"
            className="vert-slider"
            min={-50}
            max={30}
            value={hZoom}
            onChange={(event) => setHZoom(Number(event.target.value))}
            aria-label="Audio horizontal zoom"
            title="Horizontal zoom"
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
                aria-label="Audio vertical zoom"
                title="Vertical zoom"
              />
              <input
                type="range"
                className="vert-slider"
                min={0}
                max={100}
                value={displayedVolume}
                disabled={linked}
                onChange={(event) => setVolume(Number(event.target.value))}
                aria-label="Audio volume"
                title="Audio volume"
              />
            </div>
            <button
              className={`audio-tool${linked ? ' pressed' : ''}`}
              onClick={() => onToggle('audio/opt/vertical_link')}
              title="Link vertical zoom"
              aria-label="Link vertical zoom"
              aria-pressed={linked}
            >
              <img src={aegisubIconUrl('toggle_audio_link', 16)} alt="" width={16} height={16} draggable={false} />
            </button>
          </div>
        </div>
      </div>
      <div className="audio-toolbar" aria-label="Audio tools">
        {AEGISUB_TOOLBARS['audio']?.map((group, groupIndex) => (
          <div className="audio-toolbar-group" key={groupIndex}>
            {group.buttons.map((button) => renderButton(button.command))}
          </div>
        ))}
      </div>
    </section>
  );
}
