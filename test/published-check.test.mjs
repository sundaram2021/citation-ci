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
    const bypass = new Headers(opts.headers).get('x-vercel-protection-bypass');
    if (bypass !== (u.hostname === 'test-build.vercel.app' ? 'bypass-fixture-123' : null)) throw new Error('incorrect bypass scope');
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
      GITHUB_ACTIONS:'true', CITATION_COMMENT_FILE:join(dir,'comment'), VERCEL_AUTOMATION_BYPASS_SECRET:'bypass-fixture-123',
      GH_SOURCE_TOKEN:'g',VERCEL_TOKEN:'v',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary}});
  assert.equal(p.status,1,p.stderr);
  const {rows} = JSON.parse(p.stdout);
  assert.equal(rows[0].verdict,'regression'); assert.equal(rows[0].preview,'missing HTML anchor');
  const link = `https://github.com/org/sdk/blob/${published}/README.md#L1`;
  assert.equal(rows[0].sources[0].permalink,link);
  const report = await readFile(summary,'utf8');
  assert.ok(report.includes(`<a href="${link}"`)); assert.match(report, /1 new regression, /);
  assert.doesNotMatch(report+p.stdout+p.stderr+await readFile(join(dir,'comment'),'utf8'), /hidden|bypass-fixture-123/);
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

test('standalone bundled CLI matches source output without a package installation', async t => {
  const {copyFile} = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(),'citation-bundle-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const inventory = join(dir,'traffic.csv');
  const bundle = join(dir,'cli.mjs');
  await copyFile('dist/cli.mjs',bundle);
  await writeFile(inventory,'Top Pages,Clicks\n/guide?q=hidden#keys,"1,234"');
  const transport = `globalThis.fetch = async (input, opts) => {
    const url = new URL(input);
    const preview = url.hostname === 'preview.test';
    const header = new Headers(opts.headers).get('x-vercel-protection-bypass');
    if (header !== (preview ? 'fixture-bypass-secret' : null)) throw new Error('wrong scope');
    if (preview && url.pathname === '/guide') return Response.redirect(new URL('/replacement',url),302);
    return new Response(preview ? 'missing' : '<h2 id="keys">keys</h2>',{headers:{'content-type':'text/html'}});
  }`;
  const run = entry => spawnSync(process.execPath,['--import','data:text/javascript;base64,'+Buffer.from(transport).toString('base64'),
    entry,'--production','https://docs.test','--preview','https://preview.test','--file',inventory,'--json'],
    {encoding:'utf8',env:{...process.env,VERCEL_AUTOMATION_BYPASS_SECRET:'fixture-bypass-secret'}});
  const source = run('src/cli.ts'), built = run(bundle);
  assert.equal(source.status,1,source.stderr); assert.equal(built.status,1,built.stderr);
  assert.deepEqual(JSON.parse(built.stdout),JSON.parse(source.stdout));
  assert.equal(JSON.parse(built.stdout).rows[0].count,1234);
  assert.doesNotMatch(built.stdout+built.stderr,/hidden|fixture-bypass-secret/);
});

test('deployment workflow uses the reported environment URL without a preview secret', async () => {
  const yaml = await readFile('examples/workflows/deployment-preview.yml','utf8');
  assert.match(yaml, /^on: deployment_status$/m);
  assert.match(yaml, /deployment_status.state == 'success' && github.event.deployment.environment != 'Production'/);
  assert.ok(yaml.includes('preview: ${{ github.event.deployment_status.environment_url }}'));
  assert.doesNotMatch(yaml, /secrets\.|actions\/checkout/);
});
