/**
 * Browser checkpoint for GeoSQL eval runs (resume after refresh / crash).
 */
import type { GeoSqlEvalReport } from "./geoSqlEvalReport";

export const LS_EVAL_CHECKPOINT = "magdaGeoSqlEvalCheckpoint";

export const EVAL_SLUG_ORDER = [
    "land_zones",
    "manningham_trees",
    "road_segment"
] as const;

export type EvalRunMode = "single" | "all";

export type GeoSqlEvalCheckpoint = {
    runId: string;
    mode: EvalRunMode;
    startedAt: string;
    updatedAt: string;
    slugs: string[];
    completedSlugs: string[];
    currentSlug: string | null;
    currentCaseIndex: number;
    reports: Record<string, GeoSqlEvalReport>;
};

export function newRunId(): string {
    return `run-${Date.now()}`;
}

export function loadEvalCheckpoint(): GeoSqlEvalCheckpoint | null {
    try {
        const raw = localStorage.getItem(LS_EVAL_CHECKPOINT);
        if (!raw) return null;
        const o = JSON.parse(raw) as GeoSqlEvalCheckpoint;
        if (!o?.runId || !o.mode || !Array.isArray(o.slugs)) return null;
        return o;
    } catch {
        return null;
    }
}

export function saveEvalCheckpoint(cp: GeoSqlEvalCheckpoint): void {
    try {
        localStorage.setItem(
            LS_EVAL_CHECKPOINT,
            JSON.stringify({ ...cp, updatedAt: new Date().toISOString() })
        );
    } catch {
        /* quota or private mode */
    }
}

export function clearEvalCheckpoint(): void {
    try {
        localStorage.removeItem(LS_EVAL_CHECKPOINT);
    } catch {
        /* ignore */
    }
}
