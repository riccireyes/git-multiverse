# Git Multiverse

A 3D "Sacred Timeline" view of a Git repository. `main` is the golden timeline, every other branch is its own colored timeline, and commits become draggable infinity stones.

## Run

```bash
npm install
npm run dev
```

## Controls

| Action | Effect |
| --- | --- |
| Hover a timeline | Its stones (commits) rise out of it |
| Click a timeline | Pin it (stones stay visible, panel lets you commit) |
| Click a stone | Show its file changes and patch |
| Drag a stone onto another timeline | Cherry-pick that commit there |
| Drag a timeline's tip ring onto another | Merge it into that timeline |
| Right-click a timeline or stone | Create a new branch from that point |
| Scroll / left-drag / right-drag | Zoom / orbit / pan |
| `Space` / `F` / `H` / `Esc` | Replay / frame all / recent history / close |

While dragging, the target is checked for conflicts. A conflict is a **nexus event**: the timeline flashes red and nothing changes. Timelines that have fallen far behind `main` pulse red too (threshold in ⚙ settings).

## Time bar

The strip at the bottom shows the whole history as a commit histogram:

- **Gold band**: the slice of history that's loaded (only this is rendered). Drag its handles to load more or less.
- **Bright bracket**: what the camera is looking at. Drag it to pan.
- **Drag across the bar**: pick a timeframe. Inside the loaded band the camera frames it; outside, that timeframe gets loaded.
- **Click**: jump to a date.
- **▶**: replay the loaded history; timelines grow in order and the camera follows. Drag the red playhead to scrub; **Live** shows everything again.

Big repositories stay fast: only one window of commits (800 by default, set in ⚙) is loaded, and stones are only created for the part of a timeline that's on screen.

## Timelines panel

Eye toggles show or hide timelines, **◎** focuses on one timeline (plus the timelines it came from), the filter box searches, and **Show merged history** toggles the reconstructed deleted-and-merged branches.

## Brightness

⚙ has Brightness and Glow sliders. Timelines dim automatically as you zoom in, and also while their stones are revealed, so the stones stand out.

## Real repositories

Paste a local repo path into the top-left box and press **Load**.

By default everything is **simulated in memory**. Turn on **Write changes to the repository** to perform operations for real. Each one asks for confirmation and shows the equivalent git command. Writes are built in the object database (`git merge-tree` / `git commit-tree`), so your working tree is never touched, with one exception: a checked-out branch is fast-forwarded, and only when its working tree is clean. Conflicting cherry-picks and merges are refused.

## Layout

- `server/gitApi.ts`: Vite middleware: history windows, histogram, diffs, conflict checks and write operations.
- `src/model.ts`: Git model: in-memory store, branch ownership, fork/merge detection, 3D lane layout, time mapping.
- `src/sources.ts`: demo and on-disk data sources (same interface).
- `src/demo.ts`: multi-year generated demo history.
- `src/stream.ts`: one glowing timeline (GPU particle flow, core/halo tubes, spiral filaments, nexus pulse, replay cutoff).
- `src/effects.ts`: sling-ring portals, stones, tip rings, merge braids, starfield.
- `src/view.ts`: builds the scene from a layout; visibility, stones, labels.
- `src/timebar.ts`: the time bar.
- `src/main.ts`: renderer, camera, interaction, replay, settings.

## License

[MIT](LICENSE) © 2026 Ricci Reyes
