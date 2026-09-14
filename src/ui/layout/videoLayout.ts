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
