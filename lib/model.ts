// Forecast model for gta6-twitch-ccu-forecast-01, v4: a size-regression launch
// curve forecaster with a pre-release hype term.
//
// What a past launch looked like on its release day is summarised, per
// launch, as the log ratio of each hour's viewers to that launch's own
// hour-1 print. The forecast for one hour is built from a weighted
// regression of that log ratio on two launch-level predictors, fitted
// across the comparables that have data at that hour:
//
//   1. log hour-1 viewers (size). Small categories barely exist at hour 1
//      and then explode 50-100x at unlock, while a huge launch is already
//      enormous at hour 1 and stays near flat: the correlation between log
//      hour-1 viewers and the mean log ratio is about -0.88, a slope near
//      -0.54 per log unit of size, steepest in the evening (about -0.9).
//      Fitting the slope directly beats relying on a size kernel to
//      localise, which either starves the sample or averages launches
//      whose shapes differ by an order of magnitude.
//   2. the pre-release ratio: log(mean viewers over the 24 hours before
//      the release day / hour-1 viewers). A launch that was already hot
//      before its release day behaves differently through the day: its
//      early hours run lower (the pre-release audience is already counted
//      in hour 1) and its evening peak runs higher, with a coefficient
//      near -0.2 at hours 2-4 rising smoothly to about +0.15 in the
//      evening. The coefficient's smooth march across the hours, and the
//      fact that the term improves leave-one-out scores on 11 of 18
//      size-relevant targets as well as the practice cases, is what makes
//      it a real signal rather than a backtest artefact. Rolling-midnight
//      launches are measured the same way on both sides: the 24-hour
//      window before UTC midnight already contains the first regions'
//      unlock (New Zealand from 11:00Z), so the ratio also captures how
//      much of the launch had already happened before the UTC day began.
//
// Both slopes are ridge-shrunk (a penalty of 1 on the centred second
// moments), which matters for the second predictor: with only a few dozen
// launches its per-hour coefficient would otherwise chase noise.
//
// Guards on extrapolation, because Grand Theft Auto VI is bigger than
// every comparable and its pre-release ratio may sit outside the observed
// range:
//   - beyond the comparables' size range only half the size slope is
//     kept: the size trend flattens at the top end (the biggest launches
//     sit above the straight-line fit in the evening), so a straight
//     extrapolation would under-predict a launch bigger than every
//     comparable.
//   - the pre-release ratio is clipped to [-3.5, 0.5], the range the
//     comparables actually cover: the linear term is trusted inside the
//     data and not extrapolated past it. Clipping costs nothing on any
//     validation protocol (it changes the practice loss by 0.0002).
//
// The spread around the fitted line is the distribution of the
// regression residuals at that hour. Each level's quantile averages the
// weighted empirical quantile of the residuals with a normal fit's
// quantile (weighted mean and spread of the residuals): with a few dozen
// launches the empirical tails are noisy, worst at the 5% and 95% tails,
// while a normal fit is smooth but biased when the distribution is skew.
// Averaging the two halves the tails' variance without trusting either
// alone. The outer quantiles are pulled 15% toward the median, because
// with a few dozen launches the 5% and 95% empirical quantiles overshoot,
// and the pinball loss punishes an over-wide band at every hour.
//
// Launches the kit flags as early-access-contaminated are left out: their
// release-day curve is bent by players who started days early.
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
  /** UTC midnight starting the target's release day (case files carry
   *  it; the pre-release window is the 24 hours before it). */
  day_start?: string;
  /** The target's own pre-release hourly history (same shape as a
   *  comparable's hourly series); may be absent, in which case the
   *  pre-release term falls back to the comparables' average. */
  history_hourly?: HourlyPoint[];
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
/** Ridge penalty on the centred second moments of both slopes. */
const RIDGE = 1.0;
/** Range the pre-release ratio is trusted over; outside it, clipped. */
const PRE_RATIO_LOW = -3.5;
const PRE_RATIO_HIGH = 0.5;

