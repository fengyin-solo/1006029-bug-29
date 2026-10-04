import {
  CATERING_LEDGER_NAMESPACE,
  listNamespace,
  listRows,
  saveNamespace,
  saveRows,
  seedCateringLedger,
} from '../local-store'
import type {
  ActionResult,
  CateringOverview,
  EntryRow,
  FlightCateringTodo,
  HandoverBatchResult,
  HandoverClaim,
  HandoverFailure,
  HandoverItem,
  HandoverLedgerEntry,
  HandoverStage,
} from '../types'

/**
 * 航空配餐交接领域：
 * - 交接不再只凭作业号定位，必须同时核对配餐公司、交接人归属与签认；
 * - 状态只能逐级走，配送中越级确认交接一律挡回；
 * - 批次逐条校验、逐条落库，失败的一条标清楚卡在哪一步，重试只续跑失败项；
 * - 确认交接幂等入账，重复确认只记一次份数；
 * - 份数永远回配餐作业记录取，交接台账与航班保障待办都是同一份派生数据。
 */

export const CATERING_KEY = 'catering'

export const FIELD_JOB_NO = '作业编号'
export const FIELD_FLIGHT_NO = '航班号'
export const FIELD_PORTIONS = '餐食数量'
export const FIELD_COMPANY = '配餐公司'
export const FIELD_HANDLER = '交接人员'
export const FIELD_SIGN = '签认'
export const FIELD_HANDOVER_COMPANY = '交接公司'
export const FIELD_HANDOVER_AT = '交接时间'
// 行级失败标注：只做提示用，不进模块字段清单，也就不会进导出。
export const FIELD_FAILURE = '交接异常'

export const SIGN_DONE = '已签认'
export const SIGN_PENDING = '未签认'

export const STATUS_PENDING_MEAL = '待配餐'
export const STATUS_DELIVERING = '配送中'
export const STATUS_AWAITING = '待交接'
export const STATUS_HANDED = '已交接'

export const ACTION_SUBMIT = '提交交接' as const
export const ACTION_CONFIRM = '确认交接' as const

// 配餐公司与交接人归属表：交接人必须挂在对应公司名下，跨公司的归属当场挡回。
export const COMPANY_HANDLERS: Record<string, string[]> = {
  蓝天航食: ['王交接', '赵蓝天'],
  翼鲜配餐: ['李配送', '钱翼鲜'],
}

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

export function jobNoOf(row: EntryRow): string {
  return fieldText(row, FIELD_JOB_NO)
}

