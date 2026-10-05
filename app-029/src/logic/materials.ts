/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），再做分层拼版；
 * - 每一种面板材质都按它自己的计量口径真算：要不要灯/电源、包边条算不算、
 *   面板按板还是按面积、配件与加工各取哪些项——不再对其它材质乘固定比例；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, MaterialKind, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { nestPieces, type CutItem, type NestingResult, type Piece } from './nesting'
import { computeLed, type PsuPreset } from './led'

export interface SheetSpec {
  id: string
  spec: string
  wMm: number
  hMm: number
  thicknessMm: number
  priceCents: number
  kerfMm: number
}

export interface LedModuleSpec {
  id: string
  spec: string
  spacingMm: number
  powerW: number
  lumen: number
  priceCents: number
  voltageV: number
}

export interface RuleSpec {
  type: 'perPieceAreaM2' | 'perChar' | 'perMeterPerimeter' | 'perPsu' | 'perModule' | 'perStrokeBlock' | 'perOutlinePerimeter'
  value: number
  minQty: number
}

export interface ConsumableSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

export interface LaborSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

/** 面板计价口径：sheet=按整板计（先拼版）；area=按实际料件面积（元/㎡）计 */
export type PanelBasis = 'sheet' | 'area'

export interface PanelMaterialSpec {
  id: string
  name: string
  desc: string
  /** 是否计 LED 模组 */
  useLed: boolean
  /** 是否计电源（useLed=false 时此项无意义） */
  usePsu: boolean
  /** 是否计不锈钢包边条（按全部字外轮廓周长） */
  useTrim: boolean
  /** 面板计价口径 */
  panelBasis: PanelBasis
  /** 按板计价时所用板材（acrylicSheets 中的 id）；按面积计价为 null */
  sheetId: string | null
  /** 按面积计价时的单价（分/㎡）；按板计价时仅用于对照参考 */
  areaPriceCentsPerM2: number
  /** 外轮廓周长加工单价（分/米，0=不计） */
  perimeterPriceCentsPerM: number
  /** 按字加工单价（分/字，0=不计；归入加工费） */
  charLaborCents: number
  /** 该材质采用的配件（preset.consumables 的 id 列表），各材质各取各的 */
  consumableRefs: string[]
  /** 该材质采用的加工项（preset.labor 的 id 列表），各材质各取各的 */
  laborRefs: string[]
}

export interface Preset {
  version: string
  process: {
    strokeLimitMm: number
    defaultTrackRatio: number
    defaultMarginRatio: number
    defaultLineGapRatio: number
    panelFrameMm: number
    minTrackMm: number
    maxTrackMm: number
    warnTrackRatioLow: number
    warnTrackRatioHigh: number
  }
  acrylicSheets: SheetSpec[]
  ledModules: LedModuleSpec[]
  psu: PsuPreset
  consumables: ConsumableSpec[]
  labor: LaborSpec[]
  panelMaterials: PanelMaterialSpec[]
}

export const defaultPreset = materialsData as unknown as Preset

/**
 * 把出厂默认库按 id 合并进已保存的自定义目录（保留用户改的单价，补全新增条目）。
 * 用于旧版本本地预设迁移：新版的板材/加工/配件/材质字段不会因为旧存档而缺失。
 */
export function mergeCatalog<T extends { id: string }>(base: T[], saved: T[] | undefined): T[] {
  if (!saved || saved.length === 0) return base.map((x) => ({ ...x }))
  const savedById = new Map(saved.map((x) => [x.id, x]))
  const merged = base.map((b) => {
    const s = savedById.get(b.id)
    return s ? { ...b, ...s } : { ...b }
  })
  const baseIds = new Set(base.map((x) => x.id))
  for (const s of saved) if (!baseIds.has(s.id)) merged.push({ ...s })
  return merged
}

/** 按出厂默认补全单个材质的新增字段（旧存档没有 usePsu/useTrim/panelBasis/refs 等） */
export function normalizePanelMaterial(pm: Partial<PanelMaterialSpec> | undefined, fallback: PanelMaterialSpec): PanelMaterialSpec {
  if (!pm) return { ...fallback, consumableRefs: [...fallback.consumableRefs], laborRefs: [...fallback.laborRefs] }
  return {
    id: pm.id ?? fallback.id,
    name: pm.name ?? fallback.name,
    desc: pm.desc ?? fallback.desc,
    useLed: pm.useLed ?? fallback.useLed,
    usePsu: pm.usePsu ?? fallback.usePsu,
    useTrim: pm.useTrim ?? fallback.useTrim,
    panelBasis: pm.panelBasis ?? fallback.panelBasis,
    sheetId: pm.sheetId === undefined ? fallback.sheetId : pm.sheetId,
    areaPriceCentsPerM2: pm.areaPriceCentsPerM2 ?? fallback.areaPriceCentsPerM2,
    perimeterPriceCentsPerM: pm.perimeterPriceCentsPerM ?? fallback.perimeterPriceCentsPerM,
    charLaborCents: pm.charLaborCents ?? fallback.charLaborCents,
    consumableRefs: pm.consumableRefs ? [...pm.consumableRefs] : [...fallback.consumableRefs],
    laborRefs: pm.laborRefs ? [...pm.laborRefs] : [...fallback.laborRefs]
  }
}

