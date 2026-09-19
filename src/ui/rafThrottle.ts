/**
 * 帧节拍合流（异步弃帧）：同帧内多次调用只执行最后一次（后到覆盖先到）。
 *
 * 对应源码 async_video_provider 的版本号弃帧语义：高频输入（pointermove 可达
 * 数百 Hz）按浏览器帧率收敛为每帧最多一次，渲染耗时超过帧间隔时自动降频，
 * 中间结果全部丢弃（以最终位置为准）。
 */
export interface RafThrottled {
  /** 记录一次调用；本帧已有挂起调用则覆盖之 */
  (fn: () => void): void
  /** 同步执行并清空挂起的调用（pointerup 等最终值必须立即落盘的场景） */
  flush(): void
}

export function rafThrottle(): RafThrottled {
  let queued: (() => void) | null = null
  let raf = 0
  const run = () => {
    raf = 0
    const fn = queued
    queued = null
    fn?.()
  }
  const throttled = (fn: () => void) => {
    queued = fn
    if (!raf) raf = requestAnimationFrame(run)
  }
  throttled.flush = () => {
    if (raf) {
      cancelAnimationFrame(raf)
      run()
    }
  }
  return throttled as RafThrottled
}

/**
 * 串行「最新目标」通道（异步弃帧：在途任务不可打断时丢弃被取代的目标）。
 *
 * 拖动产生的目标值（时间轴位置、标记时间、视觉工具坐标）远快于异步管线
 * （worker 往返 + 解码 + 重绘）的处理速度。若把每个目标都排队，松开鼠标后
 * 画面会按队列把中间位置逐个回放（"眼睁睁看着图像从 a 慢慢走到 b"）。
 * 这里在管线上游做覆盖式丢弃：任务在途时不排队，新目标只覆盖待发槽位，
 * 在途完成后仅执行最后一个目标——与源码 async_video_provider.cpp 的
 * RequestFrame（`++version` 覆盖请求、worker 发现 req_version < version 即
 * return）同一语义。
 */
export interface SerialLatest<A extends unknown[]> {
  /** 记录最新目标；管线空闲则立即执行，否则覆盖待发槽位（中间目标丢弃） */
  (...args: A): void
  /** 立即执行待发目标（pointerup 等最终值必须落盘）；在途任务不受影响 */
  flush(): void
}

export function serialLatest<A extends unknown[]>(
  task: (...args: A) => Promise<unknown> | unknown,
): SerialLatest<A> {
  let pending: A | null = null
  let running = false
  const drain = () => {
    if (running || pending === null) return
    const args = pending
    pending = null
    running = true
    void Promise.resolve()
      .then(() => task(...args))
      .catch(() => undefined)
      .finally(() => {
        running = false
        drain()
      })
  }
  const channel = (...args: A) => {
    pending = args
    drain()
  }
  channel.flush = drain
  return channel as SerialLatest<A>
}
