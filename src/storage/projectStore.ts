/**
 * 自动保存与备份（对应源码 src/subs_controller.cpp）。
 *
 * AutoSave()（L255-292）：仅在文档有未自动保存的修改时写入
 * Path/Auto/Save（默认 ?user/autosave）下
 * `名称.年-月-日-时-分-秒.AUTOSAVE.ass`（源码 "%s.%s.AUTOSAVE.ass"，
 * name = filename.filename() 含扩展名；源码不清理旧自动保存，此处同样保留）。
 * 内容为真实 .ass 文本（core.export('ass')），落 VFS files store。
 * Load()（L184-194）：App/Auto/Backup 开启时把原始文件复制为
 * `名称.ORIGINAL.扩展名`（stem + ".ORIGINAL" + extension）到 Path/Auto/Backup
 * （默认 ?user/autoback），同名覆盖（每文件保留一份）。
 *
 * 旧数据（v4 projects store 的 autosave:<时间戳> 键与 v3 单槽 autosave 键）
 * 仅作只读回退：旧自动保存是内存文档快照，离线无法导出 .ass，
 * 故保留 core.restore 通路。
 */
import { getOptionString } from '../config/options'
import type { StoredProject, SubtitleDocument } from '../core/types'
import { openMainDatabase } from './db'
import {
  extname,
  joinPath,
  listDir,
  mkdir,
  readTextFile,
  stem,
  VFS_DIRS,
  vfsDecode,
  writeTextFile,
} from './vfs'

const AUTOSAVE_SUFFIX = '.AUTOSAVE.ass'
/** 旧版存储位置（projects store），仅作只读回退 */
const PROJECTS_STORE = 'projects'
const AUTOSAVE_PREFIX = 'autosave:'
const LEGACY_AUTOSAVE_KEY = 'autosave'

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

/** 虚拟文件名：`名称.时间戳.AUTOSAVE.ass` */
export function autosaveFileName(name: string, savedAt: number): string {
  return `${name}.${autosaveTimestamp(new Date(savedAt))}${AUTOSAVE_SUFFIX}`
}

/** 从 `名称.时间戳.AUTOSAVE.ass` 反解时间戳（对应 dialog_autosave.cpp L135-143） */
function parseAutosaveStamp(fileName: string): number | null {
  const base = fileName.slice(0, -AUTOSAVE_SUFFIX.length)
  const index = base.lastIndexOf('.')
  if (index === -1) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(base.slice(index + 1))
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/**
 * Path/Auto/Save 解析（源码：空则取当前文件父目录）。
 * web 用户文件不在 VFS 中，无父目录可表达，空值退回默认目录。
 */
function autosaveDirectory(): string {
  const raw = getOptionString('Path/Auto/Save')
  return raw ? vfsDecode(raw) : VFS_DIRS.autosave
}

/** Path/Auto/Backup 解析，空值语义同上 */
function backupDirectory(): string {
  const raw = getOptionString('Path/Auto/Backup')
  return raw ? vfsDecode(raw) : VFS_DIRS.autoback
}

/** 定时自动保存（SubsController::AutoSave），返回虚拟绝对路径 */
export async function saveAutosave(
  name: string,
  text: string,
  savedAt = Date.now(),
): Promise<string> {
  const dir = autosaveDirectory()
  const path = joinPath(dir, autosaveFileName(name, savedAt))
  await mkdir(dir)
  await writeTextFile(path, text)
  return path
}

/** 最新自动保存：新格式为 VFS .ass 文件；legacy 为旧内存文档快照 */
export type AutosaveSource =
  | { kind: 'file'; path: string; fileName: string; text: string; savedAt: number }
  | { kind: 'legacy'; fileName: string; document: SubtitleDocument; savedAt: number }

function getAllKeys(database: IDBDatabase): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function getValue<T>(database: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

interface StoredAutosave {
  version: 1
  savedAt: number
  name: string
  document: SubtitleDocument
}

/** 旧版自动保存（v4 多槽 / v3 单槽），无则 null */
async function loadLegacyAutosave(): Promise<AutosaveSource | null> {
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
      if (entry?.version === 1 && entry.document)
        return {
          kind: 'legacy',
          fileName: entry.name || 'Untitled',
          document: entry.document,
          savedAt: entry.savedAt,
        }
    }
    const single = await getValue<StoredProject>(database, LEGACY_AUTOSAVE_KEY)
    if (single?.document)
      return {
        kind: 'legacy',
        fileName: single.document.sourceName || 'Untitled',
        document: single.document,
        savedAt: single.updatedAt,
      }
    return null
  } finally {
    database.close()
  }
}

/** 最新一条自动保存（VFS 优先，旧数据只读回退），无则 null */
export async function loadLatestAutosave(): Promise<AutosaveSource | null> {
  try {
    const dir = autosaveDirectory()
    const entries = await listDir(dir)
    const candidates = entries
      .filter((entry) => !entry.directory && entry.name.endsWith(AUTOSAVE_SUFFIX))
      .map((entry) => ({ entry, stamp: parseAutosaveStamp(entry.name) }))
      .sort((a, b) => (b.stamp ?? b.entry.mtime) - (a.stamp ?? a.entry.mtime))
    for (const candidate of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- 按时间倒序取第一条可读记录
      const text = await readTextFile(candidate.entry.path)
      if (text !== null)
        return {
          kind: 'file',
          path: candidate.entry.path,
          fileName: candidate.entry.name,
          text,
          savedAt: candidate.stamp ?? candidate.entry.mtime,
        }
    }
    return await loadLegacyAutosave()
  } catch {
    return null
  }
}

/** 原始文件备份（SubsController::Load 的 .ORIGINAL 备份），同名覆盖，返回虚拟绝对路径 */
export async function saveSubtitleBackup(name: string, text: string): Promise<string> {
  const dir = backupDirectory()
  const path = joinPath(dir, `${stem(name)}.ORIGINAL${extname(name)}`)
  await mkdir(dir)
  await writeTextFile(path, text)
  return path
}
