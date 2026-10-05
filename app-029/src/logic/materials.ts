/**
 * 材料清单（BOM）与报价（规格书第 4.6 / 5 节）：
 * - 每种面板材质自带完整计量规则：面板按板拼版或按面积、要不要 LED/电源、
 *   各自的配件与加工条目，全部走同一套真实 BOM 引擎，不再按固定比例折算；
 * - 面板：异形字按「外接矩形」拆成料件（每个连通域一件），按板材质再做分层拼版；
 * - 金额一律整数「分」，Σ 明细金额 = 合计；
 * - 最细笔画低于工艺下限时「警告并可拦截」：未确认风险前不出报价单。
 */

import materialsData from '../data/materials.json'
import type { LedResult, Material, MaterialKind, Project } from './types'
import type { LayoutResult, PlacedChar } from './layout'
import { mergeCutList, nestPieces, type CutItem, type NestingResult, type Piece } from './nesting'
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

/**
 * 计量规则：
 * - perPieceAreaM2 按料件外接矩形面积（㎡）
 * - perChar 按字数
 * - perMeterPerimeter 按外轮廓周长（m，LED 布点长度同口径）
 * - perOutlinePerimeter 按描边/镂空字外轮廓周长（m）
 * - perPsu / perModule 按电源台数 / 模组只数
 * - perStrokeBlock 按连通域（笔画块）数
 * - perSheet 按拼版后板数
 */
export interface RuleSpec {
  type:
    | 'perPieceAreaM2'
    | 'perChar'
    | 'perMeterPerimeter'
    | 'perPsu'
    | 'perModule'
    | 'perStrokeBlock'
    | 'perOutlinePerimeter'
    | 'perSheet'
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

/** 材质自带的一条计费项（配件或加工） */
export interface ChargeLineSpec {
  id: string
  spec: string
  unit: string
  unitPriceCents: number
  rule: RuleSpec
}

/** 面板计量口径：sheet=按板（拼版计张数）；area=按料件外接矩形面积（㎡） */
export type PanelMode = 'sheet' | 'area'

export interface PanelMaterialSpec {
  id: string
  name: string
  desc: string
  /** 是否内藏 LED（同时决定计不计模组与电源、布不布点） */
  useLed: boolean
  panelMode: PanelMode
  /** sheet 口径下默认使用的板材 id（项目里可另选同规格库板材） */
  sheetId?: string
  panelSpec: string
  panelUnit: string
  panelRule: RuleSpec
  panelPriceCents: number
  /** 该材质自己的配件清单（各按各的规则，不再引用全局比例） */
  consumableLines: ChargeLineSpec[]
  /** 该材质自己的加工费清单（各按各的规则，不再引用全局比例） */
  laborLines: ChargeLineSpec[]
  /** 旧版估算字段：仅预设页参考/旧数据迁移用，真实出单不使用 */
  areaPriceCentsPerM2?: number
  perimeterPriceCentsPerM?: number
  charLaborCents?: number
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
  /** 通用配件工艺库：供预设页编辑/新增材质条目时取参考，真实出单以各材质自带清单为准 */
  consumables: ConsumableSpec[]
  /** 通用加工工艺库：同上 */
  labor: LaborSpec[]
  panelMaterials: PanelMaterialSpec[]
}

export const defaultPreset = materialsData as unknown as Preset

export interface BomResult {
  materials: Material[]
  totalCents: number
  led: LedResult
  /** sheet 口径下的拼版结果；area 口径为 null */
  nesting: NestingResult | null
  /** sheet 口径下实际选用的板材；area 口径为 null */
  sheet: SheetSpec | null
  module: LedModuleSpec
  cutList: CutItem[]
  pieceAreaM2: number
  outlinePerimeterM: number
  /** 工艺拦截：未确认风险时不出报价 */
  blocked: boolean
  blockReasons: string[]
  panelMaterial: PanelMaterialSpec
}

export interface BomOptions {
  /** 已确认「最细笔画低于工艺下限」的风险 */
  acknowledgeThinStroke?: boolean
  /** 覆盖项目当前面板材质（多材质对照逐行真算时使用） */
  materialId?: string
}

interface RuleCtx {
  areaM2: number
  chars: number
  perimeterM: number
  psu: number
  modules: number
  blocks: number
  outlinePerimeterM: number
  sheets: number
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
    case 'perSheet':
      raw = ctx.sheets * rule.value
      break
    default:
      raw = 0
  }
  return Math.max(rule.minQty, raw)
}

