<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import SheetDiagram from '../components/SheetDiagram.vue'
import { findFont } from '../logic/fontLoader'
import { assertBomSum, buildBom, compareMaterials, diffBom, yuan, bomGroupLabel } from '../logic/materials'
import { exportProcessCardCsv } from '../logic/quote'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset
const ack = ref(false)

/** 当前选中材质：完整真实材料清单（与报价单金额一致） */
const bom = computed(() =>
  project.value && layout.value ? buildBom(project.value, layout.value, preset.value, { acknowledgeThinStroke: ack.value }) : null
)
const sumCheck = computed(() => (bom.value ? assertBomSum(bom.value) : null))

/** 多材质对照：每一行都按该材质自己的计量真跑一遍 BOM */
const compare = computed(() => (project.value && layout.value ? compareMaterials(project.value, layout.value, preset.value) : []))

/** 当前展开看清单/差异的材质行（默认可切换到其它行查看，不改变选中方案） */
const inspectId = ref<string | null>(null)
const inspected = computed(() => compare.value.find((c) => c.id === inspectId.value) ?? null)

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

/** 被查看行相对当前选中行的逐行差异（查看当前行时为空） */
const diffLines = computed(() => {
  const row = inspected.value
  if (!row || !bom.value || row.id === project.value?.panelMaterialId) return []
  return diffBom(bom.value, row.bom)
})

const inspectedGrouped = computed(() => {
  const b = inspected.value?.bom
  if (!b) return []
  const order = ['panel', 'led_module', 'psu', 'glue', 'labor'] as const
  return order
    .map((kind) => ({ label: bomGroupLabel(kind), rows: b.materials.filter((m) => m.kind === kind) }))
    .filter((g) => g.rows.length > 0)
})

function applyMaterial(id: string): void {
  if (project.value) project.value.panelMaterialId = id
  inspectId.value = id
}

function applySheet(id: string): void {
  if (project.value) project.value.sheetId = id
}

function toggleInspect(id: string): void {
  inspectId.value = inspectId.value === id ? null : id
}

function processCard(): void {
  if (project.value && layout.value && bom.value) {
    exportProcessCardCsv(project.value, layout.value, bom.value, findFont(project.value.layout.settings.fontId)?.family ?? '')
  }
}

