<template>
  <section class="page" data-module="catering">
    <header class="page-head">
      <div>
        <h2>航空配餐管理</h2>
        <p class="page-desc">
          交接按「作业编号 + 配餐公司」共同定位，校验交接人归属与签认；状态逐级流转，确认交接后份数同源落到航班保障待办。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记配餐作业</button>
        <button class="btn" type="button" @click="exportRows">导出航空配餐清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ warn: item.warn }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item warn-legend">待交接未签认：{{ overview.unsignedAwaiting }}</span>
      <span class="legend-item warn-legend">航班保障待接收：{{ overview.pendingTodoCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>配餐公司</span>
        <input v-model="filters['配餐公司']" placeholder="按配餐公司检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="bulk-bar">
      <span class="bulk-tip">已勾选 {{ selectedCount }} 条</span>
      <button class="btn" type="button" :disabled="!hasDeliveringSelection" @click="openBatch('提交交接')">
        批量提交交接
      </button>
      <button class="btn" type="button" :disabled="!hasAwaitingSelection" @click="openBatch('确认交接')">
        批量确认交接
      </button>
      <button class="btn ghost" type="button" @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选当前列表' }}
      </button>
    </div>

    <table class="data-table catering-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal, 'row-warn': !row.abnormal && isUnsignedAwaiting(row) }">
          <td class="col-check">
            <input type="checkbox" :checked="isSelected(row)" @change="toggleSelect(row)" />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '签认'">
              <span :class="signCell(row)">{{ signText(row) }}</span>
              <span v-if="failureOf(row)" class="row-note">{{ failureOf(row) }}</span>
            </template>
            <template v-else-if="column === '作业状态'">{{ row.status }}</template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span class="status-pill" :class="statusClass(row)">{{ row.status }}</span>
            <span v-if="!row.abnormal && isUnsignedAwaiting(row)" class="row-note">签认缺失：禁止确认交接</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action.key"
              class="link"
              :class="{ danger: action.danger }"
              type="button"
              @click="invokeRowAction(action.key, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无航空配餐数据，可先登记配餐作业</td>
        </tr>
      </tbody>
    </table>

    <div v-if="lastBatch" class="batch-result" :class="{ ok: lastBatch.ok, fail: !lastBatch.ok }">
      <header class="batch-result-head">
        <strong>{{ lastBatch.action }}结果：{{ lastBatch.message }}</strong>
        <button v-if="lastBatch.failed.length" class="btn primary" type="button" @click="retryFailed">
          从失败的 {{ lastBatch.failed.length }} 条继续重试
        </button>
      </header>
      <ul v-if="lastBatch.succeeded.length" class="batch-list success">
        <li v-for="item in lastBatch.succeeded" :key="`s-${item.jobNo}`">✓ {{ item.jobNo }}：{{ item.message }}</li>
      </ul>
      <ul v-if="lastBatch.skipped.length" class="batch-list skipped">
        <li v-for="item in lastBatch.skipped" :key="`k-${item.jobNo}`">＝ {{ item.jobNo }}：{{ item.message }}</li>
      </ul>
      <ul v-if="lastBatch.failed.length" class="batch-list failed">
        <li v-for="item in lastBatch.failed" :key="`f-${item.jobNo || '无作业号'}`">
          ✗ {{ item.jobNo || '（载荷缺作业号）' }} · 卡在【{{ item.stage }}】：{{ item.reason }}
        </li>
      </ul>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条航空配餐记录 · 已交接份数与航班保障待办同源（均取自配餐作业记录）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3>{{ dialog.action }} · {{ dialog.claims.length }} 条</h3>
        <p class="modal-tip">
          每条载荷都必须带配餐公司与交接人；确认交接前请在列表中完成「补签认」。份数与作业记录不一致的一条会被挡下，其余继续。
        </p>
        <div class="claim-list">
          <div v-for="(claim, index) in dialog.claims" :key="claim.jobNo" class="claim-row">
            <div class="claim-head">
              <span>{{ claim.jobNo }}</span>
              <span class="claim-company">{{ claim.company }}</span>
              <span v-if="sourcePortion(claim.jobNo) !== null" class="claim-record">
                记录 {{ sourcePortion(claim.jobNo) }} 份
              </span>
            </div>
            <label>
              交接人
              <input v-model="claim.handler" list="catering-handler-options" placeholder="交接人必须属于该配餐公司" />
            </label>
            <label>
              交接份数
              <input
                v-model.number="claim.portions"
                type="number"
                min="0"
                placeholder="必须与作业记录一致"
                @input="markPortionsTouched(index)"
              />
              <span v-if="portionMismatch(claim)" class="field-error">
                应为 {{ sourcePortion(claim.jobNo) ?? '—' }} 份
              </span>
            </label>
          </div>
        </div>
        <datalist id="catering-handler-options">
          <option v-for="handler in handlerOptions" :key="handler" :value="handler" />
        </datalist>
        <footer class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="dialog.submitting" @click="submitDialog">
            {{ dialog.submitting ? '处理中…' : dialog.action }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  catering,
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import type { EntryRow, HandoverBatchResult, HandoverClaim } from '@/data/types'

const meta = moduleMeta('catering')
const columns = [
  '作业编号', '航班号', '餐食数量', '配餐公司', '餐车编号', '装载舱门',
  '交接人员', '签认', '作业状态', '交接公司', '交接时间',
]
const statuses = ['待配餐', '配送中', '待交接', '已交接']
const filterFields = ['作业编号', '航班号', '餐食数量']
const handlerOptions = Object.values(catering.COMPANY_HANDLERS).flat()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const selected = ref<Set<string>>(new Set())
const selectedCompany = ref<Record<string, string>>({})
const lastBatch = ref<HandoverBatchResult | null>(null)
const portionsTouched = ref<Set<number>>(new Set())

const dialog = reactive<{
  open: boolean
  action: '提交交接' | '确认交接'
  claims: HandoverClaim[]
  submitting: boolean
}>({
  open: false,
  action: '提交交接',
  claims: [],
  submitting: false,
})

const overview = computed(() => catering.cateringOverview())
const stats = computed(() => [
  { label: '今日配餐架次', value: overview.value.jobCount, warn: false },
  { label: '配送中作业', value: overview.value.delivering, warn: false },
  { label: '待交接未签认', value: overview.value.unsignedAwaiting, warn: overview.value.unsignedAwaiting > 0 },
  { label: '已交接餐食份数', value: overview.value.handedPortions, warn: false },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selectedRows = computed(() =>
  rows.value.filter((row) => selected.value.has(catering.jobNoOf(row))),
)
const selectedCount = computed(() => selectedRows.value.length)
const hasDeliveringSelection = computed(() =>
  selectedRows.value.some((row) => row.status === catering.STATUS_DELIVERING),
)
const hasAwaitingSelection = computed(() =>
  selectedRows.value.some((row) => row.status === catering.STATUS_AWAITING),
)
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selected.value.has(catering.jobNoOf(row))),
)

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

function isUnsignedAwaiting(row: EntryRow): boolean {
  return catering.isAwaitingUnsigned(row)
}

function failureOf(row: EntryRow): string {
  return catering.rowFailure(row)
}

function signText(row: EntryRow): string {
  return catering.isSigned(row) ? catering.SIGN_DONE : catering.SIGN_PENDING
}

function signCell(row: EntryRow): Record<string, boolean> {
  return {
    'sign-done': catering.isSigned(row),
    'sign-pending': !catering.isSigned(row),
  }
}

function statusClass(row: EntryRow): Record<string, boolean> {
  return {
    'st-handed': row.status === catering.STATUS_HANDED,
    'st-awaiting': row.status === catering.STATUS_AWAITING,
    'st-delivering': row.status === catering.STATUS_DELIVERING,
  }
}

type RowAction = { key: string; label: string; danger?: boolean }

function rowActions(row: EntryRow): RowAction[] {
  if (row.status === catering.STATUS_PENDING_MEAL) {
    return [{ key: '开始配送', label: '开始配送' }]
  }
  if (row.status === catering.STATUS_DELIVERING) {
    return [{ key: '提交交接', label: '提交交接' }]
  }
  if (row.status === catering.STATUS_AWAITING) {
    const actions: RowAction[] = []
    if (!catering.isSigned(row)) {
      actions.push({ key: '补签认', label: '补签认' })
    }
    actions.push({ key: '确认交接', label: '确认交接' })
    return actions
  }
  return [{ key: '重复确认', label: '重复确认', danger: true }]
}

function isSelected(row: EntryRow): boolean {
  return selected.value.has(catering.jobNoOf(row))
}

function toggleSelect(row: EntryRow) {
  const key = catering.jobNoOf(row)
  const next = new Set(selected.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
    selectedCompany.value[key] = String(row[catering.FIELD_COMPANY] ?? '')
  }
  selected.value = next
}

function toggleSelectAll() {
  if (allSelected.value) {
    selected.value = new Set()
    return
  }
  const next = new Set<string>()
  const companyMap: Record<string, string> = {}
  for (const row of rows.value) {
    const key = catering.jobNoOf(row)
    next.add(key)
    companyMap[key] = String(row[catering.FIELD_COMPANY] ?? '')
  }
  selected.value = next
  selectedCompany.value = companyMap
}

function buildClaim(row: EntryRow): HandoverClaim {
  return {
    jobNo: catering.jobNoOf(row),
    company: String(row[catering.FIELD_COMPANY] ?? ''),
    handler: String(row[catering.FIELD_HANDLER] ?? ''),
    portions: catering.portionsOf(row) ?? undefined,
  }
}

function openBatch(action: '提交交接' | '确认交接') {
  const wanted = action === '提交交接' ? catering.STATUS_DELIVERING : catering.STATUS_AWAITING
  const targets = selectedRows.value.filter((row) => row.status === wanted)
  if (!targets.length) {
    errorMessage.value = `勾选的记录里没有「${wanted}」状态的作业`
    return
  }
  dialog.open = true
  dialog.action = action
  dialog.claims = targets.map(buildClaim)
  dialog.submitting = false
  portionsTouched.value = new Set()
  lastBatch.value = null
}

function invokeRowAction(key: string, row: EntryRow) {
  errorMessage.value = ''
  if (key === '开始配送') {
    const result = catering.startDelivery(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  if (key === '补签认') {
    const result = catering.signOff(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
    return
  }
  if (key === '提交交接' || key === '确认交接') {
    dialog.open = true
    dialog.action = key
    dialog.claims = [buildClaim(row)]
    dialog.submitting = false
    portionsTouched.value = new Set()
    lastBatch.value = null
    return
  }
  if (key === '重复确认') {
    // 已交接重复确认：演示幂等，份数只记一次。
    const result = catering.processHandoverBatch('确认交接', [buildClaim(row)])
    lastBatch.value = result
    errorMessage.value = result.skipped.length ? '' : result.message
    reload()
  }
}

function sourcePortion(jobNo: string): number | null {
  const row = rows.value.find((item) => catering.jobNoOf(item) === jobNo)
  return row ? catering.portionsOf(row) : null
}

function markPortionsTouched(index: number) {
  portionsTouched.value.add(index)
}

function portionMismatch(claim: HandoverClaim): boolean {
  const recorded = sourcePortion(claim.jobNo)
  return recorded !== null && claim.portions !== undefined && claim.portions !== recorded
}

function submitDialog() {
  dialog.submitting = true
  // 每条独立成项：失败的一条不阻断其它，结果面板逐条给出卡在的阶段。
  const result = catering.processHandoverBatch(dialog.action, dialog.claims.map((claim) => ({ ...claim })))
  lastBatch.value = result
  dialog.submitting = false
  dialog.open = false
  errorMessage.value = result.ok ? '' : result.message
  portionsTouched.value = new Set()
  reload()
}

// 重试只带上失败项的原始载荷：成功的已经落库，天然从失败的那一条继续。
function retryFailed() {
  if (!lastBatch.value?.failed.length) {
    return
  }
  const action = lastBatch.value.action
  const claims = lastBatch.value.failed.map((item) => ({ ...item.claim }))
  lastBatch.value = null
  const result = catering.processHandoverBatch(action, claims)
  lastBatch.value = result
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function closeDialog() {
  dialog.open = false
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const valid = new Set(rows.value.map((row) => catering.jobNoOf(row)))
    const next = new Set([...selected.value].filter((key) => valid.has(key)))
    selected.value = next
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航空配餐列表读取失败'
  }
}

onMounted(reload)
</script>
