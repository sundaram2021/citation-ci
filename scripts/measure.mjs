// Usage: node scripts/measure.mjs src/cli.ts [other-checkout/src/cli.ts]
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const clis = process.argv.slice(2);
if (!clis.length) throw new Error('Pass one or more CLI file paths');

const count = 64;
const delayMs = 20;
const body = Array.from({length: count}, (_, i) => '<h2 id="s' + i + '">Section</h2>').join('') + ' '.repeat(32000);
const dir = await mkdtemp(join(tmpdir(), 'citation-cost-'));
let requests, active, peak;
async function listen() {
  const server = createServer((req, res) => {
    requests++; active++; peak = Math.max(active, peak);
    res.on('finish', () => active--);
    setTimeout(() => res.writeHead(200, {'content-type': 'text/html'}).end(body), delayMs);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
const servers = await Promise.all([listen(), listen()]);
const [production, preview] = servers.map(s => 'http://127.0.0.1:' + s.address().port);
const file = join(dir, 'urls.txt');
const samples = [];
try {
  for (const documents of [1, count]) {
    await writeFile(file, Array.from({length: count}, (_, i) => production + '/guide/' + (i % documents) + '#s' + i).join('\n'));
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const cli of repeat % 2 ? clis.toReversed() : clis) {
        requests = 0; active = 0; peak = 0;
        const start = performance.now();
        const {stdout} = await exec(process.execPath, [cli, '--production', production, '--preview', preview, '--file', file, '--json']);
        const ms = Math.round(performance.now() - start);
        const {rows} = JSON.parse(stdout);
        if (rows.length !== count || rows.some(r => r.verdict !== 'pass')) throw new Error('Unexpected check result');
        samples.push({cli, documents, repeat:repeat + 1, ms, requests, peak, bodyBytesServed: requests * Buffer.byteLength(body)});
      }
    }
  }
  console.log(JSON.stringify({node:process.version, delayMs, citations:count, samples}, null, 2));
} finally {
  for (const server of servers) server.close();
  await rm(dir, {recursive:true, force:true});
}
