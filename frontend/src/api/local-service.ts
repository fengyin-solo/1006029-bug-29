import { MODULE_BY_KEY } from '@/data/modules'
import {
  abortBatch,
  activeBatch,
  cateringStats,
  confirmHandover,
  fillPayload,
  flightCateringView,
  listLedger,
  resumeBatch,
  signHandover,
  startBatch,
  transition,
} from '@/data/catering-domain'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CateringStats,
  ConfirmInput,
  EntryRow,
  FlightCateringView,
  HandoverBatchState,
  HandoverLedgerEntry,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const CATERING_KEY = 'catering'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, payload?: ConfirmInput): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 配餐交接的判定全部走配餐域：公司/交接人归属、签认、载荷、越级、幂等只有这一份实现。
  if (key === CATERING_KEY) {
    return runCateringAction(id, action, payload ?? { company: '', handler: '' })
  }

  // 通用动作也不许越级：actionFrom 规定了动作发起时必须处在的状态。
  const required = meta.actionFrom?.[action]
  const current = String(rows[index].status)
  if (required && current !== required) {
    return { ok: false, message: `${meta.entity}当前为「${current}」，「${action}」只能在「${required}」状态发起，越级操作已挡回` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runCateringAction(id: number, action: string, input: ConfirmInput): ActionResult {
  if (action === '确认交接') {
    return confirmHandover(id, input)
  }
  if (action === '交接签认') {
    return signHandover(id, input.handler)
  }
  if (action === '补录载荷') {
    return fillPayload(id, input.handler)
  }
  if (action === '开始配送' || action === '提交交接') {
    return transition(id, action)
  }
  return { ok: false, message: `配餐作业没有登记「${action}」这个动作` }
}

// ---- 批量交接：整批从失败的那一条继续，已成功的靠台账幂等不重复计数 ----

export function beginHandoverBatch(rowIds: number[], input: ConfirmInput): HandoverBatchState {
  return startBatch(rowIds, input)
}

export function continueHandoverBatch(input?: ConfirmInput): HandoverBatchState | null {
  return resumeBatch(input)
}

export function currentHandoverBatch(): HandoverBatchState | null {
  return activeBatch()
}

export function cancelHandoverBatch(): void {
  abortBatch()
}

export function readCateringStats(): CateringStats {
  return cateringStats()
}

export function readHandoverLedger(): HandoverLedgerEntry[] {
  return listLedger()
}

export function readFlightCatering(flightNo: string): FlightCateringView {
  return flightCateringView(flightNo)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
