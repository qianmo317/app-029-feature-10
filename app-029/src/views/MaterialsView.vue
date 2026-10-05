<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SheetDiagram from '../components/SheetDiagram.vue'
import { findFont } from '../logic/fontLoader'
import { alignLabel } from '../logic/layout'
import {
  assertBomSum,
  basisLabel,
  buildBom,
  compareMaterials,
  diffMaterials,
  yuan,
  yuanSigned,
  type BomResult,
  type CompareRow,
  type MaterialDiff
} from '../logic/materials'
import { bomGroupLabel, exportProcessCardCsv } from '../logic/quote'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const router = useRouter()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)
/** 当前展开「清单 + 差额」详情的材质行（默认展开当前方案） */
const expandedId = ref<string | null>(null)

const bom = computed(() => (project.value && layout.value ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value }) : null))
const sumCheck = computed(() => (bom.value ? assertBomSum(bom.value) : null))
const compare = computed(() =>
  project.value && layout.value && bom.value ? compareMaterials(project.value, layout.value, preset.value, bom.value) : []
)
const activeRow = computed(() => compare.value.find((c) => c.id === project.value?.panelMaterialId) ?? null)
const expandedRow = computed(() => compare.value.find((c) => c.id === expandedId.value) ?? null)
/** 展开行相对当前方案的差额（展开的就是当前方案时为 null，只展示它自己的清单） */
const expandedDiff = computed<MaterialDiff | null>(() => {
  const row = expandedRow.value
  if (!row || !bom.value || row.id === bom.value.panelMaterial.id) return null
  return diffMaterials(bom.value, row.bom)
})

const grouped = computed(() => {
  const b = bom.value
  if (!b) return []
  const map = new Map<string, { label: string; rows: typeof b.materials }>()
  for (const m of b.materials) {
    const label = bomGroupLabel(m.kind)
    const hit = map.get(m.kind) ?? { label, rows: [] }
    hit.rows.push(m)
    map.set(m.kind, hit)
  }
  return [...map.values()]
})

/** 任一种材质的清单分组（展开面板用） */
function groupedOf(b: BomResult): { label: string; rows: BomResult['materials'] }[] {
  const map = new Map<string, { label: string; rows: BomResult['materials'] }>()
  for (const m of b.materials) {
    const label = bomGroupLabel(m.kind)
    const hit = map.get(m.kind) ?? { label, rows: [] }
    hit.rows.push(m)
    map.set(m.kind, hit)
  }
  return [...map.values()]
}

function diffFor(row: CompareRow): MaterialDiff | null {
  if (!bom.value || row.id === bom.value.panelMaterial.id) return null
  return diffMaterials(bom.value, row.bom)
}

function statusLabel(s: 'same' | 'changed' | 'added' | 'removed'): string {
  return s === 'added' ? '新增' : s === 'removed' ? '取消' : s === 'changed' ? '变化' : '相同'
}

function statusTagClass(s: 'same' | 'changed' | 'added' | 'removed'): string {
  return s === 'added' ? 'ok' : s === 'removed' ? 'bad' : s === 'changed' ? 'warn' : ''
}

const activeMaterial = computed(() => {
  if (!project.value) return preset.value.panelMaterials[0]
  return preset.value.panelMaterials.find((m) => m.id === project.value!.panelMaterialId) ?? preset.value.panelMaterials[0]
})

function applyMaterial(id: string): void {
  if (!project.value || id === project.value.panelMaterialId) return
  project.value.panelMaterialId = id
  expandedId.value = id
}

function applySheet(id: string): void {
  activeMaterial.value.sheetId = id
}

