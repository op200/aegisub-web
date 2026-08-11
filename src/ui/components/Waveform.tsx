import { useEffect, useRef, useState } from 'react';
import type { MediaSource } from '../../platform/types';
import type { SubtitleCue } from '../../core/types';

interface WaveformProps {
  media: MediaSource | null;
  durationMs: number;
  currentTimeMs: number;
  videoTimeMs: number | null;
  selectedCue: SubtitleCue | null;
  autoScroll: boolean;
  view: 'waveform' | 'spectrum';
  /** AudioDisplay::zoom_level（= -HorizontalZoom 滑块值），约 -30..50 */
  zoomLevel?: number;
  /** 振幅缩放（AudioDisplay::SetAmplitudeScale） */
  amplitude?: number;
  /** Ctrl+滚轮缩放（AudioBox::OnMouseWheel） */
  onWheelZoom?: (delta: number) => void;
  onVideoSeek: (timeMs: number) => void;
  onDurationChange: (durationMs: number) => void;
  onPatchCue: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void;
}

interface AudioData {
  durationMs: number;
  peakMin: Float32Array;
  peakMax: Float32Array;
  spectrum: { width: number; height: number; data: Float32Array } | null;
}

async function runWorker(
  payload:
    | { samples: Float32Array; durationMs: number }
    | { synthetic: { kind: 'blank' | 'noise' }; durationMs: number },
  buckets: number,
): Promise<AudioData> {
  const worker = new Worker(new URL('../../workers/waveform.worker.ts', import.meta.url), { type: 'module' });
  return await new Promise<AudioData>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<AudioData>) => {
      worker.terminate();
      resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    const transfer: Transferable[] = 'samples' in payload ? [payload.samples.buffer] : [];
    worker.postMessage({ ...payload, buckets }, transfer);
  });
}

async function createAudioData(media: MediaSource, buckets: number): Promise<AudioData> {
  if (media.syntheticAudio) {
    // 合成音频：直接在 worker 生成峰值/频谱，避免物化 1.6GB 样本
    return runWorker(
      { synthetic: { kind: media.syntheticAudio.kind }, durationMs: media.syntheticAudio.durationMs },
      buckets,
    );
  }
  const bytes = media.file ? await media.file.arrayBuffer() : await (await fetch(media.url)).arrayBuffer();
  if (bytes.byteLength > 300 * 1024 * 1024) throw new Error('Media is too large for browser audio decoding');
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(bytes);
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const samples = decoded.getChannelData(channel);
      for (let index = 0; index < samples.length; index++) mono[index] += samples[index] / decoded.numberOfChannels;
    }
    return runWorker({ samples: mono, durationMs: decoded.duration * 1000 }, buckets);
  } finally {
    await audioContext.close();
  }
}

// ---------------------------------------------------------------------------
// 与 Aegisub 一致的布局常量（audio_display.cpp）
// ---------------------------------------------------------------------------
const TIMELINE_H = 16; // 时间刻度线高度（文本高度 + 4）
const SCROLLBAR_H = 15; // 滚动条高度
const FOOT_SIZE = 6; // 标记脚尺寸
const BOUNDARY_WIDTH = 2; // Audio/Line Boundaries Thickness

// ---------------------------------------------------------------------------
// Colour/Schemes/Green（default_config.json）
// ---------------------------------------------------------------------------
interface Scheme {
  hue: number;
  hueScale?: number;
  sat: number;
  satScale?: number;
  lBase: number;
  lScale: number;
}
const SCHEME_NORMAL: Scheme = { hue: 85, sat: 255, lBase: 0, lScale: 200 };
const SCHEME_PRIMARY: Scheme = { hue: 85, sat: 128, lBase: 25, lScale: 300 };
const SPECTRUM_NORMAL: Scheme = {
  hue: 191,
  hueScale: -128,
  sat: 127,
  satScale: 128,
  lBase: 0,
  lScale: 255,
};
const SPECTRUM_PRIMARY: Scheme = {
  hue: 191,
  hueScale: -128,
  sat: 127,
  satScale: 128,
  lBase: 64,
  lScale: 192,
};
const UI_LIGHT = 'rgb(0,200,0)';
const UI_DARK = 'rgb(0,10,0)';
const UI_SEL = 'rgb(0,80,0)';
const LINE_START = 'rgb(216,0,0)';
const LINE_END = 'rgb(0,0,216)';
const CURSOR_COLOR = 'rgb(255,255,255)';
const CURRENT_FRAME_COLOR = 'rgba(255,255,255,.63)';
const PREVIOUS_FRAME_COLOR = 'rgba(255,255,255,.78)';

