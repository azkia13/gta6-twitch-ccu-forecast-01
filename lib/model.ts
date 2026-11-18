// Forecast model for gta6-twitch-ccu-forecast-01: a size-regression launch
// curve forecaster. It learns the shape of a release day from the past
// launches shipped inside the case file, then scales that shape to the
// target launch by its own first-hour print.
//
// Idea: for a past launch, the interesting object is not its absolute
// viewers but its intraday shape - the log ratio of each hour's viewers to
// the launch's own hour-1 print. Across many launches those ratios form a
// distribution per hour. The forecast's quantiles are quantiles of that
// distribution, so the spread is honest: it is the spread real launches
// actually showed, not a spread guessed in advance.
//
// The shape depends strongly on size. A small category barely exists at
// hour 1 and then explodes 50-100x at unlock, while a huge launch is
// already enormous at hour 1 and stays near flat: across the comparables
// the correlation between log hour-1 viewers and the mean log ratio is
// about -0.88, a slope of roughly -0.54 per log unit of size, steepest in
// the evening hours (about -0.9) and near zero in the small hours. A
// size kernel alone cannot capture a trend this steep: it either
// localises so tightly that the sample starves, or it averages launches
// whose shapes differ by an order of magnitude. So each hour's centre is
// a weighted linear regression of the log ratio on log hour-1 size,
// predicted at the target's own size. The regression uses every launch
// with data at that hour, weighted by a Gaussian size kernel (width 1.5
// in log viewers, widened until the effective sample reaches 8), so
// near-size launches still dominate the fit while far ones stabilise it.
//
// Two weightings keep the fit relevant to the launch at hand:
//   1. Launches whose hour-1 print is close in size to the target's get
//      more weight in the regression (a Gaussian kernel on the log
//      hour-1 ratio). If the weighting leaves too few launches with real
//      weight, the kernel widens until the effective sample is big enough
//      to trust.
//   2. Launches the kit flags as early-access-contaminated are left out:
//      their release-day curve is bent by players who started days early.
//
// The spread around the regression line is the distribution of the
// regression residuals at that hour: the quantiles of the forecast are
// the regression centre plus quantiles of the residuals. The quantiles
// themselves are an ensemble of two estimators of that residual
// distribution. With only a few dozen launches the empirical quantiles
// are noisy, worst at the 5% and 95% tails, while a normal fit (weighted
// mean and spread of the residuals) is smooth but biased when the
// distribution is skew. Averaging the two halves the variance of the
// tails without trusting either one alone.
//
// The outer quantiles are pulled 15% toward the median: with a few dozen
// launches the 5% and 95% empirical quantiles overshoot, and the pinball
// loss punishes an over-wide band at every hour. The median is the
// regression centre plus the residual median, untouched by the pull.
//
// Beyond the size range the comparables cover, the regression slope is
// halved: the size trend flattens at the top end (the biggest launches
// sit above the straight-line fit in the evening), so a straight
// extrapolation would under-predict a launch bigger than every
// comparable - exactly the situation Grand Theft Auto VI is in.
//
// Everything is computed from the case file at run time; no fitted number
// is baked in, so the same program runs the final case unchanged.

export interface HourlyPoint {
  from: string;
  viewers: number | null;
  channels?: number | null;
}

export interface ComparableLaunch {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}

export interface CaseFile {
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: ComparableLaunch[];
}

/** The quantile levels the contest scores, in order. */
export const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Width of the size kernel, in natural-log units of hour-1 viewers. */
const SIZE_KERNEL_WIDTH = 1.5;
/** How far the outer quantiles are pulled toward the median (1 = no pull). */
const SPREAD_PULL = 0.85;
/** Weight of the normal-fit quantiles in the ensemble (0 = purely empirical). */
const NORMAL_BLEND = 0.5;
/** Standard-normal quantiles at the contest's levels, in LEVELS order. */
const NORMAL_Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Smallest effective sample the kernel is allowed to leave behind. */
const MIN_EFFECTIVE_LAUNCHES = 8;
/** Widest the kernel may grow while chasing that sample. */
const MAX_KERNEL_WIDTH = 3.0;
/** Smallest number of launches that may inform one hour at all. */
const MIN_LAUNCHES_PER_HOUR = 5;
/** Slope kept beyond the observed size range (1 = straight extrapolation). */
const SLOPE_SHRINK = 0.5;

