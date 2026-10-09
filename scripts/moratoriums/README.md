# Data center moratorium pipeline

Builds the `dc-moratoriums` layer (see [`docs/layers/dc-moratoriums.md`](../../docs/layers/dc-moratoriums.md))
and refreshes it every week. Two parts:

| Part | Where | What it does |
|---|---|---|
| Build | `build*.py`, `sync.py`, `rebuild.sh` | Turns the Moratorium Nation snapshot plus TransmissionMap research CSVs into the four published files |
| Weekly refresh | `refresh/`, `.github/workflows/moratorium-refresh.yml` | Searches for new and changed measures, verifies each against its source page, rebuilds, and publishes to `data-moratoriums`: a direct commit by default, or a pull request to review first |

The map reads the published files from the root of the `data-moratoriums`
branch. Each weekly run commits there directly, with the week's report as the
commit message, so a week goes live without review and is undone with
`git revert`. Dispatching with `publish: pull_request` opens a pull request
instead, and merging it publishes.

## Directory layout

Every script takes `--work WORK` (env `DCM_WORK`), `--dataset DATASET` and
`--build BUILD`.

| Name | Default | Holds |
|---|---|---|
| `WORK/inputs/` | | `research/`, `additions.csv`, `state_additions.csv`, `territories/`, `county_names.csv`, `upstream.sha`, `upstream_as_of`, `refresh_state.json` |
| `WORK/upstream` | | Moratorium Nation clone at the commit in `inputs/upstream.sha` |
| `WORK/census` | | `cb_2023_us_{county,place,cousub}_500k.zip` (Census cartographic boundaries) |
| `DATASET` | `WORK/dataset` | Published files: `README.md`, `moratoriums.csv`, `events.csv` (append-only), `dc_moratoriums.geojson`. On the runner this is the `data-moratoriums` checkout root |
| `BUILD` | `WORK/build` | Intermediates and logs: upstream-schema `moratoriums.csv`, `research_additions.csv`, `state_actions.csv`, `qa_research.csv`, `logs/`, `run_report.json`, `pr_body.md` |

`rebuild.sh` runs `build.py`, `build_research.py`, `build_state.py`, `sync.py`
and `build_layer.py` in that order. `build_territories.py` is a one-off that
writes `inputs/territories/{retail,ba}.geojson.gz` from HIFLD and EIA sources
(needs `pyarrow`); `rebuild.sh` does not run it.

## `data-moratoriums` branch

```
README.md  moratoriums.csv  events.csv  dc_moratoriums.geojson     published (what the map reads)
inputs/
  research/2026-10-07/{,pass2/,pass3/}     the first research passes
  research/weekly/<date>/                  one folder per refresh run (CSVs + notes.md)
  additions.csv  state_additions.csv
  territories/{retail,ba}.geojson.gz       pre-simplified service areas
  county_names.csv                         county_fips,state,county_name
  upstream.sha                             pinned Moratorium Nation commit
  upstream_as_of                           that snapshot's date (build.py's TODAY, for expiry status)
  refresh_state.json                       row id -> last_queried, rotates follow-up checks
```

The branch has real history. `events.csv` is only ever appended to, and the
workflow checks that the base file is a byte prefix of the new one.

## Weekly workflow

`.github/workflows/moratorium-refresh.yml` runs on the 1st and 15th of each
month at 09:23 UTC and on
`workflow_dispatch`. The YAML must be on `main` for either to work.

| `mode` | What happens |
|---|---|
| `research` (schedule default) | Live Brave search, model extraction, quote check, rebuild, publish |
| `dry_run` | Fixture search and stub model in a temporary copy; prints the PR body; no push. `research` falls back to this, with a notice, when a search or model key is missing |
| `rebuild_only` | No search, no model. With no refresh PR open it rebuilds as of the geojson's own `generated_utc` and must show no diff (the reproducibility check); with one open it rebuilds as of the run date and force-pushes `refresh/weekly` |

