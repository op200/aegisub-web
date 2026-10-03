import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { applyConfigTree } from './config/options'
import { loadPersistedConfig } from './storage/configStore'
import { installFactoryScripts } from './storage/factoryScripts'
import { initStyleCatalogs } from './storage/styleCatalogStore'
import { setActiveHotkeys, type HotkeyMap } from './ui/aegisubHotkeys'
import { App } from './ui/App'

import './ui/styles.css'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  })
}

/**
 * 启动引导：先加载 IndexedDB 持久化配置（config.json / hotkey.json 对应物，
 * 含旧版 localStorage 一次性迁移），并载入 VFS 样式库缓存（选项下拉需同步读取），
 * 再渲染应用——选项读写全同步，必须在 React 首帧前恢复。
 * 失败时回退各模块内置的 localStorage 恢复。
 */
void loadPersistedConfig()
  .then((persisted) => {
    if (persisted.configTree) applyConfigTree(persisted.configTree)
    if (persisted.hotkeys) setActiveHotkeys(persisted.hotkeys as HotkeyMap)
  })
  .catch(() => undefined)
  .then(() => initStyleCatalogs())
  .catch(() => undefined)
  .then(() => installFactoryScripts())
  .catch(() => undefined)
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
