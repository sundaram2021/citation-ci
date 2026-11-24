import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(respond) {
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
const page = '<h1 id="keys">Create an API key</h1>';
const live = await fixture((req, res) => res.writeHead(200, {'content-type':'text/html'}).end(page));
let repaired = false;
const next = await fixture((req, res) => {
  if (req.url === '/docs/auth') return res.writeHead(308, {location: repaired ? '/guides/auth' : '/'}).end();
  res.writeHead(200, {'content-type':'text/html'}).end(req.url === '/' ? 'Welcome' : page);
});
const dir = await mkdtemp(join(tmpdir(), 'citation-ci-'));
try {
  const file = join(dir, 'citations.csv');
  await writeFile(file, 'url,engine,count\n' + live.origin + '/docs/auth#keys,example,1\n');
  for (const expected of [1, 0]) {
    repaired = expected === 0;
    console.log(repaired ? '\nAfter correcting the redirect' : 'Before correcting the redirect');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      '--production', live.origin, '--preview', next.origin, '--file', file], {stdio:'inherit'});
    const [code] = await once(child, 'exit');
    if (code !== expected) throw new Error('Expected exit ' + expected + ', received ' + code);
  }
} finally {
  live.server.close(); next.server.close();
  await rm(dir, {recursive:true, force:true});
}
