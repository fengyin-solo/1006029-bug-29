import { listRows, loadJson, onResetRows, removeJson, saveJson, saveRows } from './local-store'
import type {
  CateringStats,
  ConfirmInput,
  ConfirmResult,
  EntryRow,
  FlightCateringView,
  HandoverBatchState,
  HandoverLedgerEntry,
  HandoverStep,
  StepFailure,
} from './types'

// 配餐交接判定全部收口在这一层：页面、通用动作入口、批量入口都只能走这里，
// 保证公司归属、签认、载荷、越级、幂等等规则只有一份实现，不允许各处各判各的。

const CATERING_KEY = 'catering'
const FLIGHT_KEY = 'flight'

const LEDGER_STORE = 'airport-ground-ops:catering-handover-ledger'
const BATCH_STORE = 'airport-ground-ops:catering-handover-batch'

// 配餐状态顺序：交接只能按 待配餐→配送中→待交接→已交接 推进。
export const CATERING_STATUSES = ['待配餐', '配送中', '待交接', '已交接'] as const
const HANDED = '已交接'
const PENDING_HANDOVER = '待交接'

// 交接人归属表：交接人必须是对应配餐公司在册的交接员，否则 A 公司批次里就能把份数记到 B 公司头上。
const HANDLER_COMPANY: Record<string, string> = {
  周敏: '滨海航食',
  李楠: '滨海航食',
  陈涛: '中膳食品',
  赵磊: '中膳食品',
}

export const CATERING_COMPANIES = ['滨海航食', '中膳食品']

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fail(step: HandoverStep, message: string): ConfirmResult {
  return { ok: false, message: `交接失败（${step}）：${message}`, failure: { step, message } }
}

function cateringRows(): EntryRow[] {
  return listRows(CATERING_KEY)
}

