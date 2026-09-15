/**
 * 视频关键帧缓存（对应源码 FFMS2 的 ?local/ffms2cache/*.ffindex 索引缓存）。
 *
 * 源码：FFmpegSourceProvider::GetCacheFilename 以 crc32(文件名)_文件字节数_修改时间
 * 命名索引文件（内容含关键帧/时间码），FFmpegSourceProvider::CleanCache 按
 * Provider/FFmpegSource/Cache/Size（总大小，MB）与 Cache/Files（数量上限）
 * 从最旧开始清理（utils.cpp CleanCache）。
 *
 * Web 版以同样的键（crc32_大小_修改时间毫秒）把解复用扫描出的关键帧时间存入
 * IndexedDB 'keyframes' store，重开同一文件时免扫描直接命中。
 */
import { getOptionInt } from '../config/options'
import { openMainDatabase } from './db'

const STORE = 'keyframes'

interface StoredKeyframeEntry {
  version: 1 | 2 | 3
  name: string
  keyframeTimesMs: number[]
  /** v3：逐帧 PTS 毫秒时间码表（FFMS2 TimecodesVector 对应物）；空数组=容器无有效表 */
  frameTimesMs?: number[]
  savedAt: number
  bytes: number
}

// --- CRC-32（boost::crc_32_type，标准 CRC-32/ISO-HDLC 多项式 0xEDB88320）----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(text: string): number {
  const bytes = new TextEncoder().encode(text)
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 索引缓存键（ffmpegsource_common.cpp GetCacheFilename 命名规则） */
export function keyframeCacheKey(file: File): string {
  const modifiedSeconds = Math.floor(file.lastModified / 1000)
  return `${crc32(file.name)}_${file.size}_${modifiedSeconds}`
}

export interface CachedVideoIndex {
  keyframeTimesMs: number[]
  /** 逐帧时间码表；undefined=旧条目（无表或为浮点旧算法，需重扫描补全） */
  frameTimesMs?: number[]
}

export async function loadCachedKeyframes(file: File): Promise<CachedVideoIndex | null> {
  try {
    if (typeof indexedDB === 'undefined') return null
    const database = await openMainDatabase()
    try {
      const entry = await new Promise<StoredKeyframeEntry | undefined>((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).get(keyframeCacheKey(file))
        request.onsuccess = () => resolve(request.result as StoredKeyframeEntry | undefined)
        request.onerror = () => reject(request.error)
      })
      if (!entry || !Array.isArray(entry.keyframeTimesMs)) return null
      // v1/v2 旧条目只回关键帧（v2 的表用浮点秒截断，个别帧差 1ms，v3 重扫修正）；
      // v3 起附带逐帧时间码表
      if (entry.version !== 3 || !Array.isArray(entry.frameTimesMs))
        return { keyframeTimesMs: entry.keyframeTimesMs }
      return { keyframeTimesMs: entry.keyframeTimesMs, frameTimesMs: entry.frameTimesMs }
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

/**
 * CleanCache 逐出（utils.cpp CleanCache）：超出数量/大小上限时从最旧开始删，
 * 直到两项都不超；数量上限为 0 视为不限制（源码 max_files == 0 → 无穷大）。
 */
function selectEvictions(
  entries: Array<{ key: string; savedAt: number; bytes: number }>,
  maxFiles: number,
  maxSizeBytes: number,
): string[] {
  let totalSize = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const fileLimit = maxFiles > 0 ? maxFiles : Number.POSITIVE_INFINITY
  if (entries.length <= fileLimit && totalSize <= maxSizeBytes) return []
  const stale = [...entries].sort((a, b) => a.savedAt - b.savedAt)
  const evict: string[] = []
  for (const entry of stale) {
    if (entries.length - evict.length <= fileLimit && totalSize <= maxSizeBytes) break
    evict.push(entry.key)
    totalSize -= entry.bytes
  }
  return evict
}

export async function storeCachedKeyframes(
  file: File,
  keyframeTimesMs: number[],
  frameTimesMs?: number[],
): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined' || keyframeTimesMs.length === 0) return
    const key = keyframeCacheKey(file)
    const database = await openMainDatabase()
    try {
      // 渐进上报（WebCodecs 读流路径）不带表调用时保留既有条目的时间码表，
      // 避免空表覆盖解复用扫描已建好的表
      let table = frameTimesMs ?? []
      if (table.length === 0) {
        const existing = await new Promise<StoredKeyframeEntry | undefined>((resolve, reject) => {
          const request = database.transaction(STORE).objectStore(STORE).get(key)
          request.onsuccess = () => resolve(request.result as StoredKeyframeEntry | undefined)
          request.onerror = () => reject(request.error)
        })
        if (existing?.version === 3 && Array.isArray(existing.frameTimesMs))
          table = existing.frameTimesMs
      }
      const serialized = JSON.stringify([keyframeTimesMs, table])
      const entry: StoredKeyframeEntry = {
        version: 3,
        name: file.name,
        keyframeTimesMs,
        frameTimesMs: table,
        savedAt: Date.now(),
        bytes: serialized.length, // JSON 数字为 ASCII，字符数即字节数
      }
      const store = database.transaction(STORE, 'readwrite').objectStore(STORE)
      store.put(entry, key)
      await new Promise<void>((resolve, reject) => {
        store.transaction.oncomplete = () => resolve()
        store.transaction.onerror = () => reject(store.transaction.error)
      })
      // CleanCache：按 Cache/Files（数量）与 Cache/Size（MB）逐出最旧条目
      const maxFiles = getOptionInt('Provider/FFmpegSource/Cache/Files')
      const maxSizeBytes = getOptionInt('Provider/FFmpegSource/Cache/Size') << 20
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).getAllKeys()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const values = await new Promise<StoredKeyframeEntry[]>((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).getAll()
        request.onsuccess = () => resolve(request.result as StoredKeyframeEntry[])
        request.onerror = () => reject(request.error)
      })
      const byKey = new Map(values.map((value, index) => [String(keys[index]), value]))
      const evictions = selectEvictions(
        keys.map((cacheKey) => {
          const value = byKey.get(String(cacheKey))
          return {
            key: String(cacheKey),
            savedAt: value?.savedAt ?? 0,
            bytes: value?.bytes ?? 0,
          }
        }),
        maxFiles,
        maxSizeBytes,
      )
      if (evictions.length > 0) {
        const evictionStore = database.transaction(STORE, 'readwrite').objectStore(STORE)
        for (const cacheKey of evictions) evictionStore.delete(cacheKey)
      }
    } finally {
      database.close()
    }
  } catch {
    // 缓存不可用时仅跳过，不影响关键帧功能本身
  }
}

/** 清空关键帧缓存（设置 → Browser cache 页使用） */
export async function clearKeyframeCache(): Promise<void> {
  const database = await openMainDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

/** 关键帧缓存条目统计（设置 → Browser cache 页使用） */
export async function keyframeCacheStats(): Promise<{ count: number; bytes: number }> {
  try {
    const database = await openMainDatabase()
    try {
      const values = await new Promise<StoredKeyframeEntry[]>((resolve, reject) => {
        const request = database.transaction(STORE).objectStore(STORE).getAll()
        request.onsuccess = () => resolve(request.result as StoredKeyframeEntry[])
        request.onerror = () => reject(request.error)
      })
      return {
        count: values.length,
        bytes: values.reduce((sum, value) => sum + (value?.bytes ?? 0), 0),
      }
    } finally {
      database.close()
    }
  } catch {
    return { count: 0, bytes: 0 }
  }
}
