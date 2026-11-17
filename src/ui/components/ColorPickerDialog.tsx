import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { getOptionInt, getOptionListColor, setOption } from '../../config/options'
import {
  BLACK_COLOR,
  parseAssPickerColor,
  parseCssPickerColor,
  pickerColorToAss,
  pickerColorToCss,
  pickerColorToHtml,
  type PickerColor,
} from '../color'
import { hslToRgb, hsvToRgb, rgbToHsl, rgbToHsv } from '../colorSpace'
import { tPlain } from '../i18n'
import { Dialog } from './dialogs'

const MODES = ['RGB/R', 'RGB/G', 'RGB/B', 'HSL/L', 'HSV/H']
const SLIDER_WIDTH = 10
const RECENT_COLORS = 32

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

function sameColor(a: PickerColor, b: PickerColor): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

function parseColorValue(value: string): PickerColor {
  return parseAssPickerColor(value) ?? parseCssPickerColor(value) ?? { ...BLACK_COLOR }
}

function loadRecentColors(): PickerColor[] {
  const list = getOptionListColor('Tool/Colour Picker/Recent Colours').map((item) =>
    parseAssPickerColor(item),
  )
  const colors: PickerColor[] = []
  for (let i = 0; i < RECENT_COLORS; i++) colors.push(list[i] ?? { ...BLACK_COLOR })
  return colors
}

