/**
 * 虚拟便携文件系统（VFS）。
 *
 * 对齐源码的便携包目录结构（Aegisub/src/main.cpp L167-181）：桌面版便携模式下
 * `?data/config.json` 存在即把 `?user`、`?local` 重定向到 `?data`（可执行文件目录）。
 * Web 版恒为便携模式，故 `?data`/`?user`/`?local` 三者指向同一虚拟根 `/`；
 * `?dictionary` 由 `?data/dictionaries` 派生为 `/dictionaries`。
 *
 * 令牌解析对齐 libaegisub/common/path.cpp：
 * - Decode（L66-74）：`?token/rest` → 根 / rest；令牌未设置或路径不以令牌开头时原样返回。
 * - Encode（L118-134）：逐令牌取最短相对编码，平局保留令牌数组序靠前者。
 * 路径一律使用 POSIX 风格虚拟绝对路径；`?temp`、`?audio`、`?video`、`?script`
 * 在 Web 无对应落盘位置（`?script` 为会话令牌，Decode 原样返回）。
 *
 * 存储：主库 `files` store（无 keyPath），key = 虚拟绝对路径（目录以 '/' 结尾），
 * value = VfsEntry；文本存 UTF-8 string，二进制存 Blob。目录既可显式建（mkdir，
 * 支持空目录），也可由文件路径隐式派生（listDir 前缀扫描聚合），与 wxDir 枚举一致。
 */
import { openMainDatabase } from './db'

/** 令牌全集，顺序即源码 path.cpp L24-33，Encode 平局时取数组序靠前者 */
export const VFS_TOKENS = [
  '?audio',
  '?data',
  '?dictionary',
  '?local',
  '?script',
  '?temp',
  '?user',
  '?video',
] as const

export type VfsToken = (typeof VFS_TOKENS)[number]

/**
 * Web 便携模式下的令牌根（对应 Path::SetToken 后的 paths[]）。
 * `?data`/`?user`/`?local` 同为便携包根；空串表示未设置（Decode 原样返回）。
 */
const TOKEN_ROOTS: Record<VfsToken, string> = {
  '?audio': '',
  '?data': '/',
  '?dictionary': '/dictionaries',
  '?local': '/',
  '?script': '',
  '?temp': '',
  '?user': '/',
  '?video': '',
}

/** 虚拟目录标准位置（对应源码 OPT Path/* 默认值；便携模式 ?user/?data 同根合并） */
export const VFS_DIRS = {
  /** Path/Auto/Save（?user/autosave） */
  autosave: '/autosave',
  /** Path/Auto/Backup（?user/autoback） */
  autoback: '/autoback',
  /** 崩溃恢复目录（?user/recovered，main.cpp L398） */
  recovered: '/recovered',
  /** 样式库（?user/catalog，ass_style_storage.cpp） */
  catalog: '/catalog',
  /** Path/Automation/Autoload（?user|?data 两个令牌同根合并） */
  automationAutoload: '/automation/autoload',
  /** Path/Automation/Include（?user|?data 两个令牌同根合并） */
  automationInclude: '/automation/include',
  /** ?dictionary（?data/dictionaries） */
  dictionaries: '/dictionaries',
} as const

/** 标准化的虚拟目录 key：根为 '/'，其余目录以 '/' 结尾但不含重复斜杠 */
function normalizeDirPrefix(path: string): string {
  if (!path || path === '/' || path === '') return '/'
  return `${path.replace(/\/+$/, '')}/`
}

/** 归一化虚拟绝对路径：合并重复斜杠、消除 '.'/'..'、保证以 '/' 开头 */
export function normalizePath(path: string): string {
  const raw = path.replace(/\\/g, '/')
  const absolute = raw.startsWith('/') ? raw : `/${raw}`
  const parts: string[] = []
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** 拼接虚拟路径（对齐源码 fs::path `/` 运算符的拼接语义） */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter((part, index) => part !== '' || index === 0)
    .join('/')
  return normalizePath(joined.startsWith('/') ? joined : `/${joined}`)
}

