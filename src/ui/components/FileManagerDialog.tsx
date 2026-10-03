/**
 * 便携虚拟文件系统（VFS）文件管理器（web 特有对话框）。
 *
 * 桌面版没有对应窗口：web 版把便携包的落盘内容（自动保存 / 备份 / 样式库 /
 * 自动化脚本等，见 storage/vfs.ts）全部放进 IndexedDB，故提供一个通用文件管理器，
 * 让用户像操作真实目录一样浏览/增删改这些文件，并提供「还原默认」把出厂的
 * Automation 脚本写回。
 *
 * 有意偏差：桌面版的 dialog_autosave.cpp 是三栏「自动保存列表」语义（含
 * 时间戳解析、排序、筛选框），本对话框不还原该形态，改为通用文件管理器
 * （用户明确选择，见 未完成计划.md）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  basename,
  deletePath,
  dirname,
  joinPath,
  listDir,
  mkdir,
  readFile,
  readTextFile,
  renamePath,
  writeFile,
  writeTextFile,
  type VfsDirEntry,
} from '../../storage/vfs'
import { tPlain } from '../i18n'
import { Dialog } from './dialogs'

interface FileManagerDialogProps {
  onClose: () => void
  /** 还原出厂 Automation 脚本（storage/factoryScripts.restoreFactoryScripts） */
  onRestoreDefaults: () => Promise<void>
  /** VFS 内容变化后回调（App 重新加载自动化脚本等） */
  onChanged: () => void
}

type PromptState =
  | {
      kind: 'input'
      title: string
      initial: string
      confirmLabel: string
      onConfirm: (value: string) => void
    }
  | { kind: 'confirm'; title: string; message: string; onConfirm: () => void }

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(mtime: number): string {
  return new Date(mtime).toLocaleString()
}

