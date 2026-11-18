# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/azkia13/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/azkia13/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast Grand Theft Auto VI's launch-day Twitch viewers hour by hour: for each of hours 2 to 24 of 2026-11-19 (UTC), five quantiles of that hour's concurrent viewers, from the first hour's print and the release-day shapes of 42 past big launches shipped in the case file.

## Model

The shape of a release day is learned from the comparables, not guessed. For a past launch the model takes the log ratio of each hour's viewers to that launch's own hour-1 print; across launches those ratios form a distribution per hour, and the forecast's quantiles are quantiles of that distribution. The centre of each hour's distribution is a size regression, not a plain average:

- **Size regression.** The shape depends strongly on size: a small category barely exists at hour 1 and then explodes 50–100× at unlock, while a huge launch is already enormous at hour 1 and stays near flat (correlation −0.88 between log hour-1 viewers and the mean log ratio, slope ≈ −0.54 per log unit, steepest ≈ −0.9 in the evening hours). Each hour's centre is a weighted linear regression of the log ratio on log hour-1 size, predicted at the target's own size, so a launch bigger than every comparable is forecast by the trend rather than by averaging smaller launches. Beyond the comparables' size range the slope is halved, because the trend flattens at the top end.
- **Size kernel.** Launches whose hour-1 print is close in size to the target's get more weight in the regression (a Gaussian kernel, width 1.5 in log viewers). If the weighting leaves too few launches with real weight, the kernel widens until the effective sample reaches 8.
- **Early-access filter.** Launches the kit flags as early-access-contaminated are left out: their release-day curve is bent by players who started days early.
- **Empirical + normal ensemble.** The spread around the regression line is the residual distribution at that hour. Each level's quantile averages the weighted empirical quantile of the residuals with a normal fit's quantile (weighted mean and spread of the residuals at that hour). With a few dozen launches the empirical tails are noisy and the normal fit is smooth but biased when the distribution is skew; averaging halves the tails' variance without trusting either alone. The median is the regression centre plus the residual median.

The outer quantiles are pulled 15% toward the median, because with a few dozen launches the 5% and 95% empirical quantiles overshoot. Everything is computed from the case file at run time; no fitted number is baked in.

## Practice backtest

Scored with the contest's exact pinball loss on the log scale, against the four practice launches' real SullyGnome hourly prints (answers verified to match each case's hour-1 print):

| model | mean loss | p00 Wolverine | p01 RDR2 | p02 GoW Ragnarök | p03 Spider-Man 2 |
|---|---|---|---|---|---|
| house baseline (starter) | 0.387 | 0.744 | 0.287 | 0.215 | 0.303 |
| v1 (empirical quantiles only) | 0.196 | 0.293 | 0.164 | 0.132 | 0.193 |
| v2 (empirical + normal ensemble) | 0.185 | 0.266 | 0.155 | 0.126 | 0.194 |
| **v3 (this entry, size regression)** | **0.160** | **0.175** | **0.163** | **0.121** | **0.182** |

Typical miss 20–32% per case (mean 25%), 90% coverage 0.78–1.00 (mean 0.94). The baseline's loss reproduces the kit's published ~0.387, which validates the scorer. The practice losses above reproduce the server's own breakdowns for v1 and v2 to 6 decimals (0.195633 and 0.185170), so the backtest is the official scorer on the same four cases.

The v3 improvement was chosen on three protocols, not on the four practice cases alone: the same backtest above, leave-one-out over the comparables with hour-1 ≥ 20k viewers (v3 0.258 vs v2 0.267, and v3 also wins at ≥ 50k and over all targets), and extrapolation leave-one-out — targets bigger than every launch in their pool, the situation GTA VI itself is in — where v3 scores 0.145 against v2's 0.226. Variants that helped only the practice cases (narrower size kernel, heavier normal blend, tighter spread pull, asymmetric pulls, a quadratic size term) were tried and dropped because they made leave-one-out worse or flat.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, no randomness: two runs on the same case write the same bytes (0.2 s for all four practice cases). Reads every `<id>.in` in the input directory and writes one `<id>.out` per case: `{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, ...]}`.

## Layout

- `main.ts` — entrypoint: read cases, write forecasts, check the output shape.
- `lib/model.ts` — the forecaster: comparable launch curves, per-hour size regression, residual quantiles, adaptive kernel width.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
