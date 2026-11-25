import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect, inspectDocument, site, verdict } from '../src/check.ts';
import { inventory } from '../src/inventory.ts';

let server, origin, dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ci-test-'));
  server = createServer((req, res) => {
    switch (req.url) {
      case '/canonical/': return res.writeHead(308, {location:'/canonical'}).end();
      case '/via-retired': return res.writeHead(302, {location:'/home#okay'}).end();
      case '/home-section': return res.writeHead(308, {location:'/#okay'}).end();
      case '/lost-fragment': return res.writeHead(308, {location:'/docs#'}).end();
      case '/dead': return res.writeHead(410).end();
      case '/blocked': return res.writeHead(403).end();
      case '/docs/explicit': return res.writeHead(302, {location:'/docs#okay'}).end();
      case '/docs/indirect': return res.writeHead(302, {location:'/docs/intro#okay'}).end();
      case '/docs/intro': return res.writeHead(308, {location:'/docs'}).end();
      case '/home': return res.writeHead(301, {location:'/'}).end();
      case '/move': return res.writeHead(308, {location:'/docs'}).end();
      case '/new-id': return res.writeHead(308, {location:'/docs#okay'}).end();
      case '/loop': return res.writeHead(302, {location:'/loop'}).end();
      case '/external': return res.writeHead(307, {location:'https://other.invalid'}).end();
      default: res.writeHead(200, {'content-type':'text/html'}).end(
        '<!-- <a id="fake"> --><h1 id="okay">Docs</h1><a name="a&amp;b"></a>');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = site('http://127.0.0.1:' + server.address().port);
});
after(async () => { server.close(); await rm(dir, {recursive:true, force:true}); });
for (const [path, state] of [
  ['/canonical/','ok'], ['/docs/','ok'], ['/home-section#okay','ok'], ['/lost-fragment#okay','broken'],
  ['/docs','ok'], ['/docs/intro','broken'], ['/docs/intro#okay','unknown'], ['/docs/intro#gone','broken'],
  ['/docs/explicit#old','ok'], ['/docs/indirect#old','unknown'], ['/dead','broken'], ['/blocked','unknown'], ['/home','broken'], ['/home#okay','broken'], ['/home#top','broken'], ['/via-retired#okay','broken'],
  ['/move#okay','ok'], ['/move#gone','broken'], ['/new-id#gone','ok'], ['/docs#fake','broken'],
  ['/docs#a%26b','ok'], ['/loop','broken'], ['/external','unknown'], ['/docs#:~:text=Docs','unknown']
]) {
  test('inspect ' + path, async () => assert.equal((await inspect(new URL(path, origin), origin)).state, state));
}
for (const status of [204, 205]) {
  test(`HTTP ${status} on preview regresses a working document`, async t => {
    const url = new URL('/docs', origin);
    const live = await inspect(url, origin);
    t.mock.method(globalThis, 'fetch', async () => new Response(null, {status}));
    assert.equal(verdict(live, await inspect(url, origin)), 'regression');
  });
}
test('baseline determines whether a failure is new', () => {
  for (const [a,b,result] of [['ok','broken','regression'],['broken','broken','pre-existing'],
    ['broken','ok','fixed'],['unknown','ok','inconclusive'],['ok','unknown','inconclusive']]) {
    assert.equal(verdict({state:a}, {state:b}), result);
  }
});
test('CSV preserves fragments and merges duplicate observations', async () => {
  const file = join(dir, 'observed.csv');
  const url = new URL('/guide?version=1#one', origin).href;
  await writeFile(file, 'url,engine,count\r\n"' + url + '","A, B",2\r\n' + url + ',C,1\r\n');
  const [row] = await inventory(origin,file);
  assert.equal(row.count,3); assert.deepEqual([...row.engines],['A, B','C']); assert.equal(row.url.href,url);
});
test('file import rejects accidental off-site targets and empty lists', async () => {
  const file = join(dir,'bad.txt');
  for (const data of ['https://example.org/oops','']) {
    await writeFile(file,data); await assert.rejects(inventory(origin,file));
  }
});

test('CLI requires a source repository or a citation file before checking destinations', async () => {
  const {spawnSync} = await import('node:child_process');
  const result = spawnSync(process.execPath, ['src/cli.ts', '--production', origin.origin,
    '--preview', 'http://localhost:1'], {encoding: 'utf8'});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--file citations\.csv/);
});

