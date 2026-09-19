import type {
  CoreRequest,
  CoreResponse,
  CoreTextDelta,
  SearchMatch,
  SearchSettings,
} from '../workers/protocol'
import type { CoreCommand, CoreState, SubtitleDocument, SubtitleFormat } from './types'

type CoreRequestPayload = CoreRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

export class CoreClient {
  private readonly worker = new Worker(new URL('../workers/subtitle.worker.ts', import.meta.url), {
    type: 'module',
  })
  private nextId = 1
  /** 最近一次完整状态：文本增量响应按它做局部合并（未变 cue 保留对象身份） */
  private lastState: CoreState | null = null
  private pending = new Map<
    number,
    {
      resolve: (value: CoreState | Uint8Array | SearchMatch[] | number) => void
      reject: (error: Error) => void
    }
  >()

  constructor() {
    // 相对 base（'./'）在 worker 里会按 worker 脚本 URL 解析，必须先在
    // 主线程对文档 baseURI 绝对化再传入
    this.worker.postMessage({
      method: 'init',
      baseUrl: new URL(import.meta.env.BASE_URL ?? '/', document.baseURI).href,
    } satisfies CoreRequest)
    this.worker.onmessage = ({ data }: MessageEvent<CoreResponse>) => {
      const pending = this.pending.get(data.id)
      if (!pending) return
      this.pending.delete(data.id)
      if (data.error) {
        pending.reject(new Error(data.error))
        return
      }
      if (data.delta) {
        // 极罕见：尚无基准状态（启动即拖动）→ 回退取整份状态
        const merged = this.mergeDelta(data.delta)
        if (merged) pending.resolve(merged)
        else void this.state().then((state) => pending.resolve(state), pending.reject)
        return
      }
      if (data.result !== undefined) {
        if (isCoreState(data.result)) this.lastState = data.result
        pending.resolve(data.result)
      }
    }
  }

  /** 文本增量 → 完整状态：只重建受影响的 cue（其余 cue 对象原样复用） */
  private mergeDelta(delta: CoreTextDelta): CoreState | null {
    const base = this.lastState
    if (!base) return null
    const texts = new Map(delta.changes.map((change) => [change.id, change.text]))
    const cues = base.document.cues.map((cue) => {
      const text = texts.get(cue.id)
      return text === undefined ? cue : { ...cue, text }
    })
    const next: CoreState = {
      ...base,
      document: { ...base.document, cues, revision: delta.revision },
      canUndo: delta.canUndo,
      canRedo: delta.canRedo,
      undoLabel: delta.undoLabel,
      redoLabel: delta.redoLabel,
    }
    this.lastState = next
    return next
  }

  state(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'state' })
  }

  open(bytes: Uint8Array, sourceName: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'open', bytes, sourceName }, [bytes.buffer])
  }

  restore(document: SubtitleDocument): Promise<CoreState> {
    return this.request<CoreState>({ method: 'restore', document })
  }

  apply(commands: CoreCommand[], label: string): Promise<CoreState> {
    return this.request<CoreState>({ method: 'apply', commands, label })
  }

  undo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'undo' })
  }
  redo(): Promise<CoreState> {
    return this.request<CoreState>({ method: 'redo' })
  }
  export(format?: SubtitleFormat): Promise<Uint8Array> {
    return this.request<Uint8Array>({ method: 'export', format })
  }
  search(settings: SearchSettings): Promise<SearchMatch[]> {
    return this.request<SearchMatch[]>({ method: 'search', settings })
  }
  replaceAll(settings: SearchSettings): Promise<number> {
    // 该路径直接改文档却不回传状态：立即补取基准，避免后续文本增量合并到陈旧文档
    return this.request<number>({ method: 'replaceAll', settings }).then((count) => {
      void this.state()
      return count
    })
  }
  /** 运行时配置（Limits/Undo Levels 等）；无响应 */
  configure(config: { undoLevels: number }): void {
    this.worker.postMessage({ method: 'configure', config } satisfies CoreRequest)
  }
  /** 手动保存成功后通知核心：下一次提交不再与保存前合并；无响应 */
  markSaved(): void {
    this.worker.postMessage({ method: 'markSaved' } satisfies CoreRequest)
  }
  close(): void {
    this.worker.terminate()
  }

  private request<T extends CoreState | Uint8Array | SearchMatch[] | number>(
    payload: CoreRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: CoreState | Uint8Array | SearchMatch[] | number) => void,
        reject,
      })
      this.worker.postMessage({ ...payload, id } as CoreRequest, transfer)
    })
  }
}

const isCoreState = (value: CoreState | Uint8Array | SearchMatch[] | number): value is CoreState =>
  typeof value === 'object' && value !== null && 'document' in value