Dispatch inputs: `mode`; `publish` (`direct`, the default and what the
schedule uses, commits to `data-moratoriums`; `pull_request` opens or updates
the rolling refresh PR); `max_requests` (Brave request cap, default 220);
`models` (optional `triage,escalation,review` model ids, blank parts keep the
default; sets `DCM_TRIAGE_MODEL`, `DCM_ESCALATION_MODEL` and `DCM_REVIEW_MODEL`).

Pipeline per run: seed pages and planned queries, search, fetch, extract,
verify, review, write `inputs/research/weekly/<date>/`, rebuild, schema check,
publish. Three models split the work:

| Role | Default | What it does |
|---|---|---|
| Triage | Claude Haiku 5.5 | Reads every fetched page and fills the extraction schema |
| Escalation | Claude Sonnet 5.5 | Re-reads a page when an item's confidence is below 0.7, or it is a ban, a utility measure or a change to an upstream row |
| Review | Claude Opus 5.5 | Judges each change before it is written (below) |

Review (`refresh/review.py`, `refresh/prompts/review.md`): every new row and
every change to a tracked row first passes code checks (a new state-level
measure the dataset already holds; a change whose page names a different level
of government than the row it changes), then the review model reads the
tracked row, the proposed values, the quote, the page around it and the
state's other measures, and accepts it or names what fails: a different place,
a duplicate, something proposed rather than done, an unsupported or vaguer
date, a wrong status, not a qualifying measure, or a weak source overriding a
specific one. A rejected change is not written: it is listed with its reasons
under "Rejected in review" in the report and in that run's `notes.md`. A
change the model could not review (error, refusal, wall clock or cap) is
rejected too. A new measure the reading model rated below 0.6 confidence is
rejected without a model call. Two rules apply before review: a `pending`
measure gets no end date, and a change never replaces a tracked date with a
vaguer form of it.

A run uses one UTC date for `--as-of`, the weekly folder and the branch name,
and replaces that date's weekly folder, so the workflow refuses a second
`research` run on a date `data-moratoriums` already has; run it again the next
UTC day.

In `pull_request` mode, one rolling branch, `refresh/weekly`, is reset to the
`data-moratoriums` tip each run. If a refresh PR is open its weekly folders are carried over first,
and the run fails if the PR changed anything outside `inputs/research/weekly/`
or the four published files, since a rebuild would overwrite it. A closed PR is
not carried over. Because carried-over rows are re-synced each run, their
`events.csv` `recorded_at` is the latest run's date.

### Secrets and settings

