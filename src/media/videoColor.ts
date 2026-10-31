/**
 * 视频色彩管线（对应 Aegisub 的 YCbCr Matrix 语义）。
 *
 * 源码：脚本头 `YCbCr Matrix` 经 `agi::ycbcr::Header::override_colorspace`（ycbcr.cpp）决定
 * 视频解码用的矩阵/范围，变化时 `video_controller.cpp` 立即 `provider->SetColorSpace` 重新出图。
 *
 * Web 端无法让 <video> 按指定矩阵解 YUV（转换是浏览器内部行为），因此在 RGB 域做
 * 等效校正：把「浏览器出图所用的色彩空间」（容器标记，缺省按 guess_colorspace 猜测）
 * 换算到「脚本头生效的色彩空间」，用 WebGL 全屏 pass 输出。
 * 画面因此由自己的 canvas 呈现，绕过 Chrome 对 <video> 的直通色彩管理。
 *
 * 实测（Chrome 1234，未标记 640×360 H.264）：
 *   - 原生 <video> 的 drawImage 输出 = BT.601 + bilinear（与 guess_colorspace 一致）；
 *   - WebCodecs 解码帧默认 colorSpace = BT.709，drawImage 也按 BT.709 → 与 <video> 差
 *     一个矩阵（mean≈19）。故 WebCodecs 路径必须显式给 VideoDecoderConfig.colorSpace
 *     （见 resolveDecoderColorSpace）：只写 matrix/fullRange 会被 Chrome 忽略，四字段缺一不可；
 *     primaries/transfer 换 601 系会让 Chrome 做原色转换（与 <video> 再次不一致）。
 *   - Chrome 不做 BT.709→sRGB 传递函数转换（与 FFmpeg swscale/Aegisub 的直出 RGB 一致），
 *     与其他做完整色彩管理（如 mpv）的播放器仍会有亮度/传递函数差异，属浏览器/播放器差异。
 */
import {
  parseYcbcrHeader,
  ycbcrAffine,
  type YcbcrAffine,
  type YcbcrColorspace,
  type YcbcrMatrix,
  type YcbcrRange,
} from '../core/resample'

const MATRIX_BY_NAME: Record<string, YcbcrMatrix> = {
  bt709: 'BT709',
  smpte170m: 'SMPTE170M',
  bt470bg: 'BT470BG',
  fcc: 'FCC',
  smpte240m: 'SMPTE240M',
  bt2020nc: 'BT2020_NCL',
  bt2020_ncl: 'BT2020_NCL',
  bt2020c: 'BT2020_CL',
  bt2020_cl: 'BT2020_CL',
}

/** 容器/解码器上报的色彩空间名（ffmpeg AVColorSpace/AVColorRange 名）→ 枚举 */
export function parseContainerColorspace(colorSpace: string, colorRange: string): YcbcrColorspace {
  const matrix = MATRIX_BY_NAME[colorSpace.trim().toLowerCase()] ?? 'Unspecified'
  const rangeName = colorRange.trim().toLowerCase()
  const range: YcbcrRange =
    rangeName === 'tv' || rangeName === 'mpeg' || rangeName === 'limited'
      ? 'MPEG'
      : rangeName === 'pc' || rangeName === 'jpeg' || rangeName === 'full'
        ? 'JPEG'
        : 'Unspecified'
  return { matrix, range }
}

/** ycbcr.cpp guess_colorspace：未标记时按分辨率猜矩阵、范围缺省为 MPEG */
export function guessColorspace(
  colorspace: YcbcrColorspace,
  width: number,
  height: number,
): YcbcrColorspace {
  const matrix =
    colorspace.matrix !== 'Unspecified'
      ? colorspace.matrix
      : width > 1024 || height >= 600
        ? 'BT709'
        : 'SMPTE170M'
  return { matrix, range: colorspace.range === 'Unspecified' ? 'MPEG' : colorspace.range }
}

/**
 * Header::override_colorspace：先猜视频自身色彩空间，再被脚本头覆盖。
 * 返回 RGB 域校正系数；恒等变换返回 null（省一次 pass，画面仍由本层输出）。
 *
 * 脚本头缺失/无效时**不覆盖**（按视频自身矩阵出图）：
 * Aegisub 载入视频时会弹 "Set script's YCbCr Matrix?"（默认推荐「设为视频矩阵」，
 * dialog_video_properties.cpp MissingYCbCrMatrixAction::Prompt），桌面端最终就是视频
 * 按自身矩阵出图；web 端未实现该提示，若沿用 `to_effective()` 的「缺失 = TV.601」
 * 会把未标记 HD 视频整帧按 601 重解——表现为 Chrome/原生两条通道颜色都被映射，
 * 与 Firefox 原生播放不一致（用户实测反馈）。显式设置的 TV.601/TV.709/None 仍按
 * 源码语义覆盖。
 */