/** 金额四项分组（灯与电源合并为一项） */
export interface BomBuckets {
  panelCents: number
  lightCents: number
  accessoryCents: number
  laborCents: number
}

export interface BomResult {
  materials: Material[]
  totalCents: number
  buckets: BomBuckets
  led: LedResult
  /** 按板计价时的拼版结果；按面积计价（如贴膜）为 null */
  nesting: NestingResult | null
  /** 按板计价时所用板材；按面积计价为 null */
  sheet: SheetSpec | null
  module: LedModuleSpec | null
  cutList: CutItem[]
  pieceAreaM2: number
  perimeterM: number
  outlinePerimeterM: number
  charCount: number
  /** 工艺拦截：未确认风险时不出报价 */
  blocked: boolean
  blockReasons: string[]
  panelMaterial: PanelMaterialSpec
  /** 清单为空（没有任何可计费条目，例如尚未输入文字） */
  empty: boolean
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
  /** 覆盖项目当前选中的材质 id（对照表逐材质真算时用，不改动项目数据） */
  materialId?: string
}

/** 计量上下文（全部来自同一排版结果，与材质无关；材质只决定取哪些口径） */
interface RuleCtx {
  areaM2: number
  chars: number
  perimeterM: number
  psu: number
  modules: number
  blocks: number
  outlinePerimeterM: number
}

function ruleQty(rule: RuleSpec, ctx: RuleCtx): number {
  let raw = 0
  switch (rule.type) {
    case 'perPieceAreaM2':
      raw = ctx.areaM2 * rule.value
      break
    case 'perChar':
      raw = ctx.chars * rule.value
      break
    case 'perMeterPerimeter':
      raw = ctx.perimeterM * rule.value
      break
    case 'perPsu':
      raw = ctx.psu * rule.value
      break
    case 'perModule':
      raw = ctx.modules * rule.value
      break
    case 'perStrokeBlock':
      raw = ctx.blocks * rule.value
      break
    case 'perOutlinePerimeter':
      raw = ctx.outlinePerimeterM * rule.value
      break
    default:
      raw = 0
  }
  // minQty 由 roundQty 在「确有用量」时套用，零用量不凭空起订
  return raw
}

/**
 * 数量取整：整件单位向上取整，连续计量单位保留两位小数。
 * 没有任何实际用量（raw≈0，例如尚未输入文字）时直接给 0——
 * 此时 minQty 不能凭空变出一支胶/一台电源，避免出一张无依据的空清单；
 * 有用量时再应用 minQty 起订量。
 */
function roundQty(raw: number, unit: string, minQty = 0): number {
  if (raw <= 1e-9) return 0
  const withMin = Math.max(minQty, raw)
  const whole = ['支', '套', '个', '台', '只', '字', '张']
  return whole.includes(unit) ? Math.ceil(withMin - 1e-9) : Math.round(withMin * 100) / 100
}

/** 拆料件：每个连通域（笔画块）一件，按外接矩形计 */
export function acrylicPieces(chars: PlacedChar[]): Piece[] {
  const out: Piece[] = []
  let seq = 0
  for (const c of chars) {
    if (c.missing || c.blank || c.geom.blockBBoxes.length === 0) continue
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    c.geom.blockBBoxes.forEach((b, bi) => {
      const wMm = Math.max(1, Math.ceil((b.x1 - b.x0) * k))
      const hMm = Math.max(1, Math.ceil((b.y1 - b.y0) * k))
      out.push({ id: `p${seq++}`, label: `${c.char}-${bi + 1}`, wMm, hMm })
    })
  }
  return out
}

/** 解析某材质所用板材（材质声明缺失时回退到项目选择、再回退到第一张板） */
function resolveSheet(pm: PanelMaterialSpec, project: Project, preset: Preset): SheetSpec | null {
  if (pm.panelBasis === 'area' || !pm.sheetId) return null
  return (
    preset.acrylicSheets.find((s) => s.id === pm.sheetId) ??
    preset.acrylicSheets.find((s) => s.id === project.sheetId) ??
    preset.acrylicSheets[0] ??
    null
  )
}

