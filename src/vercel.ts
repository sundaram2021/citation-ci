import { setTimeout as delay } from 'node:timers/promises';

export async function previewForCommit(project: string, sha: string, token: string | undefined,
  team?: string, get = fetch, wait = () => delay(10000)) {
  if (!project || !/^[a-f0-9]{40}$/.test(sha) || !token) throw new Error('Vercel requires a project ID, full commit SHA, and VERCEL_TOKEN');
  const api = new URL('https://api.vercel.com/v7/deployments');
  api.searchParams.set('projectId', project);
  api.searchParams.set('sha', sha);
  api.searchParams.set('target', 'preview');
  if (team) api.searchParams.set('teamId', team);
  const deadline = Date.now() + 5*60*1000;
  do {
    const res = await get(api, {headers:{authorization:`Bearer ${token}`}, redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error(`Vercel deployment lookup returned HTTP ${res.status}`);
    const {deployments} = await res.json();
    if (!Array.isArray(deployments)) throw new Error('Unexpected Vercel deployment list');
    // API results are newest first. Never fall back to an older ready build or branch alias.
    const d = deployments.find(d => d.projectId === project && d.meta?.githubCommitSha === sha &&
      !d.customEnvironment && (d.target == null || d.target === 'preview'));
    if (d) {
      const state = d.readyState ?? d.state;
      if (['ERROR','CANCELED','BLOCKED','DELETED'].includes(state)) throw new Error(`Vercel deployment for ${sha} is ${state}`);
      if (state === 'READY') {
        if (typeof d.url !== 'string' || !/^[a-z0-9-]+\.vercel\.app$/i.test(d.url)) throw new Error('Unexpected Vercel deployment hostname');
        return new URL(`https://${d.url}`);
      }
    }
    await wait();
  } while (Date.now() < deadline);
  throw new Error(`No ready Vercel preview for ${sha} within five minutes`);
}
