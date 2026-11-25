# Citation CI

Citation CI checks whether a docs preview breaks links published in a GitHub README or Markdown guide. It compares each URL on production and preview, including its query and HTML anchor. If a working link breaks, the report points to the published file and line.

## Run against an existing preview

From this checkout, use Node.js 24 or later. Set `DOCS_ORIGIN` and `PREVIEW_ORIGIN` to the two site origins (scheme and host, no path), and `SOURCE_REPO` to the `owner/repo` that publishes the links.

```sh
npm ci
npm run check -- --production "$DOCS_ORIGIN" --preview "$PREVIEW_ORIGIN" \
  --source-repo "$SOURCE_REPO" --source-path README.md
```

The scan reads the source repo’s default branch. Use a directory as `--source-path` to check several Markdown files. Only absolute links to the production origin are checked. Set `GH_SOURCE_TOKEN` if the repo is private or you hit GitHub’s API limit.

Already have a URL list? Replace `--source-repo` and `--source-path` with `--file citations.txt` (one URL per line) or `--file citations.csv` (`url` column required; `engine` and `count` optional). Add `--json` for structured output.

## Run on Vercel pull requests

1. Enable Vercel’s Git integration for the docs repo. Production and preview pages must be accessible to the runner without signing in.
2. Copy [the PR workflow](examples/workflows/vercel-pr.yml) to `.github/workflows/published-links.yml` in your docs repository.
3. In GitHub Actions settings, add variables `DOCS_PRODUCTION_ORIGIN` and `VERCEL_PROJECT_ID`, plus `VERCEL_TEAM_ID` for a team-owned project. Add `VERCEL_TOKEN` as a secret with access to read deployments.
4. If the links live in another repo, set `LINK_SOURCE_REPO` to its `owner/repo` and adjust `source-path` in the workflow. For another private repo, pass a token with read access to its contents as `source-token`.

The workflow waits up to five minutes for the PR’s exact commit to have a ready preview. Open the `published-links` job summary to see findings. The workflow skips fork and Dependabot PRs.

## Interpret the result

| Result | Meaning |
| --- | --- |
| `regression` | Works on production; broken on preview. |
| `pre-existing` | Broken on both sites. |
| `fixed` | Broken on production; works on preview. |
| `pass` | Works on both sites. |
| `inconclusive` | At least one site could not be checked reliably. |

The CLI exits **1** for a regression, **2** for a setup error or an inconclusive run without a confirmed regression, and **0** otherwise. The workflow starts in `report` mode: findings appear in the summary, but only setup or execution errors fail the job. Switch to `enforce` to use the CLI exit code as the job result.

Anchor checks use server-returned HTML. A JavaScript-generated anchor may be reported missing; a reachable page can pass even if its content has changed.