export function buildBom(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): BomResult {
  const panelMaterial =
    preset.panelMaterials.find((m) => m.id === (opts.materialId ?? project.panelMaterialId)) ??
    preset.panelMaterials.find((m) => m.id === project.panelMaterialId) ??
    preset.panelMaterials[0]
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const sheet = resolveSheet(panelMaterial, project, preset)
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  const pieces = acrylicPieces(layout.chars)
  // 按板计价才真拼版（决定用板张数与超板拦截）；按面积计价不拼版
  const nesting = sheet ? nestPieces(pieces, sheet.wMm, sheet.hMm, sheet.kerfMm, true) : null
  const pieceAreaM2 = (nesting?.totalPieceAreaMm2 ?? pieces.reduce((s, p) => s + p.wMm * p.hMm, 0)) / 1e6

  const scaleOf = (c: PlacedChar): number => (c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0)
  const perimeterM = layout.chars.reduce((s, c) => s + c.geom.outerPerimeter * scaleOf(c), 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length

  const ctx: RuleCtx = {
    areaM2: pieceAreaM2,
    chars: charCount,
    perimeterM,
    // 无模组则无电源（与上面灯与电源条目口径一致，避免空排版仍算一台电源的安装费）
    psu: panelMaterial.useLed && panelMaterial.usePsu && led.modules > 0 ? led.psuCount : 0,
    modules: panelMaterial.useLed ? led.modules : 0,
    blocks: layout.chars.reduce((s, c) => s + (c.missing || c.blank ? 0 : c.geom.strokeBlocks), 0),
    // 包边条（perOutlinePerimeter 规则）按该材质选择对全部字外轮廓计长
    outlinePerimeterM: panelMaterial.useTrim ? perimeterM : 0
  }

  const materials: Material[] = []

  // 1) 面板材料：按材质自己的口径（整板张数 或 实际料件面积）
  //    没有任何字（未输入文字/字体未就绪）时不出「0 张板」这种空条目
  if (sheet && panelMaterial.panelBasis === 'sheet') {
    if (nesting!.sheetCount > 0) {
      materials.push({
        kind: 'acrylic',
        spec: sheet.spec,
        qty: nesting!.sheetCount,
        unit: '张',
        unitPriceCents: sheet.priceCents,
        amountCents: nesting!.sheetCount * sheet.priceCents
      })
    }
  } else {
    const areaQty = Math.round(pieceAreaM2 * 100) / 100
    if (areaQty > 0) {
      materials.push({
        kind: 'acrylic',
        spec: `${panelMaterial.name}面板料（按实际料件面积计）`,
        qty: areaQty,
        unit: '㎡',
        unitPriceCents: panelMaterial.areaPriceCentsPerM2,
        amountCents: Math.round(areaQty * panelMaterial.areaPriceCentsPerM2)
      })
    }
  }
  // 面板周长加工价（材质声明了才计，归入面板项）
  if (panelMaterial.perimeterPriceCentsPerM > 0 && perimeterM > 0) {
    const qty = Math.round(perimeterM * 100) / 100
    materials.push({
      kind: 'acrylic',
      spec: `${panelMaterial.name}围边/轮廓加工（按外轮廓周长）`,
      qty,
      unit: '米',
      unitPriceCents: panelMaterial.perimeterPriceCentsPerM,
      amountCents: Math.round(qty * panelMaterial.perimeterPriceCentsPerM)
    })
  }

  // 2) 灯与电源：各材质自己决定要不要。没有模组（无布点长度/未输入文字）就不配电，
  //    computeLed 在 L=0 时仍会返回一个标准档位，但 BOM 不应凭空配一台电源
  if (panelMaterial.useLed && led.modules > 0) {
    materials.push({
      kind: 'led_module',
      spec: module.spec,
      qty: led.modules,
      unit: '只',
      unitPriceCents: module.priceCents,
      amountCents: led.modules * module.priceCents
    })
    if (panelMaterial.usePsu && led.psuCount > 0) {
      const psuUnitPrice = Math.round(preset.psu.pricePerWattCents * led.psuUnitW)
      materials.push({
        kind: 'psu',
        spec: `${preset.psu.spec} ${led.psuUnitW}W`,
        qty: led.psuCount,
        unit: '台',
        unitPriceCents: psuUnitPrice,
        amountCents: led.psuCount * psuUnitPrice
      })
    }
  }

  // 3) 配件：取该材质声明的耗材；包边条由 useTrim 单独决定（不在 refs 里重复勾选）
  const trimSpec = preset.consumables.find((x) => x.id === 'trim')
  for (const id of panelMaterial.consumableRefs) {
    const c = preset.consumables.find((x) => x.id === id)
    if (!c) continue
    if (c.id === 'trim') continue
    const qty = roundQty(ruleQty(c.rule, ctx), c.unit, c.rule.minQty)
    if (qty <= 0) continue
    materials.push({
      kind: 'glue',
      spec: c.spec,
      qty,
      unit: c.unit,
      unitPriceCents: c.unitPriceCents,
      amountCents: Math.round(qty * c.unitPriceCents)
    })
  }
  if (panelMaterial.useTrim && trimSpec) {
    const qty = roundQty(ruleQty(trimSpec.rule, ctx), trimSpec.unit, trimSpec.rule.minQty)
    if (qty > 0) {
      materials.push({
        kind: 'glue',
        spec: trimSpec.spec,
        qty,
        unit: trimSpec.unit,
        unitPriceCents: trimSpec.unitPriceCents,
        amountCents: Math.round(qty * trimSpec.unitPriceCents)
      })
    }
  }

  // 4) 加工费：只取该材质声明的加工项（各材质各按各的计量，不乘比例）
  for (const id of panelMaterial.laborRefs) {
    const l = preset.labor.find((x) => x.id === id)
    if (!l) continue
    const qty = roundQty(ruleQty(l.rule, ctx), l.unit, l.rule.minQty)
    if (qty <= 0) continue
    materials.push({
      kind: 'labor',
      spec: l.spec,
      qty,
      unit: l.unit,
      unitPriceCents: l.unitPriceCents,
      amountCents: Math.round(qty * l.unitPriceCents)
    })
  }
  // 材质自带的按字加工单价
  if (panelMaterial.charLaborCents > 0 && charCount > 0) {
    materials.push({
      kind: 'labor',
      spec: `${panelMaterial.name}装配/制作（按字）`,
      qty: charCount,
      unit: '字',
      unitPriceCents: panelMaterial.charLaborCents,
      amountCents: charCount * panelMaterial.charLaborCents
    })
  }

  const totalCents = materials.reduce((s, m) => s + m.amountCents, 0)
  const buckets: BomBuckets = {
    panelCents: sumKind(materials, 'acrylic'),
    lightCents: sumKind(materials, 'led_module') + sumKind(materials, 'psu'),
    accessoryCents: sumKind(materials, 'glue'),
    laborCents: sumKind(materials, 'labor')
  }

  const thin = layout.glyphs.filter((g) => !g.missing && g.minStrokeMm > 0 && g.minStrokeMm < project.layout.settings.strokeLimitMm)
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...(nesting?.oversize ?? []).map(
      (p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${sheet!.wMm}×${sheet!.hMm}mm`
    )
  ]
  const blocked = (blockReasons.length > 0 && !opts.acknowledgeThinStroke) || (nesting?.oversize.length ?? 0) > 0

  return {
    materials,
    totalCents,
    buckets,
    led,
    nesting,
    sheet,
    module: panelMaterial.useLed ? module : null,
    cutList: nesting?.cutList ?? pieces.map((p) => ({ label: p.label, wMm: p.wMm, hMm: p.hMm, count: 1 })),
    pieceAreaM2,
    perimeterM,
    /** 包边条计长（useTrim 时=全部字外轮廓周长，否则 0） */
    outlinePerimeterM: ctx.outlinePerimeterM,
    charCount,
    blocked,
    blockReasons,
    panelMaterial,
    empty: materials.length === 0
  }
}

function sumKind(materials: Material[], kind: MaterialKind): number {
  return materials.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
}

/** 断言：Σ 材料金额 = 合计，且金额均为整数分 */
export function assertBomSum(bom: BomResult): { ok: boolean; message: string } {
  const sum = bom.materials.reduce((s, m) => s + m.amountCents, 0)
  const allInt = bom.materials.every((m) => Number.isInteger(m.amountCents))
  return {
    ok: sum === bom.totalCents && allInt,
    message: `Σ 明细 = ${sum} 分，合计 = ${bom.totalCents} 分；整数分校验：${allInt ? '通过' : '失败'}`
  }
}

/** 多材质成本对照（规格书第 5 节）：每一行都按该材质自己的计量真算一遍完整 BOM */
export interface CompareRow {
  id: string
  name: string
  desc: string
  panelCents: number
  ledCents: number
  psuCents: number
  accessoryCents: number
  laborCents: number
  totalCents: number
  /** 该材质自己的完整材料清单（面板/灯与电源/配件/加工） */
  bom: BomResult
}

export function compareMaterials(project: Project, layout: LayoutResult, preset: Preset, _bom?: BomResult): CompareRow[] {
  return preset.panelMaterials.map((pm) => {
    const bom = buildBom(project, layout, preset, { materialId: pm.id })
    return {
      id: pm.id,
      name: pm.name,
      desc: pm.desc,
      panelCents: bom.buckets.panelCents,
      ledCents: sumKind(bom.materials, 'led_module'),
      psuCents: sumKind(bom.materials, 'psu'),
      accessoryCents: bom.buckets.accessoryCents,
      laborCents: bom.buckets.laborCents,
      totalCents: bom.totalCents,
      bom
    }
  })
}

/** 两种材质清单逐行差额（同类同规格配对，配不上的视为新增/取消） */
export interface DiffLine {
  group: string
  spec: string
  fromText: string
  toText: string
  deltaCents: number
  status: 'same' | 'changed' | 'added' | 'removed'
}

export interface MaterialDiff {
  lines: DiffLine[]
  /** 四项分组差额（目标 − 基准） */
  buckets: { panel: number; light: number; accessory: number; labor: number }
  totalDelta: number
}

const KIND_LABEL: Record<MaterialKind, string> = {
  acrylic: '面板',
  led_module: '灯与电源',
  psu: '灯与电源',
  glue: '配件',
  labor: '加工'
}

export function diffMaterials(from: BomResult, to: BomResult): MaterialDiff {
  const keyOf = (m: Material): string => `${m.kind}|${m.spec}`
  const fromMap = new Map<string, Material>()
  for (const m of from.materials) fromMap.set(keyOf(m), m)
  const toMap = new Map<string, Material>()
  for (const m of to.materials) toMap.set(keyOf(m), m)

  const qtyText = (m: Material): string => `${m.qty}${m.unit} ×${yuan(m.unitPriceCents)}`
  const lines: DiffLine[] = []
  for (const [key, tm] of toMap) {
    const fm = fromMap.get(key)
    if (!fm) {
      lines.push({ group: KIND_LABEL[tm.kind], spec: tm.spec, fromText: '—', toText: qtyText(tm), deltaCents: tm.amountCents, status: 'added' })
    } else {
      const delta = tm.amountCents - fm.amountCents
      lines.push({
        group: KIND_LABEL[tm.kind],
        spec: tm.spec,
        fromText: qtyText(fm),
        toText: qtyText(tm),
        deltaCents: delta,
        status: delta === 0 ? 'same' : 'changed'
      })
    }
  }
  for (const [key, fm] of fromMap) {
    if (!toMap.has(key)) {
      lines.push({ group: KIND_LABEL[fm.kind], spec: fm.spec, fromText: qtyText(fm), toText: '—', deltaCents: -fm.amountCents, status: 'removed' })
    }
  }
  lines.sort((a, b) => b.deltaCents - a.deltaCents || a.spec.localeCompare(b.spec))

  return {
    lines,
    buckets: {
      panel: to.buckets.panelCents - from.buckets.panelCents,
      light: to.buckets.lightCents - from.buckets.lightCents,
      accessory: to.buckets.accessoryCents - from.buckets.accessoryCents,
      labor: to.buckets.laborCents - from.buckets.laborCents
    },
    totalDelta: to.totalCents - from.totalCents
  }
}

/** 材质计量口径说明（界面/单据用） */
export function basisLabel(bom: BomResult): string {
  const pm = bom.panelMaterial
  const parts: string[] = []
  if (bom.sheet && pm.panelBasis === 'sheet') {
    parts.push(`面板按板计：${bom.sheet.spec}，用板 ${bom.nesting?.sheetCount ?? 0} 张`)
  } else {
    parts.push(`面板按面积计：${yuan(pm.areaPriceCentsPerM2)} 元/㎡，料件 ${bom.pieceAreaM2.toFixed(3)} ㎡`)
  }
  parts.push(pm.useLed ? `计 LED 模组${pm.usePsu ? '与电源' : '（不计电源）'}` : '不计 LED 与电源')
  parts.push(pm.useTrim ? '计不锈钢包边条' : '不计包边条')
  parts.push(`配件 ${pm.consumableRefs.length} 项、加工 ${pm.laborRefs.length} 项，均按各自计量真算`)
  return parts.join('；')
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 带正负号的金额（差额展示用） */
export function yuanSigned(cents: number): string {
  if (cents === 0) return '0.00'
  return `${cents > 0 ? '+' : '−'}${yuan(Math.abs(cents))}`
}
