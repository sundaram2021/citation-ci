import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function html(value) {
  return value.slice(0, 400).replace(/[\r\n]/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function publish(env, event, report, request = fetch) {
  const {pull_request: pr} = event;
  if (!pr || pr.head.repo?.full_name !== env.GITHUB_REPOSITORY) return;
  const base = env.GITHUB_API_URL + '/repos/' + env.GITHUB_REPOSITORY;
  async function api(path, method = 'GET', body) {
    const response = await request(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {authorization: 'Bearer ' + env.GH_TOKEN, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify({body})
    });
    if (!response.ok) throw new Error('GitHub comment API returned HTTP ' + response.status);
    return response.json();
  }

  const key = createHash('sha256').update(env.GITHUB_WORKFLOW + '\n' + env.GITHUB_JOB).digest('hex');
  const marker = '<!-- citation-ci:' + key + ' -->';
  const thread = '/issues/' + pr.number + '/comments';
  let previous;
  for (let page = 1; !previous; page++) {
    const comments = await api(thread + '?per_page=100&page=' + page);
    previous = comments.find(c => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(marker + '\n'));
    if (comments.length < 100) break;
  }
  if (!previous && !report?.findings.length) return;
  const current = await api('/pulls/' + pr.number);
  if (current.head.sha !== pr.head.sha) return;

  const lines = [marker, '### Citation CI', '', report?.summary ?? 'Comparison incomplete. See the workflow run for the error.'];
  for (const row of report?.findings ?? []) {
    lines.push('', '<p><b>' + html(row.verdict) + '</b> <code>' + html(row.path) + '</code><br>Production: ' +
      html(row.production) + '<br>Preview: ' + html(row.preview) + '</p>');
  }
  const run = env.GITHUB_SERVER_URL + '/' + env.GITHUB_REPOSITORY + '/actions/runs/' + env.GITHUB_RUN_ID;
  lines.push('', '[Full workflow results](' + run + ') · Commit `' + pr.head.sha.slice(0, 7) + '`');
  const body = lines.join('\n');
  if (previous?.body === body) return;
  if (previous) await api('/issues/comments/' + previous.id, 'PATCH', body);
  else await api(thread, 'POST', body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const report = env.COMPLETE === 'true' ? JSON.parse(await readFile(env.REPORT_FILE, 'utf8')) : undefined;
  await publish(env, event, report);
}
