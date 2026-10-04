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
  // 动作允许的源状态白名单：不配置时沿用通用流转，配置后越权状态一律挡回。
  actionSources?: Record<string, string[]>
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

/** 交接批次中每一条携带的载荷：作业号之外必须带上配餐公司，杜绝只凭作业号定位。 */
export type HandoverClaim = {
  jobNo: string
  company: string
  handler?: string
  portions?: number
}

/** 交接校验分步推进，任何一步失败都要能讲清卡在哪一步。 */
export type HandoverStage =
  | '载荷读取'
  | '作业定位'
  | '公司归属'
  | '状态前置'
  | '签认检查'
  | '份数核对'
  | '结果落库'

export type HandoverFailure = {
  jobNo: string
  stage: HandoverStage
  reason: string
  // 原样带回触发失败的载荷，重试时直接从失败的这一条继续。
  claim: HandoverClaim
}

export type HandoverItem = {
  jobNo: string
  message: string
  skipped?: boolean
}

export type HandoverBatchResult = {
  ok: boolean
  action: '提交交接' | '确认交接'
  succeeded: HandoverItem[]
  skipped: HandoverItem[]
  failed: HandoverFailure[]
  message: string
}

/** 交接台账：确认交接成功才入账，按作业编号幂等，是航班保障待办的唯一落点。 */
export type HandoverLedgerEntry = {
  jobNo: string
  flightNo: string
  company: string
  handler: string
  handedAt: string
  receivedAt: string | null
}

/** 航班保障线上的配餐交接待办，由台账关联配餐作业实时派生，份数永远取自作业记录。 */
export type FlightCateringTodo = {
  jobNo: string
  flightNo: string
  company: string
  handler: string
  portions: number | null
  handedAt: string
  missingSource: boolean
}

export type CateringOverview = {
  jobCount: number
  delivering: number
  awaitingHandover: number
  unsignedAwaiting: number
  handedPortions: number
  pendingTodoCount: number
}