/** 整数计量单位向上取整；面积/长度类保留两位小数 */
function roundQty(raw: number, unit: string): number {
  const whole = ['支', '套', '个', '台', '张', '字', '根', '瓶'].includes(unit)
  return whole ? Math.ceil(raw - 1e-9) : Math.round(raw * 100) / 100
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

function pushChargeLine(out: Material[], kind: MaterialKind, line: ChargeLineSpec, qty: number): void {
  if (qty <= 0) return
  out.push({
    kind,
    spec: line.spec,
    qty,
    unit: line.unit,
    unitPriceCents: line.unitPriceCents,
    amountCents: Math.round(qty * line.unitPriceCents)
  })
}

export function buildBom(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): BomResult {
  const materialId = opts.materialId ?? project.panelMaterialId
  const module = preset.ledModules.find((m) => m.id === project.ledModuleId) ?? preset.ledModules[0]
  const panelMaterial = preset.panelMaterials.find((m) => m.id === materialId) ?? preset.panelMaterials[0]
  const led = computeLed(layout.ledLengthMm, project.led, preset.psu)

  const pieces = acrylicPieces(layout.chars)
  const pieceAreaM2 = pieces.reduce((s, p) => s + p.wMm * p.hMm, 0) / 1e6
  const cutList = mergeCutList(pieces)

  // sheet 口径：按项目所选板材拼版；area 口径不拼版
  let sheet: SheetSpec | null = null
  let nesting: NestingResult | null = null
  if (panelMaterial.panelMode === 'sheet') {
    sheet =
      preset.acrylicSheets.find((s) => s.id === project.sheetId) ??
      preset.acrylicSheets.find((s) => s.id === panelMaterial.sheetId) ??
      preset.acrylicSheets[0]
    nesting = nestPieces(pieces, sheet.wMm, sheet.hMm, sheet.kerfMm, true)
  }

  const perimeterM =
    layout.chars.reduce((s, c) => {
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const outlinePerimeterM =
    layout.chars.reduce((s, c) => {
      if (c.item.mode !== 'outline') return s
      const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
      return s + c.geom.outerPerimeter * k
    }, 0) / 1000
  const charCount = layout.chars.filter((c) => !c.missing && !c.blank).length

  const ctx: RuleCtx = {
    areaM2: pieceAreaM2,
    chars: charCount,
    perimeterM,
    psu: led.psuCount,
    modules: led.modules,
    blocks: layout.chars.reduce((s, c) => s + (c.missing || c.blank ? 0 : c.geom.strokeBlocks), 0),
    outlinePerimeterM,
    sheets: nesting?.sheetCount ?? 0
  }

  const materials: Material[] = []

  // 1) 面板（按该材质自己的口径：按板拼版 或 按面积）
  if (panelMaterial.panelMode === 'sheet' && sheet && nesting) {
    if (nesting.sheetCount > 0) {
      materials.push({
        kind: 'panel',
        spec: sheet.spec,
        qty: nesting.sheetCount,
        unit: '张',
        unitPriceCents: sheet.priceCents,
        amountCents: nesting.sheetCount * sheet.priceCents
      })
    }
  } else {
    const qty = roundQty(ruleQty(panelMaterial.panelRule, ctx), panelMaterial.panelUnit)
    if (qty > 0) {
      materials.push({
        kind: 'panel',
        spec: panelMaterial.panelSpec,
        qty,
        unit: panelMaterial.panelUnit,
        unitPriceCents: panelMaterial.panelPriceCents,
        amountCents: Math.round(qty * panelMaterial.panelPriceCents)
      })
    }
  }

  // 2) LED 模组 + 3) 电源（该材质要灯才计）
  if (panelMaterial.useLed) {
    if (led.modules > 0) {
      materials.push({
        kind: 'led_module',
        spec: module.spec,
        qty: led.modules,
        unit: '只',
        unitPriceCents: module.priceCents,
        amountCents: led.modules * module.priceCents
      })
    }
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

  // 4) 配件（该材质自带清单，各按各的计量）
  for (const line of panelMaterial.consumableLines) {
    pushChargeLine(materials, 'glue', line, roundQty(ruleQty(line.rule, ctx), line.unit))
  }
  // 5) 加工费（该材质自带清单，各按各的计量）
  for (const line of panelMaterial.laborLines) {
    pushChargeLine(materials, 'labor', line, roundQty(ruleQty(line.rule, ctx), line.unit))
  }

  const totalCents = materials.reduce((s, m) => s + m.amountCents, 0)
  const thin = layout.glyphs.filter((g) => !g.missing && g.minStrokeMm > 0 && g.minStrokeMm < project.layout.settings.strokeLimitMm)
  const blockReasons = [
    ...thin.map((g) => `「${g.char}」最细笔画 ${g.minStrokeMm}mm < 工艺下限 ${project.layout.settings.strokeLimitMm}mm`),
    ...(nesting && sheet
      ? nesting.oversize.map((p) => `料件「${p.label}」${p.wMm}×${p.hMm}mm 超过板材尺寸 ${sheet.wMm}×${sheet.hMm}mm`)
      : [])
  ]
  const blocked = (blockReasons.length > 0 && !opts.acknowledgeThinStroke) || (nesting?.oversize.length ?? 0) > 0

  // 没有任何有效字符时不出任何条目（含电源/起订量配件），界面给空清单提示，不残留上一单数字
  const empty = charCount === 0

  return {
    materials: empty ? [] : materials,
    totalCents: empty ? 0 : totalCents,
    led,
    nesting,
    sheet,
    module,
    cutList,
    pieceAreaM2,
    outlinePerimeterM,
    blocked,
    blockReasons,
    panelMaterial
  }
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

export function sumByKind(bom: BomResult, kind: MaterialKind): number {
  return bom.materials.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
}

/** 多材质成本对照（规格书第 5 节）：每一行都按该材质自己的计量真跑一遍 BOM */
export interface CompareRow {
  id: string
  name: string
  desc: string
  useLed: boolean
  panelCents: number
  ledCents: number
  psuCents: number
  accessoryCents: number
  laborCents: number
  totalCents: number
  /** 按该材质算出的完整材料清单 */
  bom: BomResult
}

export function compareMaterials(project: Project, layout: LayoutResult, preset: Preset, opts: BomOptions = {}): CompareRow[] {
  return preset.panelMaterials.map((pm) => {
    const bom = buildBom(project, layout, preset, { ...opts, materialId: pm.id })
    return {
      id: pm.id,
      name: pm.name,
      desc: pm.desc,
      useLed: pm.useLed,
      panelCents: sumByKind(bom, 'panel'),
      ledCents: sumByKind(bom, 'led_module'),
      psuCents: sumByKind(bom, 'psu'),
      accessoryCents: sumByKind(bom, 'glue'),
      laborCents: sumByKind(bom, 'labor'),
      totalCents: bom.totalCents,
      bom
    }
  })
}

/** 两种材质清单的逐行差异（同名条目合并；只列金额有差异的条目） */
export interface DiffLine {
  kind: MaterialKind
  group: string
  spec: string
  baseCents: number
  otherCents: number
  deltaCents: number
}

export function diffBom(base: BomResult, other: BomResult): DiffLine[] {
  const keyOf = (m: Material): string => `${m.kind}|${m.spec}`
  const map = new Map<string, DiffLine>()
  const ensure = (m: Material): DiffLine => {
    const key = keyOf(m)
    const hit = map.get(key)
    if (hit) return hit
    const row: DiffLine = {
      kind: m.kind,
      group: bomGroupLabel(m.kind),
      spec: m.spec,
      baseCents: 0,
      otherCents: 0,
      deltaCents: 0
    }
    map.set(key, row)
    return row
  }
  for (const m of base.materials) ensure(m).baseCents += m.amountCents
  for (const m of other.materials) ensure(m).otherCents += m.amountCents
  return [...map.values()]
    .map((d) => ({ ...d, deltaCents: d.otherCents - d.baseCents }))
    .filter((d) => d.deltaCents !== 0)
    .sort((a, b) => b.deltaCents - a.deltaCents)
}

export function bomGroupLabel(kind: string): string {
  switch (kind) {
    case 'panel':
      return '面板材料'
    case 'led_module':
      return 'LED 模组'
    case 'psu':
      return '电源'
    case 'glue':
      return '胶与配件'
    default:
      return '加工费'
  }
}

/**
 * 规整预设：兼容旧版本地数据（panelMaterials 只有估算单价、没有自带清单）。
 * 旧材质按 id 用出厂默认补齐计量规则；新增的自定义材质给一套可用的默认规则。
 */
export function normalizePreset(input: Preset): Preset {
  const out: Preset = JSON.parse(JSON.stringify(input))
  const defaults = defaultPreset
  out.panelMaterials = (out.panelMaterials ?? []).map((pm) => {
    const ref = defaults.panelMaterials.find((d) => d.id === pm.id)
    if (ref && (pm.panelMode === undefined || !pm.consumableLines || !pm.laborLines)) {
      // 旧数据：保留可编辑的名称/发光/估算单价，计量规则取出厂默认
      return {
        ...JSON.parse(JSON.stringify(ref)),
        name: pm.name ?? ref.name,
        desc: pm.desc ?? ref.desc,
        useLed: pm.useLed ?? ref.useLed,
        areaPriceCentsPerM2: pm.areaPriceCentsPerM2 ?? ref.areaPriceCentsPerM2,
        perimeterPriceCentsPerM: pm.perimeterPriceCentsPerM ?? ref.perimeterPriceCentsPerM,
        charLaborCents: pm.charLaborCents ?? ref.charLaborCents,
        panelPriceCents: pm.areaPriceCentsPerM2 ?? ref.panelPriceCents
      }
    }
    if (!pm.panelMode) pm.panelMode = 'area'
    if (!pm.panelSpec) pm.panelSpec = pm.name
    if (!pm.panelUnit) pm.panelUnit = '㎡'
    if (!pm.panelRule) pm.panelRule = { type: 'perPieceAreaM2', value: 1, minQty: 0 }
    if (!Array.isArray(pm.consumableLines)) pm.consumableLines = []
    if (!Array.isArray(pm.laborLines)) pm.laborLines = []
    if (pm.panelPriceCents === undefined) pm.panelPriceCents = pm.areaPriceCentsPerM2 ?? 0
    return pm
  })
  return out
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}
