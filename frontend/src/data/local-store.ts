import { CATERING_LEDGER_SEED } from './modules/catering-ledger-seed'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：配餐交接补了签认/交接公司等字段并引入交接台账，旧缓存结构不再沿用。
const ENTRIES_KEY = 'airport-ground-ops:entries:v2'
const NAMESPACE_KEY_PREFIX = 'airport-ground-ops:ns:v2:'

type JsonValue = EntryRow[] | Record<string, unknown>[] | Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isBrowserStorageReady(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readJson<T extends JsonValue>(key: string, fallback: T): T {
  if (!isBrowserStorageReady()) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeJson(key: string, value: JsonValue): void {
  if (!isBrowserStorageReady()) {
    return
  }
  window.localStorage.setItem(key, JSON.stringify(value))
}

function readEntries(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!isBrowserStorageReady()) {
    return fallback
  }
  const raw = window.localStorage.getItem(ENTRIES_KEY)
  if (!raw) {
    writeJson(ENTRIES_KEY, fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 只补不覆盖：老模块缓存缺列时以种子兜底，重置某条线也能回到种子。
    return { ...fallback, ...parsed }
  } catch {
    writeJson(ENTRIES_KEY, fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
const namespaceCache = new Map<string, unknown>()

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readEntries()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const previous = cache
  const next = { ...allRows(), [key]: rows }
  cache = next
  try {
    writeJson(ENTRIES_KEY, next)
  } catch (error) {
    // 落库失败要让调用方看得见，并回滚内存，避免半路停在不一致状态。
    cache = previous
    throw new Error(`「${key}」数据落库失败：${error instanceof Error ? error.message : '浏览器存储不可用'}`)
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return ENTRIES_KEY
}

/**
 * 通用命名空间存储：交接台账这类跨模块派生数据独立成档，
 * 与业务清单分开落库，任一入口读到的都是同一份。
 */
export function listNamespace<T extends JsonValue>(namespace: string, fallback: T): T {
  const hit = namespaceCache.get(namespace)
  if (hit !== undefined) {
    return clone(hit as T)
  }
  const seeded = fallback === undefined ? ([] as unknown as T) : fallback
  const value = readJson<T>(`${NAMESPACE_KEY_PREFIX}${namespace}`, seeded)
  namespaceCache.set(namespace, clone(value))
  return value
}
export function saveNamespace<T extends JsonValue>(namespace: string, value: T): void {
  const previous = namespaceCache.has(namespace) ? clone(namespaceCache.get(namespace) as T) : undefined
  namespaceCache.set(namespace, clone(value))
  try {
    writeJson(`${NAMESPACE_KEY_PREFIX}${namespace}`, value)
  } catch (error) {
    if (previous !== undefined) {
      namespaceCache.set(namespace, previous)
    } else {
      namespaceCache.delete(namespace)
    }
    throw new Error(`「${namespace}」数据落库失败：${error instanceof Error ? error.message : '浏览器存储不可用'}`)
  }
}

export function resetNamespace<T extends JsonValue>(namespace: string, fallback: T): T {
  const value = clone(fallback)
  saveNamespace(namespace, value)
  return value
}

/** 交接台账的种子：确认交接已入账、航班保障侧尚未接收，用于展示跨线待办。 */
export const CATERING_LEDGER_NAMESPACE = 'catering-handover-ledger'

export function seedCateringLedger(): typeof CATERING_LEDGER_SEED {
  return clone(CATERING_LEDGER_SEED)
}
