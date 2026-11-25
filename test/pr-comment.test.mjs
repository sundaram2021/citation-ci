import test from 'node:test';
import assert from 'node:assert/strict';
import {publish} from '../scripts/pr-comment.mjs';

const env = {GITHUB_API_URL:'https://api.github.com', GITHUB_SERVER_URL:'https://github.com',
  GITHUB_REPOSITORY:'org/docs', GITHUB_WORKFLOW:'Links', GITHUB_JOB:'docs', GITHUB_RUN_ID:'123'};
const pr = {number:7, head:{sha:'a'.repeat(40), repo:{full_name:'org/docs'}}};
const clean = {summary:'1 checked, 0 new regressions, 0 inconclusive', findings:[]};
const broken = {summary:'1 checked, 1 new regression', findings:[
  {verdict:'regression', path:'/docs#keys', production:'HTTP 200', preview:'missing HTML anchor'}
]};

test('PR comment lifecycle, ownership, pagination and stale runs', async () => {
  const comments = Array.from({length:100}, (_, id) => ({id, user:{login:'reader'}, body:'discussion'}));
  const writes = [];
  let current = pr.head.sha;
  async function api(url, options) {
    const path = new URL(url);
    if (options.method === 'GET') {
      if (path.pathname.endsWith('/pulls/7')) return Response.json({head:{sha:current}});
      const offset = (Number(path.searchParams.get('page')) - 1) * 100;
      return Response.json(comments.slice(offset, offset + 100));
    }
    const body = JSON.parse(options.body).body;
    writes.push(options.method);
    if (options.method === 'POST') comments.push({id:101, user:{login:'github-actions[bot]'}, body});
    else {
      assert.ok(path.pathname.endsWith('/issues/comments/101'));
      comments.at(-1).body = body;
    }
    return Response.json({});
  }
  const run = report => publish(env, {pull_request:pr}, report, api);
  await run(clean);
  await run(broken);
  assert.match(comments.at(-1).body, /missing HTML anchor/);
  comments[0].body = comments.at(-1).body;
  await run(broken);
  await run(clean);
  assert.match(comments.at(-1).body, /0 new regressions/);
  assert.doesNotMatch(comments.at(-1).body, /missing HTML anchor/);
  await run(undefined);
  assert.match(comments.at(-1).body, /Comparison incomplete/);
  current = 'b'.repeat(40);
  await run(broken);
  assert.deepEqual(writes, ['POST','PATCH','PATCH']);
});

test('fork events skip GitHub API calls', async () => {
  await publish(env, {pull_request:{...pr,head:{...pr.head,repo:{full_name:'fork/docs'}}}}, broken,
    () => assert.fail('unexpected request'));
});