function persistRows(rows: EntryRow[]): void {
  saveRows(CATERING_KEY, rows)
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// 台账是「份数」唯一权威来源：页面统计、航班保障待办都从它取数，不允许重复确认多记份数。
function seedLedger(): HandoverLedgerEntry[] {
  // 首次使用时从已交接的作业行反建台账，保证示例数据开箱即对齐。
  return cateringRows()
    .filter((row) => text(row.status) === HANDED)
    .map((row) => ({
      jobNo: text(row.作业编号),
      flightNo: text(row.航班号),
      company: text(row.配餐公司),
      handler: text(row.交接人员),
      portions: Number(row.餐食数量) || 0,
      signer: text(row.签认人),
      signedAt: text(row.交接时间),
      payloadNo: text(row.载荷编号),
      handedAt: text(row.交接时间),
    }))
}

function loadLedger(): HandoverLedgerEntry[] {
  return loadJson<HandoverLedgerEntry[]>(LEDGER_STORE, seedLedger)
}

function persistLedger(entries: HandoverLedgerEntry[]): void {
  saveJson(LEDGER_STORE, entries)
}

export function listLedger(): HandoverLedgerEntry[] {
  return loadLedger()
}

// 重置配餐模块时台账与断点必须一起清，否则会读到旧份数、接着旧批次跑。
onResetRows(CATERING_KEY, () => {
  removeJson(LEDGER_STORE)
  removeJson(BATCH_STORE)
})

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

// 签认缺失、载荷缺失是作业行自己的数据缺口：这一行必须显式标出来（异常态+拦截原因），
// 而不是静默挡住后什么痕迹都不留。公司/交接人对不上属于本次交接请求填错，不改作业行。
const ROW_BLOCK_STEPS: ReadonlySet<HandoverStep> = new Set(['核对交接签认', '核对载荷数据'])

function markBlocked(rows: EntryRow[], index: number, failure: StepFailure): ConfirmResult {
  rows[index] = {
    ...rows[index],
    abnormal: true,
    拦截原因: failure.message,
  }
  persistRows(rows)
  return fail(failure.step, failure.message)
}

// 补齐签认或载荷后，之前打在这一行上的拦截标记要清掉（成功交接时两类标记都消）。
function clearRowBlock(row: EntryRow): EntryRow {
  if (!row.abnormal && !text(row.拦截原因)) {
    return row
  }
  return { ...row, abnormal: false, 拦截原因: '' }
}

// 针对性消标：补签认只消签认缺口、补载荷只消载荷缺口，另一条没补的拦截原因必须留着。
function clearBlockReason(row: EntryRow, keyword: string): EntryRow {
  const reason = text(row.拦截原因)
  if (!reason.includes(keyword)) {
    return row
  }
  return { ...row, abnormal: false, 拦截原因: '' }
}

function handlerBelongsTo(handler: string, company: string): boolean {
  return HANDLER_COMPANY[handler] === company
}

function ledgerByJob(entries: HandoverLedgerEntry[]): Map<string, HandoverLedgerEntry> {
  return new Map(entries.map((entry) => [entry.jobNo, entry]))
}

// 交接结果落到航班保障这条线的待办上：航班行只存作业编号引用，份数实时回作业行/台账取，
// 因此航班保障待办与配餐页两处份数天然同源，不存在各记各的。
function syncFlightTodo(jobNo: string, flightNo: string): string | undefined {
  const flights = listRows(FLIGHT_KEY)
  const index = flights.findIndex((row) => text(row.航班号) === flightNo)
  if (index < 0) {
    return `航班 ${flightNo} 暂未登记保障任务，交接已生效，待航班补录后自动挂上`
  }
  const refs = text(flights[index].配餐交接)
    .split(/[，,、\s]+/)
    .filter(Boolean)
  if (refs.includes(jobNo)) {
    return undefined
  }
  const next = [...flights]
  next[index] = { ...next[index], 配餐交接: [...refs, jobNo].join(',') }
  saveRows(FLIGHT_KEY, next)
  return undefined
}

// 单条交接判定，逐步过关，任何一步失败都讲清停在哪一步。
export function confirmHandover(id: number, input: ConfirmInput): ConfirmResult {
  const company = text(input.company)
  const handler = text(input.handler)
  const rows = cateringRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('定位作业', `找不到编号 ${id} 的配餐作业，交接未执行`)
  }
  const row = rows[index]
  const jobNo = text(row.作业编号)
  const status = text(row.status)

  const ledger = loadLedger()
  const known = ledgerByJob(ledger)

  // 重复确认交接只记一次份数：台账已登记就直接幂等返回，不再改任何数据。
  const existing = known.get(jobNo)
  if (existing) {
    if (status !== HANDED) {
      const next = [...rows]
      next[index] = { ...row, status: HANDED, pending: false, abnormal: false, 拦截原因: '' }
      persistRows(next)
    }
    return {
      ok: true,
      message: `作业 ${jobNo} 已登记过交接，份数 ${existing.portions} 份不重复计记`,
      portions: existing.portions,
    }
  }

  // 作业不能从配送中直接跳到已交接，越级一律挡回。
  if (status !== PENDING_HANDOVER) {
    return fail(
      '校验作业状态',
      `作业 ${jobNo} 当前为「${status}」，只有「${PENDING_HANDOVER}」才能确认交接，不允许越级流转`,
    )
  }

  // 交接列表声称的配餐公司必须与作业记录一致，防止混批时把 A 的份数记到 B 上。
  const recordCompany = text(row.配餐公司)
  if (company !== recordCompany) {
    return fail(
      '核对配餐公司',
      `作业 ${jobNo} 归属「${recordCompany}」，本次按「${company || '未填写'}」交接，公司不一致已挡回`,
    )
  }

  // 交接人必须既与作业记录一致，又归属该配餐公司。
  const recordHandler = text(row.交接人员)
  if (handler !== recordHandler) {
    return fail(
      '核对交接人归属',
      `作业 ${jobNo} 登记交接人为「${recordHandler}」，本次交接人为「${handler || '未填写'}」，不允许交接`,
    )
  }
  if (!handlerBelongsTo(handler, company)) {
    return fail(
      '核对交接人归属',
      `交接人「${handler}」不在「${company}」在册交接员名单内，归属不符已挡回`,
    )
  }

  // 没签认的记录不许进入已交接，且这一行必须标出来。
  if (text(row.交接签认) !== '已签认' || !text(row.签认人)) {
    return markBlocked(rows, index, {
      step: '核对交接签认',
      message: `作业 ${jobNo} 缺少交接签认，已在列表中标出，补签后可从本条继续重试`,
    })
  }

  // 载荷数据缺失不许停在半路：指出停在载荷核对这一步，补录后从这一条重试。
  const payloadNo = text(row.载荷编号)
  if (!payloadNo) {
    return markBlocked(rows, index, {
      step: '核对载荷数据',
      message: `作业 ${jobNo} 缺少载荷编号，已在列表中标出，补录载荷后可从本条继续重试`,
    })
  }
  const portions = Number(row.餐食数量)
  if (!Number.isFinite(portions) || portions <= 0) {
    return markBlocked(rows, index, {
      step: '核对载荷数据',
      message: `作业 ${jobNo} 餐食份数「${text(row.餐食数量) || '空'}」不是有效正数，无法登记份数`,
    })
  }

  // 关全过：先落台账（幂等键=作业编号），再推进作业状态。
  const handedAt = nowText()
  const entry: HandoverLedgerEntry = {
    jobNo,
    flightNo: text(row.航班号),
    company,
    handler,
    portions,
    signer: text(row.签认人),
    signedAt: handedAt,
    payloadNo,
    handedAt,
  }
  try {
    persistLedger([...ledger, entry])
  } catch {
    return fail('登记交接台账', `作业 ${jobNo} 台账写入失败，作业状态未变更，可直接重试`)
  }

  const next = [...rows]
  next[index] = {
    ...clearRowBlock(row),
    status: HANDED,
    pending: false,
    交接时间: handedAt,
  }
  persistRows(next)

  const warning = syncFlightTodo(jobNo, entry.flightNo)
  return {
    ok: true,
    message: `作业 ${jobNo} 已交接：${company} · ${portions} 份，已同步航班 ${entry.flightNo} 保障待办`,
    portions,
    warning,
  }
}