| Name | Where | Needed for |
|---|---|---|
| `BRAVE_API_KEY` | Actions secret | Search (`research`) |
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` | Actions secret | Model extraction; Anthropic is used when both are set |
| `DCM_CONTACT` | Actions secret, optional | Contact (email or URL) in the fetcher's User-Agent, which SEC EDGAR requires; defaults to the repo URL |
| Allow GitHub Actions to create and approve pull requests | Settings > Actions > General > Workflow permissions | Opening the PR (a 403 from `gh` names this setting) |

Python is 3.12 with exact pins in `requirements-refresh.txt`, installed with
`--require-hashes`, so dependencies are pinned too; the file's header says how
to regenerate the hashes. Bump the pins together, then dispatch `rebuild_only`
and confirm no diff. The unit tests stay stdlib-only.

The workflow's third-party actions are pinned to commit SHAs. Neither checkout
keeps the job token: only the two steps that push `refresh/weekly` receive it,
in their own environment, so the steps that fetch and parse web pages are
never given a credential that can write to the repo.

### Caps and cost

| Cap | Value (`refresh/config.py`, override with `DCM_<NAME>`) |
|---|---|
| Brave requests (retries count) | 220: planned shares of pending 80, expiring 50, utilities 20, rotating no-end-date 30, discovery 20 reserved; the rest is retry slack |
| Pages fetched | 300 |
| Extraction calls / escalation calls | 400 / 40 (`max_llm_calls`, `max_escalation_calls`) |
| Review calls | 60 (`max_review_calls`); a change past the cap is rejected unreviewed |
| Job timeout | 120 minutes; fetch and model calls run 4 at a time; a rate limit (HTTP 429) is retried 5 times, honouring `Retry-After` |

Every run publishes a commit, because `refresh_state.json` and `notes.md`
change on every run even when nothing new is found. A run stops cleanly at any
cap, including a 90-minute wall clock (`wall_clock_minutes`): searches,
fetches and extraction stop 10 minutes (`review_minutes`) earlier so the review
always has time, and the cap is listed under "Caps hit" in the report. Brave
bills about $5 per 1,000 requests against a monthly credit, so a full run is
about $1.10 and the two runs a month use about 440 requests. Model cost
depends on the pages found: the first run (2026-10-09, Sonnet reading pages
and Opus escalating, no review) cost $4.12; with Haiku reading pages and Opus
only reviewing, a run is estimated at $1.50 to $2. The report and job summary
show tokens (including cache reads) and an estimated cost from the prices in
`config.py`.

## Reviewing a week

A direct run's report is its commit message on `data-moratoriums` (and
`pr_body.md` in the run's artifact); a pull-request run puts it in the PR body.

1. Read the report: new rows on the map, updated rows (each event with its old and new value), changes rejected in review with their reasons, QA flags, territory warnings, fetch rate, caps hit, cost.
2. Open each source link for the rows. Every new row is marked unconfirmed and carries its quote in the row's notes.
3. Read `inputs/research/weekly/<date>/notes.md`: leads that failed verification (page unreadable, quote not found, no county), changes rejected in review, and seed-page results. Promote a lead or a rejected change by adding a row to that week's CSVs, citing a page.
4. To reject a row, add an `updates.csv` line with `field=DROP` for its id (columns `file,id,field,old,new,source_urls,source_quality,notes`; `file` is the CSV it came from), or delete the row, under `inputs/research/weekly/`: on `data-moratoriums` for a direct run (then rebuild locally with `rebuild.sh` and commit the regenerated files), or in the PR branch then dispatch `mode=rebuild_only`. Do not edit the published CSVs or geojson by hand; the rebuild regenerates them. To take back a whole direct week, `git revert` its commit.
5. For a pull request, merge it. The map serves the new files from `data-moratoriums`.

## Moving the Moratorium Nation pin

`inputs/upstream.sha` (on `data-moratoriums`) names the upstream commit the
workflow clones, and `inputs/upstream_as_of` beside it is the date of that
snapshot, which `build.py` uses as `TODAY` to infer upstream row status. Change
both in one pull request to `data-moratoriums`, so the sha and its date always
merge together. Then dispatch `rebuild_only` and review the expected diff.
When `upstream_as_of` is absent, `build.py` logs a line and uses 2026-10-03,
the date of the first pin. Upstream column changes fail the build loudly
before any PR opens.

## Model probe

With a key in the environment, `PYTHONPATH=scripts python -m moratoriums.refresh.llm --probe --provider anthropic --out <dir>`
(or `--provider openrouter`) sends one small request and writes the raw reply to `probe_<provider>.json`.
After checking it holds no secrets, it can replace `refresh/fixtures/<provider>_response.json`, which the
parser tests read.

## Local use

```bash
bash scripts/moratoriums/rebuild.sh --work <WORK> --dataset <DATASET> --build <BUILD> [--as-of YYYY-MM-DD]
make test-pipeline
```

`rebuild.sh` needs `WORK/inputs`, `WORK/upstream` and `WORK/census` in place
and `--as-of` defaults to today (UTC). `python -m moratoriums.refresh.run`
runs with `PYTHONPATH=scripts`; `--mode dry_run` uses the fixtures and a stub
model, with no network. `make test-pipeline` runs the stdlib unit tests,
including `scripts/test_dcm_*.py`.
