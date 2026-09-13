/**
 * 自动保存与备份（对应源码 src/subs_controller.cpp）。
 *
 * AutoSave()：仅在文档有未自动保存的修改时写入，文件名为
 * `名称_年-月-日-时-分-秒.AUTOSAVE.ass`（源码 "%s.%s.AUTOSAVE.ass"），
 * 存入 Path/Auto/Save（?user/autosave）；源码不清理旧自动保存，此处同样保留。
 * Load()：App/Auto/Backup 开启时把原始文件备份为 `名称.ORIGINAL.扩展名`
 * 存入 Path/Auto/Backup（?user/autoback），同名覆盖（每文件保留一份）。
 */
import type { StoredProject, SubtitleDocument } from '../core/types'
import { openMainDatabase } from './db'

const STORE = 'projects'
const AUTOSAVE_PREFIX = 'autosave:'
/** 旧版单槽自动保存键（v3），仅作只读回退 */
const LEGACY_AUTOSAVE_KEY = 'autosave'
const BACKUP_PREFIX = 'backup:'

/** 源码 agi::util::strftime("%Y-%m-%d-%H-%M-%S") 的本地时间格式 */
function autosaveTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    '-',
    pad(date.getMinutes()),
    '-',
    pad(date.getSeconds()),
  ].join('')
}

/** 虚拟文件名：`名称.时间戳.AUTOSAVE.ass`（状态栏消息使用） */
export function autosaveFileName(name: string, savedAt: number): string {
  return `${name}.${autosaveTimestamp(new Date(savedAt))}.AUTOSAVE.ass`
}

interface StoredAutosave {
  version: 1
  savedAt: number
  name: string
  document: SubtitleDocument
}

function putValue(database: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

function getValue<T>(database: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

function getAllKeys(database: IDBDatabase): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 定时自动保存（SubsController::AutoSave），返回虚拟文件名 */
export async function saveAutosave(name: string, document: SubtitleDocument): Promise<string> {
  const savedAt = Date.now()
  const entry: StoredAutosave = { version: 1, savedAt, name, document }
  const database = await openMainDatabase()
  try {
    await putValue(database, `${AUTOSAVE_PREFIX}${savedAt}`, entry)
  } finally {
    database.close()
  }
  return autosaveFileName(name, savedAt)
}

/** 最新一条自动保存（含旧版单槽数据回退），无则 null */
export async function loadLatestAutosave(): Promise<StoredAutosave | null> {
  try {
    const database = await openMainDatabase()
    try {
      const keys = await getAllKeys(database)
      const stamps = keys
        .map((key) => String(key))
        .filter((key) => key.startsWith(AUTOSAVE_PREFIX))
        .map((key) => Number(key.slice(AUTOSAVE_PREFIX.length)))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => b - a)
      if (stamps.length > 0) {
        const entry = await getValue<StoredAutosave>(database, `${AUTOSAVE_PREFIX}${stamps[0]}`)
        if (entry?.version === 1 && entry.document) return entry
      }
      // 旧版单槽数据（v3）：作为回退继续可恢复
      const legacy = await getValue<StoredProject>(database, LEGACY_AUTOSAVE_KEY)
      if (legacy?.document)
        return {
          version: 1,
          savedAt: legacy.updatedAt,
          name: legacy.document.sourceName || 'Untitled',
          document: legacy.document,
        }
      return null
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

/** 原始文件备份（SubsController::Load 的 .ORIGINAL 备份），同名覆盖 */
export async function saveSubtitleBackup(name: string, text: string): Promise<void> {
  const database = await openMainDatabase()
  try {
    await putValue(database, `${BACKUP_PREFIX}${name}`, {
      version: 1,
      savedAt: Date.now(),
      name,
      text,
    })
  } finally {
    database.close()
  }
}