export function portionsOf(row: EntryRow): number | null {
  const raw = row[FIELD_PORTIONS]
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function isSigned(row: EntryRow): boolean {
  return fieldText(row, FIELD_SIGN) === SIGN_DONE
}

export function isAwaitingUnsigned(row: EntryRow): boolean {
  return row.status === STATUS_AWAITING && !isSigned(row)
}

export function rowFailure(row: EntryRow): string {
  const note = fieldText(row, FIELD_FAILURE)
  if (note) {
    return note
  }
  return isAwaitingUnsigned(row) ? `签认检查：交接人尚未${SIGN_DONE}，不允许确认交接` : ''
}

export function handlerBelongs(company: string, handler: string): boolean {
  return Boolean(COMPANY_HANDLERS[company]?.includes(handler))
}

function nowStamp(): string {
  return new Date().toISOString()
}

// ---------- 交接台账：确认交接的唯一落库点 ----------

export function listLedger(): HandoverLedgerEntry[] {
  return listNamespace<HandoverLedgerEntry[]>(CATERING_LEDGER_NAMESPACE, seedCateringLedger())
}

function persistLedger(entries: HandoverLedgerEntry[]): void {
  saveNamespace(CATERING_LEDGER_NAMESPACE, entries)
}

function ledgerUpsert(entries: HandoverLedgerEntry[], entry: HandoverLedgerEntry): { next: HandoverLedgerEntry[]; existed: boolean } {
  const index = entries.findIndex((item) => item.jobNo === entry.jobNo)
  if (index < 0) {
    return { next: [...entries, entry], existed: false }
  }
  const next = [...entries]
  next[index] = { ...next[index], ...entry }
  return { next, existed: true }
}

// ---------- 批次交接 ----------

type StageFailure = { stage: HandoverStage; reason: string }

function makeFailure(claim: HandoverClaim, stage: HandoverStage, reason: string): HandoverFailure {
  return { jobNo: claim.jobNo ?? '', stage, reason, claim: { ...claim } }
}

// 数据级失败落到行上：缺签认、错公司、份数对不上，刷新后那一行依然是红的。
function annotateRow(row: EntryRow, stage: HandoverStage, reason: string): EntryRow {
  return { ...row, abnormal: true, [FIELD_FAILURE]: `${stage}：${reason}` }
}

function clearAnnotation(row: EntryRow): EntryRow {
  const next = { ...row }
  delete next[FIELD_FAILURE]
  next.abnormal = isAwaitingUnsigned(next)
  return next
}

function commitRow(rowIndex: number, row: EntryRow, ledger?: HandoverLedgerEntry[]): void {
  const snapshot = listRows(CATERING_KEY)
  const nextRows = [...snapshot]
  nextRows[rowIndex] = row
  saveRows(CATERING_KEY, nextRows)
  if (ledger) {
    try {
      persistLedger(ledger)
    } catch (error) {
      // 台账与作业状态必须同生共死：台账没落上就回滚作业状态，不能只成一半。
      saveRows(CATERING_KEY, snapshot)
      throw error
    }
  }
}

function validateOwnership(row: EntryRow, claim: HandoverClaim): StageFailure | null {
  const rowCompany = fieldText(row, FIELD_COMPANY)
  const claimCompany = claim.company.trim()
  if (claimCompany !== rowCompany) {
    return {
      stage: '公司归属',
      reason: `载荷里的配餐公司「${claimCompany}」与作业记录「${rowCompany}」不一致，份数不能记到别的公司头上`,
    }
  }
  const handler = (claim.handler ?? '').trim() || fieldText(row, FIELD_HANDLER)
  if (!handler) {
    return { stage: '公司归属', reason: '缺少交接人，无法核对其配餐公司归属' }
  }
  if (!handlerBelongs(rowCompany, handler)) {
    return { stage: '公司归属', reason: `交接人「${handler}」不属于配餐公司「${rowCompany}」` }
  }
  return null
}

function validatePortions(row: EntryRow, claim: HandoverClaim): StageFailure | null {
  const recorded = portionsOf(row)
  if (recorded === null) {
    return { stage: '份数核对', reason: '作业记录缺少餐食数量（载荷数据缺失），无法核对份数' }
  }
  if (claim.portions === undefined || claim.portions === null || !Number.isFinite(claim.portions)) {
    return { stage: '份数核对', reason: `交接载荷未带份数，作业记录为 ${recorded} 份，请补齐后重试` }
  }
  if (claim.portions !== recorded) {
    return {
      stage: '份数核对',
      reason: `载荷份数 ${claim.portions} 与作业记录 ${recorded} 份不一致，疑似记到了别的公司批次上`,
    }
  }
  return null
}

function batchSummary(result: HandoverBatchResult): string {
  const parts: string[] = []
  if (result.succeeded.length) {
    parts.push(`成功 ${result.succeeded.length} 条`)
  }
  if (result.skipped.length) {
    parts.push(`跳过 ${result.skipped.length} 条`)
  }
  if (result.failed.length) {
    const first = result.failed[0]
    parts.push(`失败 ${result.failed.length} 条（首条卡在「${first.stage}」：${first.reason}），可从失败项继续重试`)
  }
  return `${result.action}：${parts.join('，') || '没有可处理的记录'}`
}

/**
 * 批次交接。
 * 每条记录独立走完全部校验阶段：任何一条失败都不阻断其它条，
 * 成功的立刻落库，失败的带阶段与原因返回；重试只传失败项即可从断点继续。
 */
export function processHandoverBatch(
  action: '提交交接' | '确认交接',
  claims: HandoverClaim[],
): HandoverBatchResult {
  const result: HandoverBatchResult = {
    ok: true,
    action,
    succeeded: [],
    skipped: [],
    failed: [],
    message: '',
  }

  for (const rawClaim of claims) {
    const claim: HandoverClaim = {
      jobNo: String(rawClaim?.jobNo ?? '').trim(),
      company: String(rawClaim?.company ?? '').trim(),
      handler: rawClaim?.handler === undefined ? undefined : String(rawClaim.handler).trim(),
      portions: rawClaim?.portions,
    }

    // 第一步：载荷读取。载荷缺件不允许悄悄放过去，更不允许只凭作业号继续。
    if (!claim.jobNo) {
      result.failed.push(makeFailure(claim, '载荷读取', '交接载荷缺少作业编号'))
      continue
    }
    if (!claim.company) {
      result.failed.push(makeFailure(claim, '载荷读取', '交接载荷缺少配餐公司，拒绝只按作业号定位'))
      continue
    }

    // 第二步：作业定位。
    const rows = listRows(CATERING_KEY)
    const index = rows.findIndex((row) => jobNoOf(row) === claim.jobNo)
    if (index < 0) {
      result.failed.push(makeFailure(claim, '作业定位', `按作业编号 + 配餐公司未找到作业「${claim.jobNo}」`))
      continue
    }
    const located = rows[index]
    const failLocated = (stage: HandoverStage, reason: string, annotate: boolean) => {
      result.failed.push(makeFailure(claim, stage, reason))
      if (annotate) {
        try {
          const next = [...rows]
          next[index] = annotateRow(located, stage, reason)
          saveRows(CATERING_KEY, next)
        } catch {
          // 标注落不下来不改变校验结论，失败项照常返回。
        }
      }
    }

    // 第三步：公司归属（公司一致 + 交接人归属）。
    const ownership = validateOwnership(located, claim)
    if (ownership) {
      failLocated(ownership.stage, ownership.reason, true)
      continue
    }

    // 第四步：状态前置——逐级流转，越级挡回，已完成的走幂等跳过。
    const current = String(located.status)
    if (action === ACTION_SUBMIT) {
      if (current === STATUS_AWAITING || current === STATUS_HANDED) {
        const item: HandoverItem = { jobNo: claim.jobNo, message: `作业已是「${current}」，无需重复提交交接` }
        result.skipped.push(item)
        continue
      }
      if (current !== STATUS_DELIVERING) {
        failLocated('状态前置', `作业当前为「${current}」，必须先完成「开始配送」才能提交交接`, false)
        continue
      }
    } else {
      if (current === STATUS_HANDED) {
        // 重复确认交接：台账已有同号记录，份数不重复记。
        result.skipped.push({ jobNo: claim.jobNo, message: '已确认交接，重复确认只记一次份数' })
        continue
      }
      if (current !== STATUS_AWAITING) {
        failLocated(
          '状态前置',
          `作业当前为「${current}」，不能越级跳到「${STATUS_HANDED}」，请先提交交接并等待签认`,
          false,
        )
        continue
      }
    }

    if (action === ACTION_SUBMIT) {
      // 提交交接不查签认，但份数必须对得上，防止 A 公司的份数挂到 B 公司的提交上。
      const portionFailure = validatePortions(located, claim)
      if (portionFailure) {
        failLocated(portionFailure.stage, portionFailure.reason, true)
        continue
      }
      const handler = (claim.handler ?? '').trim() || fieldText(located, FIELD_HANDLER)
      const updated = clearAnnotation({
        ...located,
        status: STATUS_AWAITING,
        pending: true,
        [FIELD_HANDOVER_COMPANY]: claim.company,
        [FIELD_HANDLER]: handler,
      })
      try {
        commitRow(index, updated)
      } catch (error) {
        failLocated('结果落库', error instanceof Error ? error.message : '作业状态落库失败', false)
        continue
      }
      result.succeeded.push({
        jobNo: claim.jobNo,
        message: isSigned(updated)
          ? '已进入待交接（交接人已签认，可确认交接）'
          : '已进入待交接，但交接人尚未签认，该记录不得确认交接',
      })
      continue
    }

    // 确认交接：必须经过签认这一环。
    if (!isSigned(located)) {
      failLocated('签认检查', `交接人尚未${SIGN_DONE}，该记录不允许进入「${STATUS_HANDED}」，请先补签认`, true)
      continue
    }
    const portionFailure = validatePortions(located, claim)
    if (portionFailure) {
      failLocated(portionFailure.stage, portionFailure.reason, true)
      continue
    }

    const company = fieldText(located, FIELD_COMPANY)
    const handler = fieldText(located, FIELD_HANDLER)
    const updated = clearAnnotation({
      ...located,
      status: STATUS_HANDED,
      pending: false,
      abnormal: false,
      [FIELD_HANDOVER_COMPANY]: company,
      [FIELD_HANDOVER_AT]: nowStamp(),
    })
    const ledgerEntry: HandoverLedgerEntry = {
      jobNo: claim.jobNo,
      flightNo: fieldText(located, FIELD_FLIGHT_NO),
      company,
      handler,
      handedAt: nowStamp(),
      receivedAt: null,
    }
    let ledgerNext: HandoverLedgerEntry[]
    try {
      const upsert = ledgerUpsert(listLedger(), ledgerEntry)
      ledgerNext = upsert.next
      commitRow(index, updated, ledgerNext)
    } catch (error) {
      failLocated('结果落库', error instanceof Error ? error.message : '交接结果落库失败', false)
      continue
    }
    result.succeeded.push({ jobNo: claim.jobNo, message: `已交接并入账，${portionsOf(updated) ?? 0} 份记入航班保障待办` })
  }

  result.ok = result.failed.length === 0
  result.message = batchSummary(result)
  return result
}

// ---------- 单条动作：开始配送 / 补签认 ----------

export type CateringActionResult = ActionResult & { stage?: HandoverStage }

function findIndexById(id: number): { rows: EntryRow[]; index: number } {
  const rows = listRows(CATERING_KEY)
  return { rows, index: rows.findIndex((row) => Number(row.id) === id) }
}

export function startDelivery(id: number): CateringActionResult {
  const { rows, index } = findIndexById(id)
  if (index < 0) {
    return { ok: false, stage: '作业定位', message: `没有找到编号为 ${id} 的配餐作业` }
  }
  const row = rows[index]
  if (row.status === STATUS_DELIVERING) {
    return { ok: false, message: '作业已在配送中' }
  }
  if (row.status !== STATUS_PENDING_MEAL) {
    return {
      ok: false,
      stage: '状态前置',
      message: `作业当前为「${row.status}」，不能越级开始配送`,
    }
  }
  const updated = clearAnnotation({ ...row, status: STATUS_DELIVERING, pending: true })
  try {
    commitRow(index, updated)
  } catch (error) {
    return { ok: false, stage: '结果落库', message: error instanceof Error ? error.message : '落库失败' }
  }
  return { ok: true, message: '作业已开始配送' }
}

export function signOff(id: number): CateringActionResult {
  const { rows, index } = findIndexById(id)
  if (index < 0) {
    return { ok: false, stage: '作业定位', message: `没有找到编号为 ${id} 的配餐作业` }
  }
  const row = rows[index]
  if (row.status !== STATUS_AWAITING) {
    return {
      ok: false,
      stage: '状态前置',
      message: `作业当前为「${row.status}」，只有待交接的记录需要补签认`,
    }
  }
  const updated = { ...row, [FIELD_SIGN]: SIGN_DONE } as EntryRow
  const note = fieldText(updated, FIELD_FAILURE)
  if (note.startsWith('签认检查')) {
    delete updated[FIELD_FAILURE]
  }
  updated.abnormal = isAwaitingUnsigned(updated) || (fieldText(updated, FIELD_FAILURE).length > 0)
  try {
    commitRow(index, updated)
  } catch (error) {
    return { ok: false, stage: '结果落库', message: error instanceof Error ? error.message : '落库失败' }
  }
  return { ok: true, message: '交接人已签认，可以确认交接' }
}

// ---------- 同源派生选择器：所有入口读的都是同一份口径 ----------

export function handedJobs(): EntryRow[] {
  return listRows(CATERING_KEY).filter((row) => row.status === STATUS_HANDED)
}

/** 已交接份数：配餐统计和航班保障待办共用这一个口径，台账里不冗余份数。 */
export function handedPortionTotal(): number {
  return handedJobs().reduce((sum, row) => sum + (portionsOf(row) ?? 0), 0)
}

export function awaitingRows(): EntryRow[] {
  return listRows(CATERING_KEY).filter((row) => row.status === STATUS_AWAITING)
}

export function unsignedAwaitingRows(): EntryRow[] {
  return awaitingRows().filter((row) => !isSigned(row))
}

export function flightCateringTodos(): FlightCateringTodo[] {
  const rows = listRows(CATERING_KEY)
  return listLedger()
    .filter((entry) => entry.receivedAt === null)
    .map((entry) => {
      const source = rows.find((row) => jobNoOf(row) === entry.jobNo)
      return {
        jobNo: entry.jobNo,
        flightNo: entry.flightNo,
        company: entry.company,
        handler: entry.handler,
        portions: source ? portionsOf(source) : null,
        handedAt: entry.handedAt,
        missingSource: !source,
      }
    })
}

/** 航班保障线接收待办：幂等，接收后从待办里消失，份数口径始终由配餐作业决定。 */
export function receiveFlightTodo(jobNo: string): ActionResult {
  const entries = listLedger()
  const index = entries.findIndex((entry) => entry.jobNo === jobNo)
  if (index < 0) {
    return { ok: false, message: `交接台账中没有作业「${jobNo}」` }
  }
  if (entries[index].receivedAt !== null) {
    return { ok: false, message: '该待办已接收，无需重复接收' }
  }
  const next = [...entries]
  next[index] = { ...next[index], receivedAt: nowStamp() }
  try {
    persistLedger(next)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '接收结果落库失败' }
  }
  return { ok: true, message: `作业「${jobNo}」已由航班保障线接收` }
}

export function cateringOverview(): CateringOverview {
  const rows = listRows(CATERING_KEY)
  const todos = flightCateringTodos()
  return {
    jobCount: rows.length,
    delivering: rows.filter((row) => row.status === STATUS_DELIVERING).length,
    awaitingHandover: awaitingRows().length,
    unsignedAwaiting: unsignedAwaitingRows().length,
    handedPortions: handedPortionTotal(),
    pendingTodoCount: todos.length,
  }
}