/** 父目录（根目录的父目录仍为根，对齐 fs::path::parent_path 在根上的空串语义时取 '/'） */
export function dirname(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

/** 末段名称（去目录后） */
export function basename(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, '')
  if (normalized === '' || normalized === '/') return ''
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** 扩展名（含点；无扩展名返回空串） */
export function extname(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index)
}

/** 去掉扩展名的文件名 */
export function stem(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index <= 0 ? name : name.slice(0, index)
}

function findToken(path: string): VfsToken | null {
  if (path.length < 5 || path[0] !== '?') return null
  for (const token of VFS_TOKENS) {
    if (path.startsWith(token)) return token
  }
  return null
}

/** 令牌路径 → 虚拟绝对路径（Path::Decode，path.cpp L66-74） */
export function vfsDecode(tokenPath: string): string {
  if (!tokenPath) return tokenPath
  const token = findToken(tokenPath)
  if (!token) return normalizePath(tokenPath)
  const root = TOKEN_ROOTS[token]
  if (!root) return tokenPath
  let rest = tokenPath.slice(token.length)
  rest = rest.replace(/^\/+/, '')
  if (rest === '') return root
  return joinPath(root, rest)
}

/** 组件数（对齐 boost::distance(fs::path) 的比较语义） */
function componentCount(path: string): number {
  return normalizePath(path)
    .split('/')
    .filter((segment) => segment !== '').length
}

/** MakeRelative(path, base)：path.cpp L85-106 */
function makeRelative(path: string, base: string): string {
  const target = normalizePath(path)
  const reference = normalizePath(base)
  const targetParts = target.split('/').filter((segment) => segment !== '')
  const baseParts = reference.split('/').filter((segment) => segment !== '')
  let index = 0
  while (
    index < targetParts.length &&
    index < baseParts.length &&
    targetParts[index] === baseParts[index]
  ) {
    index += 1
  }
  return [...baseParts.slice(index).map(() => '..'), ...targetParts.slice(index)].join('/')
}

/** 虚拟绝对路径 → 最短令牌编码（Path::Encode，path.cpp L118-134） */
export function vfsEncode(path: string): string {
  const target = normalizePath(path)
  let shortest = target
  // 源码初始长度为绝对路径组件数（含根组件），平局时保留未编码形式
  let length = componentCount(target) + 1
  for (const token of VFS_TOKENS) {
    const root = TOKEN_ROOTS[token]
    if (!root) continue
    const relative = makeRelative(target, root)
    const distance = componentCount(relative)
    if (distance < length) {
      length = distance
      shortest = relative === '' ? token : `${token}/${relative}`
    }
  }
  return shortest
}

/** files store 记录 */
export interface VfsEntry {
  /** 虚拟绝对路径；目录以 '/' 结尾（根目录 key 为 '/'） */
  path: string
  name: string
  /** 父目录绝对路径，根为 '/' */
  dir: string
  mtime: number
  size: number
  /** 文本内容（UTF-8）；与 data 二选一 */
  text?: string
  /** 二进制内容 */
  data?: Blob
  directory?: boolean
}

export interface VfsDirEntry {
  name: string
  path: string
  directory: boolean
  size: number
  mtime: number
}

const STORE = 'files'

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openMainDatabase()
  try {
    const transaction = database.transaction(STORE, mode)
    const result = await run(transaction.objectStore(STORE))
    if (mode === 'readwrite') {
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    }
    return result
  } finally {
    database.close()
  }
}

function decodeTextBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function makeEntry(
  path: string,
  fields: { text?: string; data?: Blob; directory?: boolean },
): VfsEntry {
  const size =
    typeof fields.text === 'string'
      ? new TextEncoder().encode(fields.text).length
      : (fields.data?.size ?? 0)
  const entry: VfsEntry = {
    path,
    name: basename(path) || '/',
    dir: dirname(path),
    mtime: Date.now(),
    size,
  }
  if (typeof fields.text === 'string') entry.text = fields.text
  if (fields.data) entry.data = fields.data
  if (fields.directory) {
    entry.directory = true
    if (!entry.path.endsWith('/')) entry.path = `${entry.path}/`
  }
  return entry
}

/** 写入 UTF-8 文本文件 */
export async function writeTextFile(vpath: string, text: string): Promise<void> {
  const path = normalizePath(vpath)
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(makeEntry(path, { text }), path))
  })
}

/** 写入二进制文件 */
export async function writeFile(vpath: string, data: Blob | Uint8Array): Promise<void> {
  const path = normalizePath(vpath)
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart])
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(makeEntry(path, { data: blob }), path))
  })
}

/** 读取文本文件；不存在返回 null */
export async function readTextFile(vpath: string): Promise<string | null> {
  const path = normalizePath(vpath)
  const entry = await withStore('readonly', (store) =>
    requestToPromise<VfsEntry | undefined>(store.get(path)),
  )
  if (!entry) return null
  if (typeof entry.text === 'string') return entry.text
  if (entry.data) return decodeTextBytes(new Uint8Array(await entry.data.arrayBuffer()))
  return null
}

/** 读取二进制文件；不存在返回 null */
export async function readFile(vpath: string): Promise<Blob | null> {
  const path = normalizePath(vpath)
  const entry = await withStore('readonly', (store) =>
    requestToPromise<VfsEntry | undefined>(store.get(path)),
  )
  if (!entry) return null
  if (entry.data) return entry.data
  if (typeof entry.text === 'string') return new Blob([entry.text], { type: 'text/plain' })
  return null
}

/** 读取字节；不存在返回 null */
export async function readBytes(vpath: string): Promise<Uint8Array | null> {
  const blob = await readFile(vpath)
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** 文件是否存在（目录 key 带斜杠，二者不混淆） */
export async function fileExists(vpath: string): Promise<boolean> {
  const entry = await stat(vpath)
  return entry !== null && !entry.directory
}

/** 目录是否存在 */
export async function dirExists(vpath: string): Promise<boolean> {
  const path = normalizePath(vpath)
  if (path === '/') return true
  const key = normalizeDirPrefix(path)
  const entry = await withStore('readonly', (store) =>
    requestToPromise<VfsEntry | undefined>(store.get(key)),
  )
  return entry !== undefined
}

/** 取记录（文件或目录）；不存在返回 null */
export async function stat(vpath: string): Promise<VfsEntry | null> {
  const path = normalizePath(vpath)
  const keys = path === '/' ? ['/'] : [path, normalizeDirPrefix(path)]
  return withStore('readonly', async (store) => {
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- 同一事务内的请求必须按序发出
      const entry = await requestToPromise<VfsEntry | undefined>(store.get(key))
      if (entry) return entry
    }
    return null
  })
}