/** A launch's release-day curve, reduced to its hour-1 print and the
 *  log ratio of every later hour to it. Hours with no usable point are
 *  simply absent. */
export interface LaunchShape {
  name: string;
  hourOne: number;
  logRatio: Map<number, number>;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function hourOf(iso: string): number {
  return Number(iso.slice(11, 13)) + 1;
}

/** True when the kit's own research note marks this launch's release day
 *  as bent by early access (its peak happened days before release). */
export function isEarlyAccessContaminated(launch: ComparableLaunch): boolean {
  return (launch.unlock ?? '').includes('early-access-contaminated');
}

/** Pull the release-day shape out of one comparable launch. Returns null
 *  when the launch has no usable hour-1 print (the target's own
 *  pre-release history is such a launch: it never had a release day). */
export function launchShape(launch: ComparableLaunch): LaunchShape | null {
  const day = dayOf(launch.day_start);
  const byHour = new Map<number, number>();
  for (const point of launch.hourly) {
    if (point.viewers === null || point.viewers <= 0) continue;
    if (dayOf(point.from) !== day) continue;
    byHour.set(hourOf(point.from), point.viewers);
  }
  const hourOne = byHour.get(1);
  if (hourOne === undefined) return null;
  const logRatio = new Map<number, number>();
  for (const [hour, viewers] of byHour) {
    if (hour === 1) continue;
    logRatio.set(hour, Math.log(viewers / hourOne));
  }
  return { name: launch.name, hourOne, logRatio };
}

/** Gaussian kernel weight: 1 for a launch the same size as the target,
 *  fading as the hour-1 prints drift apart in log space. */
function sizeWeight(launchHourOne: number, targetHourOne: number, width: number): number {
  const d = Math.log(launchHourOne / targetHourOne) / width;
  return Math.exp(-0.5 * d * d);
}

/** Effective sample size of a weight list: (sum w)^2 / sum w^2. */
function effectiveCount(weights: number[]): number {
  let sum = 0;
  let sumSq = 0;
  for (const w of weights) {
    sum += w;
    sumSq += w * w;
  }
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

/** Interpolated quantile of a weighted sample: pairs of (value, weight),
 *  read off the weighted empirical distribution with linear interpolation
 *  between neighbouring order statistics. */
export function weightedQuantile(pairs: Array<[number, number]>, tau: number): number {
  const ordered = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = ordered.reduce((acc, [, w]) => acc + w, 0);
  if (ordered.length === 1 || total <= 0) return ordered[0][0];
  // Each value sits at the middle of its own weight's span.
  const anchors: Array<[number, number]> = [];
  let seen = 0;
  for (const [value, w] of ordered) {
    anchors.push([seen + w / 2, value]);
    seen += w;
  }
  const target = tau * total;
  if (target <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (target >= last[0]) return last[1];
  for (let i = 0; i + 1 < anchors.length; i++) {
    const [x0, v0] = anchors[i];
    const [x1, v1] = anchors[i + 1];
    if (target >= x0 && target <= x1) {
      const f = x1 > x0 ? (target - x0) / (x1 - x0) : 0;
      return v0 * (1 - f) + v1 * f;
    }
  }
  return last[1];
}

/** Weighted mean and standard deviation of a weighted sample: the normal
 *  fit the ensemble blends against the empirical quantiles. */
function weightedMeanSd(pairs: Array<[number, number]>): [number, number] {
  let total = 0;
  let mean = 0;
  for (const [value, w] of pairs) {
    total += w;
    mean += value * w;
  }
  if (total <= 0) return [pairs[0][0], 0];
  mean /= total;
  let variance = 0;
  for (const [value, w] of pairs) {
    variance += w * (value - mean) * (value - mean);
  }
  return [mean, Math.sqrt(variance / total)];
}

/** Weighted least squares of y on x: returns [intercept, slope] for the
 *  line y = a + b*x. Triples are (x, y, weight). A zero spread in x falls
 *  back to the weighted mean with a flat slope. */
function weightedLeastSquares(triples: Array<[number, number, number]>): [number, number] {
  let total = 0;
  let meanX = 0;
  let meanY = 0;
  for (const [x, y, w] of triples) {
    total += w;
    meanX += x * w;
    meanY += y * w;
  }
  if (total <= 0) return [triples[0][1], 0];
  meanX /= total;
  meanY /= total;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y, w] of triples) {
    sxx += w * (x - meanX) * (x - meanX);
    sxy += w * (x - meanX) * (y - meanY);
  }
  if (sxx <= 0) return [meanY, 0];
  const slope = sxy / sxx;
  return [meanY - slope * meanX, slope];
}

/** The five quantiles of one hour's log ratio, as viewer counts. The
 *  centre is the size regression's prediction at the target's size; the
 *  spread is the residual distribution around that line, as the average
 *  of its empirical quantiles and a normal fit's quantiles, with the
 *  outer quantiles pulled toward the residual median by SPREAD_PULL. */
function hourQuantiles(
  shapes: LaunchShape[],
  hour: number,
  targetHourOne: number,
): number[] | null {
  let width = SIZE_KERNEL_WIDTH;
  let triples: Array<[number, number, number]> = [];
  // Widen the kernel until enough launches carry real weight, or the cap.
  while (true) {
    triples = [];
    for (const shape of shapes) {
      const ratio = shape.logRatio.get(hour);
      if (ratio === undefined) continue;
      triples.push([Math.log(shape.hourOne), ratio, sizeWeight(shape.hourOne, targetHourOne, width)]);
    }
    if (triples.length < MIN_LAUNCHES_PER_HOUR) return null;
    if (effectiveCount(triples.map(([, , w]) => w)) >= MIN_EFFECTIVE_LAUNCHES) break;
    if (width >= MAX_KERNEL_WIDTH) break;
    width *= 1.25;
  }
  const [intercept, slope] = weightedLeastSquares(triples);
  const targetX = Math.log(targetHourOne);
  let centre = intercept + slope * targetX;
  // Beyond the size range the comparables cover, keep only half the
  // slope: the size trend flattens at the top end, so a straight
  // extrapolation would under-predict a launch bigger than every
  // comparable - exactly the situation Grand Theft Auto VI is in.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of triples) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (targetX > maxX) {
    centre = intercept + slope * maxX + slope * SLOPE_SHRINK * (targetX - maxX);
  } else if (targetX < minX) {
    centre = intercept + slope * minX + slope * SLOPE_SHRINK * (targetX - minX);
  }
  const residuals: Array<[number, number]> = triples.map(([x, y, w]) => [
    y - (intercept + slope * x),
    w,
  ]);
  const median = weightedQuantile(residuals, 0.5);
  const [mean, sd] = weightedMeanSd(residuals);
  return LEVELS.map((tau, i) => {
    const empirical = weightedQuantile(residuals, tau);
    const normal = mean + NORMAL_Z[i] * sd;
    const q = (1 - NORMAL_BLEND) * empirical + NORMAL_BLEND * normal;
    return targetHourOne * Math.exp(centre + median + SPREAD_PULL * (q - median));
  });
}

