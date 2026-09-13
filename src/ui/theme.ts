/**
 * 自动主题（未完成计划/UI）：跟随系统 prefers-color-scheme 在 light/dark 间切换。
 * CSS 侧由 styles.css 的 @media (prefers-color-scheme: dark) 变量覆盖承担；
 * 本模块供 JS 消费者（网格配色反相、语法高亮、canvas 绘制）获取当前生效主题。
 */
import { useEffect, useState } from 'react'

export type ThemeName = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function resolveTheme(): ThemeName {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** 当前生效主题（React 绑定：系统深浅色切换时触发重渲染） */
export function useSystemTheme(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(resolveTheme)
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return theme
}

/** 视频滑动条画布调色（video_slider.cpp 用 wxSYS_COLOUR_* 系统色绘制） */
export interface SliderPalette {
  /** wxSYS_COLOUR_3DDKSHADOW */
  shad: string
  /** wxSYS_COLOUR_3DLIGHT */
  high: string
  /** wxSYS_COLOUR_3DFACE */
  face: string
  /** 箭头轮廓（窗口前景色） */
  bord: string
}

export const SLIDER_PALETTES: Record<ThemeName, SliderPalette> = {
  light: { shad: '#6d6d6d', high: '#e3e3e3', face: '#f0f0f0', bord: '#000' },
  dark: { shad: '#0f0f0f', high: '#3d3d3d', face: '#202020', bord: '#f0f0f0' },
}

/** 卡拉OK拆分条画布调色（audio_karaoke.cpp split bar，位于 chrome 面板上） */
export const SPLIT_BAR_PALETTES: Record<ThemeName, { bg: string; text: string }> = {
  light: { bg: '#ffffff', text: '#1c1c1c' },
  dark: { bg: '#2b2b2b', text: '#f0f0f0' },
}
