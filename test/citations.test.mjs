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
      case '/dead': return res.writeHead(410).end();
      case '/blocked': return res.writeHead(403).end();
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
  ['/docs','ok'], ['/dead','broken'], ['/blocked','unknown'], ['/home','broken'],
  ['/move#okay','ok'], ['/move#gone','broken'], ['/new-id#gone','ok'], ['/docs#fake','broken'],
  ['/docs#a%26b','ok'], ['/loop','broken'], ['/external','unknown'], ['/docs#:~:text=Docs','unknown']
]) {
  test('inspect ' + path, async () => assert.equal((await inspect(new URL(path, origin), origin)).state, state));
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