test('multiple anchors reuse one document request and get independent verdicts', async t => {
  const {inspectDocument} = await import('../src/check.ts');
  const get = t.mock.method(globalThis, 'fetch', async () => new Response(
    '<h1 id="found">Docs</h1>', {headers:{'content-type':'text/html'}}));
  const urls = ['', '#found', '#missing', '#%ZZ', '#:~:text=Docs'].map(hash => new URL('/guide' + hash, origin));
  const rows = await inspectDocument(urls, origin);
  assert.equal(get.mock.callCount(), 1);
  assert.deepEqual(rows.map(row => row.state), ['ok','ok','broken','unknown','unknown']);
});

test('anchors use the HTTP charset; an unsupported charset is inconclusive', async t => {
  let charset = 'windows-1252';
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('<h1 id="café">Guide</h1>', 'latin1'),
    {headers: {'content-type': `text/html; charset="${charset}"`}}));
  const url = new URL('/guide#caf%C3%A9', origin);
  assert.equal((await inspect(url, origin)).state, 'ok');
  charset = 'unsupported-encoding';
  assert.equal((await inspect(url, origin)).state, 'unknown');
});

test('an oversized anchored response preserves the unanchored verdict', async t => {
  const {inspectDocument} = await import('../src/check.ts');
  t.mock.method(globalThis,'fetch', async () => new Response('x'.repeat(2*1024*1024 + 1),
    {headers:{'content-type':'text/html'}}));
  const urls = ['/guide', '/guide#x'].map(path => new URL(path, origin));
  const rows = await inspectDocument(urls, origin);
  assert.deepEqual(rows.map(row => row.state), ['ok','unknown']);
});

test('distinct query variants stay separate and JSON output redacts query values', async () => {
  const file = join(dir, 'versions.txt');
  const urls = ['?v=first#okay','?v=second#okay'].map(query => new URL('/docs' + query, origin).href);
  await writeFile(file, urls.join('\n'));
  const [a,b] = await inventory(origin, file);
  assert.notEqual(a.url.search,b.url.search);
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const hits = [];
  const preview = createServer((req,res) => {
    hits.push(req.url);
    res.writeHead(200,{'content-type':'text/html'}).end('<h1 id="okay">Guide</h1>');
  });
  preview.listen(0,'127.0.0.1');
  await once(preview,'listening');
  try {
    const {stdout} = await promisify(execFile)(process.execPath,['src/cli.ts','--file',file,
      '--production',origin.origin,'--preview','http://127.0.0.1:' + preview.address().port,'--json']);
    assert.deepEqual(hits.sort(),['/docs?v=first','/docs?v=second']);
    assert.deepEqual(JSON.parse(stdout).rows.map(row => row.verdict),['pass','pass']);
    assert.doesNotMatch(stdout,/first|second/);
  } finally { preview.close(); }
});

test('only the declared parent move is accepted', async () => {
  const url = new URL('/docs/intro', origin);
  const compare = async moves => (await inspectDocument([url], origin, {parentMoves: new Map(moves)}))[0].state;
  assert.equal(await compare([['/docs/intro','/docs']]), 'ok');
  assert.equal(await compare([['/docs/other','/docs']]), 'broken');
  assert.equal(await compare([['/docs/intro','/docs?v=1']]), 'broken');
  url.hash = 'okay';
  assert.equal(await compare([['/docs/intro','/docs']]), 'ok');
  url.hash = 'gone';
  assert.equal(await compare([['/docs/intro','/docs']]), 'broken');
});

test('the CLI recognizes a configured soft 404 and accepts an exact parent move', async () => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const file = join(dir, 'policy.txt');
  await writeFile(file, ['/docs/intro', '/missing', '/missing#okay', '/article'].map(p => new URL(p, origin).href).join('\n'));
  const preview = createServer((req, res) => {
    if (req.url === '/docs/intro') return res.writeHead(301, {location:'/docs'}).end();
    const body = req.url === '/missing'
      ? '<main data-template="docs-not-found" id="okay">Missing</main>'
      : '<article>How to diagnose a 404</article>';
    res.writeHead(200, {'content-type':'text/html'}).end(body);
  });
  preview.listen(0, '127.0.0.1');
  await once(preview, 'listening');
  try {
    const args = ['src/cli.ts', '--file', file, '--production', origin.origin,
      '--preview', 'http://127.0.0.1:' + preview.address().port, '--parent-moves', '{"/docs/intro":"/docs"}',
      '--error-page-marker', 'data-template="docs-not-found"', '--json'];
    await assert.rejects(promisify(execFile)(process.execPath, args), error => {
      assert.equal(error.code, 1);
      const {rows} = JSON.parse(error.stdout);
      assert.deepEqual(Object.fromEntries(rows.map(r => [r.path, r.verdict])), {
        '/docs/intro':'pass', '/missing':'regression', '/missing#okay':'regression', '/article':'pass'
      });
      return true;
    });
  } finally { preview.close(); }
});

