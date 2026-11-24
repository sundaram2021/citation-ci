import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { Citation } from './check.ts';

export async function inventory(site: URL, file: string): Promise<Citation[]> {
  const entries = new Map<string, Citation>();
  function add(raw: string, engine = '', count = 1) {
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new Error('Invalid citation URL in inventory'); }
    if (url.origin !== site.origin || url.username || url.password) {
      throw new Error('File contains a URL outside the production origin or with credentials');
    }
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid citation count');
    const entry = entries.get(url.href) ?? { url, count: 0, engines: new Set<string>() };
    entry.count += count;
    if (engine) entry.engines.add(engine);
    entries.set(url.href, entry);
  }
  const data = await readFile(file, 'utf8');
  if (file.toLowerCase().endsWith('.csv')) {
    const rows = parse(data, { bom: true, columns: true, skip_empty_lines: true, trim: true });
    for (const row of rows) add(row.url, row.engine, Number(row.count || 1));
  } else {
    for (const line of data.split(/\r?\n/)) if (line.trim()) add(line.trim());
  }
  if (!entries.size) throw new Error('No citations matched the production origin');
  return [...entries.values()].sort((a, b) => b.count - a.count || a.url.href.localeCompare(b.url.href));
}
