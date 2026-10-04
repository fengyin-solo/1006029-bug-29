/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 动作发起前记录必须处在的状态：缺了它动作可以越级跳，例如配送中直接确认交接。
  actionFrom?: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 交接判定逐道关：任何一步不过都不许进入已交接，失败信息直接告诉调用方停在哪一步。
export type HandoverStep =
  | '定位作业'
  | '校验作业状态'
  | '核对配餐公司'
  | '核对交接人归属'
  | '核对交接签认'
  | '核对载荷数据'
  | '登记交接台账'
  | '同步航班保障待办'

export type StepFailure = {
  step: HandoverStep
  message: string
}

export type ConfirmInput = {
  // 交接列表里声称的配餐公司，必须与作业记录一致（防止 A 公司批次把份数记到 B 公司）。
  company: string
  // 交接列表里声称的交接人，必须既等于记录上的交接人又归属该配餐公司。
  handler: string
}

export type ConfirmResult = {
  ok: boolean
  message: string
  // 仅在成功或幂等命中时给出当前台账份数，两处统计都从这里取数。
  portions?: number
  failure?: StepFailure
  warning?: string
}

// 一次批量交接的断点：成功的行已落库，cursor 停在失败的那一条，重试从它继续。
export type HandoverBatchState = {
  id: string
  company: string
  handler: string
  rowIds: number[]
  cursor: number
  status: 'failed' | 'completed'
  failure?: { id: number; jobNo: string } & StepFailure
  startedAt: string
  finishedAt?: string
  doneCount: number
  totalCount: number
}

// 交接台账：以作业编号为幂等键，重复确认交接不会重复登记份数。
export type HandoverLedgerEntry = {
  jobNo: string
  flightNo: string
  company: string
  handler: string
  portions: number
  signer: string
  signedAt: string
  payloadNo: string
  handedAt: string
}

export type CateringStats = {
  todayCount: number
  deliveringCount: number
  pendingHandoverCount: number
  handedCount: number
  // 餐食总份数：只统计台账（已交接），与航班保障待办同源，没进台账的份数一律不算。
  handedPortions: number
  blockedCount: number
}

export type FlightCateringView = {
  flightNo: string
  handed: { jobNo: string; company: string; handler: string; portions: number }[]
  pending: { id: number; jobNo: string; company: string; portions: number }[]
  blocked: { id: number; jobNo: string; reason: string }[]
}
