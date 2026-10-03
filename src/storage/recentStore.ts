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

/**
 * 字符串型 MRU：源码 mru.cpp 中 "Find"/"Replace" 两类（上限 Limits/Find Replace）。
 * 条目为纯字符串（非文件句柄），存放在 localStorage（与文件型 MRU 的 IndexedDB 分离）。
 */
export type SearchMruType = 'Find' | 'Replace'

export type SearchMruLists = Record<SearchMruType, string[]>

const SEARCH_MRU_STORAGE_KEY = 'aegisub-web:search-mru'

function emptySearchMru(): SearchMruLists {
  return { Find: [], Replace: [] }
}

/** mru.cpp Prune：上限取 Limits/Find Replace（默认 16） */
function searchMruLimit(): number {
  return Math.max(0, getOptionInt('Limits/Find Replace'))
}

export function loadSearchMru(): SearchMruLists {
  try {
    const raw = localStorage.getItem(SEARCH_MRU_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<SearchMruType, unknown>>) : {}
    return {
      Find: Array.isArray(parsed.Find) ? (parsed.Find as string[]) : [],
      Replace: Array.isArray(parsed.Replace) ? (parsed.Replace as string[]) : [],
    }
  } catch {
    // 私密模式 / 数据损坏：回退空列表
    return emptySearchMru()
  }
}

/** mru.cpp MRUManager::Add：已在首位为 no-op；否则前移/插入并裁剪 */
export function pushSearchMru(type: SearchMruType, entry: string): SearchMruLists {
  const lists = loadSearchMru()
  const index = lists[type].indexOf(entry)
  if (index !== 0) {
    if (index > 0) lists[type].splice(index, 1)
    lists[type].unshift(entry)
    lists[type] = lists[type].slice(0, searchMruLimit())
    try {
      localStorage.setItem(SEARCH_MRU_STORAGE_KEY, JSON.stringify(lists))
    } catch {
      // 配额不足：仅本次内存生效
    }
  }
  return lists
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
