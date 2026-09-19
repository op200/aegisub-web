/**
 * worker 环境的 window 别名。web-demuxer 在模块求值时以 `typeof window < "u"`
 * 决定其内部解复用 worker 用 blob 还是 data-URL 创建：worker 线程无 window →
 * 走 data-URL worker（opaque origin），其内 fetch 本地 wasm 会被 CORS 拦截
 * （Failed to fetch）。补上 window 别名让 blob 路径生效——blob worker 继承
 * 创建方 origin，同源 fetch 正常。
 *
 * 必须作为 peaks.worker 的首个 import：ESM import 按序求值，
 * 需先于 web-demuxer（经 demux.ts 引入）的模块求值。
 */
if (typeof window === 'undefined' && typeof self !== 'undefined') {
  ;(self as unknown as { window: unknown }).window = self
}
