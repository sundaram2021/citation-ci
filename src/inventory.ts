import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { Citation } from './check.ts';

function sourceLabel(label: string, site: URL) {
  let url: URL;
  let prefix: string;
  if (URL.canParse(label)) {
    url = new URL(label);
    prefix = url.protocol + (url.host ? '//' + url.host : '');
  } else if (label.startsWith('//') && URL.canParse('https:' + label)) {
    url = new URL('https:' + label);
    prefix = '//' + url.host;
  } else if (label.startsWith('/') && !label.startsWith('//') && URL.canParse(label, site)) {
    url = new URL(label, site);
    prefix = '';
  } else return label;

  if (url.username || url.password) throw new Error('Invalid credentialed source URL');
  return url.search ? prefix + url.pathname + '?[redacted]' + url.hash : label;
}

export async function inventory(site: URL, file: string): Promise<Citation[]> {
  const entries = new Map<string, Citation>();
  function add(raw: string, engine = '', count = 1) {
    let url: URL;
    if (raw.startsWith('//') || raw.includes('\\')) throw new Error('Invalid citation URL in inventory');
    try { url = raw.startsWith('/') ? new URL(raw, site) : new URL(raw); }
    catch { throw new Error('Invalid citation URL in inventory'); }
    if (url.origin !== site.origin || url.username || url.password) {
      throw new Error('File contains a URL outside the production origin or with credentials');
    }
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid citation count');
    const entry = entries.get(url.href) ?? { url, count: 0, engines: new Set<string>() };
    if (!Number.isSafeInteger(entry.count + count)) throw new Error('Invalid citation count');
    entry.count += count;
    if (engine) entry.engines.add(engine);
    entries.set(url.href, entry);
  }
  const data = await readFile(file, 'utf8');
  if (file.toLowerCase().endsWith('.csv')) {
    let rows: string[][];
    try { rows = parse(data, {bom: true, skip_empty_lines: true, trim: true}); }
    catch { throw new Error('Invalid citation CSV'); }
    const headers = (rows.shift() ?? []).map(header => header.trim().toLowerCase());
    function column(...aliases: string[]) {
      for (const name of aliases) {
        const index = headers.indexOf(name);
        if (index >= 0) return index;
      }
      return -1;
    }
    const url = column('url', 'page', 'top pages', 'landing page', 'path');
    if (url < 0) throw new Error('No recognized URL column in citation CSV');
    const count = column('count', 'clicks', 'visits', 'views', 'pageviews', 'impressions');
    const source = column('engine', 'source', 'referrer');
    for (const row of rows) {
      const value = row[count]?.trim() || '1';
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) throw new Error('Invalid citation count');
      add(row[url].trim(), sourceLabel(row[source]?.trim() ?? '', site), Number(value.replaceAll(',', '')));
    }
  } else {
    for (const line of data.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.startsWith('#')) add(value);
    }
  }
  if (!entries.size) throw new Error('No citations matched the production origin');
  return [...entries.values()].sort((a, b) => b.count - a.count || a.url.href.localeCompare(b.url.href));
}
