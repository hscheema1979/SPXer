/**
 * Metrics query API — importable functions for serving metrics data
 * over the HTTP server.
 *
 * All functions accept a better-sqlite3 Database instance so they can
 * be used from any context (data service, replay viewer, standalone).
 *
 * Usage:
 *   import { getLatestMetrics, getMetricSeries, getMetricsSummary } from './ops/metrics-api';
 *   const latest = getLatestMetrics(db);
 */

import type { Database as DB } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LatestMetric {
  value: number;
  ts: number;
  tags?: string;
}

export interface SeriesPoint {
  ts: number;
  value: number;
}

export interface MetricSummary {
  min: number;
  max: number;
  avg: number;
  latest: number;
  count: number;
}

// ---------------------------------------------------------------------------
// getLatestMetrics
// ---------------------------------------------------------------------------

/**
 * Returns the most recent value for each distinct (name, tags) pair.
 *
 * Result is keyed by metric name. For tagged metrics (e.g. per-provider),
 * the tags field is included so callers can distinguish them.
 */
export function getLatestMetrics(db: DB): Record<string, LatestMetric> {
  const rows = db.prepare(`
    SELECT m.name, m.value, m.ts, m.tags
    FROM metrics m
    INNER JOIN (
      SELECT name, tags, MAX(ts) AS max_ts
      FROM metrics
      GROUP BY name, tags
    ) latest ON m.name = latest.name AND m.tags = latest.tags AND m.ts = latest.max_ts
    ORDER BY m.name
  `).all() as Array<{ name: string; value: number; ts: number; tags: string }>;

  const result: Record<string, LatestMetric> = {};
  for (const row of rows) {
    // For tagged metrics, append tags to key to keep them distinct
    const key = row.tags ? `${row.name}[${row.tags}]` : row.name;
    result[key] = {
      value: row.value,
      ts: row.ts,
      ...(row.tags ? { tags: row.tags } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// getMetricSeries
// ---------------------------------------------------------------------------

/**
 * Returns a time series for a specific metric between `from` and `to`
 * (Unix seconds, inclusive).
 *
 * If `step` is provided (in seconds), values are averaged into buckets
 * of that size for downsampling. Otherwise all raw points are returned.
 *
 * Optional `tags` parameter filters to a specific tag value (e.g.
 * '{"provider":"tradier"}').
 */
export function getMetricSeries(
  db: DB,
  name: string,
  from: number,
  to: number,
  step?: number,
  tags?: string,
): SeriesPoint[] {
  if (step && step > 0) {
    // Downsampled: average values into fixed-width time buckets
    // Params: (ts / ?step * ?step), WHERE name=? ts>=? ts<=? [tags=?]
    const bindArgs: any[] = [step, step, name, from, to];
    let tagClause = '';
    if (tags !== undefined) {
      tagClause = ' AND tags = ?';
      bindArgs.push(tags);
    }

    const rows = db.prepare(`
      SELECT (ts / ? * ?) AS bucket_ts, AVG(value) AS value
      FROM metrics
      WHERE name = ? AND ts >= ? AND ts <= ?${tagClause}
      GROUP BY bucket_ts
      ORDER BY bucket_ts
    `).all(...bindArgs) as Array<{ bucket_ts: number; value: number }>;

    return rows.map((r) => ({ ts: r.bucket_ts, value: parseFloat(r.value.toFixed(4)) }));
  }

  // Raw series
  const params: any[] = [name, from, to];
  let tagClause = '';
  if (tags !== undefined) {
    tagClause = ' AND tags = ?';
    params.push(tags);
  }

  const rows = db.prepare(`
    SELECT ts, value
    FROM metrics
    WHERE name = ? AND ts >= ? AND ts <= ?${tagClause}
    ORDER BY ts
  `).all(...params) as Array<{ ts: number; value: number }>;

  return rows.map((r) => ({ ts: r.ts, value: r.value }));
}

// ---------------------------------------------------------------------------
// getMetricsSummary
// ---------------------------------------------------------------------------

/**
 * Returns min/max/avg/latest/count for every distinct metric over the
 * last `hours` hours (default 24).
 *
 * For tagged metrics, each (name, tags) combination is a separate entry
 * keyed as `name[tags]`.
 */
export function getMetricsSummary(
  db: DB,
  hours: number = 24,
): Record<string, MetricSummary> {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;

  const rows = db.prepare(`
    SELECT
      name,
      tags,
      MIN(value) AS min_val,
      MAX(value) AS max_val,
      AVG(value) AS avg_val,
      COUNT(*) AS cnt
    FROM metrics
    WHERE ts >= ?
    GROUP BY name, tags
    ORDER BY name
  `).all(since) as Array<{
    name: string;
    tags: string;
    min_val: number;
    max_val: number;
    avg_val: number;
    cnt: number;
  }>;

  // Fetch latest value for each (name, tags) pair
  const latestRows = db.prepare(`
    SELECT m.name, m.tags, m.value
    FROM metrics m
    INNER JOIN (
      SELECT name, tags, MAX(ts) AS max_ts
      FROM metrics
      WHERE ts >= ?
      GROUP BY name, tags
    ) latest ON m.name = latest.name AND m.tags = latest.tags AND m.ts = latest.max_ts
  `).all(since) as Array<{ name: string; tags: string; value: number }>;

  const latestMap = new Map<string, number>();
  for (const r of latestRows) {
    const key = r.tags ? `${r.name}[${r.tags}]` : r.name;
    latestMap.set(key, r.value);
  }

  const result: Record<string, MetricSummary> = {};
  for (const row of rows) {
    const key = row.tags ? `${row.name}[${row.tags}]` : row.name;
    result[key] = {
      min: parseFloat(row.min_val.toFixed(4)),
      max: parseFloat(row.max_val.toFixed(4)),
      avg: parseFloat(row.avg_val.toFixed(4)),
      latest: latestMap.get(key) ?? row.max_val,
      count: row.cnt,
    };
  }

  return result;
}
