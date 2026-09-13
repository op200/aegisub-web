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

export function calculateAttachedVideoLayout(
  intrinsic: VideoSize,
  zoom: number,
  aspectRatio: number,
): VideoLayout {
  const safeWidth = Math.max(1, intrinsic.width)
  const safeHeight = Math.max(1, intrinsic.height)
  const ratio = aspectRatio > 0 ? aspectRatio : safeWidth / safeHeight
  const requestedHeight = safeHeight * Math.max(0.125, zoom)
  const requestedWidth = requestedHeight * ratio
  const displayWidth = Math.max(1, Math.round(requestedWidth))
  const displayHeight = Math.max(1, Math.round(requestedHeight))
  return {
    displayWidth,
    displayHeight,
    panelWidth: displayWidth + PANEL_SIDE_CHROME,
    panelHeight: displayHeight + CHROME_HEIGHT,
  }
}
