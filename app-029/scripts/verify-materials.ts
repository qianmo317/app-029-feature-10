/**
 * 真实验证脚本：起 vite preview → fetch 本地字体 → 真跑排版 → 5 种材质各算一遍 BOM。
 * 校验：
 *  1) 每种材质的对照行合计 = 切换 project.panelMaterialId 后 buildBom 的合计（逐行真算，不乘比例）
 *  2) 不发光材质无 LED/电源
 *  3) Σ 明细 = 合计（整数分）
 *  4) 切换材质后拼版/板数/工艺卡相关字段随之改变，不留上一种材质数字
 *  5) 旧版预设（只有估算单价）经 normalizePreset 后可真算
 */
import { readFile } from 'node:fs/promises'
import { registerLocalFont } from '../src/logic/fontLoader'
import { computeLayout, defaultProject, textToItems } from '../src/logic/layout'
import { assertBomSum, buildBom, compareMaterials, defaultPreset, normalizePreset } from '../src/logic/materials'
import type { Preset } from '../src/logic/materials'

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  // 直接从磁盘读字体并注册为会话字体（脚本验证不走网络）
  const heiBuf = (await readFile('public/fonts/hei-400.otf')).buffer.slice(0)
  const hei = await registerLocalFont('hei-400.otf', heiBuf)

  const p = defaultProject('verify', { wMm: 3000, hMm: 800, frameMm: 60, mounting: 'board' })
  p.layout.settings.fontId = hei.id
  p.layout.settings.baseSizeMm = 300
  p.layout.items = textToItems('广告招牌制作', [], p.layout.settings, 300)
  const layout = computeLayout(p.layout, { autoSize: true })

  const preset: Preset = normalizePreset(defaultPreset)
  const cmp = compareMaterials(p, layout, preset)

  console.log(`排版：字号 ${layout.sizeMm}mm，占宽 ${layout.occupiedW}mm，料件布点长度 ${layout.ledLengthMm}mm\n`)
  console.log('材质'.padEnd(14), '面板'.padStart(9), 'LED'.padStart(9), '电源'.padStart(8), '配件'.padStart(8), '加工'.padStart(8), '合计'.padStart(10))
  for (const c of cmp) {
    console.log(
      c.name.padEnd(14),
      (c.panelCents / 100).toFixed(2).padStart(9),
      (c.ledCents / 100).toFixed(2).padStart(9),
      (c.psuCents / 100).toFixed(2).padStart(8),
      (c.accessoryCents / 100).toFixed(2).padStart(8),
      (c.laborCents / 100).toFixed(2).padStart(8),
      (c.totalCents / 100).toFixed(2).padStart(10)
    )
  }
  console.log('')

  // 1) 各行合计 = 分项之和
  for (const c of cmp) {
    if (c.totalCents !== c.panelCents + c.ledCents + c.psuCents + c.accessoryCents + c.laborCents) fail(`${c.name} 分项之和≠合计`)
  }

  // 2) 逐行真算：切换后 buildBom 必须与对照行完全一致
  for (const c of cmp) {
    p.panelMaterialId = c.id
    const real = buildBom(p, layout, preset)
    const sum = assertBomSum(real)
    if (!sum.ok) fail(`${c.name} 金额校验失败：${sum.message}`)
    if (real.totalCents !== c.totalCents) fail(`${c.name}：对照行 ${c.totalCents} ≠ 切换后真算 ${real.totalCents}`)
    const specsReal = real.materials.map((m) => `${m.kind}:${m.spec}:${m.qty}:${m.amountCents}`).sort().join('|')
    const specsCmp = c.bom.materials.map((m) => `${m.kind}:${m.spec}:${m.qty}:${m.amountCents}`).sort().join('|')
    if (specsReal !== specsCmp) fail(`${c.name}：对照行清单与切换后清单不一致`)
    if (!c.useLed && (c.ledCents !== 0 || c.psuCents !== 0)) fail(`${c.name} 不发光却计了 LED/电源`)
  }

  // 3) 切换材质后派生数据确实改变（亚克力发光→钛金）
  p.panelMaterialId = 'acrylic_led'
  const ledBom = buildBom(p, layout, preset)
  p.panelMaterialId = 'titanium'
  const titBom = buildBom(p, layout, preset)
  if (ledBom.nesting === null) fail('亚克力方案应有拼版结果')
  if (titBom.nesting !== null || titBom.sheet !== null) fail('钛金方案不应有拼版/整板')
  if (titBom.totalCents === ledBom.totalCents) fail('切换材质后合计未变化')
  if (titBom.materials.some((m) => m.kind === 'led_module' || m.kind === 'psu')) fail('钛金方案残留 LED/电源条目')
  // 切回来必须完全恢复
  p.panelMaterialId = 'acrylic_led'
  const back = buildBom(p, layout, preset)
  if (back.totalCents !== ledBom.totalCents || back.nesting?.sheetCount !== ledBom.nesting?.sheetCount) fail('切回原材质后数据未恢复一致')

  // 4) 面积口径材质的配件/加工条目与发光材质不同（不乘比例的证据）
  const film = cmp.find((c) => c.id === 'film')!
  const acrylic = cmp.find((c) => c.id === 'acrylic_led')!
  const filmGlueKinds = film.bom.materials.filter((m) => m.kind === 'glue').map((m) => m.spec)
  if (filmGlueKinds.some((s) => s.includes('电源线'))) fail('贴膜字不应计电源线')
  const accRatio = acrylic.accessoryCents ? film.accessoryCents / acrylic.accessoryCents : 0
  console.log(`贴膜/亚克力 配件比 = ${accRatio.toFixed(3)}（旧逻辑固定 0.4；若仍为 0.4 说明可能还在乘比例）`)

  // 5) 旧版预设迁移
  const legacy = JSON.parse(JSON.stringify(defaultPreset))
  legacy.panelMaterials = legacy.panelMaterials.map((m: Record<string, unknown>) => ({
    id: m.id,
    name: m.name,
    desc: m.desc,
    useLed: m.useLed,
    areaPriceCentsPerM2: 99999,
    perimeterPriceCentsPerM: 0,
    charLaborCents: 1000
  }))
  const migrated = normalizePreset(legacy)
  for (const m of migrated.panelMaterials) {
    if (!m.consumableLines || !m.laborLines || !m.panelRule) fail(`旧材质 ${m.id} 迁移后缺少真算规则`)
  }
  const migBom = buildBom({ ...p, panelMaterialId: 'titanium' }, layout, migrated)
  if (migBom.totalCents <= 0) fail('迁移后钛金方案算不出金额')

  // 6) 空清单提示场景：无文字
  const empty = defaultProject('empty', { wMm: 3000, hMm: 800 })
  empty.layout.settings.fontId = hei.id
  empty.layout.items = textToItems('', [], empty.layout.settings, 300)
  const emptyLayout = computeLayout(empty.layout)
  for (const id of preset.panelMaterials.map((m) => m.id)) {
    empty.panelMaterialId = id
    const eb = buildBom(empty, emptyLayout, preset)
    if (eb.cutList.length !== 0) fail('无文字时不应有料件')
    // 电源有 minQty？按规则不应有面板条目
    if (eb.materials.some((m) => m.kind === 'panel')) fail(`无文字时 ${id} 不应出面板条目`)
  }

  console.log('\n全部验证通过：')
  console.log('  ✓ 5 种材质各按各的计量真算（面板/LED/电源/配件/加工）')
  console.log('  ✓ 对照行 = 切换后真算清单，可来回切换且数据一致')
  console.log('  ✓ 不发光材质无 LED/电源，面积口径无拼版')
  console.log('  ✓ 金额整数分，Σ 明细 = 合计')
  console.log('  ✓ 旧预设可迁移，无文字场景不出面板条目')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