// 待交接行补签认：签认人必须是该作业登记的交接人本人。
export function signHandover(id: number, signer: string): ConfirmResult {
  const rows = cateringRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('定位作业', `找不到编号 ${id} 的配餐作业`)
  }
  const row = rows[index]
  const jobNo = text(row.作业编号)
  if (text(row.status) !== PENDING_HANDOVER) {
    return fail('核对交接签认', `作业 ${jobNo} 当前为「${text(row.status)}」，只有待交接作业能签认`)
  }
  const name = text(signer) || text(row.交接人员)
  if (name !== text(row.交接人员)) {
    return fail(
      '核对交接人归属',
      `签认人「${name}」与作业 ${jobNo} 登记交接人「${text(row.交接人员)}」不一致，已挡回`,
    )
  }
  const next = [...rows]
  next[index] = {
    ...clearBlockReason(row, '签认'),
    交接签认: '已签认',
    签认人: name,
  }
  persistRows(next)
  return { ok: true, message: `作业 ${jobNo} 已由 ${name} 签认` }
}

// 补录载荷：载荷核对卡住后，从失败的这一条补录即可继续，不用整批重来。
export function fillPayload(id: number, payloadNo: string): ConfirmResult {
  const rows = cateringRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('定位作业', `找不到编号 ${id} 的配餐作业`)
  }
  const row = rows[index]
  const jobNo = text(row.作业编号)
  if (text(row.status) !== PENDING_HANDOVER) {
    return fail('核对载荷数据', `作业 ${jobNo} 当前为「${text(row.status)}」，只有待交接作业能补录载荷`)
  }
  const payload = text(payloadNo)
  if (!payload) {
    return fail('核对载荷数据', `作业 ${jobNo} 载荷编号不能为空`)
  }
  const next = [...rows]
  next[index] = { ...clearBlockReason(row, '载荷'), 载荷编号: payload }
  persistRows(next)
  return { ok: true, message: `作业 ${jobNo} 已补录载荷 ${payload}，可从该条继续交接` }
}

// 开始配送 / 提交交接：同一套越级拦截，不允许跨状态推进。
export function transition(id: number, action: '开始配送' | '提交交接'): ConfirmResult {
  const rows = cateringRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('定位作业', `找不到编号 ${id} 的配餐作业`)
  }
  const row = rows[index]
  const required = action === '开始配送' ? '待配餐' : '配送中'
  const target = action === '开始配送' ? '配送中' : PENDING_HANDOVER
  const jobNo = text(row.作业编号)
  if (text(row.status) !== required) {
    return fail('校验作业状态', `作业 ${jobNo} 当前为「${text(row.status)}」，需先处于「${required}」，已挡回越级操作`)
  }
  const next = [...rows]
  next[index] = { ...clearRowBlock(row), status: target, pending: true }
  persistRows(next)
  return { ok: true, message: `作业 ${jobNo} 已${action}，当前状态「${target}」` }
}

// ---- 批量交接：断点落库，失败的那一条之前都已提交，重试从失败的这一条继续 ----