test('exact homepage move allows only that destination and still checks fragments', async () => {
  const paths = ['/home', '/home#okay', '/home#missing'].map(path => new URL(path, origin));
  const policy = {parentMoves: new Map([['/home', '/']])};
  const results = await inspectDocument(paths, origin, policy);
  assert.deepEqual(results.map(r => r.state), ['ok', 'ok', 'broken']);
  const [other] = await inspectDocument(paths, origin, {parentMoves: new Map([['/home', '/?v=1']])});
  assert.equal(other.state, 'broken');
});

test('a malformed UTF-8 byte outside a heading preserves usable anchors', async t => {
  const body = Buffer.concat([Buffer.from([0xff]), Buffer.from('<h2 id="keys">Keys</h2>')]);
  t.mock.method(globalThis, 'fetch', async () => new Response(body, {headers:{'content-type':'text/html; charset=utf-8'}}));
  const urls = ['keys','absent'].map(id => new URL('/docs#' + id, origin));
  assert.deepEqual((await inspectDocument(urls, origin)).map(r => r.state), ['ok','broken']);
});

test('preview bypass stays on authorized same-origin hops', async t => {
  const headers = {'x-vercel-protection-bypass':'fixture-bypass'};
  const production = new URL('https://docs.test'), preview = new URL('https://preview.test');
  const citation = new URL('/guide#keys', production);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url.origin, url.pathname, new Headers(options.headers).get('x-vercel-protection-bypass')]);
    assert.equal(options.redirect, 'manual');
    if (url.origin === production.origin) return new Response('OK');
    const location = url.pathname === '/guide' ? '/moved' : 'https://external.test/';
    return new Response(null, {status:302, headers:{location}});
  });
  await inspectDocument([citation], production);
  const [row] = await inspectDocument([citation], preview, {headers});
  assert.equal(row.state, 'unknown');
  assert.deepEqual(calls, [[production.origin,'/guide',null], [preview.origin,'/guide','fixture-bypass'],
    [preview.origin,'/moved','fixture-bypass']]);
});

test('analytics CSV aliases, counts, source labels and primary column precedence', async () => {
  const file = join(dir, 'analytics.csv');
  for (const [url, count] of [[' PAGE ', 'CLICKS'], ['Top Pages', 'Visits'], ['LANDING PAGE', 'Views'],
    ['Path', 'PageViews'], ['URL','Impressions']]) {
    await writeFile(file, '"' + url + '",' + count + ',ReFeRrEr\n/docs#keys,"1,234",https://ref.test/?q=private');
    const [row] = await inventory(origin,file);
    assert.equal(row.url.href, new URL('/docs#keys',origin).href);
    assert.equal(row.count,1234);
    assert.deepEqual([...row.engines], ['https://ref.test/?[redacted]']);
  }
  await writeFile(file,'page,url,views,count,source,engine\n/other,/docs,9,3,support,sdk');
  const [row] = await inventory(origin,file);
  assert.equal(row.url.pathname,'/docs'); assert.equal(row.count,3); assert.deepEqual([...row.engines],['sdk']);
  for (const invalid of ['0','-1','1.2','1,23','abc','9007199254740992']) {
    await writeFile(file,'path,views\n/docs,"'+invalid+'"');
    await assert.rejects(inventory(origin,file), /Invalid citation count/);
  }
  await writeFile(file,'views,source\n1,foo');
  await assert.rejects(inventory(origin,file), /No recognized URL column/);
});

test('text inventories ignore comments and constrain relative links to the production origin', async () => {
  const file = join(dir,'list.txt');
  await writeFile(file,'  # shared links\n\n/docs?q=v#keys\n');
  const [row] = await inventory(origin,file);
  assert.equal(row.url.href,new URL('/docs?q=v#keys',origin).href);
  for (const bad of ['//'+origin.host+'/docs', '/\\\\other.test/docs', 'https://other.test/docs',
    'http://user:pass@'+origin.host+'/docs','docs/relative']) {
    await writeFile(file,bad);
    await assert.rejects(inventory(origin,file), /Invalid citation URL|outside the production origin/);
  }
});
