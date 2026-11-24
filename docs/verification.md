# Citation CI verification report

**24 November 2026.** Citation CI caught a broken deep link even though production and preview both served HTTP 200. The GitHub Action exited 1 when the preview dropped the cited section. Restoring that section made the same Action pass. All 22 automated tests and the strict TypeScript check passed on the hosted runner. [GitHub Actions run](https://github.com/sundaram2021/citation-ci/actions/runs/45389139039)

## Hosted experiment

The workflow started two HTTP servers on the runner. Production served `/auth.html` with an element whose ID was `keys`. Preview served the same route without that element. The input file contained one synthetic citation ending in `/auth.html#keys`. After the first check, the workflow copied production's HTML into the preview and ran the composite Action again. [Workflow](../.github/workflows/test.yml)

| Observation | Before repair | After repair |
| --- | --- | --- |
| Production HTTP response | 200 | 200 |
| Preview HTTP response | 200 | 200 |
| Preview contains the cited anchor | No | Yes |
| Citation CI verdict | `regression` | `pass` |
| Composite Action | Failed, exit 1 | Succeeded |

The outer workflow is green because it explicitly asserts that the first check failed and requires the second check to succeed. In a consumer workflow, omitting `continue-on-error` makes a regression fail the job. Enforcing that job before merge requires the repository's required-check configuration. [Job and step logs](https://github.com/sundaram2021/citation-ci/actions/runs/45389139039/job/138427902289) · [Saved log excerpt](evidence/github-actions.txt)

## Findings from code review

| Case | Corrected behavior | Regression test |
| --- | --- | --- |
| Canonical trailing slash | A working `/docs/`, including a redirect to `/docs`, passes. The original path comparison could flag its own normalized path as a parent section. | `/docs/`, `/canonical/` |
| Redirect to a homepage section | A redirect to `/#okay` passes when the target ID exists. | `/home-section#okay` |
| Redirect explicitly clears the fragment | A cited anchor that is cleared by an empty destination fragment is reported as broken. | `/lost-fragment#okay` |

The suite also covers redirect loops, removed pages, blocked reads, HTML entity decoding and CSV aggregation. Credentialed customer data, AI referral traffic, and citation rankings were outside these measurements. Client-rendered anchors require separate browser verification. [Test cases](../test/citations.test.mjs)

## Reproduce

From a checkout of the tested revision with Node.js 24 or later:

```sh
npm ci
npm run typecheck
npm test
npm run demo
```

The demo checks a separate synthetic redirect, verifies exit 1 for the broken destination, applies the repair, and verifies exit 0. The README shows how to run the same checker on a deployment preview. [Setup instructions](../README.md)
