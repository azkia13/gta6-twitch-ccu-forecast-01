// Forecast model for gta6-twitch-ccu-forecast-01: an empirical launch-curve
// forecaster. It learns the shape of a release day from the past launches
// shipped inside the case file, then scales that shape to the target launch
// by its own first-hour print.
//
// Idea: for a past launch, the interesting object is not its absolute
// viewers but its intraday shape - the log ratio of each hour's viewers to
// the launch's own hour-1 print. Across many launches those ratios form a
// distribution per hour. The forecast's quantiles are quantiles of that
// distribution, so the spread is honest: it is the spread real launches
// actually showed, not a spread guessed in advance.
//
// Two weightings keep the distribution relevant to the launch at hand:
//   1. Launches whose hour-1 print is close in size to the target's get
//      more weight (a Gaussian kernel on the log hour-1 ratio). A launch
//      ten times smaller peaks at a different time of day than a huge one.
//   2. Launches the kit flags as early-access-contaminated are left out:
//      their release-day curve is bent by players who started days early.
// If the weighting leaves too few launches with real weight, the kernel
// widens until the effective sample is big enough to trust.
//
// The outer quantiles are pulled 15% toward the median: with a few dozen
// launches the 5% and 95% empirical quantiles overshoot, and the pinball
// loss punishes an over-wide band at every hour. The median is untouched.
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
const SIZE_KERNEL_WIDTH = 1.0;
/** How far the outer quantiles are pulled toward the median (1 = no pull). */
const SPREAD_PULL = 0.85;
/** Smallest effective sample the kernel is allowed to leave behind. */
const MIN_EFFECTIVE_LAUNCHES = 8;
/** Widest the kernel may grow while chasing that sample. */
const MAX_KERNEL_WIDTH = 3.0;
/** Smallest number of launches that may inform one hour at all. */
const MIN_LAUNCHES_PER_HOUR = 5;

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

/** The five quantiles of one hour's log ratio, as viewer counts. The
 *  median anchors the forecast; the outer quantiles are pulled toward it
 *  by SPREAD_PULL so a thin sample does not overstate the spread. */
function hourQuantiles(
  shapes: LaunchShape[],
  hour: number,
  targetHourOne: number,
): number[] | null {
  let width = SIZE_KERNEL_WIDTH;
  let pairs: Array<[number, number]> = [];
  // Widen the kernel until enough launches carry real weight, or the cap.
  while (true) {
    pairs = [];
    for (const shape of shapes) {
      const ratio = shape.logRatio.get(hour);
      if (ratio === undefined) continue;
      pairs.push([ratio, sizeWeight(shape.hourOne, targetHourOne, width)]);
    }
    if (pairs.length < MIN_LAUNCHES_PER_HOUR) return null;
    if (effectiveCount(pairs.map(([, w]) => w)) >= MIN_EFFECTIVE_LAUNCHES) break;
    if (width >= MAX_KERNEL_WIDTH) break;
    width *= 1.25;
  }
  const median = weightedQuantile(pairs, 0.5);
  return LEVELS.map((tau) => {
    const q = weightedQuantile(pairs, tau);
    return targetHourOne * Math.exp(median + SPREAD_PULL * (q - median));
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
