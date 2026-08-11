import { Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { aegisubIconUrl } from '../aegisubIcons';
import type { MediaSource } from '../../platform/types';
import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from '../../core/types';
import { formatVideoTime } from '../../core/time';
import { readVisualOverrides, setOverride, setPosition } from '../../core/assVisual';
import { assColorToCss } from '../color';

interface PreviewPaneProps {
  document: SubtitleDocument;
  media: MediaSource | null;
  currentTimeMs: number;
  activeCue: SubtitleCue | null;
  onTimeChange: (timeMs: number) => void;
  onDurationChange: (durationMs: number) => void;
  onOpenMedia: () => void;
  mediaAction: { sequence: number; type: string };
  onCommand: (id: string) => void;
  onPatchCue: (id: string, patch: Partial<Omit<SubtitleCue, 'id'>>, label: string) => void;
  onPatchStyle: (id: string, patch: Partial<Omit<SubtitleStyle, 'id'>>, label: string) => void;
  isCommandEnabled: (id: string) => boolean;
  isCommandChecked: (id: string) => boolean;
  windowZoom: number;
  onWindowZoomChange: (zoom: number) => void;
  onIntrinsicSizeChange: (width: number, height: number) => void;
  intrinsicWidth: number;
  intrinsicHeight: number;
  style?: CSSProperties;
}

const VICON = (name: string) => aegisubIconUrl(name, 16);

/** 对 hex 颜色做明暗调整（棋盘格用） */
function shadeColor(hex: string, percent: number): string {
  const m = hex.replace('#', '');
  const num = parseInt(
    m.length === 3
      ? m
          .split('')
          .map((c) => c + c)
          .join('')
      : m,
    16,
  );
  const r = Math.max(0, Math.min(255, Math.round(((num >> 16) & 0xff) * (1 + percent / 100))));
  const g = Math.max(0, Math.min(255, Math.round(((num >> 8) & 0xff) * (1 + percent / 100))));
  const b = Math.max(0, Math.min(255, Math.round((num & 0xff) * (1 + percent / 100))));
  return `rgb(${r},${g},${b})`;
}

/** 绘制 dummy 视频背景（纯色或棋盘格，对应 video_provider_dummy.cpp），绘制到 (x,y)-(x+w,y+h) */
function drawDummyBackground(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  pattern: boolean,
): void {
  if (!pattern) {
    context.fillStyle = color;
    context.fillRect(x, y, w, h);
    return;
  }
  const cell = Math.max(10, Math.round(h / 12));
  const dark = shadeColor(color, -25);
  for (let cy = y; cy < y + h; cy += cell) {
    for (let cx = x; cx < x + w; cx += cell) {
      context.fillStyle = (Math.floor((cx - x) / cell) + Math.floor((cy - y) / cell)) % 2 ? dark : color;
      context.fillRect(cx, cy, cell, cell);
    }
  }
}
const VISUAL_TOOLS = [
  ['video/tool/cross', 'visual_standard', 'Standard visual tool'],
  ['video/tool/drag', 'visual_move', 'Drag subtitles'],
  ['video/tool/rotate/z', 'visual_rotatez', 'Rotate subtitles'],
  ['video/tool/rotate/xy', 'visual_rotatexy', 'Rotate XY subtitles'],
  ['video/tool/scale', 'visual_scale', 'Scale subtitles'],
  ['video/tool/clip', 'visual_clip', 'Rectangular clip'],
  ['video/tool/vector_clip', 'visual_vector_clip', 'Vector clip'],
  ['', '', ''],
  ['help/video', 'visual_help', 'Visual typesetting help'],
] as const;

interface HitBox {
  cue: SubtitleCue;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function plainText(text: string): string[] {
  return text
    .replace(/\{[^}]*}/g, '')
    .replaceAll('\\h', ' ')
    .split(/\\N|\\n/);
}

function drawCue(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  style: SubtitleStyle,
  playResX: number,
  playResY: number,
): { left: number; right: number; top: number; bottom: number } {
  const scaleX = width / Math.max(1, playResX);
  const scaleY = height / Math.max(1, playResY);
  const scale = scaleY;
  const overrides = readVisualOverrides(text);
  const fontSize = Math.max(1, style.fontSize * scale);
  const lines = plainText(text);
  const lineHeight = fontSize * 1.2;
  const defaultVertical =
    style.alignment <= 3
      ? height - Math.max(18, style.marginV * scale) - lineHeight * (lines.length - 1)
      : style.alignment >= 7
        ? Math.max(fontSize, style.marginV * scale + fontSize)
        : height / 2;
  const defaultHorizontal = [1, 4, 7].includes(style.alignment)
    ? Math.max(16, style.marginL * scale)
    : [3, 6, 9].includes(style.alignment)
      ? width - Math.max(16, style.marginR * scale)
      : width / 2;
  const horizontal = overrides.pos ? overrides.pos.x * scaleX : defaultHorizontal;
  const vertical = overrides.pos ? overrides.pos.y * scaleY : defaultVertical;
  context.textAlign = [1, 4, 7].includes(style.alignment)
    ? 'left'
    : [3, 6, 9].includes(style.alignment)
      ? 'right'
      : 'center';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : '400 '}${fontSize}px "${style.fontName}", sans-serif`;
  context.fillStyle = assColorToCss(style.primaryColor);
  context.strokeStyle = assColorToCss(style.outlineColor, '#000000');
  context.lineWidth = Math.max(1, style.outline * scale * 2);
  context.save();
  if (overrides.clip) {
    context.beginPath();
    context.rect(
      overrides.clip.x1 * scaleX,
      overrides.clip.y1 * scaleY,
      (overrides.clip.x2 - overrides.clip.x1) * scaleX,
      (overrides.clip.y2 - overrides.clip.y1) * scaleY,
    );
    if (!overrides.clip.inverse) context.clip();
  }
  context.translate(horizontal, vertical);
  context.rotate((overrides.rotationZ * Math.PI) / 180);
  const xyScaleX = Math.max(0.05, Math.abs(Math.cos((overrides.rotationY * Math.PI) / 180)));
  const xyScaleY = Math.max(0.05, Math.abs(Math.cos((overrides.rotationX * Math.PI) / 180)));
  context.scale((overrides.scaleX / 100) * xyScaleX, (overrides.scaleY / 100) * xyScaleY);
  let boxLeft = width;
  let boxRight = 0;
  lines.forEach((line, index) => {
    const y = (index - (lines.length - 1)) * lineHeight;
    const measured = context.measureText(line);
    const textWidth =
      Math.abs(measured.actualBoundingBoxLeft) + Math.abs(measured.actualBoundingBoxRight) || measured.width;
    if (style.shadow > 0) {
      context.shadowColor = assColorToCss(style.backColor, 'rgba(0,0,0,.7)');
      context.shadowBlur = 0;
      context.shadowOffsetX = style.shadow * scale;
      context.shadowOffsetY = style.shadow * scale;
    }
    if (style.outline > 0) context.strokeText(line, 0, y);
    context.fillText(line, 0, y);
    context.shadowColor = 'transparent';
    const lineLeft = context.textAlign === 'center' ? -textWidth / 2 : context.textAlign === 'right' ? -textWidth : 0;
    boxLeft = Math.min(boxLeft, horizontal + lineLeft - style.outline * scale);
    boxRight = Math.max(boxRight, horizontal + lineLeft + textWidth + style.outline * scale);
  });
  context.restore();
  const scaledHeight = lineHeight * Math.max(0.05, overrides.scaleY / 100);
  const top = vertical - scaledHeight * (lines.length - 1) - style.outline * scale;
  const bottom = vertical + lineHeight + style.outline * scale;
  return { left: boxLeft, right: boxRight, top, bottom };
}

interface VideoSliderProps {
  durationMs: number;
  currentTimeMs: number;
  frameDurationMs: number;
  onSeek: (timeMs: number) => void;
}

/** 自定义 Seek 滑块，与 video_slider.cpp 绘制一致（轨道 + 箭头游标 + 底部选区条） */
function VideoSliderControl({ durationMs, currentTimeMs, frameDurationMs, onSeek }: VideoSliderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const maxFrame = Math.max(1, Math.round(durationMs / Math.max(1, frameDurationMs)));
  const frame = Math.round(currentTimeMs / Math.max(1, frameDurationMs));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const shad = '#6d6d6d'; // wxSYS_COLOUR_3DDKSHADOW
    const high = '#e3e3e3'; // wxSYS_COLOUR_3DLIGHT
    const face = '#f0f0f0'; // wxSYS_COLOUR_3DFACE
    const sel = 'rgb(123,251,232)';
    const bord = '#000';

    const x1 = 5;
    const x2 = w - 5;
    const y1 = 8;
    const y2 = h - 8;

    // 背景
    ctx.fillStyle = face;
    ctx.fillRect(0, 0, w, h);

    // 轨道（凹陷边框）
    ctx.strokeStyle = shad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y1);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1, y2);
    ctx.stroke();
    ctx.strokeStyle = high;
    ctx.beginPath();
    ctx.moveTo(x1, y2);
    ctx.lineTo(x2, y2);
    ctx.moveTo(x2, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const getXAtValue = (value: number) => (value * (w - 10)) / maxFrame + 5;
    const curX = getXAtValue(Math.min(Math.max(0, frame), maxFrame));

    // 填充游标背景
    ctx.fillStyle = face;
    ctx.fillRect(curX - 2, y1 - 1, 4, y2 - y1 + 5);

    // 高光
    ctx.strokeStyle = high;
    ctx.beginPath();
    ctx.moveTo(curX, y1 - 2);
    ctx.lineTo(curX - 4, y1 + 2);
    ctx.moveTo(curX - 3, y1 + 2);
    ctx.lineTo(curX - 3, y2 + 5);
    ctx.stroke();

    // 阴影
    ctx.strokeStyle = shad;
    ctx.beginPath();
    ctx.moveTo(curX + 1, y1 - 1);
    ctx.lineTo(curX + 4, y1 + 2);
    ctx.moveTo(curX + 3, y1 + 2);
    ctx.lineTo(curX + 3, y2 + 5);
    ctx.moveTo(curX - 3, y2 + 4);
    ctx.lineTo(curX + 3, y2 + 4);
    ctx.stroke();

    // 轮廓（黑色箭头）
    ctx.strokeStyle = bord;
    ctx.beginPath();
    ctx.moveTo(curX, y1 - 3);
    ctx.lineTo(curX - 4, y1 + 1);
    ctx.moveTo(curX, y1 - 3);
    ctx.lineTo(curX + 4, y1 + 1);
    ctx.moveTo(curX - 4, y1 + 1);
    ctx.lineTo(curX - 4, y2 + 5);
    ctx.moveTo(curX + 4, y1 + 1);
    ctx.lineTo(curX + 4, y2 + 5);
    ctx.moveTo(curX - 3, y2 + 5);
    ctx.lineTo(curX + 4, y2 + 5);
    ctx.moveTo(curX - 3, y2);
    ctx.lineTo(curX + 4, y2);
    ctx.stroke();

    // 底部选区条
    ctx.fillStyle = sel;
    ctx.fillRect(curX - 3, y2 + 1, 7, 4);
  }, [currentTimeMs, frame, maxFrame]);

  const seekFromX = (x: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(1, canvas.clientWidth);
    if (w <= 10) return;
    const value = ((x - 5) * maxFrame) / (w - 10);
    onSeek(Math.max(0, Math.min(durationMs, Math.round(value) * frameDurationMs)));
  };

  const seekFromPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    seekFromX(event.clientX - bounds.left);
  };

  return (
    <canvas
      className="video-slider"
      ref={canvasRef}
      tabIndex={0}
      aria-label="Video timeline"
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) seekFromPointer(event);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          onSeek(Math.max(0, Math.min(durationMs, (frame + (event.key === 'ArrowRight' ? 1 : -1)) * frameDurationMs)));
        }
      }}
      onWheel={(event) => {
        event.preventDefault();
        const delta = event.deltaY > 0 ? 1 : -1;
        onSeek(Math.max(0, Math.min(durationMs, (frame + delta) * frameDurationMs)));
      }}
    />
  );
}

export function PreviewPane({
  document,
  media,
  currentTimeMs,
  activeCue,
  onTimeChange,
  onDurationChange,
  onOpenMedia,
  mediaAction,
  onCommand,
  onPatchCue,
  isCommandEnabled,
  isCommandChecked,
  windowZoom,
  onWindowZoomChange,
  onIntrinsicSizeChange,
  intrinsicWidth,
  intrinsicHeight,
  style: panelStyle,
}: PreviewPaneProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dummyPlaying, setDummyPlaying] = useState(false);
  const [visualTool, setVisualTool] = useState('video/tool/cross');
  const [zoomText, setZoomText] = useState(`${windowZoom * 100}%`);
  const FPS = 24; // dummy 视频帧率（Aegisub DummyVideoProvider 默认 24fps）
  const hasVideo = !!(media?.url || media?.dummy);
  const hitBoxesRef = useRef<HitBox[]>([]);
  const currentRef = useRef(currentTimeMs);
  currentRef.current = currentTimeMs;
  const dummyScaleRef = useRef(1);
  const dummyOffsetRef = useRef({ x: 0, y: 0 });
  const windowZoomRef = useRef(windowZoom);
  const onWindowZoomChangeRef = useRef(onWindowZoomChange);
  const dragRef = useRef<{
    cue: SubtitleCue;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    baseScaleX: number;
    baseScaleY: number;
    baseRotationX: number;
    baseRotationY: number;
    baseRotationZ: number;
  } | null>(null);

  useEffect(() => {
    windowZoomRef.current = windowZoom;
    onWindowZoomChangeRef.current = onWindowZoomChange;
  }, [onWindowZoomChange, windowZoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.125 : -0.125;
      onWindowZoomChangeRef.current(Math.max(0.125, Math.min(3, windowZoomRef.current + delta)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const renderOverlay = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, stage.clientWidth);
    const cssHeight = Math.max(1, stage.clientHeight);
    const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
    const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    const active = document.cues.filter(
      (cue) => !cue.comment && cue.startMs <= currentTimeMs && cue.endMs >= currentTimeMs,
    );

    // dummy 视频：按视频分辨率等比 letterbox（不拉伸），黑边 + 背景 + 视频坐标系内绘制字幕
    if (media?.dummy) {
      const { width: vw, height: vh, color, pattern } = media.dummy;
      const s = Math.min(cssWidth / vw, cssHeight / vh);
      const vwPx = vw * s;
      const vhPx = vh * s;
      const ox = (cssWidth - vwPx) / 2;
      const oy = (cssHeight - vhPx) / 2;
      context.fillStyle = '#000';
      context.fillRect(0, 0, cssWidth, cssHeight);
      drawDummyBackground(context, ox, oy, vwPx, vhPx, color, pattern);
      dummyScaleRef.current = s;
      dummyOffsetRef.current = { x: ox, y: oy };
      context.save();
      context.translate(ox, oy);
      context.scale(s, s);
      const boxes: HitBox[] = [];
      for (const cue of active) {
        const style = document.styles.find((item) => item.name === cue.style) ?? document.styles[0];
        if (!style) continue;
        const box = drawCue(context, vw, vh, cue.text, style, vw, vh);
        boxes.push({
          cue,
          left: ox + box.left * s,
          right: ox + box.right * s,
          top: oy + box.top * s,
          bottom: oy + box.bottom * s,
        });
      }
      hitBoxesRef.current = boxes;
      context.restore();
    } else {
      const playResY = Number(document.scriptInfo.PlayResY) || 1080;
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9);
      const boxes: HitBox[] = [];
      for (const cue of active) {
        const style = document.styles.find((item) => item.name === cue.style) ?? document.styles[0];
        if (!style) continue;
        const box = drawCue(context, cssWidth, cssHeight, cue.text, style, playResX, playResY);
        boxes.push({ cue, left: box.left, right: box.right, top: box.top, bottom: box.bottom });
      }
      hitBoxesRef.current = boxes;
    }

    // 拖拽/缩放模式下高亮所有可见行
    if (visualTool !== 'video/tool/cross') {
      context.setLineDash([6, 4]);
      context.strokeStyle = 'rgba(255,255,0,.8)';
      context.lineWidth = 1.5 * ratio;
      for (const box of hitBoxesRef.current) {
        context.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      }
      context.setLineDash([]);
    }
  }, [currentTimeMs, document, media, visualTool]);

  useEffect(() => {
    renderOverlay();
    const observer = new ResizeObserver(renderOverlay);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [renderOverlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    let frame = 0;
    const update = () => {
      onTimeChange(video.currentTime * 1000);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [onTimeChange, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && !playing && Math.abs(video.currentTime * 1000 - currentTimeMs) > 40)
      video.currentTime = currentTimeMs / 1000;
  }, [currentTimeMs, playing]);

  useEffect(() => {
    // dummy 视频 / 合成音频：无 <video> 元数据，直接取时长
    if (media?.dummy) {
      setDurationMs(media.dummy.lengthMs);
      onDurationChange(media.dummy.lengthMs);
      onIntrinsicSizeChange(media.dummy.width, media.dummy.height);
    } else if (media?.syntheticAudio) {
      setDurationMs(media.syntheticAudio.durationMs);
      onDurationChange(media.syntheticAudio.durationMs);
    }
  }, [media, onDurationChange, onIntrinsicSizeChange]);

  useEffect(() => {
    setZoomText(`${Math.round(windowZoom * 1000) / 10}%`);
  }, [windowZoom]);

  const commitZoom = (text = zoomText) => {
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) {
      setZoomText(`${Math.round(windowZoom * 1000) / 10}%`);
      return;
    }
    onWindowZoomChange(Math.max(0.125, Math.min(3, value / 100)));
  };

  const seek = (value: number) => {
    const clamped = Math.max(0, Math.min(durationMs || value, value));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
    onTimeChange(clamped);
  };

  // dummy 视频播放：无 <video> 元素，用 rAF 推进当前时间
  useEffect(() => {
    if (!dummyPlaying || !media?.dummy) return;
    let frame = 0;
    const tick = () => {
      const next = currentRef.current + 1000 / 24;
      if (next >= (media.dummy?.lengthMs ?? 0)) {
        setDummyPlaying(false);
        onTimeChange(media.dummy?.lengthMs ?? 0);
      } else {
        onTimeChange(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dummyPlaying, media, onTimeChange]);

  useEffect(() => {
    if (!mediaAction.sequence) return;
    const video = videoRef.current;
    const frame = 1000 / 24;
    if (mediaAction.type.startsWith('video/tool/')) {
      setVisualTool(mediaAction.type);
      return;
    }
    if (mediaAction.type.startsWith('zoom-')) {
      if (mediaAction.type === 'zoom-in' || mediaAction.type === 'zoom-out') {
        onWindowZoomChange(
          Math.max(0.125, Math.min(3, windowZoom + (mediaAction.type === 'zoom-in' ? 0.125 : -0.125))),
        );
      } else {
        const value = Number(mediaAction.type.slice(5));
        if (Number.isFinite(value) && value > 0) onWindowZoomChange(Math.max(0.125, Math.min(3, value / 100)));
      }
      return;
    }
    // dummy 视频的播放控制
    if (media?.dummy && (mediaAction.type === 'toggle' || mediaAction.type === 'play' || mediaAction.type === 'stop')) {
      if (mediaAction.type === 'toggle') setDummyPlaying((prev) => !prev);
      else setDummyPlaying(mediaAction.type === 'play');
      return;
    }
    const actionSeek = (timeMs: number) => {
      const clamped = Math.max(
        0,
        Math.min(video && Number.isFinite(video.duration) ? video.duration * 1000 : timeMs, timeMs),
      );
      if (video) video.currentTime = clamped / 1000;
      onTimeChange(clamped);
    };
    switch (mediaAction.type) {
      case 'toggle':
        if (video) {
          if (video.paused) void video.play();
          else video.pause();
        }
        break;
      case 'play':
        if (video?.paused) void video.play();
        break;
      case 'stop':
        if (video) video.pause();
        break;
      case 'frame-prev':
        actionSeek((video?.currentTime ?? 0) * 1000 - frame);
        break;
      case 'frame-next':
        actionSeek((video?.currentTime ?? 0) * 1000 + frame);
        break;
      case 'keyframe-prev':
        actionSeek((video?.currentTime ?? 0) * 1000 - 10_000);
        break;
      case 'keyframe-next':
        actionSeek((video?.currentTime ?? 0) * 1000 + 10_000);
        break;
      case 'start':
        actionSeek(0);
        break;
      case 'end':
        actionSeek(video && Number.isFinite(video.duration) ? video.duration * 1000 : 0);
        break;
    }
  }, [media, mediaAction, onTimeChange, onWindowZoomChange, windowZoom]);

  const hitTest = (x: number, y: number): HitBox | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const bounds = stage.getBoundingClientRect();
    const px = x - bounds.left;
    const py = y - bounds.top;
    for (let i = hitBoxesRef.current.length - 1; i >= 0; i--) {
      const box = hitBoxesRef.current[i];
      if (px >= box.left && px <= box.right && py >= box.top && py <= box.bottom) return box;
    }
    return null;
  };

  const canvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (visualTool === 'video/tool/vector_clip') return;
    const hit = hitTest(event.clientX, event.clientY);
    const cue = hit?.cue ?? activeCue;
    if (!cue) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stage = stageRef.current;
    if (!stage) return;
    const overrides = readVisualOverrides(cue.text);
    const playResY = Number(document.scriptInfo.PlayResY) || 1080;
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9);
    const bounds = stage.getBoundingClientRect();
    const pointerX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * playResX;
    const pointerY = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * playResY;
    const baseX = overrides.pos?.x ?? pointerX;
    const baseY = overrides.pos?.y ?? pointerY;
    dragRef.current = {
      cue,
      startX: event.clientX,
      startY: event.clientY,
      baseX,
      baseY,
      baseScaleX: overrides.scaleX,
      baseScaleY: overrides.scaleY,
      baseRotationX: overrides.rotationX,
      baseRotationY: overrides.rotationY,
      baseRotationZ: overrides.rotationZ,
    };
    if (visualTool === 'video/tool/clip') {
      onPatchCue(
        cue.id,
        {
          text: setOverride(
            cue.text,
            'clip',
            `(${Math.round(pointerX)},${Math.round(pointerY)},${Math.round(pointerX)},${Math.round(pointerY)})`,
          ),
        },
        'Set clipping rectangle',
      );
    }
  };

  const canvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const stage = stageRef.current;
    if (!stage) return;
    // 屏幕像素 → 视频坐标的缩放：dummy 用 letterbox 等比缩放，真实视频用舞台高度/PlayResY
    const scale = media?.dummy
      ? dummyScaleRef.current
      : stage.clientHeight / (Number(document.scriptInfo.PlayResY) || 1080);
    if (visualTool === 'video/tool/drag') {
      const dx = Math.round((event.clientX - drag.startX) / scale);
      const dy = Math.round((event.clientY - drag.startY) / scale);
      onPatchCue(drag.cue.id, { text: setPosition(drag.cue.text, drag.baseX + dx, drag.baseY + dy) }, 'Move subtitle');
    } else if (visualTool === 'video/tool/scale') {
      let dx = ((event.clientX - drag.startX) / scale) * 1.25;
      let dy = ((drag.startY - event.clientY) / scale) * 1.25;
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (event.altKey) dx = dy = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      let sx = Math.max(0, drag.baseScaleX + dx);
      let sy = Math.max(0, drag.baseScaleY + dy);
      if (event.ctrlKey) {
        sx = Math.round(sx / 25) * 25;
        sy = Math.round(sy / 25) * 25;
      }
      const text = setOverride(setOverride(drag.cue.text, 'fscx', `${Math.round(sx)}`), 'fscy', `${Math.round(sy)}`);
      onPatchCue(drag.cue.id, { text }, 'Scale subtitle');
    } else if (visualTool === 'video/tool/rotate/z') {
      const originX = drag.startX;
      const originY = drag.startY;
      let angle = drag.baseRotationZ + (Math.atan2(event.clientY - originY, event.clientX - originX) * 180) / Math.PI;
      if (event.ctrlKey) angle = Math.round(angle / 30) * 30;
      angle = ((angle % 360) + 360) % 360;
      onPatchCue(drag.cue.id, { text: setOverride(drag.cue.text, 'frz', angle.toFixed(2)) }, 'Rotate subtitle');
    } else if (visualTool === 'video/tool/rotate/xy') {
      let rx = drag.baseRotationX - (event.clientY - drag.startY) * 2;
      let ry = drag.baseRotationY + (event.clientX - drag.startX) * 2;
      if (event.shiftKey) {
        if (Math.abs(rx - drag.baseRotationX) > Math.abs(ry - drag.baseRotationY)) ry = drag.baseRotationY;
        else rx = drag.baseRotationX;
      }
      if (event.ctrlKey) {
        rx = Math.round(rx / 30) * 30;
        ry = Math.round(ry / 30) * 30;
      }
      const text = setOverride(
        setOverride(drag.cue.text, 'frx', `${((rx % 360) + 360) % 360}`),
        'fry',
        `${((ry % 360) + 360) % 360}`,
      );
      onPatchCue(drag.cue.id, { text }, 'Rotate subtitle');
    } else if (visualTool === 'video/tool/clip') {
      const bounds = stage.getBoundingClientRect();
      const playResY = Number(document.scriptInfo.PlayResY) || 1080;
      const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9);
      const x2 = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * playResX;
      const y2 = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * playResY;
      const value = `(${Math.round(Math.min(drag.baseX, x2))},${Math.round(Math.min(drag.baseY, y2))},${Math.round(Math.max(drag.baseX, x2))},${Math.round(Math.max(drag.baseY, y2))})`;
      onPatchCue(drag.cue.id, { text: setOverride(drag.cue.text, 'clip', value) }, 'Set clipping rectangle');
    }
  };

  const canvasDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (visualTool !== 'video/tool/cross' || !activeCue) return;
    const stage = stageRef.current;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const playResY = Number(document.scriptInfo.PlayResY) || 1080;
    const playResX = Number(document.scriptInfo.PlayResX) || Math.round((playResY * 16) / 9);
    const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * playResX;
    const y = ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * playResY;
    onPatchCue(activeCue.id, { text: setPosition(activeCue.text, x, y) }, 'Position subtitle');
  };

  const canvasPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <section className="preview-panel" aria-label="Video preview" style={panelStyle}>
      <div className="video-content">
        <div className="visual-toolbar" aria-label="Visual tools">
          {VISUAL_TOOLS.map(([id, icon, label]) =>
            id === '' ? (
              <div className="visual-sep" key={`sep-${label}`} />
            ) : (
              <button
                className={`visual-tool${visualTool === id ? ' pressed' : ''}`}
                title={label}
                aria-label={label}
                key={id}
                disabled={id === 'video/tool/vector_clip' || !isCommandEnabled(id)}
                aria-pressed={id.startsWith('video/tool/') ? visualTool === id || isCommandChecked(id) : undefined}
                onClick={() => onCommand(id)}
              >
                <img src={VICON(icon)} alt="" width={16} height={16} draggable={false} />
              </button>
            ),
          )}
        </div>
        <div className="video-stage" ref={stageRef} tabIndex={0} data-shortcut-context="Video">
          <div className="video-zoom-stage">
            {media?.url ? (
              <video
                ref={videoRef}
                src={media.url}
                preload="metadata"
                style={{
                  width: `${Math.round(intrinsicWidth * windowZoom)}px`,
                  height: `${Math.round(intrinsicHeight * windowZoom)}px`,
                }}
                onLoadedMetadata={(event) => {
                  const value = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration * 1000 : 0;
                  setDurationMs(value);
                  onDurationChange(value);
                  onIntrinsicSizeChange(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
            ) : media?.dummy ? (
              <div
                className="dummy-video-stage"
                aria-label="Dummy video"
                style={{
                  width: `${Math.round(media.dummy.width * windowZoom)}px`,
                  height: `${Math.round(media.dummy.height * windowZoom)}px`,
                }}
              />
            ) : (
              <button className="empty-media" onClick={onOpenMedia}>
                <Video size={28} aria-hidden="true" />
                <span>Open media</span>
              </button>
            )}
          </div>
          <canvas
            ref={canvasRef}
            className="subtitle-overlay"
            style={{
              pointerEvents: !hasVideo || visualTool === 'video/tool/vector_clip' ? 'none' : 'auto',
            }}
            onPointerDown={canvasPointerDown}
            onPointerMove={canvasPointerMove}
            onPointerUp={canvasPointerUp}
            onPointerCancel={canvasPointerUp}
            onDoubleClick={canvasDoubleClick}
          />
        </div>
      </div>
      <div className="video-static-line" />
      <VideoSliderControl
        durationMs={hasVideo ? durationMs : 0}
        currentTimeMs={hasVideo ? currentTimeMs : 0}
        frameDurationMs={1000 / FPS}
        onSeek={seek}
      />
      <div className="video-bottom">
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/play')}
          disabled={!hasVideo}
          title="Play video"
          aria-label="Play video"
        >
          <img
            src={VICON(playing || dummyPlaying ? 'button_pause' : 'button_play')}
            alt=""
            width={16}
            height={16}
            draggable={false}
          />
        </button>
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/play/line')}
          disabled={!hasVideo}
          title="Play current line"
          aria-label="Play current line"
        >
          <img src={VICON('button_playline')} alt="" width={16} height={16} draggable={false} />
        </button>
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/stop')}
          disabled={!hasVideo}
          title="Stop video"
          aria-label="Stop video"
        >
          <img src={VICON('button_stop')} alt="" width={16} height={16} draggable={false} />
        </button>
        <button
          className="video-tool-btn"
          onClick={() => onCommand('video/opt/autoscroll')}
          disabled={!hasVideo}
          title="Auto scroll"
          aria-label="Auto scroll"
        >
          <img src={VICON('toggle_video_autoscroll')} alt="" width={16} height={16} draggable={false} />
        </button>
        <input
          className="video-position"
          readOnly
          value={hasVideo ? `${formatVideoTime(currentTimeMs)} - ${Math.round(currentTimeMs / (1000 / FPS))}` : ''}
          aria-label="Current frame time and number"
          title="Current frame time and number"
        />
        <input
          className="video-subs-pos"
          readOnly
          value={
            activeCue
              ? `${currentTimeMs - activeCue.startMs >= 0 ? '+' : ''}${currentTimeMs - activeCue.startMs}ms; ${
                  currentTimeMs - activeCue.endMs >= 0 ? '+' : ''
                }${currentTimeMs - activeCue.endMs}ms`
              : ''
          }
          aria-label="Time of this frame relative to start and end of current subs"
          title="Time of this frame relative to start and end of current subs"
        />
        <input
          className="video-zoom"
          list="video-zoom-options"
          value={zoomText}
          onChange={(event) => {
            setZoomText(event.target.value);
          }}
          onBlur={() => commitZoom()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitZoom(event.currentTarget.value);
            if (event.key === 'Escape') setZoomText(`${Math.round(windowZoom * 1000) / 10}%`);
          }}
          aria-label="Video zoom"
        />
        <datalist id="video-zoom-options">
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={`${(i + 1) * 12.5}%`} />
          ))}
        </datalist>
      </div>
    </section>
  );
}