/** 与 colorspace.cpp hsl_to_rgb 一致的 HSL→RGB（0..255 输入） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hh = h / 255;
  const ss = s / 255;
  const ll = l / 255;
  const temp2 = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const temp1 = 2 * ll - temp2;
  const hue2rgb = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (6 * t < 1) return p + (q - p) * 6 * t;
    if (2 * t < 1) return q;
    if (3 * t < 2) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(hue2rgb(temp1, temp2, hh + 1 / 3) * 255);
  const g = Math.round(hue2rgb(temp1, temp2, hh) * 255);
  const b = Math.round(hue2rgb(temp1, temp2, hh - 1 / 3) * 255);
  return [r, g, b];
}

/** 配色方案在级别 t（0..1）处的颜色 */
function schemeColor(scheme: Scheme, t: number): string {
  const [r, g, b] = hslToRgb(
    Math.max(0, Math.min(255, scheme.hue + t * (scheme.hueScale ?? 0))),
    Math.max(0, Math.min(255, scheme.sat + t * (scheme.satScale ?? 0))),
    Math.max(0, Math.min(255, scheme.lBase + t * scheme.lScale)),
  );
  return `rgb(${r},${g},${b})`;
}

/** AudioDisplay::GetZoomLevelFactor */
function zoomFactor(level: number): number {
  let factor = 100;
  if (level > 0) {
    factor += 25 * level;
  } else if (level < 0) {
    if (level >= -5) factor += 10 * level;
    else if (level >= -11) factor = 50 + (level + 5) * 5;
    else factor = 20 + level + 11;
    if (factor <= 0) factor = 1;
  }
  return factor;
}

