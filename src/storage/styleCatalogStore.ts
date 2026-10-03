/**
 * 样式库持久化（对应源码 src/ass_style_storage.cpp）。
 *
 * 桌面版每个目录库是一个文件：?user/catalog/<名称>.sty（LoadCatalog L79-81、
 * GetCatalogs L102-107），内容为 UTF-8 BOM + 每行 `Style: ...`（Save L48-58），
 * 读取时忽略无效行（Load L60-77），文件缺失视为空库。
 * web 落 VFS /catalog/*.sty，复用 core/styleFormat 的 parse/exportStyleCatalog。
 *
 * 选项界面的「Default Style Catalog」下拉需要同步取值，故本模块维护内存缓存：
 * 启动时 initStyleCatalogs() 载入（并把旧 localStorage 数据一次性迁移为 .sty），
 * loadStyleCatalogs() 同步读缓存，saveStyleCatalogs() 同步更新缓存、异步写 VFS
 * （全量写出并清理已删除的 .sty）。
 */
import { createDefaultStyle } from '../core/defaults'
import { exportStyleCatalog, parseStyleCatalog } from '../core/styleFormat'
import type { SubtitleStyle } from '../core/types'
import { deletePath, joinPath, listDir, mkdir, readTextFile, VFS_DIRS, writeTextFile } from './vfs'

/** 旧版（localStorage-only）存储键，迁移成功后删除 */
const LEGACY_KEY = 'aegisub-style-catalogs-v1'

export interface StyleCatalog {
  name: string
  styles: SubtitleStyle[]
}

function cloneStyles(styles: SubtitleStyle[]) {
  return structuredClone(styles)
}

function defaults(): StyleCatalog[] {
  return [{ name: 'Default', styles: [createDefaultStyle()] }]
}

function readLegacy(): StyleCatalog[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '') as StyleCatalog[]
    return Array.isArray(parsed)
      ? parsed.filter((catalog) => catalog?.name && Array.isArray(catalog.styles))
      : []
  } catch {
    return []
  }
}

/** 枚举 /catalog/*.sty 并解析（对应 GetCatalogs + LoadCatalog） */
async function readCatalogsFromVfs(): Promise<StyleCatalog[]> {
  const entries = await listDir(VFS_DIRS.catalog)
  const catalogs: StyleCatalog[] = []
  for (const entry of entries) {
    if (entry.directory || !entry.name.toLowerCase().endsWith('.sty')) continue
    // oxlint-disable-next-line no-await-in-loop -- 逐个解析目录库文件
    const text = await readTextFile(entry.path)
    if (text === null) continue
    catalogs.push({ name: entry.name.slice(0, -'.sty'.length), styles: parseStyleCatalog(text) })
  }
  return catalogs
}

/** 全量写出目录库并清理已删除的 .sty（对应 Save + Delete） */
async function writeCatalogs(catalogs: StyleCatalog[]): Promise<void> {
  await mkdir(VFS_DIRS.catalog)
  const names = new Set(catalogs.map((catalog) => `${catalog.name}.sty`))
  for (const catalog of catalogs) {
    // oxlint-disable-next-line no-await-in-loop -- 逐个写出目录库文件
    await writeTextFile(
      joinPath(VFS_DIRS.catalog, `${catalog.name}.sty`),
      exportStyleCatalog(catalog.styles),
    )
  }
  const entries = await listDir(VFS_DIRS.catalog)
  for (const entry of entries) {
    if (entry.directory || !entry.name.toLowerCase().endsWith('.sty')) continue
    if (names.has(entry.name)) continue
    // oxlint-disable-next-line no-await-in-loop -- 清理已删除的目录库
    await deletePath(entry.path)
  }
}

let cache: StyleCatalog[] | null = null

/** 启动引导：载入缓存（首次运行时把旧 localStorage 数据迁移为 .sty） */
export async function initStyleCatalogs(): Promise<void> {
  let catalogs: StyleCatalog[] = []
  try {
    catalogs = await readCatalogsFromVfs()
  } catch {
    catalogs = []
  }
  if (catalogs.length) {
    cache = catalogs
    return
  }
  const legacy = readLegacy()
  if (legacy.length) {
    cache = legacy
    try {
      await writeCatalogs(legacy)
      localStorage.removeItem(LEGACY_KEY)
    } catch {
      // 迁移失败：缓存与旧数据保留，下次启动重试
    }
    return
  }
  cache = defaults()
}

/** 同步读取（返回副本，避免调用方改动缓存）；未初始化时给出默认库 */
export function loadStyleCatalogs(): StyleCatalog[] {
  return cache ? structuredClone(cache) : defaults()
}

/** 保存：同步更新缓存、异步写 VFS（目录库数量少，全量写出） */
export function saveStyleCatalogs(catalogs: StyleCatalog[]): void {
  cache = catalogs
  void writeCatalogs(catalogs).catch(() => undefined)
}

export function uniqueStyleName(base: string, styles: SubtitleStyle[]): string {
  const used = new Set(styles.map((style) => style.name.toLocaleLowerCase()))
  if (!used.has(base.toLocaleLowerCase())) return base
  let index = 2
  while (used.has(`${base} (${index})`.toLocaleLowerCase())) index += 1
  return `${base} (${index})`
}

export function copyStyle(
  style: SubtitleStyle,
  styles: SubtitleStyle[],
  suffix = `${style.name} - Copy`,
): SubtitleStyle {
  return {
    ...cloneStyles([style])[0],
    id: `style-${crypto.randomUUID()}`,
    name: uniqueStyleName(suffix, styles),
  }
}