/** Round to 2 decimals, half up, then keep the value inside the range
 *  the contest accepts. Rounding is monotone, so the quantiles stay
 *  in order. */
function clean(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded) || rounded <= 0) return 0.01;
  return Math.min(rounded, 1_000_000_000);
}

/** Forecast every hour the case asks for. Returns hour -> five quantiles.
 *  An hour no launch can inform falls back to the target's own first-hour
 *  print at every quantile: a flat forecast is honest about knowing
 *  nothing, and a missing hour would invalidate the whole case. */
export function forecastCase(c: CaseFile): Map<number, number[]> {
  const hourOneRow = c.known.find((k) => k.hour === 1);
  if (hourOneRow === undefined) throw new Error('case has no hour-1 print');
  const targetHourOne = Math.max(1, hourOneRow.viewers);
  const shapes: LaunchShape[] = [];
  for (const launch of c.comparables) {
    if (isEarlyAccessContaminated(launch)) continue;
    const shape = launchShape(launch);
    if (shape !== null) shapes.push(shape);
  }
  const out = new Map<number, number[]>();
  const seenHours = new Set<number>();
  for (const row of c.forecast) {
    if (row.hour < 2 || row.hour > 24) {
      throw new Error(`case asks for hour ${row.hour}, outside 2..24`);
    }
    if (seenHours.has(row.hour)) {
      throw new Error(`case asks for hour ${row.hour} twice`);
    }
    seenHours.add(row.hour);
    const quantiles = hourQuantiles(shapes, row.hour, targetHourOne);
    if (quantiles === null) {
      out.set(row.hour, LEVELS.map(() => targetHourOne));
    } else {
      out.set(row.hour, quantiles.map(clean));
    }
  }
  return out;
}