function loadBatch(): HandoverBatchState | null {
  return loadJson<HandoverBatchState | null>(BATCH_STORE, () => null)
}

function persistBatch(state: HandoverBatchState | null): void {
  saveJson(BATCH_STORE, state)
}

export function activeBatch(): HandoverBatchState | null {
  return loadBatch()
}

export function abortBatch(): void {
  persistBatch(null)
}

export function startBatch(rowIds: number[], input: ConfirmInput): HandoverBatchState {
  const rows = cateringRows()
  const company = text(input.company)
  const handler = text(input.handler)
  const picked = rowIds.map((id) => findRow(rows, id)).filter((r): r is EntryRow => Boolean(r))
  const state: HandoverBatchState = {
    id: `BATCH-${Date.now()}`,
    company,
    handler,
    rowIds: picked.map((row) => Number(row.id)),
    cursor: 0,
    status: 'failed',
    startedAt: nowText(),
    doneCount: 0,
    totalCount: picked.length,
  }
  persistBatch(state)
  return runBatch(state)
}

// 从断点继续：cursor 指向失败的那一条，已成功的不重跑，份数由台账保证不重复。
// 失败原因是公司/交接人填错时，可以在页面改后带着新的归属信息重试，不必放弃整批。
export function resumeBatch(patch?: Partial<ConfirmInput>): HandoverBatchState | null {
  const state = loadBatch()
  if (!state || state.status === 'completed') {
    return state
  }
  const nextState: HandoverBatchState = {
    ...state,
    company: text(patch?.company) || state.company,
    handler: text(patch?.handler) || state.handler,
  }
  persistBatch(nextState)
  return runBatch(nextState)
}

function runBatch(state: HandoverBatchState): HandoverBatchState {
  const rows = cateringRows()
  let current = { ...state }
  let index = state.cursor
  for (; index < state.rowIds.length; index += 1) {
    const id = state.rowIds[index]
    const row = findRow(rows, id)
    const jobNo = row ? text(row.作业编号) : `#${id}`
    const result = confirmHandover(id, { company: state.company, handler: state.handler })
    if (!result.ok && result.failure) {
      // 停在失败的这一条：前面的都已逐条落库，断点记下步骤与原因，供页面讲清失败点并重试。
      current = {
        ...current,
        cursor: index,
        status: 'failed',
        failure: { id, jobNo, ...result.failure },
        doneCount: index,
      }
      persistBatch(current)
      return current
    }
  }
  current = {
    ...current,
    cursor: index,
    status: 'completed',
    finishedAt: nowText(),
    doneCount: index,
    failure: undefined,
  }
  persistBatch(current)
  return current
}

// ---- 派生视图：统计与航班保障待办都从台账+作业行同源派生 ----

export function cateringStats(): CateringStats {
  const rows = cateringRows()
  const portions = loadLedger().reduce((sum, entry) => sum + entry.portions, 0)
  return {
    todayCount: rows.length,
    deliveringCount: rows.filter((row) => text(row.status) === '配送中').length,
    pendingHandoverCount: rows.filter((row) => text(row.status) === PENDING_HANDOVER).length,
    handedCount: rows.filter((row) => text(row.status) === HANDED).length,
    handedPortions: portions,
    blockedCount: rows.filter((row) => Boolean(text(row.拦截原因))).length,
  }
}

// 航班保障线读到的配餐交接待办：已交接的从台账取（份数权威），待交接/被拦截的回作业行取。
export function flightCateringView(flightNo: string): FlightCateringView {
  const rows = cateringRows().filter((row) => text(row.航班号) === flightNo)
  const ledger = loadLedger().filter((entry) => entry.flightNo === flightNo)
  const pending: FlightCateringView['pending'] = []
  const blocked: FlightCateringView['blocked'] = []
  for (const row of rows) {
    if (text(row.status) !== PENDING_HANDOVER) {
      continue
    }
    const reason = text(row.拦截原因)
    if (reason) {
      blocked.push({ id: Number(row.id), jobNo: text(row.作业编号), reason })
    } else {
      pending.push({
        id: Number(row.id),
        jobNo: text(row.作业编号),
        company: text(row.配餐公司),
        portions: Number(row.餐食数量) || 0,
      })
    }
  }
  return {
    flightNo,
    handed: ledger.map((entry) => ({
      jobNo: entry.jobNo,
      company: entry.company,
      handler: entry.handler,
      portions: entry.portions,
    })),
    pending,
    blocked,
  }
}
