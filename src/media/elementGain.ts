/**
 * 媒体元素音量增益（对应源码 audio_player SetVolume 语义）。
 *
 * Aegisub 音量曲线为 pow(mid(1,pos,100)/50, 3)——50 为不变量、100 为 8 倍增益；
 * HTMLMediaElement.volume 上限 1.0，直接赋值时滑条 50 以上整段死区（表现即
 * "音量滑条无法控制音量"）。经 WebAudio GainNode 路由后 >1 的增益可用。
 *
 * 规范限制：每个媒体元素只允许创建一次 MediaElementAudioSourceNode，创建后元素
 * 声音仅经该节点输出——因此节点随元素生命周期复用，元素被替换时 detach 旧节点。
 * AudioContext 为共享单例（浏览器对上下文数量有上限）；resume 在播放手势的
 * 'play' 事件内进行，避免悬浮的 suspended 上下文静音元素。
 */

let context: AudioContext | null = null
const attached = new Map<
  HTMLMediaElement,
  { source: MediaElementAudioSourceNode; gain: GainNode; onPlay: () => void }
>()

function audioContext(): AudioContext {
  if (!context) context = new AudioContext()
  if (context.state === 'suspended') void context.resume()
  return context
}

/** 为元素套用增益因子（1.0 不变，>1 放大；幂等，重复调用仅更新增益值） */
export function setElementGain(el: HTMLMediaElement, gain: number): void {
  let node = attached.get(el)
  if (!node) {
    const ctx = audioContext()
    const source = ctx.createMediaElementSource(el)
    const gainNode = ctx.createGain()
    source.connect(gainNode)
    gainNode.connect(ctx.destination)
    const onPlay = () => {
      if (ctx.state === 'suspended') void ctx.resume()
    }
    el.addEventListener('play', onPlay)
    node = { source, gain: gainNode, onPlay }
    attached.set(el, node)
  }
  node.gain.gain.value = gain
}

/** 元素被移除/替换时断开其节点（断开后元素静音，仅适用于元素即将废弃的场景） */
export function detachElementGain(el: HTMLMediaElement): void {
  const node = attached.get(el)
  if (!node) return
  el.removeEventListener('play', node.onPlay)
  node.source.disconnect()
  node.gain.disconnect()
  attached.delete(el)
}