/** dialog_colorpicker.cpp 的 2D 光谱图（256x256） */
function paintSpectrum(canvas: HTMLCanvasElement, mode: number, color: PickerColor) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(256, 256)
  const data = image.data
  const hsl = rgbToHsl(color.r, color.g, color.b)
  const hsv = rgbToHsv(color.r, color.g, color.b)
  const lightness = hsl[2]
  const hue = hsv[0]
  const maxColor = mode === 4 ? hsvToRgb(hue, 255, 255) : [0, 0, 0]

  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      let r = 0
      let g = 0
      let b = 0
      switch (mode) {
        case 0:
          r = color.r
          g = y
          b = x
          break
        case 1:
          r = y
          g = color.g
          b = x
          break
        case 2:
          r = y
          g = x
          b = color.b
          break
        case 3: {
          // MakeHSSpectrum：h = y，s = x，向 l 灰度插值
          const [mr, mg, mb] = hslToRgb(y, 255, lightness)
          r = Math.floor((mr * x) / 256 + ((255 - x) * lightness) / 256)
          g = Math.floor((mg * x) / 256 + ((255 - x) * lightness) / 256)
          b = Math.floor((mb * x) / 256 + ((255 - x) * lightness) / 256)
          break
        }
        default: {
          // MakeSVSpectrum：v = y，s = x
          const rr = Math.floor(((255 - maxColor[0]) * y) / 256)
          const rg = Math.floor(((255 - maxColor[1]) * y) / 256)
          const rb = Math.floor(((255 - maxColor[2]) * y) / 256)
          r = 255 - Math.floor((rr * x) / 256) - (255 - y)
          g = 255 - Math.floor((rg * x) / 256) - (255 - y)
          b = 255 - Math.floor((rb * x) / 256) - (255 - y)
          break
        }
      }
      const offset = (y * 256 + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

/** dialog_colorpicker.cpp 的 1D 滑块（其中一维固定） */
function paintSlider(canvas: HTMLCanvasElement, mode: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(SLIDER_WIDTH, 256)
  const data = image.data
  for (let y = 0; y < 256; y++) {
    let r = 0
    let g = 0
    let b = 0
    if (mode <= 2) {
      const rgb = [0, 0, 0]
      rgb[mode] = y
      ;[r, g, b] = rgb
    } else if (mode === 3) {
      r = g = b = y
    } else {
      ;[r, g, b] = hsvToRgb(y, 255, 255)
    }
    for (let x = 0; x < SLIDER_WIDTH; x++) {
      const offset = (y * SLIDER_WIDTH + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

/** 透明度滑块：棋盘格 + 当前颜色（alpha=0 顶部不透明） */
function paintAlphaSlider(canvas: HTMLCanvasElement, color: PickerColor) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(SLIDER_WIDTH, 256)
  const data = image.data
  for (let y = 0; y < 256; y++) {
    const invertY = 0xff - y
    const boxColors = [
      Math.floor(0x66 - (invertY * 0x66) / 0xff),
      Math.floor(0x99 - (invertY * 0x99) / 0xff),
    ]
    if (Math.floor(y / 5) & 1) boxColors.reverse()
    const colors = boxColors.map((base) => [
      Math.floor((color.r * invertY) / 0xff) + base,
      Math.floor((color.g * invertY) / 0xff) + base,
      Math.floor((color.b * invertY) / 0xff) + base,
    ])
    for (let x = 0; x < SLIDER_WIDTH; x++) {
      const rgb = colors[Math.floor(x / 5)] ?? colors[0]
      const offset = (y * SLIDER_WIDTH + x) * 4
      data[offset] = rgb[0]
      data[offset + 1] = rgb[1]
      data[offset + 2] = rgb[2]
      data[offset + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}

interface ColorPickerDialogProps {
  title?: string
  initial: string
  /** 是否允许编辑 alpha（ColourButton 的 alpha 参数） */
  alpha?: boolean
  /** 实时回调：光谱/滑块/输入框每次变化都会触发 */
  onChange: (value: string) => void
  /** 取消时的额外处理（默认回写 initial）；用于调用方撤销实时预览 */
  onCancel?: () => void
  /** 输出格式：ASS 颜色或 CSS 颜色 */
  format: 'ass' | 'css'
  onClose: () => void
}

export function ColorPickerDialog({
  title,
  initial,
  alpha = false,
  onChange,
  onCancel,
  format,
  onClose,
}: ColorPickerDialogProps) {
  const original = parseColorValue(initial)
  const [color, setColor] = useState<PickerColor>(original)
  const [mode, setMode] = useState(() => {
    const saved = getOptionInt('Tool/Colour Picker/Mode')
    return saved < 0 || saved > 4 ? 3 : saved
  })
  const [recent, setRecent] = useState<PickerColor[]>(loadRecentColors)
  const [assText, setAssText] = useState(() => pickerColorToAss(original, false))
  const [htmlText, setHtmlText] = useState(() => pickerColorToHtml(original))
  const spectrumRef = useRef<HTMLCanvasElement>(null)
  const sliderRef = useRef<HTMLCanvasElement>(null)
  const alphaSliderRef = useRef<HTMLCanvasElement>(null)

  const hsl = rgbToHsl(color.r, color.g, color.b)
  const hsv = rgbToHsv(color.r, color.g, color.b)

  const emit = (next: PickerColor) => {
    setColor(next)
    onChange(format === 'ass' ? pickerColorToAss(next, true) : pickerColorToCss(next))
    setAssText(pickerColorToAss(next, false))
    setHtmlText(pickerColorToHtml(next))
  }

  // 光谱图只在固定分量变化时重绘（源码 spectrum_dirty）
  const spectrumKey =
    mode === 0
      ? `0:${color.r}`
      : mode === 1
        ? `1:${color.g}`
        : mode === 2
          ? `2:${color.b}`
          : mode === 3
            ? `3:${hsl[2]}`
            : `4:${hsv[0]}`
  useEffect(() => {
    const canvas = spectrumRef.current
    if (canvas) paintSpectrum(canvas, mode, color)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- color 的其余分量不影响该光谱
  }, [spectrumKey, mode])

  useEffect(() => {
    const canvas = sliderRef.current
    if (canvas) paintSlider(canvas, mode)
  }, [mode])

  useEffect(() => {
    const canvas = alphaSliderRef.current
    if (canvas) paintAlphaSlider(canvas, color)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- alpha 滑块只用 rgb，alpha 变化无需重绘
  }, [color.r, color.g, color.b])

  const alphaValue = alpha ? color.a : original.a

  const setRgb = (r: number, g: number, b: number) => emit({ ...color, r, g, b })
  const setFromHsl = (h: number, s: number, l: number) => {
    const [r, g, b] = hslToRgb(h, s, l)
    setRgb(r, g, b)
  }
  const setFromHsv = (h: number, s: number, v: number) => {
    const [r, g, b] = hsvToRgb(h, s, v)
    setRgb(r, g, b)
  }

  const spectrumPointer =
    mode === 0
      ? { x: color.b, y: color.g }
      : mode === 1
        ? { x: color.b, y: color.r }
        : mode === 2
          ? { x: color.g, y: color.r }
          : mode === 3
            ? { x: hsl[1], y: hsl[0] }
            : { x: hsv[1], y: hsv[2] }
  const sliderValue =
    mode === 0
      ? color.r
      : mode === 1
        ? color.g
        : mode === 2
          ? color.b
          : mode === 3
            ? hsl[2]
            : hsv[0]

  const valueAt = (event: { clientX: number; clientY: number }, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const x = clampByte(((event.clientX - rect.left) / rect.width) * 255)
    const y = clampByte(((event.clientY - rect.top) / rect.height) * 255)
    return { x, y }
  }

  const applySpectrum = (x: number, y: number) => {
    if (mode === 0) setRgb(color.r, y, x)
    else if (mode === 1) setRgb(y, color.g, x)
    else if (mode === 2) setRgb(y, x, color.b)
    else if (mode === 3) setFromHsl(y, x, hsl[2])
    else setFromHsv(hsv[0], x, y)
  }

  const applySlider = (y: number) => {
    if (mode === 0) setRgb(y, color.g, color.b)
    else if (mode === 1) setRgb(color.r, y, color.b)
    else if (mode === 2) setRgb(color.r, color.g, y)
    else if (mode === 3) setFromHsl(hsl[0], hsl[1], y)
    else setFromHsv(y, hsv[1], hsv[2])
  }

  const addToRecent = () => {
    const list = [...recent]
    const existing = list.findIndex((item) => sameColor(item, color))
    if (existing >= 0) {
      const [item] = list.splice(existing, 1)
      list.unshift(item)
    } else {
      list.unshift(color)
      list.pop()
    }
    setRecent(list)
    setOption(
      'Tool/Colour Picker/Recent Colours',
      list.map((item) => pickerColorToAss(item)),
    )
  }

  const cancel = () => {
    if (onCancel) onCancel()
    else onChange(format === 'ass' ? pickerColorToAss(original, true) : pickerColorToCss(original))
    onClose()
  }

  const ok = () => {
    addToRecent()
    onClose()
  }

  const pickFromScreen = async () => {
    const api = (
      window as Window & {
        EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
      }
    ).EyeDropper
    if (!api) return
    try {
      const result = await new api().open()
      const picked = parseCssPickerColor(result.sRGBHex)
      // 源码 OS 取色器固定 a=0
      if (picked) emit({ ...picked, a: alpha ? 0 : color.a })
    } catch {
      // 用户取消取色
    }
  }

  const byteInput = (value: number, onValue: (value: number) => void, label: string) => (
    <input
      className="picker-number"
      type="number"
      min={0}
      max={255}
      value={value}
      aria-label={label}
      onChange={(event) => {
        const parsed = Number.parseInt(event.target.value, 10)
        if (Number.isFinite(parsed)) onValue(clampByte(parsed))
      }}
    />
  )

  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

  return (
    <Dialog
      title={title ?? tPlain('Select Color')}
      onClose={cancel}
      className="color-picker-dialog"
      footer={
        <>
          <button onClick={ok}>{tPlain('OK')}</button>
          <button onClick={cancel}>{tPlain('Cancel')}</button>
        </>
      }
    >
      <div className="color-picker-body">
        <fieldset className="color-picker-spectrum">
          <legend>{tPlain('Color spectrum')}</legend>
          <select
            value={mode}
            aria-label={tPlain('Color space')}
            onChange={(event) => {
              const next = Number(event.target.value)
              setMode(next)
              setOption('Tool/Colour Picker/Mode', next)
            }}
          >
            {MODES.map((label, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
          </select>
          <div className="color-picker-spectrum-row">
            <div className="color-picker-spectrum-wrap">
              <canvas
                ref={spectrumRef}
                width={256}
                height={256}
                className="color-picker-canvas"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  const { x, y } = valueAt(event, event.currentTarget)
                  applySpectrum(x, y)
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                  const { x, y } = valueAt(event, event.currentTarget)
                  applySpectrum(x, y)
                }}
              />
              <span
                className="color-picker-pointer"
                style={{
                  left: `${(spectrumPointer.x / 255) * 100}%`,
                  top: `${(spectrumPointer.y / 255) * 100}%`,
                }}
              />
            </div>
            <div className="color-picker-slider-wrap">
              <canvas
                ref={sliderRef}
                width={SLIDER_WIDTH}
                height={256}
                className="color-picker-slider"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  applySlider(valueAt(event, event.currentTarget).y)
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                  applySlider(valueAt(event, event.currentTarget).y)
                }}
              />
              <span
                className="color-picker-slider-pointer"
                style={{ top: `${(sliderValue / 255) * 100}%` }}
              />
            </div>
            {alpha && (
              <div className="color-picker-slider-wrap">
                <canvas
                  ref={alphaSliderRef}
                  width={SLIDER_WIDTH}
                  height={256}
                  className="color-picker-slider"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    emit({ ...color, a: valueAt(event, event.currentTarget).y })
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                    emit({ ...color, a: valueAt(event, event.currentTarget).y })
                  }}
                />
                <span
                  className="color-picker-slider-pointer"
                  style={{ top: `${(alphaValue / 255) * 100}%` }}
                />
              </div>
            )}
          </div>
        </fieldset>

        <div className="color-picker-controls">
          <fieldset>
            <legend>{tPlain('RGB color')}</legend>
            <div className="picker-input-row">
              <label>
                <span>{tPlain('Red:')}</span>
                {byteInput(color.r, (value) => setRgb(value, color.g, color.b), tPlain('Red'))}
              </label>
              <label>
                <span>{tPlain('Green:')}</span>
                {byteInput(color.g, (value) => setRgb(color.r, value, color.b), tPlain('Green'))}
              </label>
              <label>
                <span>{tPlain('Blue:')}</span>
                {byteInput(color.b, (value) => setRgb(color.r, color.g, value), tPlain('Blue'))}
              </label>
            </div>
            <label className="picker-input-row">
              <span>ASS:</span>
              <input
                className="picker-text"
                value={assText}
                onChange={(event) => {
                  setAssText(event.target.value)
                  const parsed = parseAssPickerColor(event.target.value)
                  if (parsed) emit({ ...parsed, a: color.a })
                }}
              />
            </label>
            <label className="picker-input-row">
              <span>HTML:</span>
              <input
                className="picker-text"
                value={htmlText}
                onChange={(event) => {
                  setHtmlText(event.target.value)
                  const parsed = parseCssPickerColor(event.target.value)
                  if (parsed) emit({ ...parsed, a: color.a })
                }}
              />
            </label>
            {alpha && (
              <label className="picker-input-row">
                <span>{tPlain('Alpha:')}</span>
                {byteInput(color.a, (value) => emit({ ...color, a: value }), tPlain('Alpha'))}
              </label>
            )}
          </fieldset>

          <div className="color-picker-hsx">
            <fieldset>
              <legend>{tPlain('HSL color')}</legend>
              <label className="picker-input-row">
                <span>{tPlain('Hue:')}</span>
                {byteInput(hsl[0], (value) => setFromHsl(value, hsl[1], hsl[2]), tPlain('Hue'))}
              </label>
              <label className="picker-input-row">
                <span>{tPlain('Sat.:')}</span>
                {byteInput(hsl[1], (value) => setFromHsl(hsl[0], value, hsl[2]), tPlain('Sat.'))}
              </label>
              <label className="picker-input-row">
                <span>{tPlain('Lum.:')}</span>
                {byteInput(hsl[2], (value) => setFromHsl(hsl[0], hsl[1], value), tPlain('Lum.'))}
              </label>
            </fieldset>
            <fieldset>
              <legend>{tPlain('HSV color')}</legend>
              <label className="picker-input-row">
                <span>{tPlain('Hue:')}</span>
                {byteInput(hsv[0], (value) => setFromHsv(value, hsv[1], hsv[2]), tPlain('Hue'))}
              </label>
              <label className="picker-input-row">
                <span>{tPlain('Sat.:')}</span>
                {byteInput(hsv[1], (value) => setFromHsv(hsv[0], value, hsv[2]), tPlain('Sat.'))}
              </label>
              <label className="picker-input-row">
                <span>{tPlain('Value:')}</span>
                {byteInput(hsv[2], (value) => setFromHsv(hsv[0], hsv[1], value), tPlain('Value'))}
              </label>
            </fieldset>
          </div>

          <div className="color-picker-bottom">
            <div
              className="color-picker-preview"
              style={{
                backgroundImage: `linear-gradient(${pickerColorToCss(color)}, ${pickerColorToCss(color)}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%)`,
                backgroundSize: 'auto, 10px 10px',
              }}
              title={pickerColorToAss(color, true)}
            />
            {hasEyeDropper && (
              <button
                type="button"
                className="picker-dropper"
                onClick={() => void pickFromScreen()}
              >
                {tPlain('Pick from screen')}
              </button>
            )}
            <div className="color-picker-recent" role="group" aria-label={tPlain('Recent colors')}>
              {recent.map((item, index) => (
                <button
                  type="button"
                  key={index}
                  className="color-picker-swatch"
                  title={pickerColorToAss(item)}
                  style={{ backgroundColor: pickerColorToCss(item) }}
                  onClick={() => emit(item)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

interface ColorButtonProps {
  /** 当前值：format='ass' 时为 &HAABBGGRR，format='css' 时为 rgb()/rgba() */
  value: string
  format?: 'ass' | 'css'
  alpha?: boolean
  title?: string
  disabled?: boolean
  className?: string
  onChange: (value: string) => void
}

/** wxColourButton 等价控件：色块 + 点击弹出颜色选择器（dialog_colorpicker.cpp） */
export function ColorButton({
  value,
  format = 'ass',
  alpha = true,
  title,
  disabled,
  className,
  onChange,
}: ColorButtonProps) {
  const [open, setOpen] = useState(false)
  const color = parseColorValue(value)
  const swatch = format === 'ass' ? pickerColorToCss(color) : value
  return (
    <>
      <button
        type="button"
        className={`colour-button${className ? ` ${className}` : ''}`}
        style={
          {
            '--swatch-color': swatch,
          } as CSSProperties
        }
        title={title ?? tPlain('Select Color')}
        aria-label={title ?? tPlain('Select Color')}
        disabled={disabled}
        onClick={() => setOpen(true)}
      />
      {open && (
        <ColorPickerDialog
          initial={value}
          alpha={alpha}
          format={format}
          title={title}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
