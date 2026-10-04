import type { HandoverLedgerEntry } from '../types'

// 交接台账初始数据：CATE-0005 已确认交接并入账，航班保障侧尚未接收。
// 台账只记身份与时间，不记份数——份数永远回配餐作业取，保证两处同源。
export const CATERING_LEDGER_SEED: HandoverLedgerEntry[] = [
  {
    jobNo: 'CATE-0005',
    flightNo: 'MU5102',
    company: '蓝天航食',
    handler: '王交接',
    handedAt: '2026-10-04T07:42:00.000Z',
    receivedAt: null,
  },
]
