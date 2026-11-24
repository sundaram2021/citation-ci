import { parseArgs } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { inspectDocument, site, verdict } from './check.ts';
import { inventory } from './inventory.ts';

const usage = 'node src/cli.ts --production ORIGIN --preview ORIGIN --file citations.csv [--json]';

async function main() {
  const { values } = parseArgs({ options: {
    production: { type: 'string' }, preview: { type: 'string' }, file: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) { console.log(usage); return 0; }
  if (!values.production || !values.preview || !values.file) throw new Error(usage);
  const production = site(values.production);
  const preview = site(values.preview);
  if (production.origin === preview.origin) throw new Error('Choose distinct production and preview origins');
  const citations = await inventory(production, values.file);
  const rows: { path: string; count: number; engines: string[]; verdict: ReturnType<typeof verdict>;
    production: string; preview: string }[] = [];
  const documents = new Map<string, number[]>();
  for (const [index, citation] of citations.entries()) {
    const key = citation.url.href.split('#', 1)[0];
    const indexes = documents.get(key);
    if (indexes) indexes.push(index);
    else documents.set(key, [index]);
  }
  const pending = documents.values();
  async function worker() {
    for (const indexes of pending) {
      const urls = indexes.map(i => citations[i].url);
      const [live, next] = await Promise.all([inspectDocument(urls, production), inspectDocument(urls, preview)]);
      for (const [position, index] of indexes.entries()) {
        const {url, count, engines} = citations[index];
        const path = url.pathname + (url.search ? '?[redacted]' : '') + url.hash;
        rows[index] = {path, count, engines: [...engines].sort(), verdict: verdict(live[position], next[position]),
          production: live[position].detail, preview: next[position].detail};
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(4, documents.size)}, worker));
  const regressions = rows.filter(row => row.verdict === 'regression').length;
  const unknown = rows.filter(row => row.verdict === 'inconclusive').length;
  const summary = rows.length + ' checked, ' + regressions + ' new regressions, ' + unknown + ' inconclusive';
  const lines = rows.map(row => ('[' + row.verdict + ']' + '  ' + row.path + '  | live: ' + row.production +
    '  | preview: ' + row.preview + '  | citations: ' + row.count + ' ' + row.engines.join(', ')).trimEnd().replace(/[\u0000-\u001f\u007f]/g, ' '));
  const report = 'Citation CI: ' + summary + '\n' + lines.join('\n');
  console.log(values.json ? JSON.stringify({ summary, rows }, null, 2) : report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const important = lines.filter((_, i) => !['pass', 'fixed'].includes(rows[i].verdict));
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '## Citation CI\n\n' + summary + '\n\n<pre>' +
      escape(important.slice(0, 100).join('\n')).slice(0, 100000) + '</pre>\n');
  }
  return regressions ? 1 : unknown ? 2 : 0;
}
try { process.exitCode = await main(); }
catch (error) {
  console.error('Citation CI: ' + (error instanceof Error ? error.message : 'check failed'));
  process.exitCode = 2;
}
