import { parseArgs } from 'node:util';
import { appendFile, writeFile } from 'node:fs/promises';
import { inspectDocument, site, verdict } from './check.ts';
import { inventory } from './inventory.ts';
import { discover } from './discover.ts';
import { previewForCommit } from './vercel.ts';
import type { Source } from './check.ts';

const usage = 'node src/cli.ts --production ORIGIN (--preview ORIGIN | --vercel-project ID --commit SHA) (--file citations.csv | --source-repo OWNER/REPO [--source-path PATH]) [--parent-moves JSON] [--error-page-marker TEXT] [--json]';

function parentMoves(raw: string | undefined): Map<string, string> {
  if (raw === undefined) return new Map();
  const moves: unknown = JSON.parse(raw);
  if (!moves || typeof moves !== 'object' || Array.isArray(moves))
    throw new Error('--parent-moves expects a JSON object of source to destination paths');
  const result = new Map<string, string>();
  for (const [from, to] of Object.entries(moves)) {
    for (const path of [from, to]) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('#'))
        throw new Error('--parent-moves requires exact origin-relative paths without fragments');
      const url = new URL(path, 'https://docs.invalid');
      if (url.origin !== 'https://docs.invalid' || url.pathname + url.search !== path)
        throw new Error('--parent-moves requires canonical paths and queries');
    }
    result.set(from, to);
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    production: { type: 'string' }, preview: { type: 'string' }, file: { type: 'string' },
    'source-repo': {type:'string'}, 'source-path': {type:'string'}, 'vercel-project': {type:'string'}, commit: {type:'string'},
    'parent-moves': { type: 'string' }, 'error-page-marker': { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) { console.log(usage); return 0; }
  if (!values.production || !!values.file === !!values['source-repo'] || (!!values['source-path'] && !values['source-repo']) ||
      !!values.preview === !!values['vercel-project'] || !!values['vercel-project'] !== !!values.commit) throw new Error(usage);
  const policy = { parentMoves: parentMoves(values['parent-moves']), errorPageMarker: values['error-page-marker'] };
  const production = site(values.production);
  const preview = values.preview ? site(values.preview) : await previewForCommit(values['vercel-project']!, values.commit!, process.env.VERCEL_TOKEN, process.env.VERCEL_TEAM_ID);
  if (production.origin === preview.origin) throw new Error('Choose distinct production and preview origins');
  const citations = values.file ? await inventory(production, values.file) : await discover(production,values['source-repo']!,values['source-path']);
  const rows: { path: string; count: number; engines: string[]; sources?: Source[]; verdict: ReturnType<typeof verdict>;
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
      const [live, next] = await Promise.all([inspectDocument(urls, production, policy), inspectDocument(urls, preview, policy)]);
      for (const [position, index] of indexes.entries()) {
        const {url, count, engines} = citations[index];
        const path = url.pathname + (url.search ? '?[redacted]' : '') + url.hash;
        rows[index] = {path, count, engines: [...engines].sort(), sources: citations[index].sources, verdict: verdict(live[position], next[position]),
          production: live[position].detail, preview: next[position].detail};
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(4, documents.size)}, worker));
  const rank = {regression:0, inconclusive:1, 'pre-existing':2, fixed:3, pass:4};
  rows.sort((a,b)=>rank[a.verdict]-rank[b.verdict] || b.count-a.count);
  const regressions = rows.filter(row => row.verdict === 'regression').length;
  const unknown = rows.filter(row => row.verdict === 'inconclusive').length;
  const summary = rows.length + ' checked, ' + regressions + ' new regressions, ' + unknown + ' inconclusive';
  const lines = rows.map(row => ('[' + row.verdict + ']' + '  ' + row.path + '  | live: ' + row.production +
    '  | preview: ' + row.preview + '  | citations: ' + row.count + ' ' + row.engines.join(', ') +
    (row.sources?.length ? ' | published in: '+row.sources[0].permalink : '')).trimEnd().replace(/[\u0000-\u001f\u007f]/g, ' '));
  const report = 'Citation CI: ' + summary + '\n' + lines.join('\n');
  console.log(values.json ? JSON.stringify({ summary, rows }, null, 2) : report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const findings = rows.filter(r => !['pass','fixed'].includes(r.verdict));
    const notice = 'Additional findings omitted. See the workflow log for the full list.\n';
    let report = '## Citation CI\n\n' + summary + '\n\n';
    let shown = 0;
    for (const r of findings.slice(0, 100)) {
      const sources = (r.sources ?? []).slice(0,3).map(s=>`<a href="${escape(s.permalink).replaceAll('"','&quot;')}">${escape(s.repo+'/'+s.path)}:${s.line}</a>`);
      const entry = `<p><b>${r.verdict}</b> <code>${escape(r.path)}</code> — live: ${escape(r.production)}; preview: ${escape(r.preview)}` +
        (sources.length ? '<br>Published in: '+sources.join(', ') : '') +
        (r.verdict === 'regression' && r.preview === 'missing HTML anchor' ? '<br>Restore the anchor or redirect to its replacement.' : '') + '</p>';
      const reserve = shown + 1 < findings.length ? notice.length : 0;
      if (report.length + entry.length + 1 + reserve > 100000) break;
      report += entry + '\n';
      shown++;
    }
    if (shown < findings.length) report += notice;
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  }
  if (process.env.CITATION_COMMENT_FILE) {
    const findings = rows.filter(row => row.verdict === 'regression' || row.verdict === 'inconclusive');
    await writeFile(process.env.CITATION_COMMENT_FILE, JSON.stringify({summary, findings: findings.slice(0, 5)}));
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'comparison-complete=true\n');
  if (process.env.GITHUB_ACTIONS && (regressions || unknown)) {
    const escapeCommand = (s: string) => s.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
    console.error('::warning title=Published link check::'+summary+' — see the job summary for details.');
    for (const row of rows.filter(r=>r.verdict==='regression').slice(0,3)) {
      console.error('::warning title=Published link regression::'+escapeCommand(`${row.path}: ${row.preview}` +
        (row.sources?.length ? ` — published in ${row.sources[0].permalink}` : '')));
    }
  }
  return regressions ? 1 : unknown ? 2 : 0;
}
try { process.exitCode = await main(); }
catch (error) {
  console.error('Citation CI: ' + (error instanceof Error ? error.message : 'check failed'));
  process.exitCode = 2;
}
