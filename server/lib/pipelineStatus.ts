// Levac fork: the real step of a request, from the Media Pipeline service.
//
// Seerr's own status for a request is wrong for most family requests (it says
// "Processing" for weeks). The Media Pipeline tracks every request to Plex and
// writes plain-English headline/detail lines for the TV app; this reads them
// so the Seerr pages can show the same thing. Config:
// ${CONFIG_DIRECTORY}/levac-pipeline.json = {"url": "...", "key": "..."}.
// No file means the feature is off and nothing extra is shown.
import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { ownerFromPath, type LibraryAccess } from '@server/lib/libraryAccess';
import logger from '@server/logger';
import axios from 'axios';
import { readFileSync } from 'fs';
import path from 'path';
import { In } from 'typeorm';

/** What the pages need of one pipeline row; no internal fields. */
export interface PipelineStatus {
  requestId: number;
  stage: string;
  headline: string | null;
  detail: string | null;
  /** 0 to 1 while downloading. */
  progress: number | null;
  etaSeconds: number | null;
  /** Bytes per second. */
  speed: number | null;
  unreleased: boolean;
  comesOut: string | null;
  /** 0 to 1 while copying into the library. */
  transferProgress: number | null;
  transferSpeed: number | null;
  problem: string | null;
  hermes: { state: string; note: string | null } | null;
}

export interface PipelineRow {
  id: number;
  stage?: string | null;
  headline?: string | null;
  detail?: string | null;
  progress?: number | null;
  etaSeconds?: number | null;
  speed?: number | null;
  unreleased?: boolean;
  comesOut?: string | null;
  transferProgress?: number | null;
  transferSpeed?: number | null;
  problem?: { kind?: string; text?: string } | null;
  hermes?: { state?: string; note?: string | null } | null;
  done?: boolean;
  declined?: boolean;
}

export type PipelineResult =
  | { available: true; statuses: PipelineStatus[]; stale: boolean }
  | { available: false; statuses: [] };

const CONFIG_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/levac-pipeline.json`
  : path.join(__dirname, '../../config/levac-pipeline.json');

const FRESH_MS = 10_000;
const STALE_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

export function pipelineConfig(): { url: string; key: string } | null {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return config?.url && config?.key ? config : null;
  } catch {
    return null;
  }
}

async function fetchRows(config: {
  url: string;
  key: string;
}): Promise<PipelineRow[]> {
  const res = await axios.get(
    `${config.url.replace(/\/+$/, '')}/api/requests`,
    {
      params: { days: 90 },
      headers: { 'X-Api-Key': config.key },
      timeout: TIMEOUT_MS,
    }
  );
  const rows = res.data?.requests;
  if (!Array.isArray(rows)) throw new Error('unexpected pipeline response');
  return rows;
}

/** Swappable in tests. */
export const pipelineSources = { config: pipelineConfig, fetchRows };

let cache: { rows: PipelineRow[]; at: number } | null = null;
let loading: Promise<PipelineRow[]> | null = null;

export function resetPipelineCache(): void {
  cache = null;
  loading = null;
}

/**
 * The pipeline's rows, fetched at most every 10 seconds and shared by every
 * caller. If a fetch fails the last good copy is served for up to 5 minutes;
 * past that, or with no config, null.
 */
export async function pipelineRows(): Promise<{
  rows: PipelineRow[];
  stale: boolean;
} | null> {
  const config = pipelineSources.config();
  if (!config) return null;
  const now = Date.now();
  if (cache && now - cache.at < FRESH_MS)
    return { rows: cache.rows, stale: false };
  if (!loading) {
    loading = pipelineSources
      .fetchRows(config)
      .then((rows) => {
        cache = { rows, at: Date.now() };
        return rows;
      })
      .finally(() => {
        loading = null;
      });
  }
  try {
    return { rows: await loading, stale: false };
  } catch (e) {
    logger.warn(`Pipeline status: could not read the pipeline: ${e.message}`, {
      label: 'Pipeline Status',
    });
    if (cache && Date.now() - cache.at < STALE_MS)
      return { rows: cache.rows, stale: true };
    return null;
  }
}

export function trim(row: PipelineRow): PipelineStatus {
  return {
    requestId: row.id,
    stage: row.stage ?? 'requested',
    headline: row.headline ?? null,
    detail: row.detail ?? null,
    progress: row.progress ?? null,
    etaSeconds: row.etaSeconds ?? null,
    speed: row.speed ?? null,
    unreleased: !!row.unreleased,
    comesOut: row.comesOut ?? null,
    transferProgress: row.transferProgress ?? null,
    transferSpeed: row.transferSpeed ?? null,
    problem: row.problem?.text ?? null,
    hermes: row.hermes?.state
      ? { state: row.hermes.state, note: row.hermes.note ?? null }
      : null,
  };
}

/** Their own requests, or ones for a library they can see; null access = all. */
export function canSeeRequest(
  request: { requestedById?: number | null; rootFolder?: string | null },
  user: Pick<User, 'id'> | undefined,
  access: LibraryAccess | null
): boolean {
  if (!access) return true;
  if (user && request.requestedById === user.id) return true;
  const owner = ownerFromPath(request.rootFolder);
  return !!owner && access.owners.has(owner);
}

/**
 * Statuses for the open requests the caller may see. Finished, declined and
 * not-yet-approved requests, and ones the pipeline doesn't know, are left out.
 */
export async function pipelineStatusesFor(
  user: User | undefined,
  access: LibraryAccess | null,
  requestIds?: number[]
): Promise<PipelineResult> {
  const got = await pipelineRows();
  if (!got) return { available: false, statuses: [] };
  const wanted = requestIds ? new Set(requestIds) : null;
  const rows = got.rows.filter(
    (r) =>
      Number.isSafeInteger(r.id) &&
      !r.done &&
      !r.declined &&
      (!wanted || wanted.has(r.id))
  );
  if (!rows.length) return { available: true, statuses: [], stale: got.stale };
  const found = await getRepository(MediaRequest).find({
    select: { id: true, status: true, rootFolder: true },
    relations: { requestedBy: true },
    where: { id: In(rows.map((r) => r.id)) },
  });
  const byId = new Map(found.map((r) => [r.id, r]));
  const statuses = rows
    .filter((row) => {
      const req = byId.get(row.id);
      return (
        req &&
        req.status === MediaRequestStatus.APPROVED &&
        canSeeRequest(
          { requestedById: req.requestedBy?.id, rootFolder: req.rootFolder },
          user,
          access
        )
      );
    })
    .map(trim);
  return { available: true, statuses, stale: got.stale };
}
