import { getOptionInt } from '../config/options'
/**
 * 最近文件（对应 Aegisub MRU：libaegisub/mru.cpp，每类上限 Limits/MRU，默认 16）。
 * File 对象可结构化克隆并存入 IndexedDB，因此 Web 版可以真正重新打开最近的文件。
 */
import { openMainDatabase } from './db'

export type RecentType = 'subtitle' | 'video' | 'audio' | 'timecodes' | 'keyframes'

export const RECENT_TYPES: RecentType[] = ['subtitle', 'video', 'audio', 'timecodes', 'keyframes']

/** mru.cpp：MRU_MAXENTRIES 上限可由 Limits/MRU 配置（Preferences → General → Recently Used Lists） */
export function mruMaxEntries(): number {
  return Math.max(0, Math.min(16, getOptionInt('Limits/MRU')))
}

export interface RecentEntry {
  name: string
  file?: File
  addedAt: number
}

export type RecentLists = Record<RecentType, RecentEntry[]>

function emptyLists(): RecentLists {
  return { subtitle: [], video: [], audio: [], timecodes: [], keyframes: [] }
}

const STORE = 'recent'
const KEY = 'mru'

export async function loadRecentLists(): Promise<RecentLists> {
  try {
    const database = await openMainDatabase()
    const value = await new Promise<RecentLists | undefined>((resolve, reject) => {
      const request = database.transaction(STORE).objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result as RecentLists | undefined)
      request.onerror = () => reject(request.error)
    })
    database.close()
    const lists = emptyLists()
    if (value) {
      for (const type of RECENT_TYPES) {
        lists[type] = Array.isArray(value[type]) ? value[type].slice(0, mruMaxEntries()) : []
      }
    }
    return lists
  } catch {
    return emptyLists()
  }
}

/** 新条目插到最前（按文件名去重），超过 16 条裁剪 */
export async function pushRecent(
  type: RecentType,
  entry: { name: string; file?: File },
): Promise<RecentLists> {
  const lists = await loadRecentLists()
  const rest = lists[type].filter((item) => item.name !== entry.name)
  lists[type] = [{ ...entry, addedAt: Date.now() }, ...rest].slice(0, mruMaxEntries())
  try {
    const database = await openMainDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(lists, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // 私密模式下 IndexedDB 可能不可用，仅内存保留
  }
  return lists
}
