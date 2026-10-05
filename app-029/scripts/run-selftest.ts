/** 运行应用内全部验收自检（浏览器里跑的同一套断言），字体请求由本地文件响应，输出 PASS/FAIL */
import { readFile } from 'node:fs/promises'
import { runAcceptance } from '../src/logic/selftest'
import { normalizePreset, defaultPreset } from '../src/logic/materials'

// 拦截 fontLoader 对 fonts/*.otf 的 fetch，直接从磁盘返回
const origFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  const m = url.match(/fonts\/([\w.-]+)$/)
  if (m) {
    const buf = await readFile(`public/fonts/${m[1]}`)
    return new Response(buf, { status: 200, headers: { 'content-type': 'font/otf' } })
  }
  return origFetch(input as RequestInfo)
}) as typeof fetch

async function main(): Promise<void> {
  const report = await runAcceptance(normalizePreset(defaultPreset))
  for (const c of report.checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
    if (!c.pass) {
      console.log(`     ${c.detail}`)
      for (const e of c.evidence.slice(0, 8)) console.log(`     · ${e}`)
    }
  }
  console.log(`\n${report.allPass ? '全部通过' : '存在 FAIL'}（${report.elapsedMs.toFixed(0)}ms）`)
  if (!report.allPass) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
