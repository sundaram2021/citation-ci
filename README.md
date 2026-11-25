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

Anchor checks use server-returned HTML. A JavaScript-generated anchor may be reported missing; a reachable page can pass even if its content has changed.

### Configure site-specific redirects and error pages

A redirect from a document to the homepage is broken even when the homepage reuses the original anchor ID. An explicit redirect to a homepage section (for example, `Location: /#installation`) still checks the replacement anchor.

For an intentional move to a parent page or a site that serves an error template with HTTP 200, add the relevant inputs under the Action's `with` block:

```yaml
parent-moves: '{"/manual/chapter":"/manual"}'
error-page-marker: 'data-template="docs-not-found"'
```

The CLI accepts the same values through `--parent-moves` and `--error-page-marker`. Parent moves match the exact source and final path, including query strings and trailing slashes. A match permits the parent redirect and still checks HTTP status and fragments.

Choose a case-sensitive literal unique to the raw HTML of your error template. When configured, the checker reads HTML on both origins, including pages without a fragment. A matching page is broken. An unreadable HTML body or one larger than 2 MiB is inconclusive. Without a marker, ordinary HTTP 200 pages without fragments keep their status-only check.

### Does the GitHub check fail?

| Run result | CLI exit | `mode: enforce` | `mode: report` |
| --- | --- | --- | --- |
| All links are `pass`, `fixed`, or `pre-existing` | `0` | Pass | Pass |
| At least one `regression`, even if other links are `inconclusive` | `1` | Fail | Pass with findings |
| At least one `inconclusive`, no regressions | `2` | Fail | Pass with findings |
| The checker cannot complete (for example, no matching links or no ready preview) | `2` | Fail | Fail |

The action defaults to `enforce`; the example workflow sets `report` explicitly. In either mode, read the job summary for per-link findings. A failed check blocks merging only if the repository requires it.

## Paperlint: a live PR check

In [Paperlint PR #1](https://github.com/sundaram2021/paperlint/pull/1), Citation CI discovered the homepage link on [line 15 of the published profile README](https://github.com/sundaram2021/sundaram2021/blob/071127efe55384f5d74385aacefa04f1857a653d/README.md#L15). The workflow used `enforce` and compared live production with the exact PR commit served on the GitHub Actions runner.

| Run | Production `/` | PR checkout `/` | Verdict and check |
| --- | --- | --- | --- |
| [Baseline](https://github.com/sundaram2021/paperlint/actions/runs/45561402983) | 200 | 200 | `pass` — passed |
| [Homepage returns Gone](https://github.com/sundaram2021/paperlint/actions/runs/45561704279) | 200 | 410 | `regression` — failed with exit `1`; the report linked to the README line |
| [Homepage restored](https://github.com/sundaram2021/paperlint/actions/runs/45561795753) | 200 | 200 | `pass` — passed |

Checked separately, the hosted Vercel preview redirected to sign-in and returned an `inconclusive` verdict. The three runs above did not test automatic Vercel deployment selection. The PR was closed without merging.
