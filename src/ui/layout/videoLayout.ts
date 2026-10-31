export interface VideoSize {
  width: number
  height: number
}

export interface VideoLayout {
  displayWidth: number
  displayHeight: number
  panelWidth: number
  panelHeight: number
}

// 视觉工具栏的 grid 列宽为 30px，预览面板还有 1px 的右边框。
const PANEL_SIDE_CHROME = 31
const CHROME_HEIGHT = 56

/**
 * frame_main.cpp FrameMain::OnVideoOpen：视频载入后按分辨率与主窗口尺寸调整窗口缩放，
 * 而不是一律按 100% 显示（否则不同分辨率的视频载入时外观大小差异巨大）：
 *   视频显示宽 > 窗口宽 4/3 或高 > 窗口高 6/4 → 缩到 1/4；
 *   视频显示宽 > 窗口宽 2/3 或高 > 窗口高 3/4 → 缩到 1/2。
 * 源码比较的是 video×zoom 与 wx 逻辑像素的窗口尺寸（GetSize），故此处同样用
 * CSS 像素（= 逻辑像素）的窗口尺寸；结果再按 video_display.cpp SetWindowZoom 钳到 12.5%。
 */
export function fitWindowZoomToVideo(
  intrinsic: VideoSize,
  zoom: number,
  windowWidth: number,
  windowHeight: number,
): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return zoom
  const width = Math.max(1, intrinsic.width)
  const height = Math.max(1, intrinsic.height)
  let factor = 1
  if (width * 3 * zoom > windowWidth * 4 || height * 4 * zoom > windowHeight * 6) factor = 0.25
  else if (width * 3 * zoom > windowWidth * 2 || height * 4 * zoom > windowHeight * 3) factor = 0.5
  return Math.max(0.125, zoom * factor)
}

/**
 * video_display.cpp FitClientSizeToVideo：viewport = video × windowZoom 是"物理设备像素"
 * （客户区逻辑像素 = viewport / scale_factor，GL 视口 = client × scale_factor），
 * 因此 zoom 100% = 1 视频像素 : 1 物理屏幕像素（点对点），与系统 DPI 无关。
 * Web 对应：CSS 像素 = 物理像素 / devicePixelRatio（CSS 小数值由浏览器精确映射到设备像素）。
 */
export function calculateAttachedVideoLayout(
  intrinsic: VideoSize,
  zoom: number,
  aspectRatio: number,
  dpr = 1,
): VideoLayout {
  const safeWidth = Math.max(1, intrinsic.width)
  const safeHeight = Math.max(1, intrinsic.height)
  const ratio = aspectRatio > 0 ? aspectRatio : safeWidth / safeHeight
  const scale = Math.max(0.125, zoom)
  // 源码按物理像素逐维取整：高度 = video.h × zoom，宽度 = 高 × AR
  const physicalHeight = Math.max(1, Math.round(safeHeight * scale))
  const physicalWidth = Math.max(1, Math.round(physicalHeight * ratio))
  const divisor = dpr > 0 ? dpr : 1
  const displayWidth = Math.max(1, physicalWidth / divisor)
  const displayHeight = Math.max(1, physicalHeight / divisor)
  return {
    displayWidth,
    displayHeight,
    panelWidth: displayWidth + PANEL_SIDE_CHROME,
    panelHeight: displayHeight + CHROME_HEIGHT,
  }
}
