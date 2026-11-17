/**
 * MyThes 同义词库（thesaurus.cpp 的 web 移植）。
 * 从 `?dictionary` 读取 `th_<lang>.dat` + `th_<lang>.idx`；
 * .idx 首行给出编码，.dat 为索引文件，按顺序解析成 word → 词义列表。
 */
import { getOptionString, setOption } from '../config/options'
import { VFS_DIRS, listDir, readBytes, readTextFile } from '../storage/vfs'

export interface ThesaurusEntry {
  /** 词性（可能为空）+ 同义词对应的词（thesaurus.cpp Entry::first） */
  first: string
  second: string[]
}

let entries: Map<string, ThesaurusEntry[]> | null = null
let languages: string[] = []
let loadedLanguage = ''
let version = 0
let loadPromise: Promise<void> | null = null
const listeners = new Set<() => void>()

export function getThesaurusVersion(): number {
  return version
}

export function subscribeThesaurus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function bump() {
  version += 1
  for (const listener of listeners) listener()
}

export function getThesaurusLanguages(): string[] {
  return [...languages]
}

export function getThesaurusLanguage(): string {
  return getOptionString('Tool/Thesaurus/Language')
}

export function isThesaurusLoaded(): boolean {
  return entries !== null && loadedLanguage === getThesaurusLanguage()
}

async function scanLanguages(): Promise<string[]> {
  const list = await listDir(VFS_DIRS.dictionaries)
  const names = new Set(list.filter((entry) => !entry.directory).map((entry) => entry.name))
  const result: string[] = []
  for (const name of names) {
    if (!name.startsWith('th_') || !name.endsWith('.idx')) continue
    const language = name.slice(3, -4)
    if (names.has(`th_${language}.dat`)) result.push(language)
  }
  return result.sort()
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 顺序解析 .dat：首行 word|meaningCount，随后 meaningCount 行 pos|word|syn... */
function parseDat(text: string): Map<string, ThesaurusEntry[]> {
  const result = new Map<string, ThesaurusEntry[]>()
  const lines = text.split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const header = lines[index]
    index += 1
    const match = /^(.*)\|(\d+)\s*$/.exec(header)
    if (!match) continue
    const word = match[1].trim()
    const meanings = Number.parseInt(match[2], 10)
    if (!word || !Number.isFinite(meanings)) continue
    const list: ThesaurusEntry[] = []
    for (let i = 0; i < meanings && index < lines.length; i++, index++) {
      const fields = lines[index].split('|')
      if (fields.length < 2) continue
      const first = fields[0] ? `${fields[0]} ${fields[1]}` : fields[1]
      const second = fields.slice(2).filter(Boolean)
      list.push({ first, second })
    }
    if (!list.length) continue
    const key = word.toLowerCase()
    const existing = result.get(key)
    if (existing) existing.push(...list)
    else result.set(key, list)
  }
  return result
}

async function loadThesaurus(language: string): Promise<void> {
  const base = `${VFS_DIRS.dictionaries}/th_${language}`
  const idxBytes = await readBytes(`${base}.idx`)
  const datText = await readTextFile(`${base}.dat`)
  if (!idxBytes || !datText) {
    entries = null
    loadedLanguage = ''
    bump()
    return
  }
  const idxText = new TextDecoder('utf-8').decode(idxBytes)
  const encoding = (idxText.split(/\r?\n/, 1)[0] || 'UTF-8').trim()
  // .idx/.dat 使用同一编码；readTextFile 固定 UTF-8，因此以 idx 的编码重新读 dat 字节
  const datBytes = await readBytes(`${base}.dat`)
  const decodedDat = datBytes ? decodeWith(datBytes, encoding) : datText
  entries = parseDat(decodedDat)
  loadedLanguage = language
  bump()
}

/** 扫描语言列表并按 Tool/Thesaurus/Language 加载（幂等） */
export async function ensureThesaurusLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  const requested = getThesaurusLanguage()
  if (entries && requested && loadedLanguage === requested) return
  loadPromise = (async () => {
    languages = await scanLanguages()
    const language = requested
    try {
      if (language) await loadThesaurus(language)
      else {
        entries = null
        loadedLanguage = ''
        bump()
      }
    } catch {
      entries = null
      loadedLanguage = ''
      bump()
    }
  })()
  await loadPromise
  loadPromise = null
}

export async function reloadThesaurus(): Promise<void> {
  loadPromise = null
  entries = null
  loadedLanguage = ''
  await ensureThesaurusLoaded()
}

export async function setThesaurusLanguage(language: string): Promise<void> {
  setOption('Tool/Thesaurus/Language', language)
  await reloadThesaurus()
}

/** Lookup：与源码一致按原词大小写查表（索引区分大小写） */
export function thesaurusLookup(word: string): ThesaurusEntry[] {
  if (!entries || !word) return []
  return entries.get(word.toLowerCase()) ?? []
}
