# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/azkia13/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/azkia13/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast Grand Theft Auto VI's launch-day Twitch viewers hour by hour: for each of hours 2 to 24 of 2026-11-19 (UTC), five quantiles of that hour's concurrent viewers, from the first hour's print and the release-day shapes of 42 past big launches shipped in the case file.

## Model

The shape of a release day is learned from the comparables, not guessed. For a past launch the model takes the log ratio of each hour's viewers to that launch's own hour-1 print; across launches those ratios form a distribution per hour, and the forecast's quantiles are quantiles of that distribution. Two weightings keep the distribution relevant:

- **Size kernel.** Launches whose hour-1 print is close in size to the target's get more weight (a Gaussian kernel, width 1.0 in log viewers). A launch ten times smaller peaks at a different time of day than a huge one. If the weighting leaves too few launches with real weight, the kernel widens until the effective sample reaches 8.
- **Early-access filter.** Launches the kit flags as early-access-contaminated are left out: their release-day curve is bent by players who started days early.

The outer quantiles are pulled 15% toward the median, because with a few dozen launches the 5% and 95% empirical quantiles overshoot. Everything is computed from the case file at run time; no fitted number is baked in.

## Practice backtest

Scored with the contest's exact pinball loss on the log scale, against the four practice launches' real SullyGnome hourly prints (answers verified to match each case's hour-1 print):

| model | mean loss | p00 Wolverine | p01 RDR2 | p02 GoW Ragnarök | p03 Spider-Man 2 |
|---|---|---|---|---|---|
| house baseline (starter) | 0.387 | 0.744 | 0.287 | 0.215 | 0.303 |
| this entry | **0.196** | 0.293 | 0.164 | 0.132 | 0.193 |

Typical miss 19–75% per case (mean 37%), 90% coverage 0.78–0.96 (mean 0.90). The baseline's loss reproduces the kit's published ~0.387, which validates the scorer.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, no randomness: two runs on the same case write the same bytes (0.2 s for all four practice cases). Reads every `<id>.in` in the input directory and writes one `<id>.out` per case: `{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, ...]}`.

## Layout

- `main.ts` — entrypoint: read cases, write forecasts, check the output shape.
- `lib/model.ts` — the forecaster: comparable launch curves, weighted empirical quantiles, adaptive kernel width.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