export function Waveform({
  media,
  durationMs,
  currentTimeMs,
  videoTimeMs,
  selectedCue,
  autoScroll,
  view,
  zoomLevel = 0,
  amplitude = 1,
  onWheelZoom,
  onVideoSeek,
  onDurationChange,
  onPatchCue,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<AudioData | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const scrollLeftRef = useRef(0);
  scrollLeftRef.current = scrollLeft;
  const wheelZoomRef = useRef(onWheelZoom);
  wheelZoomRef.current = onWheelZoom;
  const dragRef = useRef<
    | { mode: 'timeline' | 'scrollbar'; startX: number; startScroll: number }
    | { mode: 'marker'; marker: 'start' | 'end' }
    | null
  >(null);

  // ---- 音频数据加载 ----
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setUnavailable(false);
    if (!media?.file && !media?.syntheticAudio) {
      if (media) setUnavailable(true);
      return;
    }
    void createAudioData(media, 2400)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          if (result.durationMs > 0) onDurationChange(result.durationMs);
        }
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [media, onDurationChange]);

  // ---- 尺寸监听 ----
  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 缩放/滚动模型（AudioDisplay::SetZoomLevel / ScrollPixelToLeft） ----
  const msPerPixel = 2000 / zoomFactor(zoomLevel);
  const pixelAudioWidth = durationMs > 0 ? Math.max(1, Math.floor(durationMs / msPerPixel)) : 1;
  const maxScroll = Math.max(0, pixelAudioWidth - Math.max(1, size.w));
  const clampedScroll = Math.min(Math.max(0, scrollLeft), maxScroll);

  useEffect(() => {
    setScrollLeft((current) => Math.min(Math.max(0, current), maxScroll));
  }, [maxScroll]);

  // 选中行变化时滚动到可见（Audio/Auto/Scroll，ScrollTimeRangeInView）
  const lastSelKeyRef = useRef('');
  useEffect(() => {
    if (!autoScroll || !selectedCue || durationMs <= 0) return;
    const key = `${selectedCue.id}|${selectedCue.startMs}|${selectedCue.endMs}`;
    if (lastSelKeyRef.current === key) return;
    lastSelKeyRef.current = key;
    const clientWidth = Math.max(1, size.w);
    const begin = selectedCue.startMs / msPerPixel;
    const end = selectedCue.endMs / msPerPixel;
    const rangeLen = end - begin;
    const leftAdjust = clientWidth / 20;
    const clientLeft = clampedScroll + leftAdjust;
    const visibleWidth = (clientWidth * 9) / 10;
    let target = clampedScroll;
    if (!(begin >= clientLeft && end <= clientLeft + visibleWidth)) {
      if (rangeLen < visibleWidth) {
        target = begin - (visibleWidth - rangeLen) / 2 - leftAdjust;
      } else if (!(begin < clientLeft && end > clientLeft + visibleWidth)) {
        if (end >= clientLeft && end < clientLeft + visibleWidth) {
          target = end - clientWidth - leftAdjust;
        } else {
          target = begin - leftAdjust;
        }
      }
    }
    setScrollLeft(Math.min(Math.max(0, target), maxScroll));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, selectedCue?.id]);

  // 播放光标不自动滚动（Audio/Lock Scroll on Cursor 默认关闭）

  // ---- 离屏频谱预渲染 ----
  const specCanvasRef = useRef<{ normal: HTMLCanvasElement; primary: HTMLCanvasElement } | null>(null);
  useEffect(() => {
    if (view !== 'spectrum' || !data?.spectrum) {
      specCanvasRef.current = null;
      return;
    }
    const { width: cols, height: rows, data: spec } = data.spectrum;
    const normal = document.createElement('canvas');
    const primary = document.createElement('canvas');
    normal.width = primary.width = cols;
    normal.height = primary.height = rows;
    const normalContext = normal.getContext('2d');
    const primaryContext = primary.getContext('2d');
    if (!normalContext || !primaryContext) return;
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const value = spec[col * rows + row] ?? 0;
        normalContext.fillStyle = schemeColor(SPECTRUM_NORMAL, value);
        normalContext.fillRect(col, rows - row - 1, 1, 1);
        primaryContext.fillStyle = schemeColor(SPECTRUM_PRIMARY, value);
        primaryContext.fillRect(col, rows - row - 1, 1, 1);
      }
    }
    specCanvasRef.current = { normal, primary };
  }, [data, view]);

  // ---- 绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(size.w * ratio));
    const H = Math.max(1, Math.round(size.h * ratio));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const audioTop = TIMELINE_H;
    const audioHeight = Math.max(1, size.h - TIMELINE_H - SCROLLBAR_H);
    const midpoint = Math.floor(audioHeight / 2);
    const centerY = audioTop + midpoint;
    const scroll = clampedScroll;
    const absXFromTime = (timeMs: number) => timeMs / msPerPixel;

    // ================= 时间刻度线（AudioDisplayTimeline::Paint） =================
    {
      ctx.fillStyle = UI_DARK;
      ctx.fillRect(0, 0, size.w, TIMELINE_H);
      ctx.strokeStyle = UI_LIGHT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, TIMELINE_H - 1);
      ctx.lineTo(size.w, TIMELINE_H - 1);
      ctx.stroke();

      const pxPerSec = 1000 / msPerPixel;
      let minorDivisor = 1000;
      let majorModulo = 10;
      if (pxPerSec > 3000) {
        minorDivisor = 1;
        majorModulo = 10;
      } else if (pxPerSec > 300) {
        minorDivisor = 10;
        majorModulo = 10;
      } else if (pxPerSec > 30) {
        minorDivisor = 100;
        majorModulo = 10;
      } else if (pxPerSec > 3) {
        minorDivisor = 1000;
        majorModulo = 10;
      } else if (pxPerSec > 1 / 3) {
        minorDivisor = 10000;
        majorModulo = 6;
      } else if (pxPerSec > 1 / 9) {
        minorDivisor = 60000;
        majorModulo = 10;
      } else if (pxPerSec > 1 / 90) {
        minorDivisor = 600000;
        majorModulo = 6;
      } else {
        minorDivisor = 3600000;
        majorModulo = 10;
      }

      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = UI_LIGHT;
      const scrollMs = scroll * msPerPixel;
      let nextMark = Math.floor(scrollMs / minorDivisor);
      if (nextMark * minorDivisor < scrollMs) nextMark += 1;
      let lastTextRight = -1;
      let lastHour = -1;
      let lastMinute = -1;
      if (durationMs < 3_600_000) lastHour = 0; // 短于 1 小时不显示小时
      for (let guard = 0; guard < 100000; guard++) {
        const markPos = Math.round((nextMark * minorDivisor) / msPerPixel - scroll);
        if (markPos > size.w) break;
        const isMajor = nextMark % majorModulo === 0;
        ctx.strokeStyle = UI_LIGHT;
        ctx.beginPath();
        if (isMajor) {
          ctx.moveTo(markPos, TIMELINE_H - 6);
          ctx.lineTo(markPos, TIMELINE_H - 1);
        } else {
          ctx.moveTo(markPos, TIMELINE_H - 4);
          ctx.lineTo(markPos, TIMELINE_H - 1);
        }
        ctx.stroke();

        if (isMajor && markPos > lastTextRight) {
          const markTime = (nextMark * minorDivisor) / 1000;
          const markHour = Math.floor(markTime / 3600);
          const markMinute = Math.floor(markTime / 60) % 60;
          const markSecond = markTime - markHour * 3600 - markMinute * 60;
          let timeString = '';
          if (markHour !== lastHour) {
            timeString = `${markHour}:${String(markMinute).padStart(2, '0')}:`;
            lastHour = markHour;
            lastMinute = markMinute;
          } else if (markMinute !== lastMinute) {
            timeString = `${markMinute}:`;
            lastMinute = markMinute;
          }
          if (minorDivisor >= 100) {
            // %02d（Decisecond/Second/Minute...）
            timeString += String(Math.floor(markSecond)).padStart(2, '0');
          } else if (minorDivisor === 10) {
            // %02.1f（Centisecond）
            timeString += markSecond.toFixed(1).padStart(4, '0');
          } else {
            // %02.2f（Millisecond）
            timeString += markSecond.toFixed(2).padStart(5, '0');
          }
          ctx.fillText(timeString, markPos, 1);
          const tw = ctx.measureText(timeString).width;
          lastTextRight = markPos + tw;
        }
        nextMark += 1;
      }
    }

    // ================= 音频区域 =================
    const inSelection = (timeMs: number) =>
      !!selectedCue && timeMs >= selectedCue.startMs && timeMs < selectedCue.endMs;
    const styleAt = (timeMs: number): Scheme => (inSelection(timeMs) ? SCHEME_PRIMARY : SCHEME_NORMAL);

    // 背景（Normal + 选区 Primary 覆盖）
    ctx.fillStyle = schemeColor(SCHEME_NORMAL, 0);
    ctx.fillRect(0, audioTop, size.w, audioHeight);
    if (selectedCue) {
      const sx1 = Math.max(0, Math.round(absXFromTime(selectedCue.startMs) - scroll));
      const sx2 = Math.min(size.w, Math.round(absXFromTime(selectedCue.endMs) - scroll));
      if (sx2 > sx1) {
        ctx.fillStyle = schemeColor(SCHEME_PRIMARY, 0);
        ctx.fillRect(sx1, audioTop, sx2 - sx1, audioHeight);
      }
    }

    if (view === 'spectrum' && specCanvasRef.current) {
      const { normal, primary } = specCanvasRef.current;
      const srcX = ((scroll * msPerPixel) / Math.max(1, durationMs)) * normal.width;
      const srcW = ((size.w * msPerPixel) / Math.max(1, durationMs)) * normal.width;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(normal, srcX, 0, Math.max(1, srcW), normal.height, 0, audioTop, size.w, audioHeight);
      if (selectedCue) {
        const sx1 = Math.max(0, Math.round(absXFromTime(selectedCue.startMs) - scroll));
        const sx2 = Math.min(size.w, Math.round(absXFromTime(selectedCue.endMs) - scroll));
        if (sx2 > sx1) {
          const selectedSrcX = srcX + (sx1 / size.w) * srcW;
          const selectedSrcW = ((sx2 - sx1) / size.w) * srcW;
          ctx.drawImage(
            primary,
            selectedSrcX,
            0,
            Math.max(1, selectedSrcW),
            primary.height,
            sx1,
            audioTop,
            sx2 - sx1,
            audioHeight,
          );
        }
      }
    } else if (data?.peakMin && data.peakMax && durationMs > 0) {
      const { peakMin, peakMax } = data;
      const len = Math.min(peakMin.length, peakMax.length);
      // AudioWaveformRenderer：每像素取真实负峰/正峰，默认 Maximum 风格不绘制平均值。
      ctx.lineWidth = 1;
      for (let x = 0; x < size.w; x++) {
        const time = (scroll + x) * msPerPixel;
        const idx = Math.min(len - 1, Math.max(0, Math.floor((time / durationMs) * len)));
        const minimum = Math.max(-midpoint, (peakMin[idx] ?? 0) * amplitude * midpoint);
        const maximum = Math.min(midpoint, (peakMax[idx] ?? 0) * amplitude * midpoint);
        ctx.strokeStyle = schemeColor(styleAt(time), 0.4);
        ctx.beginPath();
        ctx.moveTo(x, centerY - maximum);
        ctx.lineTo(x, centerY - minimum);
        ctx.stroke();
      }
      // 默认 Waveform Style = Maximum，零线与峰值使用 pal.get(0.4)。
      ctx.lineWidth = 1;
      let runStart = 0;
      let runStyle = styleAt(scroll * msPerPixel);
      for (let x = 1; x <= size.w; x++) {
        const st = styleAt((scroll + x) * msPerPixel);
        if (st !== runStyle) {
          ctx.strokeStyle = schemeColor(runStyle, 0.4);
          ctx.beginPath();
          ctx.moveTo(runStart, centerY);
          ctx.lineTo(x, centerY);
          ctx.stroke();
          runStart = x;
          runStyle = st;
        }
      }
      ctx.strokeStyle = schemeColor(runStyle, 0.4);
      ctx.beginPath();
      ctx.moveTo(runStart, centerY);
      ctx.lineTo(size.w, centerY);
      ctx.stroke();
    }

    // ================= 视频帧范围（VideoPositionMarkerProvider） =================
    if (videoTimeMs !== null && durationMs > 0) {
      // 当前媒体层尚未暴露 VFR timecodes，先使用与视频栏一致的 24fps 近似。
      const frameDuration = 1000 / 24;
      const frame = Math.max(0, Math.floor(videoTimeMs / frameDuration));
      const frameStart = frame * frameDuration;
      const frameEnd = (frame + 1) * frameDuration;
      const previousStart = Math.max(0, (frame - 1) * frameDuration);
      const drawFrameRange = (startMs: number, endMs: number, color: string) => {
        const x1 = Math.round(absXFromTime(startMs) - scroll) + 1;
        const x2 = Math.round(absXFromTime(endMs) - scroll);
        if (x2 < 0 || x1 > size.w) return;
        ctx.fillStyle = color;
        ctx.fillRect(x1, audioTop, Math.max(1, x2 - x1), audioHeight);
      };
      drawFrameRange(previousStart, frameStart, PREVIOUS_FRAME_COLOR);
      drawFrameRange(frameStart, frameEnd, CURRENT_FRAME_COLOR);
      const videoX = Math.round(absXFromTime(frameStart) - scroll);
      if (videoX >= 0 && videoX < size.w) {
        ctx.strokeStyle = CURSOR_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(videoX, audioTop);
        ctx.lineTo(videoX, audioTop + audioHeight);
        ctx.stroke();
      }
    }

    // ================= 行边界标记（AudioMarker + PaintFoot） =================
    if (selectedCue) {
      const drawMarker = (timeMs: number, color: string, dir: number) => {
        const mx = Math.round(absXFromTime(timeMs) - scroll);
        if (mx < -FOOT_SIZE || mx > size.w + FOOT_SIZE) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = BOUNDARY_WIDTH;
        ctx.beginPath();
        ctx.moveTo(mx, audioTop);
        ctx.lineTo(mx, audioTop + audioHeight);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(mx + FOOT_SIZE * dir, audioTop);
        ctx.lineTo(mx, audioTop);
        ctx.lineTo(mx, audioTop + FOOT_SIZE);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(mx + FOOT_SIZE * dir, audioTop + audioHeight);
        ctx.lineTo(mx, audioTop + audioHeight - FOOT_SIZE);
        ctx.lineTo(mx, audioTop + audioHeight);
        ctx.closePath();
        ctx.fill();
      };
      // 起点标记（红）脚朝右；终点标记（蓝）脚朝左
      drawMarker(selectedCue.startMs, LINE_START, 1);
      drawMarker(selectedCue.endMs, LINE_END, -1);
    }

    // ================= 播放光标（PaintTrackCursor，白色竖线） =================
    if (durationMs > 0) {
      const cx = Math.round(absXFromTime(currentTimeMs) - scroll);
      if (cx >= 0 && cx < size.w) {
        ctx.strokeStyle = CURSOR_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, audioTop);
        ctx.lineTo(cx, audioTop + audioHeight);
        ctx.stroke();
      }
    }

    // ================= 滚动条（AudioDisplayScrollbar::Paint） =================
    {
      const sy = size.h - SCROLLBAR_H;
      ctx.fillStyle = UI_DARK;
      ctx.fillRect(0, sy, size.w, SCROLLBAR_H);
      ctx.strokeStyle = UI_LIGHT;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, sy + 0.5, size.w - 1, SCROLLBAR_H - 1);
      // 选区范围
      if (selectedCue && durationMs > 0) {
        const ss = Math.round((absXFromTime(selectedCue.startMs) / pixelAudioWidth) * size.w);
        const sl = Math.max(
          1,
          Math.round(((selectedCue.endMs - selectedCue.startMs) / msPerPixel / pixelAudioWidth) * size.w),
        );
        ctx.fillStyle = UI_SEL;
        ctx.fillRect(ss, sy, sl, SCROLLBAR_H);
      }
      // 滑块（thumb，最小 10px）
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth));
      const thumbX = Math.round((size.w * scroll) / pixelAudioWidth);
      ctx.fillStyle = UI_LIGHT;
      ctx.fillRect(thumbX, sy, thumbW, SCROLLBAR_H);
    }

    // 无数据提示
    if (!media) {
      ctx.fillStyle = '#9a9a9a';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No audio', size.w / 2, audioTop + audioHeight / 2);
    } else if (media && !data && !unavailable) {
      ctx.fillStyle = '#9a9a9a';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Decoding audio...', size.w / 2, audioTop + audioHeight / 2);
    } else if (unavailable) {
      ctx.fillStyle = '#a15d00';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waveform unavailable', size.w / 2, audioTop + audioHeight / 2);
    }
  }, [
    amplitude,
    clampedScroll,
    currentTimeMs,
    data,
    durationMs,
    media,
    msPerPixel,
    pixelAudioWidth,
    selectedCue,
    size,
    unavailable,
    videoTimeMs,
    view,
  ]);

  // ---- 鼠标滚轮（AudioBox::OnMouseWheel：默认滚动，Ctrl 缩放） ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) {
        const delta = -Math.sign(event.deltaY);
        wheelZoomRef.current?.(delta);
      } else {
        const max = Math.max(0, pixelAudioWidth - Math.max(1, size.w));
        setScrollLeft((current) => Math.min(Math.max(0, current + event.deltaY), max));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, pixelAudioWidth]);

  // ---- 指针交互 ----
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (y >= size.h - SCROLLBAR_H) {
      if (event.button !== 0) return;
      // AudioDisplayScrollbar：左键按下即将 thumb 中心定位到鼠标。
      dragRef.current = { mode: 'scrollbar', startX: x, startScroll: clampedScroll };
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth));
      const shaft = Math.max(1, size.w - thumbW);
      setScrollLeft(Math.min(Math.max(0, ((x - thumbW / 2) / shaft) * maxScroll), maxScroll));
      return;
    }
    if (y < TIMELINE_H) {
      if (event.button !== 0) return;
      // AudioDisplayTimeline：仅左键拖动滚动。
      dragRef.current = { mode: 'timeline', startX: x, startScroll: clampedScroll };
      return;
    }
    const time = Math.max(0, Math.min(durationMs, Math.round((clampedScroll + x) * msPerPixel)));
    if (event.button === 1) {
      // AudioDisplay::OnMouseEvent：中键将视频跳转到指针时间。
      onVideoSeek(time);
      return;
    }
    if (selectedCue && y < size.h - SCROLLBAR_H && event.button === 2) {
      onPatchCue(selectedCue.id, { endMs: Math.max(selectedCue.startMs, time) }, 'Set end time');
      dragRef.current = { mode: 'marker', marker: 'end' };
      return;
    }
    if (selectedCue && y < size.h - SCROLLBAR_H && event.button === 0) {
      const startX = selectedCue.startMs / msPerPixel - clampedScroll;
      const endX = selectedCue.endMs / msPerPixel - clampedScroll;
      if (Math.abs(x - startX) <= 8) {
        dragRef.current = { mode: 'marker', marker: 'start' };
        return;
      }
      if (Math.abs(x - endX) <= 8) {
        dragRef.current = { mode: 'marker', marker: 'end' };
        return;
      }
      // AudioTimingControllerDialogue：远离两端时立即设置左标记，继续拖动右标记。
      onPatchCue(selectedCue.id, { startMs: Math.min(time, selectedCue.endMs) }, 'Set start time');
      dragRef.current = { mode: 'marker', marker: 'end' };
      return;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    if (drag.mode === 'marker' && selectedCue) {
      const time = Math.max(0, Math.min(durationMs, Math.round((clampedScroll + x) * msPerPixel)));
      if (drag.marker === 'start') {
        onPatchCue(selectedCue.id, { startMs: Math.min(time, selectedCue.endMs) }, 'Adjust start time');
      } else {
        onPatchCue(selectedCue.id, { endMs: Math.max(time, selectedCue.startMs) }, 'Adjust end time');
      }
      return;
    }
    if (drag.mode === 'marker') return;
    let target = drag.startScroll + (x - drag.startX);
    if (drag.mode === 'scrollbar' && maxScroll > 0) {
      const thumbW = Math.max(10, Math.round((size.w * Math.max(1, size.w)) / pixelAudioWidth));
      const shaft = Math.max(1, size.w - thumbW);
      target = ((x - thumbW / 2) / shaft) * maxScroll;
    }
    setScrollLeft(Math.min(Math.max(0, target), maxScroll));
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="waveform" title={unavailable ? 'Waveform unavailable for this media format' : 'Click to seek'}>
      <canvas
        ref={canvasRef}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
