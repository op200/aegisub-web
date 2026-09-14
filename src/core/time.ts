export function parseAssTime(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,3})$/)
  if (!match) return 0
  const [, hours, minutes, seconds, fraction] = match
  const centiseconds = Number(fraction.padEnd(2, '0').slice(0, 2))
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    centiseconds * 10
  )
}

export function formatAssTime(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds / 10) * 10)
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const centiseconds = Math.floor((value % 1000) / 10)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

export function parseSrtTime(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/)
  if (!match) return 0
  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(match[4])
  )
}

export function formatSrtTime(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const millis = value % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** 视频位置框格式：与 Aegisub Time::GetAssFormatted(true) 一致（H:MM:SS.mmm，毫秒截断）
 *  Time(int) 构造钳制 [0, 10h-6ms]，位数提取为整数截断（非四舍五入） */
export function formatVideoTime(milliseconds: number): string {
  const value = Math.max(0, Math.min(Math.trunc(milliseconds), 10 * 60 * 60 * 1000 - 6))
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const millis = value % 1000
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** 编辑框/网格时间格式：与 Aegisub Time::GetAssFormatted 一致（H:MM:SS.CC，厘秒） */
export function formatEditorTime(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds / 10) * 10)
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1000)
  const centiseconds = Math.floor((value % 1000) / 10)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

/** 解析 H:MM:SS.CC（与 Aegisub Time::Time(string) 一致，小数位为厘秒） */
export function parseEditorTime(value: string): number | null {
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!match) return null
  const [, hours, minutes, seconds, fraction = ''] = match
  let ms = Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000
  let scale = 100
  for (const ch of fraction) {
    ms += Number(ch) * scale
    scale /= 10
  }
  return ms
}
