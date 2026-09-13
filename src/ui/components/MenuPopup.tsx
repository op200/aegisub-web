import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 右键弹出菜单（position: fixed）
 * 以 (x, y) 为首选位置，挂载后测量自身尺寸并钳制在视口内，
 * 避免贴屏幕右/下边缘右键时菜单超出屏幕（内容过高时限制高度滚动）
 */
export function MenuPopup(props: { x: number; y: number; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: props.x,
    top: props.y,
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 4
    const { width, height } = el.getBoundingClientRect()
    const next: { left: number; top: number; maxHeight?: number } = {
      left: Math.max(margin, Math.min(props.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(props.y, window.innerHeight - height - margin)),
    }
    if (height > window.innerHeight - margin * 2) next.maxHeight = window.innerHeight - margin * 2
    setPos(next)
  }, [props.x, props.y])
  return (
    <div ref={ref} className="grid-context-menu" role="menu" aria-label={props.label} style={pos}>
      {props.children}
    </div>
  )
}
