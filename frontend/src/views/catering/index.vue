<template>
  <section class="page" data-module="catering">
    <header class="page-head">
      <div>
        <h2>航空配餐管理</h2>
        <p class="page-desc">交接按配餐公司与交接人归属逐道核对：未签认、缺载荷的作业会被标出并停在失败步骤，补齐后从该条继续。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记配餐作业</button>
        <button class="btn" type="button" @click="exportRows">导出航空配餐清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-danger': item.danger }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <span class="filter-item">
        <span>本次交接配餐公司</span>
        <select v-model="batchCompany">
          <option v-for="company in companies" :key="company" :value="company">{{ company }}</option>
        </select>
      </span>
      <label class="filter-item">
        <span>交接人</span>
        <input v-model="batchHandler" placeholder="交接人姓名" />
      </label>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="confirmBatch">
        批量确认交接（{{ selectedIds.length }} 条）
      </button>
      <span v-if="!selectedIds.length" class="batch-hint">勾选「待交接」作业后整批核对交接</span>
    </div>

    <div v-if="batch" class="batch-panel" :class="{ 'batch-failed': batch.status === 'failed' }">
      <template v-if="batch.status === 'failed' && batch.failure">
        <strong>批次 {{ batch.id }} 停在第 {{ batch.cursor + 1 }}/{{ batch.totalCount }} 条：</strong>
        作业 {{ batch.failure.jobNo }} 在「{{ batch.failure.step }}」被挡 —— {{ batch.failure.message }}。
        前 {{ batch.doneCount }} 条已逐条落库，不会重复计数。如因配餐公司/交接人填错，可在上方改后重试。
        <button class="btn primary" type="button" @click="retryBatch">从失败的这一条继续</button>
        <button class="btn" type="button" @click="cancelBatch">终止批次</button>
      </template>
      <template v-else>
        <strong>批次 {{ batch.id }} 已完成：</strong>{{ batch.doneCount }}/{{ batch.totalCount }} 条全部完成交接，份数已登记台账。
        <button class="btn" type="button" @click="cancelBatch">关闭</button>
      </template>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allPendingSelected"
              :disabled="!pendingRows.length"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-blocked': isBlocked(row) }">
          <td class="col-check">
            <input
              v-if="String(row.status) === '待交接'"
              type="checkbox"
              :value="Number(row.id)"
              v-model="selectedIds"
            />
          </td>
          <td v-for="column in columns" :key="column">
            <span v-if="column === '拦截原因' && isBlocked(row)" class="badge-danger">⛔ {{ row[column] }}</span>
            <span v-else-if="column === '交接签认' && String(row[column]) !== '已签认'" class="badge-warn">未签认</span>
            <span v-else-if="column === '载荷编号' && !row[column] && String(row.status) === '待交接'" class="badge-warn">缺载荷</span>
            <span v-else>{{ row[column] || '—' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in rowActions(row)" :key="action">
              <button class="link" type="button" @click="runRowAction(action, row)">{{ action }}</button>
            </template>
            <span v-if="!rowActions(row).length" class="text-muted">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无航空配餐数据，可先登记配餐作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航空配餐记录 · 已交接餐食份数以交接台账为准（{{ stats.handedPortions }} 份），与航班保障待办同源</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  beginHandoverBatch,
  cancelHandoverBatch,
  continueHandoverBatch,
  currentHandoverBatch,
  downloadEntries,
  listEntries,
  moduleMeta,
  readCateringStats,
  runAction as applyAction,
} from '@/api/local-service'
import type { CateringStats, EntryRow, HandoverBatchState } from '@/data/types'

const meta = moduleMeta('catering')
const columns = meta.fields
const companies = ['滨海航食', '中膳食品']
const statuses = ['待配餐', '配送中', '待交接', '已交接']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const batchCompany = ref(companies[0])
const batchHandler = ref('周敏')
const batch = ref<HandoverBatchState | null>(null)
const stats = ref<CateringStats>({
  todayCount: 0,
  deliveringCount: 0,
  pendingHandoverCount: 0,
  handedCount: 0,
  handedPortions: 0,
  blockedCount: 0,
})

const statCards = computed(() => [
  { label: '今日配餐架次', value: stats.value.todayCount, danger: false },
  { label: '配送中作业', value: stats.value.deliveringCount, danger: false },
  { label: '待交接作业', value: stats.value.pendingHandoverCount, danger: false },
  { label: '已交接架次', value: stats.value.handedCount, danger: false },
  { label: '已交接餐食份数', value: stats.value.handedPortions, danger: false },
  { label: '被拦截作业', value: stats.value.blockedCount, danger: stats.value.blockedCount > 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pendingRows = computed(() => rows.value.filter((row) => String(row.status) === '待交接'))
const allPendingSelected = computed(
  () => pendingRows.value.length > 0 && pendingRows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)

function isBlocked(row: EntryRow): boolean {
  return Boolean(String(row.拦截原因 ?? '').trim())
}

function rowActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待配餐':
      return ['开始配送']
    case '配送中':
      return ['提交交接']
    case '待交接': {
      const actions = ['交接签认', '确认交接']
      if (!String(row.载荷编号 ?? '').trim()) {
        actions.splice(1, 0, '补录载荷')
      }
      return actions
    }
    default:
      return []
  }
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? pendingRows.value.map((row) => Number(row.id)) : []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '配餐作业登记入口尚未接入审批流'
}

function runRowAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const id = Number(row.id)
  if (action === '交接签认') {
    const signer = window.prompt(`请填写作业 ${row.作业编号} 的签认交接人（须为登记交接人本人）`, String(row.交接人员 ?? ''))
    if (signer === null) {
      return
    }
    applyAndReload(id, action, { company: String(row.配餐公司 ?? ''), handler: signer })
    return
  }
  if (action === '补录载荷') {
    const payloadNo = window.prompt(`请补录作业 ${row.作业编号} 的载荷编号`, String(row.载荷编号 ?? ''))
    if (payloadNo === null) {
      return
    }
    // 载荷编号复用交接人槽位传给落库层，落库只认这一个补录入口。
    applyAndReload(id, action, { company: '', handler: payloadNo })
    return
  }
  if (action === '确认交接') {
    // 交接人/配餐公司在列表里按行核对一遍再提交，防止混批时把 A 的份数记到 B。
    const ok = window.confirm(
      `确认按「${batchCompany.value} · 交接人 ${batchHandler.value}」交接作业 ${row.作业编号}？\n（记录归属：${row.配餐公司} · ${row.交接人员}，不一致会被挡回）`,
    )
    if (!ok) {
      return
    }
    applyAndReload(id, action, { company: batchCompany.value, handler: batchHandler.value })
    return
  }
  applyAndReload(id, action, { company: '', handler: '' })
}

function applyAndReload(id: number, action: string, payload: { company: string; handler: string }) {
  const result = applyAction(meta.key, id, action, payload)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function confirmBatch() {
  errorMessage.value = ''
  const ids = [...selectedIds.value]
  if (!ids.length) {
    return
  }
  const state = beginHandoverBatch(ids, { company: batchCompany.value, handler: batchHandler.value })
  selectedIds.value = []
  if (state.status === 'failed' && state.failure) {
    errorMessage.value = `批次停在作业 ${state.failure.jobNo} 的「${state.failure.step}」：${state.failure.message}`
  }
  reload()
}

function retryBatch() {
  errorMessage.value = ''
  const state = continueHandoverBatch({ company: batchCompany.value, handler: batchHandler.value })
  if (state?.status === 'failed' && state.failure) {
    errorMessage.value = `仍停在作业 ${state.failure.jobNo} 的「${state.failure.step}」：${state.failure.message}`
  }
  reload()
}

function cancelBatch() {
  cancelHandoverBatch()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = readCateringStats()
    // 批量断点是落库数据：刷新页面后仍显示失败点，支持从失败的那一条继续。
    batch.value = currentHandoverBatch()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航空配餐列表读取失败'
  }
}

onMounted(reload)
</script>
