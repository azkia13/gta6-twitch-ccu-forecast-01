// gta6-twitch-ccu-forecast-01: forecast the Twitch viewers of Grand Theft
// Auto VI's release day, hour by hour, from the first hour's print.
//
// Run: node main.ts (Node 22, standard library only). It reads every
// <id>.in in the input directory and writes one <id>.out per case to the
// output directory. Outside the grader's container the directories come
// from MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR, else /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The forecast itself lives in lib/model.ts: the shape of a release day
// learned from the past launches shipped in each case file, scaled to the
// target launch by its own hour-1 print. This file only does the plumbing:
// read a case, ask the model, write the answer in the shape the contest
// scores. It runs offline, with no network and no randomness, so two runs
// on the same case write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastCase, LEVELS, type CaseFile } from './lib/model.ts';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The levels a case must ask for, in the order each row lists them. */
const EXPECTED_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** One forecast row, exactly as the output file carries it. */
interface ForecastRow {
  hour: number;
  q: number[];
}

function levelsMatch(levels: number[]): boolean {
  return (
    levels.length === EXPECTED_LEVELS.length &&
    levels.every((level, i) => level === EXPECTED_LEVELS[i])
  );
}

function checkRow(row: ForecastRow): void {
  if (row.q.length !== LEVELS.length) {
    throw new Error(`hour ${row.hour}: expected ${LEVELS.length} quantiles, got ${row.q.length}`);
  }
  for (let i = 0; i < row.q.length; i++) {
    const value = row.q[i];
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
      throw new Error(`hour ${row.hour}: quantile ${i} is ${value}, outside (0, 1e9]`);
    }
    if (i > 0 && value < row.q[i - 1]) {
      throw new Error(`hour ${row.hour}: quantiles are not in order`);
    }
  }
}

function forecastFile(casePath: string, caseId: string): void {
  const parsed = JSON.parse(readFileSync(casePath, 'utf8')) as CaseFile & { levels: number[] };
  if (!levelsMatch(parsed.levels)) {
    throw new Error(`${caseId} asks for levels ${JSON.stringify(parsed.levels)}`);
  }
  const byHour = forecastCase(parsed);
  const rows: ForecastRow[] = parsed.forecast
    .map((asked) => {
      const q = byHour.get(asked.hour);
      if (q === undefined) throw new Error(`${caseId} has no forecast for hour ${asked.hour}`);
      return { hour: asked.hour, q };
    })
    .sort((a, b) => a.hour - b.hour);
  if (rows.length !== 23) {
    throw new Error(`${caseId} asks for ${rows.length} hours, expected 23`);
  }
  for (const row of rows) checkRow(row);
  writeFileSync(join(outputDir, `${caseId}.out`), `${JSON.stringify({ hours: rows })}\n`);
}

function main(): void {
  mkdirSync(outputDir, { recursive: true });
  const caseFiles = readdirSync(inputDir)
    .filter((name) => name.endsWith('.in'))
    .sort();
  if (caseFiles.length === 0) throw new Error(`no .in case files in ${inputDir}`);
  for (const name of caseFiles) {
    forecastFile(join(inputDir, name), name.slice(0, -'.in'.length));
  }
}

main();