function toggleDetail(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

function processCard(): void {
  if (project.value && layout.value && bom.value && !bom.value.empty) {
    exportProcessCardCsv(project.value, layout.value, bom.value, findFont(project.value.layout.settings.fontId)?.family ?? '')
  }
}

function goQuote(): void {
  if (project.value && bom.value && !bom.value.empty && !bom.value.blocked) {
    router.push(`/quote/${project.value.id}`)
  }
}

const diffBucketRows = computed(() => {
  const d = expandedDiff.value
  if (!d || !bom.value || !expandedRow.value) return []
  const from = bom.value.buckets
  const to = expandedRow.value.bom.buckets
  return [
    { name: '面板', delta: d.buckets.panel, from: from.panelCents, to: to.panelCents },
    { name: '灯与电源', delta: d.buckets.light, from: from.lightCents, to: to.lightCents },
    { name: '配件', delta: d.buckets.accessory, from: from.accessoryCents, to: to.accessoryCents },
    { name: '加工', delta: d.buckets.labor, from: from.laborCents, to: to.laborCents }
  ]
})
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div v-if="bom?.blocked" class="banner bad">
        <b>工艺风险拦截：</b>
        <ul class="notes" style="color: inherit">
          <li v-for="(r, i) in bom.blockReasons" :key="i">{{ r }}</li>
        </ul>
        <button class="primary" style="margin-top: 6px" @click="ack = true">已确认工艺风险，继续出报价</button>
        <span class="muted" style="margin-left: 8px">未确认前不出报价单（避免做不出来的活）</span>
      </div>

      <div class="split">
        <section class="card">
          <header>
            <h1>材料清单</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>面板材料方案</label>
            <div class="ctl">
              <select v-model="project.panelMaterialId">
                <option v-for="m in preset.panelMaterials" :key="m.id" :value="m.id">{{ m.name }}</option>
              </select>
            </div>
          </div>
          <div class="field" v-if="activeMaterial.panelBasis === 'sheet'">
            <label>该材质所用板材规格</label>
            <div class="ctl">
              <select :value="activeMaterial.sheetId ?? ''" @change="applySheet(($event.target as HTMLSelectElement).value)">
                <option v-for="s in preset.acrylicSheets" :key="s.id" :value="s.id">{{ s.spec }}</option>
              </select>
            </div>
          </div>
          <div class="field" v-else>
            <label>面板计价口径</label>
            <div class="ctl muted">按实际料件面积 {{ yuan(activeMaterial.areaPriceCentsPerM2) }} 元/㎡，不拼整板</div>
          </div>

          <h3 style="margin-top: 12px">材料用量要点</h3>
          <div class="kv-list">
            <span class="muted">当前计量口径</span><span>{{ bom ? basisLabel(bom) : '—' }}</span>
            <span class="muted">异形字口径</span><span>按外接矩形（每个连通域一件），不用轮廓面积</span>
            <template v-if="bom?.nesting">
              <span class="muted">拼版方式</span><span>分层装箱（guillotine，料条横向贯通）</span>
            </template>
            <span class="muted">料件总数</span><span class="mono">{{ bom?.nesting?.pieceCount ?? bom?.cutList.length ?? 0 }} 件</span>
            <span class="muted">料件面积</span><span class="mono">{{ bom?.pieceAreaM2.toFixed(3) ?? 0 }} ㎡</span>
            <template v-if="bom?.nesting">
              <span class="muted">用板数量</span><span class="mono">{{ bom.nesting.sheetCount }} 张</span>
              <span class="muted">综合利用率</span><span class="mono">{{ (bom.nesting.utilization * 100).toFixed(1) }}%</span>
            </template>
            <template v-else>
              <span class="muted">用板数量</span><span class="muted">不适用（按面积计价）</span>
            </template>
            <span class="muted">排版摘要</span>
            <span>
              {{ layout?.sizeMm }}mm · {{ alignLabel(project.layout.settings.align) }} · 占宽 {{ layout?.occupiedW }}mm · 视觉间距极差
              {{ layout?.gapSpread }}mm
            </span>
          </div>

          <div class="row" style="margin-top: 12px">
            <button :disabled="!bom || bom.empty || bom.blocked" @click="processCard">导出工艺卡（CSV）</button>
            <button class="primary" :disabled="!bom || bom.empty || bom.blocked" @click="goQuote">去报价单</button>
          </div>
          <p class="muted" v-if="bom?.empty">清单为空：请先到排版页输入文字并等待字体加载后，再导出工艺卡或报价单。</p>
          <p class="muted" v-else-if="bom?.nesting?.oversize.length">
            超板料件：{{ bom.nesting.oversize.map((p) => `${p.label} ${p.wMm}×${p.hMm}`).join('；') }}（需换更大板材或分件拼接）
          </p>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>材料明细与金额</h2>
              <span class="hint">当前方案：{{ bom?.panelMaterial.name }} · 金额单位「分」，Σ 明细 = 合计</span>
            </header>
            <table v-if="bom && !bom.empty">
              <thead>
                <tr>
                  <th>类别</th>
                  <th>规格 / 说明</th>
                  <th class="num">数量</th>
                  <th>单位</th>
                  <th class="num">单价（元）</th>
                  <th class="num">金额（元）</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="g in grouped" :key="g.label">
                  <tr v-for="(m, i) in g.rows" :key="`${g.label}${i}`">
                    <td>{{ i === 0 ? g.label : '' }}</td>
                    <td>{{ m.spec }}</td>
                    <td class="num">{{ m.qty }}</td>
                    <td>{{ m.unit }}</td>
                    <td class="num">{{ yuan(m.unitPriceCents) }}</td>
                    <td class="num">{{ yuan(m.amountCents) }}</td>
                  </tr>
                </template>
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">合计</td>
                  <td class="num">{{ bom ? yuan(bom.totalCents) : '0.00' }}</td>
                </tr>
              </tfoot>
            </table>
            <div v-else class="empty-box">
              <b>当前方案还没有材料清单</b>
              <p>排版中暂无可计入的字（尚未输入文字，或字体尚未加载完成）。请先在排版页完成文字与字体，此处会按「{{ activeMaterial.name }}」的计量口径自动重算，不会出空表。</p>
            </div>
            <p class="muted" v-if="sumCheck">{{ sumCheck.message }}</p>
          </div>

          <div class="card" style="margin-top: 14px" v-if="bom?.nesting && bom.sheet">
            <header>
              <h2>板材拼版图（{{ bom.sheet.wMm }}×{{ bom.sheet.hMm }}mm）</h2>
              <span class="hint">{{ bom.panelMaterial.name }} · 细虚线为分层切割线</span>
            </header>
            <SheetDiagram :key="bom.panelMaterial.id" :nesting="bom.nesting" :sheet-w="bom.sheet.wMm" :sheet-h="bom.sheet.hMm" />
          </div>
          <div class="card" style="margin-top: 14px" v-else-if="bom && !bom.empty">
            <header>
              <h2>料件下料尺寸</h2>
              <span class="hint">{{ bom.panelMaterial.name }} 按面积计价，无需拼整板</span>
            </header>
          </div>

          <div class="card" style="margin-top: 14px" v-if="bom && !bom.empty">
            <header>
              <h2>裁切尺寸清单</h2>
              <span class="hint">同尺寸合并计数</span>
            </header>
            <table>
              <thead>
                <tr><th>料件</th><th class="num">宽 mm</th><th class="num">高 mm</th><th class="num">数量</th></tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in bom.cutList" :key="i">
                  <td>{{ c.label }}</td>
                  <td class="num">{{ c.wMm }}</td>
                  <td class="num">{{ c.hMm }}</td>
                  <td class="num">{{ c.count }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>多材质成本对照</h2>
              <span class="hint">同一排版结果下 {{ compare.length }} 种工艺，每一行都按该材质自己的计量真算（不乘比例）</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>材质</th>
                  <th class="num">面板</th>
                  <th class="num">灯与电源</th>
                  <th class="num">配件</th>
                  <th class="num">加工</th>
                  <th class="num">合计（元）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="c in compare" :key="c.id">
                  <tr :class="{ 'row-active': c.id === project.panelMaterialId }">
                    <td>
                      <span class="mat-name">{{ c.name }}</span>
                      <span v-if="c.id === project.panelMaterialId" class="tag ok current-tag">● 当前方案</span>
                      <div class="muted mat-desc">{{ c.desc }}</div>
                    </td>
                    <td class="num">{{ yuan(c.panelCents) }}</td>
                    <td class="num">{{ yuan(c.ledCents + c.psuCents) }}</td>
                    <td class="num">{{ yuan(c.accessoryCents) }}</td>
                    <td class="num">{{ yuan(c.laborCents) }}</td>
                    <td class="num"><b>{{ yuan(c.totalCents) }}</b></td>
                    <td class="nowrap">
                      <button v-if="c.id !== project.panelMaterialId" class="mini primary" @click="applyMaterial(c.id)">换成此材质</button>
                      <span v-else class="muted">已选用</span>
                      <button class="mini" @click="toggleDetail(c.id)">{{ expandedId === c.id ? '收起' : '清单 / 差额' }}</button>
                    </td>
                  </tr>
                  <tr v-if="expandedId === c.id" class="detail-row">
                    <td colspan="7">
                      <div class="detail-box">
                        <p class="basis-line"><b>计量口径：</b>{{ basisLabel(c.bom) }}</p>

                        <div v-if="c.bom.empty" class="empty-box">
                          该材质清单为空：排版中暂无可计入的字（尚未输入文字或字体未加载），无法给出材料条目。
                        </div>
                        <template v-else>
                          <table class="detail-table">
                            <thead>
                              <tr>
                                <th>类别</th><th>规格 / 说明</th><th class="num">数量</th><th>单位</th>
                                <th class="num">单价（元）</th><th class="num">金额（元）</th>
                              </tr>
                            </thead>
                            <tbody>
                              <template v-for="g in groupedOf(c.bom)" :key="g.label">
                                <tr v-for="(m, i) in g.rows" :key="`${c.id}-${g.label}-${i}`">
                                  <td>{{ i === 0 ? g.label : '' }}</td>
                                  <td>{{ m.spec }}</td>
                                  <td class="num">{{ m.qty }}</td>
                                  <td>{{ m.unit }}</td>
                                  <td class="num">{{ yuan(m.unitPriceCents) }}</td>
                                  <td class="num">{{ yuan(m.amountCents) }}</td>
                                </tr>
                              </template>
                            </tbody>
                            <tfoot>
                              <tr><td colspan="5">合计</td><td class="num">{{ yuan(c.bom.totalCents) }}</td></tr>
                            </tfoot>
                          </table>

                          <div v-if="diffFor(c)" class="diff-box">
                            <h4>与当前方案（{{ activeRow?.name }}）差在哪</h4>
                            <table class="detail-table">
                              <thead>
                                <tr><th>项目</th><th>当前方案</th><th>{{ c.name }}</th><th class="num">差额（元）</th></tr>
                              </thead>
                              <tbody>
                                <tr v-for="b in diffBucketRows" :key="b.name" class="bucket-row">
                                  <td><b>{{ b.name }}（小计）</b></td>
                                  <td class="num">{{ yuan(b.from) }}</td>
                                  <td class="num">{{ yuan(b.to) }}</td>
                                  <td class="num" :class="b.delta > 0 ? 'cell-up' : b.delta < 0 ? 'cell-down' : ''">
                                    <b>{{ yuanSigned(b.delta) }}</b>
                                  </td>
                                </tr>
                                <tr v-for="(ln, i) in diffFor(c)!.lines" :key="`${c.id}-d${i}`" :class="`st-${ln.status}`">
                                  <td><span class="tag" :class="statusTagClass(ln.status)">{{ statusLabel(ln.status) }}</span><span class="muted">{{ ln.group }}</span> {{ ln.spec }}</td>
                                  <td class="num">{{ ln.fromText }}</td>
                                  <td class="num">{{ ln.toText }}</td>
                                  <td class="num" :class="ln.deltaCents > 0 ? 'cell-up' : ln.deltaCents < 0 ? 'cell-down' : ''">
                                    {{ yuanSigned(ln.deltaCents) }}
                                  </td>
                                </tr>
                              </tbody>
                              <tfoot>
                                <tr>
                                  <td colspan="3">合计差额</td>
                                  <td class="num" :class="diffFor(c)!.totalDelta > 0 ? 'cell-up' : 'cell-down'">
                                    <b>{{ yuanSigned(diffFor(c)!.totalDelta) }}</b>
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                            <p class="muted">
                              {{ c.name }} 合计 {{ yuan(c.totalCents) }} 元，比当前方案{{ diffFor(c)!.totalDelta >= 0 ? '贵' : '便宜' }}
                              {{ yuan(Math.abs(diffFor(c)!.totalDelta)) }} 元；差额为正表示该材质此项更贵，负表示更省。
                            </p>
                          </div>
                          <p v-else class="muted">这是当前选用方案：本清单即报价单、工艺卡所用数据。</p>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <p class="muted" style="margin-top: 8px">
              蓝色高亮行为<strong>当前选中方案</strong>。每行金额都来自该材质自己的完整清单：面板按板/按面积、要不要 LED 与电源、包边条算不算、
              配件与加工取哪几项，均按各自计量真实计算；点「换成此材质」后，本页与报价单、工艺卡全部按新材质重算。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mat-name {
  font-weight: 600;
}
.current-tag {
  margin-left: 6px;
  font-weight: 700;
}
.mat-desc {
  font-size: 12px;
  margin-top: 2px;
  max-width: 260px;
}
.nowrap {
  white-space: nowrap;
}
button.mini {
  padding: 2px 8px;
  font-size: 12px;
  margin-left: 4px;
}
tr.row-active {
  box-shadow: inset 4px 0 0 var(--brand);
}
.detail-row > td {
  padding: 0;
  background: #fafbfd;
}
.detail-box {
  padding: 10px 14px 12px;
}
.basis-line {
  margin: 2px 0 8px;
  font-size: 13px;
}
.detail-table {
  margin-top: 4px;
}
.diff-box {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.diff-box h4 {
  margin: 4px 0;
}
.st-same td {
  color: var(--ink-2);
}
.bucket-row td {
  border-top: 1px solid var(--line);
  background: #fafbfd;
}
.diff-box .tag {
  margin-right: 6px;
  font-size: 11px;
}
.cell-up {
  color: var(--danger);
}
.cell-down {
  color: var(--ok);
}
.empty-box {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  background: #fafbfd;
  color: var(--ink-2);
}
.empty-box p {
  margin: 6px 0 0;
  font-size: 13px;
}
</style>