export function FileManagerDialog({
  onClose,
  onRestoreDefaults,
  onChanged,
}: FileManagerDialogProps) {
  const [cwd, setCwd] = useState('/')
  const [entries, setEntries] = useState<VfsDirEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [editor, setEditor] = useState<{ path: string; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null

  const refresh = useCallback(async (dir: string) => {
    try {
      const list = await listDir(dir)
      // 隐藏内部标记文件（如 /automation/.factory-scripts）
      setEntries(list.filter((entry) => !entry.name.startsWith('.')))
    } catch {
      setStatus(tPlain('Failed to read directory'))
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await refresh(cwd)
    })()
  }, [cwd, refresh])

  // 导航（进入目录 / 上一级）时重置选中与编辑器，避免 Effect 内同步 setState
  const navigate = useCallback((dir: string) => {
    setSelected(null)
    setEditor(null)
    setCwd(dir)
  }, [])

  const run = useCallback(
    async (action: () => Promise<void>, message: string) => {
      try {
        await action()
        setStatus(message)
        await refresh(cwd)
        onChanged()
      } catch (error) {
        setStatus(error instanceof Error ? error.message : tPlain('Operation failed'))
      }
    },
    [cwd, onChanged, refresh],
  )

  const openPrompt = (next: PromptState) => {
    setPromptValue(next.kind === 'input' ? next.initial : '')
    setPrompt(next)
  }

  const openEntry = (entry: VfsDirEntry) => {
    if (entry.directory) navigate(entry.path)
    else setSelected(entry.path)
  }

  const newFolder = () =>
    openPrompt({
      kind: 'input',
      title: tPlain('New Folder'),
      initial: '',
      confirmLabel: tPlain('Create'),
      onConfirm: (value) => {
        const name = value.trim()
        if (!name) return
        void run(() => mkdir(joinPath(cwd, name)), tPlain('Folder created'))
      },
    })

  const newFile = () =>
    openPrompt({
      kind: 'input',
      title: tPlain('New File'),
      initial: 'untitled.lua',
      confirmLabel: tPlain('Create'),
      onConfirm: (value) => {
        const name = value.trim()
        if (!name) return
        void run(() => writeTextFile(joinPath(cwd, name), ''), tPlain('File created'))
      },
    })

  const renameSelected = () => {
    if (!selectedEntry) return
    openPrompt({
      kind: 'input',
      title: tPlain('Rename'),
      initial: selectedEntry.name,
      confirmLabel: tPlain('Rename'),
      onConfirm: (value) => {
        const name = value.trim()
        if (!name || name === selectedEntry.name) return
        void run(() => renamePath(selectedEntry.path, joinPath(cwd, name)), tPlain('Renamed'))
      },
    })
  }

  const deleteSelected = () => {
    if (!selectedEntry) return
    openPrompt({
      kind: 'confirm',
      title: tPlain('Delete'),
      message: `${tPlain('Delete')} "${selectedEntry.name}"?`,
      onConfirm: () => {
        void run(() => deletePath(selectedEntry.path), tPlain('Deleted'))
      },
    })
  }

  const editSelected = async () => {
    if (!selectedEntry || selectedEntry.directory) return
    const text = await readTextFile(selectedEntry.path)
    if (text === null) {
      setStatus(tPlain('Cannot edit this file as text'))
      return
    }
    setEditor({ path: selectedEntry.path, text })
  }

  const saveEditor = () =>
    void run(() => writeTextFile(editor!.path, editor!.text), tPlain('File saved'))

  const downloadSelected = async () => {
    if (!selectedEntry || selectedEntry.directory) return
    const blob = await readFile(selectedEntry.path)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = selectedEntry.name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const uploadFiles = (files: FileList) => {
    if (!files.length) return
    void run(async () => {
      for (const file of Array.from(files)) {
        // oxlint-disable-next-line no-await-in-loop -- 逐个写入上传文件
        await writeFile(joinPath(cwd, file.name), file)
      }
    }, tPlain('Uploaded'))
  }

  const restoreDefaults = () => void run(onRestoreDefaults, tPlain('Default scripts restored'))

  return (
    <Dialog
      title={tPlain('File Manager')}
      onClose={onClose}
      footer={
        <>
          <button className="dialog-button" onClick={restoreDefaults}>
            {tPlain('Restore Defaults')}
          </button>
          <span className="fm-status" title={status}>
            {status}
          </span>
          <button className="dialog-button primary" onClick={onClose}>
            {tPlain('Close')}
          </button>
        </>
      }
    >
      <div className="fm-toolbar">
        <button
          className="dialog-button"
          onClick={() => navigate(dirname(cwd))}
          disabled={cwd === '/'}
        >
          {tPlain('Up')}
        </button>
        <button className="dialog-button" onClick={newFolder}>
          {tPlain('New Folder')}
        </button>
        <button className="dialog-button" onClick={newFile}>
          {tPlain('New File')}
        </button>
        <button
          className="dialog-button"
          onClick={() => void editSelected()}
          disabled={!selectedEntry || selectedEntry.directory}
        >
          {tPlain('Edit')}
        </button>
        <button className="dialog-button" onClick={renameSelected} disabled={!selectedEntry}>
          {tPlain('Rename')}
        </button>
        <button className="dialog-button" onClick={deleteSelected} disabled={!selectedEntry}>
          {tPlain('Delete')}
        </button>
        <button className="dialog-button" onClick={() => fileInputRef.current?.click()}>
          {tPlain('Upload')}
        </button>
        <button
          className="dialog-button"
          onClick={() => void downloadSelected()}
          disabled={!selectedEntry || selectedEntry.directory}
        >
          {tPlain('Download')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) uploadFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>

      <div className="fm-path">{cwd}</div>

      <div className="fm-body">
        <div className="fm-list" role="listbox" aria-label={tPlain('Files')}>
          {cwd !== '/' && (
            <button className="fm-row" onClick={() => navigate(dirname(cwd))}>
              <span className="fm-name">..</span>
            </button>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              className={`fm-row${selected === entry.path ? ' selected' : ''}`}
              role="option"
              aria-selected={selected === entry.path}
              onClick={() => setSelected(entry.path)}
              onDoubleClick={() => openEntry(entry)}
            >
              <span className="fm-name">{entry.directory ? `${entry.name}/` : entry.name}</span>
              <span className="fm-size">{entry.directory ? '' : formatSize(entry.size)}</span>
              <span className="fm-time">{formatTime(entry.mtime)}</span>
            </button>
          ))}
          {entries.length === 0 && <div className="fm-empty">{tPlain('Empty folder')}</div>}
        </div>

        {editor && (
          <div className="fm-editor">
            <div className="fm-editor-head">
              <span>{basename(editor.path)}</span>
              <span>
                <button className="dialog-button primary" onClick={saveEditor}>
                  {tPlain('Save')}
                </button>
                <button className="dialog-button" onClick={() => setEditor(null)}>
                  {tPlain('Close')}
                </button>
              </span>
            </div>
            <textarea
              value={editor.text}
              spellCheck={false}
              onChange={(event) =>
                setEditor((current) =>
                  current ? { ...current, text: event.target.value } : current,
                )
              }
            />
          </div>
        )}
      </div>

      {prompt && (
        <div className="fm-prompt-backdrop" role="presentation">
          <div className="fm-prompt" role="dialog" aria-label={prompt.title}>
            <strong>{prompt.title}</strong>
            {prompt.kind === 'input' ? (
              <input
                autoFocus
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    prompt.onConfirm(promptValue)
                    setPrompt(null)
                  }
                }}
              />
            ) : (
              <p>{prompt.message}</p>
            )}
            <div className="fm-prompt-actions">
              <button
                className="dialog-button primary"
                onClick={() => {
                  if (prompt.kind === 'input') prompt.onConfirm(promptValue)
                  else prompt.onConfirm()
                  setPrompt(null)
                }}
              >
                {tPlain('OK')}
              </button>
              <button className="dialog-button" onClick={() => setPrompt(null)}>
                {tPlain('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