/** A launch's release-day curve, reduced to its hour-1 print, the log
 *  ratio of every later hour to it, and its pre-release ratio. Hours
 *  with no usable point are simply absent; a launch with no usable
 *  pre-release window has a null pre-release ratio and is left out of
 *  the two-predictor fit for that hour. */
export interface LaunchShape {
  name: string;
  hourOne: number;
  logRatio: Map<number, number>;
  preRatio: number | null;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function hourOf(iso: string): number {
  return Number(iso.slice(11, 13)) + 1;
}

/** Parse an ISO timestamp the case files use (always UTC, 'Z' suffix). */
function parseTime(iso: string): number {
  return Date.parse(iso);
}

/** Mean viewers over the 24 hours before a release day, from an hourly
 *  series. Points with no usable viewers are skipped; the window is
 *  [dayStart - 24h, dayStart). Returns null when the window holds no
 *  usable point. */
function meanPreReleaseViewers(points: HourlyPoint[], dayStart: string): number | null {
  const start = parseTime(dayStart);
  let sum = 0;
  let count = 0;
  for (const point of points) {
    if (point.viewers === null || point.viewers <= 0) continue;
    const at = parseTime(point.from);
    if (at < start && start - at <= 24 * 3600 * 1000) {
      sum += point.viewers;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
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
  const pre = meanPreReleaseViewers(launch.hourly, launch.day_start);
  const preRatio = pre === null ? null : Math.max(PRE_RATIO_LOW, Math.min(PRE_RATIO_HIGH, Math.log(pre / hourOne)));
  return { name: launch.name, hourOne, logRatio, preRatio };
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

/** One row of the per-hour regression: x is log hour-1 size, z is the
 *  pre-release ratio, y the hour's log ratio, w the size-kernel weight. */
interface FitRow {
  x: number;
  y: number;
  w: number;
  z: number | null;
}

/** Ridge-shrunk weighted least squares of y on (x, z): returns
 *  [intercept, size slope, pre-release slope]. The penalty sits on the
 *  centred second moments of both slopes, so neither slope can chase
 *  noise in a few dozen launches. A zero spread in either predictor, or
 *  a singular system, falls back to the slopes that are identified. */
function ridgeLeastSquares(rows: FitRow[]): [number, number, number] {
  const withZ = rows.filter((r) => r.z !== null) as Array<FitRow & { z: number }>;
  const useZ = withZ.length >= MIN_LAUNCHES_PER_HOUR;
  const fit = useZ ? withZ : rows;
  let total = 0;
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  for (const r of fit) {
    total += r.w;
    meanX += r.x * r.w;
    meanY += r.y * r.w;
    if (useZ) meanZ += (r.z as number) * r.w;
  }
  if (total <= 0) return [fit[0].y, 0, 0];
  meanX /= total;
  meanY /= total;
  meanZ /= total;
  let sxx = RIDGE;
  let sxz = 0;
  let szz = RIDGE;
  let sxy = 0;
  let szy = 0;
  for (const r of fit) {
    const dx = r.x - meanX;
    const dy = r.y - meanY;
    sxx += r.w * dx * dx;
    sxy += r.w * dx * dy;
    if (useZ) {
      const dz = (r.z as number) - meanZ;
      sxz += r.w * dx * dz;
      szz += r.w * dz * dz;
      szy += r.w * dz * dy;
    }
  }
  if (!useZ || sxx <= 0) {
    const slope = sxx > 0 ? sxy / sxx : 0;
    return [meanY - slope * meanX, slope, 0];
  }
  const det = sxx * szz - sxz * sxz;
  if (Math.abs(det) < 1e-12) {
    const slope = sxy / sxx;
    return [meanY - slope * meanX, slope, 0];
  }
  const slopeX = (sxy * szz - szy * sxz) / det;
  const slopeZ = (szy * sxx - sxy * sxz) / det;
  return [meanY - slopeX * meanX - slopeZ * meanZ, slopeX, slopeZ];
}

/** The five quantiles of one hour's log ratio, as viewer counts. The
 *  centre is the two-predictor regression's prediction at the target's
 *  own size and pre-release ratio; the spread is the residual
 *  distribution around that line, as the average of its empirical
 *  quantiles and a normal fit's quantiles, with the outer quantiles
 *  pulled toward the residual median by SPREAD_PULL. */
function hourQuantiles(
  shapes: LaunchShape[],
  hour: number,
  targetHourOne: number,
  targetPreRatio: number | null,
): number[] | null {
  let width = SIZE_KERNEL_WIDTH;
  let rows: FitRow[] = [];
  // Widen the kernel until enough launches carry real weight, or the cap.
  while (true) {
    rows = [];
    for (const shape of shapes) {
      const ratio = shape.logRatio.get(hour);
      if (ratio === undefined) continue;
      rows.push({
        x: Math.log(shape.hourOne),
        y: ratio,
        w: sizeWeight(shape.hourOne, targetHourOne, width),
        z: shape.preRatio,
      });
    }
    if (rows.length < MIN_LAUNCHES_PER_HOUR) return null;
    if (effectiveCount(rows.map((r) => r.w)) >= MIN_EFFECTIVE_LAUNCHES) break;
    if (width >= MAX_KERNEL_WIDTH) break;
    width *= 1.25;
  }
  const [intercept, slopeX, slopeZ] = ridgeLeastSquares(rows);
  // Residuals are taken over exactly the rows the fit used: when the
  // pre-release term is in play, rows without a pre-release ratio are
  // out of the fit and out of the spread as well.
  const useZ = rows.filter((r) => r.z !== null).length >= MIN_LAUNCHES_PER_HOUR;
  const fittedRows = useZ ? rows.filter((r) => r.z !== null) : rows;
  // A target with no pre-release history of its own is scored at the
  // comparables' weight-averaged ratio: no adjustment either way.
  let zTarget = targetPreRatio;
  if (zTarget === null) {
    let total = 0;
    let meanZ = 0;
    for (const r of rows) {
      if (r.z === null) continue;
      total += r.w;
      meanZ += r.z * r.w;
    }
    zTarget = total > 0 ? meanZ / total : 0;
  }
  const targetX = Math.log(targetHourOne);
  let centre = intercept + slopeX * targetX + slopeZ * zTarget;
  // Beyond the size range the comparables cover, keep only half the
  // size slope: the size trend flattens at the top end, so a straight
  // extrapolation would under-predict a launch bigger than every
  // comparable - exactly the situation Grand Theft Auto VI is in. The
  // pre-release term is not extrapolated: its slope stays as fitted.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const r of rows) {
    if (r.x < minX) minX = r.x;
    if (r.x > maxX) maxX = r.x;
  }
  if (targetX > maxX) {
    centre = intercept + slopeX * maxX + slopeX * SLOPE_SHRINK * (targetX - maxX) + slopeZ * zTarget;
  } else if (targetX < minX) {
    centre = intercept + slopeX * minX + slopeX * SLOPE_SHRINK * (targetX - minX) + slopeZ * zTarget;
  }
  const residuals: Array<[number, number]> = fittedRows.map((r) => [
    r.y - (intercept + slopeX * r.x + slopeZ * (r.z ?? zTarget)),
    r.w,
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
  // The target's own pre-release ratio, from its history in the case
  // file measured against its own release day, exactly as for a
  // comparable; null when the case carries no usable pre-release history.
  let targetPreRatio: number | null = null;
  if (c.day_start !== undefined && c.history_hourly && c.history_hourly.length > 0) {
    const pre = meanPreReleaseViewers(c.history_hourly, c.day_start);
    if (pre !== null) {
      targetPreRatio = Math.max(PRE_RATIO_LOW, Math.min(PRE_RATIO_HIGH, Math.log(pre / targetHourOne)));
    }
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
    const quantiles = hourQuantiles(shapes, row.hour, targetHourOne, targetPreRatio);
    if (quantiles === null) {
      out.set(row.hour, LEVELS.map(() => targetHourOne));
    } else {
      out.set(row.hour, quantiles.map(clean));
    }
  }
  return out;
}
