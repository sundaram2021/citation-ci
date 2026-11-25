import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/discover.ts';
import { previewForCommit } from '../src/vercel.ts';

const site = new URL('https://docs.example');
const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const entry = path => ({path,sha:'c'.repeat(40),type:'blob',mode:'100644',size:150});
const markdown = ['```','https://docs.example/ignore','```','`https://docs.example/code`',
  '[Guide][ref]', 'https://docs.example/guide?q=1#part', '[else](https://other.example)',
  '![image](https://docs.example/img)', '', '[ref]: https://docs.example/guide?q=1#part'].join('\n');

test('published source uses immutable objects, preserves occurrence lines, and shares identical blobs', async () => {
  const hits = [];
  const data = await discover(site,'org/sdk','',async endpoint => {
    const path = endpoint.split('/org/sdk/')[1]; hits.push(path);
    if (path === 'commits/HEAD') return Response.json({sha,commit:{tree:{sha:tree}}});
    if (path === `git/trees/${tree}?recursive=1`) return Response.json({tree:[entry('README.md'),entry('docs/a b.md'),entry('other.js'),{...entry('link.md'),mode:'120000'}]});
    assert.equal(path, `git/blobs/${entry('').sha}`);
    return Response.json({content:Buffer.from(markdown).toString('base64'),encoding:'base64'});
  });
  assert.equal(hits.length,3); assert.equal(data.length,1);
  assert.equal(data[0].url.href,'https://docs.example/guide?q=1#part');
  assert.equal(data[0].count,4);
  assert.deepEqual(data[0].sources.map(s=>s.line),[5,6,5,6]);
  assert.ok(data[0].sources.some(s=>s.permalink===`https://github.com/org/sdk/blob/${sha}/docs/a%20b.md#L5`));
});

test('incomplete discovery never silently reports success', async () => {
  for (const [response,pattern] of [[{tree:[],truncated:true},/Incomplete/],[{tree:[]},/No published/],
    [{tree:[{...entry('large.md'),size:2**20+1}]},/budget/]]) {
    await assert.rejects(discover(site,'org/sdk','',async path=>Response.json(path.endsWith('/HEAD') ?
      {sha,commit:{tree:{sha:tree}}} : response)),pattern);
  }
});

const deployment = {meta:{githubCommitSha:sha},projectId:'prj_1',url:'docs-exact.vercel.app',readyState:'READY',target:null};
test('preview lookup waits for the exact project, deployment target and revision', async () => {
  let polls=0, waits=0;
  const url = await previewForCommit('prj_1',sha,'fixture','team_1',async (url,opts) => {
    assert.equal(url.origin,'https://api.vercel.com'); assert.equal(url.searchParams.get('sha'),sha);
    assert.equal(url.searchParams.get('teamId'),'team_1'); assert.equal(opts.redirect,'error');
    return Response.json({deployments:[{...deployment,projectId:'another'}, {...deployment,target:'production'},
      {...deployment,meta:{githubCommitSha:tree}}, {...deployment,readyState:++polls===1?'BUILDING':'READY'}]});
  },async()=>{waits++});
  assert.equal(waits,1); assert.equal(url.origin,'https://docs-exact.vercel.app');
});

test('failed newest preview cannot fall back to an older successful build', async () => {
  await assert.rejects(previewForCommit('prj_1',sha,'fixture',undefined,async()=>Response.json({deployments:[
    {...deployment,readyState:'ERROR'},deployment]})),/is ERROR/);
});

test('invalid source paths are rejected before discovery makes any requests', async () => {
  for (const path of ['docs//README.md', '/', '/docs', 'docs/../README.md']) {
    await assert.rejects(discover(site, 'org/sdk', path, () => assert.fail('unexpected API call')), /repository-relative source path/);
  }
});

test('discovers HTML anchors in MDX and MKD with original line numbers and API headers', async () => {
  const body = ['# Docs', '', '<div align="center">', ' <a href="https://docs.example/badge?a=1&amp;b=2">badge</a>',
    '</div>', '', 'Inline <a href="https://docs.example/inline">link</a>.', '',
    '`<a href="https://docs.example/code">code</a>`', '', '```html', '<a href="https://docs.example/fenced">', '```',
    '', '<table><tr><td><a href="https://docs.example/table">table</a></td></tr></table>'].join('\n');
  const rows = await discover(site, 'org/sdk', '', async (url,opts) => {
    const headers = new Headers(opts.headers);
    assert.equal(headers.get('user-agent'),'citation-ci'); assert.equal(headers.get('x-github-api-version'),'2022-11-28');
    if (url.endsWith('/HEAD')) return Response.json({sha,commit:{tree:{sha:tree}}});
    if (url.includes('/trees/')) return Response.json({tree:[entry('guide.mdx'),entry('guide.mkd')]});
    return Response.json({encoding:'base64',content:Buffer.from(body).toString('base64')});
  });
  assert.deepEqual(rows.map(r => [r.url.pathname+r.url.search,r.sources.map(s=>[s.path,s.line])]), [
    ['/badge?a=1&b=2',[['guide.mdx',4],['guide.mkd',4]].sort()],
    ['/inline',[['guide.mdx',7],['guide.mkd',7]].sort()],
    ['/table',[['guide.mdx',15],['guide.mkd',15]].sort()]
  ]);
});

test('expired Vercel poll skips its trailing wait and rejects non-Vercel hostnames', async t => {
  let now = 0;
  t.mock.method(Date,'now',()=>now);
  await assert.rejects(previewForCommit('prj_1',sha,'token',undefined,async () => {
    now = 300000;
    return Response.json({deployments:[]});
  }, async () => assert.fail('unexpected trailing wait')), /within five minutes/);
  await assert.rejects(previewForCommit('prj_1',sha,'token',undefined,async () =>
    Response.json({deployments:[{...deployment,url:'test.vercel.app.example.com'}]})), /hostname/);
});