export function resolveVideoColorTransform(
  real: YcbcrColorspace,
  headerValue: string,
  width: number,
  height: number,
): YcbcrAffine | null {
  const source = guessColorspace(real, width, height)
  const header = parseYcbcrHeader(headerValue)
  const target = header.kind === 'colorspace' ? header.colorspace : source
  if (source.matrix === target.matrix && source.range === target.range) return null
  try {
    return ycbcrAffine(source, target)
  } catch {
    return null
  }
}

type DecoderColorSpace = NonNullable<VideoDecoderConfig['colorSpace']>

// lib.dom 的 VideoColorPrimaries / VideoTransferCharacteristics / VideoMatrixCoefficients
// 只收录了 601/709 少数项，而 Chrome 运行时支持 H.273 的完整枚举（bt2020、pq、hlg…）。
// 这里按 WebCodecs 规范补全，返回处一次性断言为 DOM 类型。
type DecoderMatrix = 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020-ncl'
type DecoderPrimaries = 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020' | 'smpte432'
type DecoderTransfer = 'bt709' | 'smpte170m' | 'iec61966-2-1' | 'linear' | 'pq' | 'hlg'

// Chrome 1234 实测：VideoMatrixCoefficients 只接受 bt709/bt470bg/smpte170m/bt2020-ncl（+rgb），
// 传 smpte240m、bt2020-cl、fcc、ictcp 会抛 TypeError；VideoTransferCharacteristics 只接受
// bt709/smpte170m/iec61966-2-1/linear/pq/hlg（bt2020-10/12、smpte2084 等均拒绝）。
// 无法表达的一律返回 null（保持浏览器默认），绝不传非法值。
const DECODER_MATRIX: Partial<Record<YcbcrMatrix, DecoderMatrix>> = {
  BT709: 'bt709',
  BT470BG: 'bt470bg',
  SMPTE170M: 'smpte170m',
  BT2020_NCL: 'bt2020-ncl',
}

/** ffmpeg color_primaries 名 → WebCodecs 枚举 */
const DECODER_PRIMARIES: Partial<Record<string, DecoderPrimaries>> = {
  bt709: 'bt709',
  bt470bg: 'bt470bg',
  smpte170m: 'smpte170m',
  bt2020: 'bt2020',
  smpte432: 'smpte432',
}

/** ffmpeg color_transfer 名 → WebCodecs 枚举（smpte2084 → pq，arib-std-b67 → hlg） */
const DECODER_TRANSFER: Partial<Record<string, DecoderTransfer>> = {
  bt709: 'bt709',
  smpte170m: 'smpte170m',
  'iec61966-2-1': 'iec61966-2-1',
  linear: 'linear',
  smpte2084: 'pq',
  'arib-std-b67': 'hlg',
}

/** ffmpeg 对"未标记"上报 "unknown"；空串同义 */
function normalizeColorName(name: string): string {
  const value = name.trim().toLowerCase()
  return value === 'unknown' || value === 'unspecified' ? '' : value
}

/**
 * WebCodecs 解码帧的色彩空间声明（VideoDecoderConfig.colorSpace）。
 *
 * 矩阵/范围按 Aegisub 的 guess_colorspace：容器未标记时 SD（W≤1024 且 H<600）用
 * SMPTE170M、其余 BT709，范围缺省 MPEG。Chrome 的 VideoDecoder 对未标记视频统一报
 * BT.709（实测 640×360 未标记 H.264），mkv/avi 回退路径因此与 <video>、Aegisub 差一个矩阵。
 *
 * 实测约束（Chrome 1234）：
 *   - 只给 matrix/fullRange 时 Chrome 忽略整个声明，帧仍是 bt709 —— 四个字段必须齐全；
 *   - primaries/transfer 换成 601 系会触发 Chrome 的原色转换（与 <video> 再差 mean≈7.8），
 *     因此这两个字段沿用容器标记（缺省 bt709 = Chrome 自身的默认），只有矩阵/范围按 Aegisub 猜。
 *   - 矩阵无法映射为 WebCodecs 枚举（如 FCC）时返回 null，保持浏览器默认。
 */
