import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

// 配套业务数据（交接台账、批量交接断点等）各自一个键，落库层统一读写，不允许域服务各存各的。
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 模块重置钩子：重置业务行时，配套落库的台账/断点也要一并清掉，避免读到脏数据。
const resetHooks = new Map<string, () => void>()

export function onResetRows(key: string, hook: () => void): void {
  resetHooks.set(key, hook)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  resetHooks.get(key)?.()
  return rows
}

// 通用 JSON 存取：配套数据只认落库层给的键，别处只读自己那一份。
const jsonCache = new Map<string, unknown>()

export function loadJson<T>(key: string, fallback: () => T): T {
  if (jsonCache.has(key)) {
    return jsonCache.get(key) as T
  }
  let value: T
  if (typeof window === 'undefined' || !window.localStorage) {
    value = fallback()
  } else {
    const raw = window.localStorage.getItem(key)
    if (raw === null) {
      value = fallback()
    } else {
      try {
        value = JSON.parse(raw) as T
      } catch {
        value = fallback()
      }
    }
  }
  jsonCache.set(key, value)
  return value
}

export function saveJson<T>(key: string, value: T): void {
  jsonCache.set(key, value)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function removeJson(key: string): void {
  jsonCache.delete(key)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(key)
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