function signDelta(cents: number): string {
  return `${cents > 0 ? '+' : ''}${yuan(cents)}`
}
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
          <div class="field" v-if="bom?.sheet">
            <label>面板板材规格</label>
            <div class="ctl">
              <select :value="project.sheetId" @change="applySheet(($event.target as HTMLSelectElement).value)">
                <option v-for="s in preset.acrylicSheets" :key="s.id" :value="s.id">{{ s.spec }}</option>
              </select>
            </div>
          </div>
          <p class="muted" v-else>
            当前材质（{{ bom?.panelMaterial.name }}）按料件外接矩形面积下料，不走整板拼版；面板规格：{{ bom?.panelMaterial.panelSpec }}
          </p>

          <h3 style="margin-top: 12px">材料用量要点</h3>
          <div class="kv-list">
            <span class="muted">面板口径</span>
            <span>{{ bom?.sheet ? '按板拼版（每个连通域一件，按外接矩形）' : '按面积下料（每个连通域一件，按外接矩形）' }}</span>
            <span class="muted">拼版方式</span><span v-if="bom?.sheet">分层装箱（guillotine，料条横向贯通）</span><span v-else>—（不发光/不拼板材质无此项）</span>
            <span class="muted">料件总数</span><span class="mono">{{ bom?.cutList.reduce((s, c) => s + c.count, 0) ?? 0 }} 件</span>
            <span class="muted">料件面积</span><span class="mono">{{ bom?.pieceAreaM2.toFixed(3) ?? 0 }} ㎡</span>
            <span class="muted">用板数量</span>
            <span class="mono">{{ bom?.nesting ? `${bom.nesting.sheetCount} 张` : '—（按面积下料）' }}</span>
            <span class="muted">综合利用率</span>
            <span class="mono">{{ bom?.nesting ? `${(bom.nesting.utilization * 100).toFixed(1)}%` : '—' }}</span>
            <span class="muted">LED / 电源</span>
            <span class="mono">{{ bom?.panelMaterial.useLed ? `模组 ${bom.led.modules} 只 · 电源 ${bom.led.suggestedPsu}` : '不计（不发光材质）' }}</span>
            <span class="muted">排版摘要</span>
            <span>
              {{ layout?.sizeMm }}mm · 占宽 {{ layout?.occupiedW }}mm · 视觉间距极差 {{ layout?.gapSpread }}mm
            </span>
          </div>

          <div class="row" style="margin-top: 12px">
            <button :disabled="!bom || bom.blocked || bom.materials.length === 0" @click="processCard">导出工艺卡（CSV）</button>
            <router-link :to="`/quote/${project.id}`"><button class="primary">去报价单</button></router-link>
          </div>
          <p class="muted" v-if="bom?.nesting?.oversize.length">
            超板料件：{{ bom.nesting.oversize.map((p) => `${p.label} ${p.wMm}×${p.hMm}`).join('；') }}（需换更大板材或分件拼接）
          </p>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>材料明细与金额（{{ bom?.panelMaterial.name }}）</h2>
              <span class="hint">金额单位「分」，Σ 明细 = 合计</span>
            </header>
            <table v-if="bom && bom.materials.length > 0">
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
            <div v-else class="banner warn">
              当前材质没有可计入的材料条目：请先回到排版页输入文字（或更换字体后重试）。不会输出空清单。
            </div>
            <p class="muted">{{ sumCheck?.message }}</p>
          </div>

          <div class="card" style="margin-top: 14px" v-if="bom?.nesting && bom.sheet">
            <header>
              <h2>板材拼版图（{{ bom.sheet.wMm }}×{{ bom.sheet.hMm }}mm）</h2>
              <span class="hint">细虚线为分层切割线</span>
            </header>
            <SheetDiagram :nesting="bom.nesting" :sheet-w="bom.sheet.wMm" :sheet-h="bom.sheet.hMm" />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>裁切尺寸清单</h2>
              <span class="hint">同尺寸合并计数</span>
            </header>
            <table v-if="bom && bom.cutList.length > 0">
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
            <p class="muted" v-else>暂无料件：请先在排版页输入文字。</p>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>多材质成本对照</h2>
              <span class="hint">同一排版结果下 {{ compare.length }} 种工艺，每一行都按各自计量真算（不乘比例）</span>
            </header>
            <table class="compare-table">
              <thead>
                <tr>
                  <th>材质</th>
                  <th>灯/电源</th>
                  <th class="num">面板</th>
                  <th class="num">LED</th>
                  <th class="num">电源</th>
                  <th class="num">配件</th>
                  <th class="num">加工</th>
                  <th class="num">合计（元）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in compare"
                  :key="c.id"
                  :class="{ 'row-active': c.id === project.panelMaterialId }"
                >
                  <td>
                    <b v-if="c.id === project.panelMaterialId">✓ {{ c.name }}</b>
                    <a href="#" v-else @click.prevent="toggleInspect(c.id)">{{ c.name }}</a>
                  </td>
                  <td class="muted">{{ c.useLed ? '计' : '不计' }}</td>
                  <td class="num">{{ yuan(c.panelCents) }}</td>
                  <td class="num">{{ c.useLed ? yuan(c.ledCents) : '—' }}</td>
                  <td class="num">{{ c.useLed ? yuan(c.psuCents) : '—' }}</td>
                  <td class="num">{{ yuan(c.accessoryCents) }}</td>
                  <td class="num">{{ yuan(c.laborCents) }}</td>
                  <td class="num"><b>{{ yuan(c.totalCents) }}</b></td>
                  <td>
                    <button
                      v-if="c.id !== project.panelMaterialId"
                      class="primary"
                      style="padding: 2px 8px"
                      @click="applyMaterial(c.id)"
                    >
                      换成此材质
                    </button>
                    <span v-else class="tag ok">当前方案</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="muted">
              蓝色高亮（✓）为<strong>当前出单方案</strong>；点其它材质名可查看按它真算的材料清单和与当前方案的逐项差价，点「换成此材质」即切换——
              切换后本页清单、拼版/用板、报价单与工艺卡全部按新材质重算。
            </p>

            <!-- 被查看材质的真算清单 + 与当前方案的差异 -->
            <div v-if="inspected" style="margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px">
              <header style="display: flex; justify-content: space-between; align-items: baseline">
                <h3 style="margin: 0">
                  {{ inspected.name }} 的材料清单
                  <span v-if="inspected.id === project.panelMaterialId" class="tag ok">即当前方案</span>
                </h3>
                <span class="muted">合计 ¥{{ yuan(inspected.totalCents) }}</span>
              </header>
              <p class="muted" style="margin: 4px 0">{{ inspected.desc }}</p>
              <table v-if="inspected.bom.materials.length > 0" style="margin-top: 6px">
                <thead>
                  <tr>
                    <th>类别</th>
                    <th>规格 / 说明</th>
                    <th class="num">数量</th>
                    <th>单位</th>
                    <th class="num">金额（元）</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="g in inspectedGrouped" :key="g.label">
                    <tr v-for="(m, i) in g.rows" :key="`${g.label}${i}`">
                      <td>{{ i === 0 ? g.label : '' }}</td>
                      <td>{{ m.spec }}</td>
                      <td class="num">{{ m.qty }}</td>
                      <td>{{ m.unit }}</td>
                      <td class="num">{{ yuan(m.amountCents) }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
              <p class="muted" v-else>该材质在此排版下没有可计入的材料条目（请先输入文字）。</p>

              <template v-if="inspected.id !== project.panelMaterialId">
                <h4 style="margin: 10px 0 4px">
                  与当前方案「{{ bom?.panelMaterial.name }}」的差异
                  <span class="muted">（当前 ¥{{ bom ? yuan(bom.totalCents) : '0.00' }} → {{ inspected.name }} ¥{{ yuan(inspected.totalCents) }}，
                    <b :style="{ color: inspected.totalCents - (bom?.totalCents ?? 0) > 0 ? 'var(--danger)' : 'var(--ok)' }">
                      {{ signDelta(inspected.totalCents - (bom?.totalCents ?? 0)) }} 元
                    </b>）
                  </span>
                </h4>
                <table v-if="diffLines.length > 0">
                  <thead>
                    <tr><th>分项</th><th>规格 / 说明</th><th class="num">{{ bom?.panelMaterial.name }}（元）</th><th class="num">{{ inspected.name }}（元）</th><th class="num">差额（元）</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(d, i) in diffLines" :key="i">
                      <td>{{ d.group }}</td>
                      <td>{{ d.spec }}</td>
                      <td class="num">{{ d.baseCents ? yuan(d.baseCents) : '—' }}</td>
                      <td class="num">{{ d.otherCents ? yuan(d.otherCents) : '—' }}</td>
                      <td class="num" :style="{ color: d.deltaCents > 0 ? 'var(--danger)' : 'var(--ok)' }">{{ signDelta(d.deltaCents) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="muted" v-else>两者金额相同（分项也一致）。</p>
                <p class="muted" style="margin-top: 6px">
                  差价来源：面板口径（{{ inspected.bom.sheet ? '按板' : '按面积' }}）、LED/电源（{{ inspected.useLed ? '计' : '不计' }}）、配件与加工条目各自独立计量。
                </p>
              </template>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
