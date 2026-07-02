# repo-dash

A single-file, zero-dependency dashboard for a repo you're actively working
in — especially useful once you're running multiple [Claude Code](https://claude.com/claude-code)
sessions and git worktrees in parallel and lose track of what's where.

It answers, in one page:

- **Ladder** — where do `dev`/`beta`/`live` (or whatever your promotion chain
  is) sit relative to each other?
- **Worktrees** — which worktrees exist, what branch/commit are they on, are
  they clean, and are they behind the integration branch?
- **Sessions** — which Claude Code session (and which of its background jobs)
  is working in which worktree, on what, and what did you last ask it?
- **Cleanup candidates** — worktrees with no unique commits over the
  integration branch, cross-checked against GitHub's merged-PR state via `gh`,
  with a ready `git worktree remove` / `git branch -D` command
- **Needs update** — worktrees behind the integration branch, with the
  `git merge` command to fix it
- **Dev servers** — what's actually running and on which port

Nothing here executes a destructive action for you — cleanup/update rows print
copy-paste commands, they don't run them. This is meant to run on your own
machine (or over Tailscale to your own devices), not as a public service.

## Use

```sh
node dash.mjs           # one-shot CLI report
node dash.mjs --serve   # serve a live, auto-refreshing page on :7799
npx github:weiv/repo-dash --serve   # run it without cloning
```

Run it from anywhere inside the git repo you want to inspect — it finds the
repo root itself.

For an always-on dashboard (e.g. via `launchd`/`systemd`), point it at a
dedicated worktree checked out to your integration branch, not your daily
working checkout — otherwise every dashboard update requires committing to
whatever branch you happen to have checked out.

## Requirements

- Node.js 18+
- `git` (required)
- [`gh`](https://cli.github.com/) (optional — enables Open PRs, merged-PR
  detection for cleanup candidates)

## Configuration

Everything is an optional environment variable; with none set it still works,
using sane generic defaults:

| Variable | Default | Purpose |
|---|---|---|
| `DASH_NAME` | repo name, title-cased | Display name |
| `DASH_LADDER` | the repo's actual default branch, alone | Comma-separated promotion ladder, e.g. `dev,beta,live`. First entry is the "integration" branch everything else is measured against. |
| `DASH_PREVIEW_URL` | none | Per-branch preview link template, e.g. `https://{branch}-myapp.pages.dev` — `{branch}` is replaced with a slugified branch name |
| `DASH_DEV_PROCS` | `vite\|webpack-dev-server\|next dev\|http\.server\|nodemon` | Regex `ps` pattern for the Dev servers section |
| `FB_URL` + `FB_KEY` | unset (panel omitted) | Optional remote usage/feedback panel — GETs `${FB_URL}/dash?format=json&key=${FB_KEY}`; KPI labels are derived from whatever keys the endpoint's `usage.kpis` object returns |

## How it finds sessions

Claude Code session transcripts live at
`~/.claude/projects/<slugified-repo-path>/*.jsonl`. Each session's cwd is
matched against the live `git worktree list` output (by path prefix, so a
session whose cwd was a subdirectory still resolves to the right worktree),
giving you the worktree ↔ branch ↔ session correspondence.

## License

MIT
