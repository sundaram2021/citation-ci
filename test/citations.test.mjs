import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect, site, verdict } from '../src/check.ts';
import { inventory } from '../src/inventory.ts';

let server, origin, dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ci-test-'));
  server = createServer((req, res) => {
    switch (req.url) {
      case '/canonical/': return res.writeHead(308, {location:'/canonical'}).end();
      case '/home-section': return res.writeHead(308, {location:'/#okay'}).end();
      case '/lost-fragment': return res.writeHead(308, {location:'/docs#'}).end();
      case '/dead': return res.writeHead(410).end();
      case '/blocked': return res.writeHead(403).end();
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
  ['/docs','ok'], ['/docs/intro','broken'], ['/docs/intro#okay','ok'], ['/dead','broken'], ['/blocked','unknown'], ['/home','broken'],
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

test('CLI requires a citation file before checking destinations', async () => {
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
