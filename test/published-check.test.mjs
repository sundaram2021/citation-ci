import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('PR check ties a missing preview anchor to the published source, not to the PR branch', async t => {
  const dir = await mkdtemp(join(tmpdir(),'published-check-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const summary = join(dir,'summary'), output = join(dir,'output');
  const head = '1'.repeat(40), published = '2'.repeat(40), tree = '3'.repeat(40);
  // Exercise the real CLI, Markdown parser, HTTP inspection and summary writer.
  // Intercept only transport. Unexpected requests or leaked credentials fail the run.
  const transport = `globalThis.fetch = async (input,opts) => {
    const u = new URL(input); const auth = new Headers(opts.headers).get('authorization');
    if (u.hostname === 'api.vercel.com' && auth === 'Bearer v' && u.searchParams.get('sha') === '${head}')
      return Response.json({deployments:[{target:null,meta:{githubCommitSha:'${head}'},projectId:'prj_test',readyState:'READY',url:'test-build.vercel.app'}]});
    if (u.hostname === 'api.github.com' && auth === 'Bearer g') {
      if (u.pathname.endsWith('/commits/HEAD')) return Response.json({sha:'${published}',commit:{tree:{sha:'${tree}'}}});
      if (u.pathname.endsWith('/git/trees/${tree}')) return Response.json({tree:[{path:'README.md',type:'blob',mode:'100644',size:128,sha:'abc'}]});
      if (u.pathname.endsWith('/git/blobs/abc')) return Response.json({encoding:'base64',content:Buffer.from('[Guide](https://docs.test/auth?k=hidden#keys)').toString('base64')});
    }
    if (!auth && u.pathname === '/auth' && u.search === '?k=hidden' && ['docs.test','test-build.vercel.app'].includes(u.hostname))
      return new Response(u.hostname==='docs.test'?'<p id="keys">Keys</p>':'<p>Guide</p>',{headers:{'content-type':'text/html'}});
    throw new Error('unexpected request');
  };`;
  const p = spawnSync(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(transport).toString('base64'),
    'src/cli.ts','--source-repo','org/sdk','--source-path','README.md','--production','https://docs.test',
    '--vercel-project','prj_test','--commit',head,'--json'], {encoding:'utf8',env:{...process.env,
      GH_SOURCE_TOKEN:'g',VERCEL_TOKEN:'v',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(p.status,1,p.stderr);
  const {rows} = JSON.parse(p.stdout);
  assert.equal(rows[0].verdict,'regression'); assert.equal(rows[0].preview,'missing HTML anchor');
  const link = `https://github.com/org/sdk/blob/${published}/README.md#L1`;
  assert.equal(rows[0].sources[0].permalink,link);
  const report = await readFile(summary,'utf8');
  assert.ok(report.includes(`<a href="${link}"`)); assert.doesNotMatch(report+p.stdout,/hidden/);
  assert.match(await readFile(output,'utf8'),/comparison-complete=true/);
});

test('a large job summary only includes complete findings and an omission notice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-summary-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const file = join(dir, 'links.txt'), summary = join(dir, 'summary');
  const production = 'https://docs.test', preview = 'https://preview.test';
  const urls = Array.from({length:90}, (_, i) => production + '/guide#' + i + 'a'.repeat(1800));
  await writeFile(file, urls.join('\n'));
  const transport = "globalThis.fetch = async () => new Response('<p>Guide</p>', {headers:{'content-type':'text/html'}})";
  const run = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(transport),
    'src/cli.ts', '--production', production, '--preview', preview, '--file', file],
    {encoding:'utf8', env:{...process.env, GITHUB_STEP_SUMMARY:summary}});
  assert.equal(run.status, 0, run.stderr);
  const report = await readFile(summary, 'utf8');
  const entries = report.split('\n').filter(line => line.startsWith('<p>'));
  assert.ok(entries.length > 0 && entries.length < urls.length);
  assert.ok(entries.every(line => line.endsWith('</p>')));
  assert.ok(report.length <= 100000);
  assert.match(report, /additional findings omitted/i);
});