/** 列出目录内容（对齐 wxDir 枚举；隐式目录由文件路径前缀聚合，按名称排序） */
export async function listDir(vpath: string): Promise<VfsDirEntry[]> {
  const dir = normalizeDirPrefix(vpath)
  const prefix = dir === '/' ? '/' : dir
  const result = await withStore('readonly', (store) =>
    requestToPromise<VfsEntry[]>(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))),
  )
  const map = new Map<string, VfsDirEntry>()
  for (const entry of result) {
    const relative = entry.path.slice(prefix.length)
    if (relative === '') continue
    const slash = relative.indexOf('/')
    if (slash === -1) {
      map.set(relative, {
        name: relative,
        path: entry.path.replace(/\/$/, ''),
        directory: entry.directory === true,
        size: entry.size,
        mtime: entry.mtime,
      })
      continue
    }
    // 更深层路径：聚合出中间目录节点
    const childName = relative.slice(0, slash)
    const childPath = `${prefix}${childName}`
    if (!map.has(childName)) {
      map.set(childName, {
        name: childName,
        path: childPath,
        directory: true,
        size: 0,
        mtime: entry.mtime,
      })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 仅列出文件名（不含目录项） */
export async function listFiles(vpath: string): Promise<string[]> {
  const entries = await listDir(vpath)
  return entries.filter((entry) => !entry.directory).map((entry) => entry.name)
}

/** 创建目录（显式记录空目录；父目录不存在时按需补建） */
export async function mkdir(vpath: string): Promise<void> {
  const path = normalizePath(vpath)
  if (path === '/') return
  const segments = path.split('/').filter((segment) => segment !== '')
  const record = async (dirPath: string): Promise<void> => {
    const key = normalizeDirPrefix(dirPath)
    await withStore('readwrite', async (store) => {
      const existing = await requestToPromise<VfsEntry | undefined>(store.get(key))
      if (!existing) await requestToPromise(store.put(makeEntry(key, { directory: true }), key))
    })
  }
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    // oxlint-disable-next-line no-await-in-loop -- 逐级建目录须按序
    await record(current)
  }
}

/** 删除文件或目录（目录递归；不存在静默） */
export async function deletePath(vpath: string): Promise<void> {
  const path = normalizePath(vpath)
  const keys: string[] = [path, normalizeDirPrefix(path)]
  await withStore('readwrite', async (store) => {
    const entries = await requestToPromise<VfsEntry[]>(
      store.getAll(IDBKeyRange.bound(`${path}/`, `${path}/\uffff`)),
    )
    keys.push(...entries.map((entry) => entry.path))
    // oxlint-disable-next-line no-await-in-loop -- 同一事务内的删除须按序发出
    for (const key of keys) await requestToPromise(store.delete(key))
  })
}

/** 重命名/移动（文件或目录，含子项） */
export async function renamePath(from: string, to: string): Promise<void> {
  const source = normalizePath(from)
  const target = normalizePath(to)
  if (source === target) return
  const sourceDir = normalizeDirPrefix(source)
  await withStore('readwrite', async (store) => {
    const entries = await requestToPromise<VfsEntry[]>(store.getAll())
    const affected = entries.filter(
      (entry) => entry.path === source || entry.path.startsWith(sourceDir),
    )
    for (const entry of affected) {
      const suffix = entry.path.slice(source.length)
      const nextPath = entry.directory
        ? normalizeDirPrefix(`${target}${suffix}`)
        : `${target}${suffix}`
      const moved: VfsEntry = {
        ...entry,
        path: nextPath,
        name: basename(nextPath) || '/',
        dir: dirname(nextPath.replace(/\/$/, '')),
      }
      // oxlint-disable-next-line no-await-in-loop -- 同一事务内的搬迁须按序发出
      await requestToPromise(store.delete(entry.path))
      // oxlint-disable-next-line no-await-in-loop -- 同上
      await requestToPromise(store.put(moved, nextPath))
    }
  })
}

/** 复制文件（源不存在时静默） */
export async function copyFile(from: string, to: string): Promise<void> {
  const source = normalizePath(from)
  const target = normalizePath(to)
  const entry = await stat(source)
  if (!entry || entry.directory) return
  const copied = makeEntry(target, { text: entry.text, data: entry.data })
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(copied, target))
  })
}

/** 确保目录存在（幂等） */
export async function ensureDir(vpath: string): Promise<void> {
  await mkdir(vpath)
}

/** 清空全部 VFS 内容（仅用于测试/重置） */
export async function clearVfs(): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.clear())
  })
}

/** 递归枚举整棵目录树（文件管理器展示用） */
export async function listTree(vpath = '/'): Promise<VfsEntry[]> {
  const path = normalizePath(vpath)
  const prefix = path === '/' ? '/' : `${path}/`
  return withStore('readonly', (store) =>
    requestToPromise<VfsEntry[]>(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))),
  )
}