export function resolveDecoderColorSpace(
  container: YcbcrColorspace,
  width: number,
  height: number,
  primaries: string,
  transfer: string,
): DecoderColorSpace | null {
  const guessed = guessColorspace(container, width, height)
  const matrix = DECODER_MATRIX[guessed.matrix]
  if (!matrix) return null
  const primariesName = normalizeColorName(primaries)
  const transferName = normalizeColorName(transfer)
  const decoderPrimaries = primariesName ? DECODER_PRIMARIES[primariesName] : 'bt709'
  const decoderTransfer = transferName ? DECODER_TRANSFER[transferName] : 'bt709'
  // 容器标记了但 WebCodecs 表达不了（如 bt2020-10 传递函数）：交给浏览器默认，
  // 强行回落 bt709 反而会覆盖掉本来正确的声明
  if (!decoderPrimaries || !decoderTransfer) return null
  return {
    primaries: decoderPrimaries,
    transfer: decoderTransfer,
    matrix,
    fullRange: guessed.range === 'JPEG',
  } as DecoderColorSpace
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vTexCoord;
void main() {
  vTexCoord = vec2(aPosition.x * 0.5 + 0.5, aPosition.y * 0.5 + 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uTexture;
uniform mat3 uMatrix;
uniform vec3 uOffset;
void main() {
  vec3 rgb = texture2D(uTexture, vTexCoord).rgb;
  gl_FragColor = vec4(clamp(uMatrix * rgb + uOffset, 0.0, 1.0), 1.0);
}
`

function compile(context: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = context.createShader(type)
  if (!shader) return null
  context.shaderSource(shader, source)
  context.compileShader(shader)
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    context.deleteShader(shader)
    return null
  }
  return shader
}

/**
 * 视频色彩层：把 <video>（或 WebCodecs 画布）上传为纹理，按校正矩阵重绘。
 * 绘制失败/无 WebGL 时返回 null，调用方退回直接显示 <video>。
 */
export class VideoColorStage {
  private context: WebGLRenderingContext
  private program: WebGLProgram
  private texture: WebGLTexture
  private matrixLocation: WebGLUniformLocation | null
  private offsetLocation: WebGLUniformLocation | null
  private source: HTMLVideoElement | HTMLCanvasElement | null = null

  private constructor(
    private canvas: HTMLCanvasElement,
    context: WebGLRenderingContext,
    program: WebGLProgram,
    texture: WebGLTexture,
  ) {
    this.context = context
    this.program = program
    this.texture = texture
    this.matrixLocation = context.getUniformLocation(program, 'uMatrix')
    this.offsetLocation = context.getUniformLocation(program, 'uOffset')
  }

  static create(canvas: HTMLCanvasElement): VideoColorStage | null {
    const context = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // 截图（video save_snapshot）需要事后读回像素
    })
    if (!context) return null
    const vertex = compile(context, context.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vertex || !fragment) return null
    const program = context.createProgram()
    if (!program) return null
    context.attachShader(program, vertex)
    context.attachShader(program, fragment)
    context.linkProgram(program)
    if (!context.getProgramParameter(program, context.LINK_STATUS)) return null
    context.useProgram(program)

    // 全屏三角带（位置同时用于推导纹理坐标）
    const buffer = context.createBuffer()
    context.bindBuffer(context.ARRAY_BUFFER, buffer)
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      context.STATIC_DRAW,
    )
    const position = context.getAttribLocation(program, 'aPosition')
    context.enableVertexAttribArray(position)
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0)

    const texture = context.createTexture()
    context.bindTexture(context.TEXTURE_2D, texture)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
    // 纹理行序与视频一致（左上原点）；着色器不再翻转
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true)
    context.uniform1i(context.getUniformLocation(program, 'uTexture'), 0)

    const stage = new VideoColorStage(canvas, context, program, texture)
    stage.setTransform(null)
    return stage
  }

  setSource(source: HTMLVideoElement | HTMLCanvasElement): void {
    this.source = source
  }

  /** null = 恒等（仍重绘：本层是画面的显示面） */
  setTransform(transform: YcbcrAffine | null): void {
    const context = this.context
    context.useProgram(this.program)
    if (transform) {
      // GLSL 的 mat3 按列主序解释，而 WebGL1 的 uniformMatrix3fv 不接受 transpose=true，
      // 必须把行主序的仿射矩阵重排成列主序，否则 shader 实际乘的是转置矩阵（颜色会改但映射错误）
      const m = transform.matrix
      context.uniformMatrix3fv(
        this.matrixLocation,
        false,
        new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]),
      )
      context.uniform3f(
        this.offsetLocation,
        transform.offset[0] / 255,
        transform.offset[1] / 255,
        transform.offset[2] / 255,
      )
    } else {
      context.uniformMatrix3fv(
        this.matrixLocation,
        false,
        new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      )
      context.uniform3f(this.offsetLocation, 0, 0, 0)
    }
  }

  /** 画布像素尺寸跟随源显示尺寸；尺寸未变返回 false（无需重设 viewport） */
  measure(width: number, height: number): boolean {
    if (!width || !height) return false
    if (this.canvas.width === width && this.canvas.height === height) return false
    this.canvas.width = width
    this.canvas.height = height
    return true
  }

  /** 上传当前源并重绘；源尚无可用帧（readyState 过低）时返回 false */
  draw(): boolean {
    const source = this.source
    if (!source) return false
    const context = this.context
    if (!this.canvas.width || !this.canvas.height) return false
    context.viewport(0, 0, this.canvas.width, this.canvas.height)
    context.bindTexture(context.TEXTURE_2D, this.texture)
    try {
      context.texImage2D(
        context.TEXTURE_2D,
        0,
        context.RGBA,
        context.RGBA,
        context.UNSIGNED_BYTE,
        source,
      )
    } catch {
      // 源尚未有可上传帧：保留上一帧
      return false
    }
    context.drawArrays(context.TRIANGLE_STRIP, 0, 4)
    return true
  }

  destroy(): void {
    this.source = null
    this.context.bindTexture(this.context.TEXTURE_2D, null)
    this.context.deleteTexture(this.texture)
    this.context.deleteProgram(this.program)
  }
}
