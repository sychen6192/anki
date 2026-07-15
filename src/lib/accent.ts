const LOOKUP_CHUNK = 200

export function isValidAccent(s: string): boolean {
  return s === '' || /^\d+(,\d+)*$/.test(s)
}

export interface AccentQuery { expression: string; reading: string }

/** 呼叫 /api/accent/lookup;>200 筆自動分批。回傳與 items 同序,查無為 null。 */
export async function lookupAccents(
  items: AccentQuery[], fetchFn: typeof fetch = fetch,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(items.length).fill(null)
  for (let i = 0; i < items.length; i += LOOKUP_CHUNK) {
    const slice = items.slice(i, i + LOOKUP_CHUNK)
    const res = await fetchFn('/api/accent/lookup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: slice }),
    })
    if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
    const data = (await res.json()) as { results: (string | null)[] }
    data.results.forEach((r, k) => { out[i + k] = r })
  }
  return out
}

/** 對 accent 為空的列批次查詢並回填(回傳新物件,不 mutate 輸入)。 */
export async function fillMissingAccents<T extends { expression: string; reading: string; accent: string }>(
  rows: T[], fetchFn: typeof fetch = fetch,
): Promise<{ rows: T[]; filled: number; missed: number }> {
  const targets: number[] = []
  rows.forEach((r, i) => { if (r.accent === '') targets.push(i) })
  if (targets.length === 0) return { rows: rows.map((r) => ({ ...r })), filled: 0, missed: 0 }

  const results = await lookupAccents(
    targets.map((i) => ({ expression: rows[i].expression, reading: rows[i].reading })), fetchFn,
  )
  const out = rows.map((r) => ({ ...r }))
  let filled = 0, missed = 0
  targets.forEach((i, k) => {
    const pitch = results[k]
    if (pitch != null) { out[i].accent = pitch; filled++ } else missed++
  })
  return { rows: out, filled, missed }
}
