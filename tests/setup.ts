// vitest 运行在 Node 环境：Node 22+ 的 localStorage 是实验性全局（需 --localstorage-file），
// 仅引用（含 typeof 守卫）即触发 ExperimentalWarning 且值为 undefined。
// 此处统一替换为内存实现，消除警告并让测试中的持久化真实生效。
class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

// Node 将 localStorage 定义为访问器属性，直接赋值可能抛错，需 defineProperty 覆盖
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
})
