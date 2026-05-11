import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Directory for per-request search timing JSON (`search-*.json`). */
export function getSearchPerfLogDir(): string {
  const env = process.env.MEME_PERF_LOG_DIR?.trim() ?? process.env.SEARCH_PERF_LOG_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), "logs.json");
}

export type PerfRecord = {
  scope: string;
  phase: string;
  ms: number;
  meta?: Record<string, unknown>;
};

export interface PerfRecorderLike {
  record(scope: string, phase: string, ms: number, meta?: Record<string, unknown>): void;
}

async function ensureLogDir(): Promise<string> {
  const root = getSearchPerfLogDir();
  await mkdir(root, { recursive: true });
  return root;
}

export async function writeSearchPerfJson(payload: Record<string, unknown>): Promise<string> {
  const dir = await ensureLogDir();
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = `search-${iso}-${Math.random().toString(36).slice(2, 10)}.json`;
  const filePath = path.join(dir, fname);
  await Bun.write(filePath, JSON.stringify(payload, null, 2) + "\n");
  return filePath;
}

export function createPerfRecorder() {
  const records: PerfRecord[] = [];
  return {
    record(scope: string, phase: string, ms: number, meta?: Record<string, unknown>): void {
      records.push(meta ? { scope, phase, ms, meta } : { scope, phase, ms });
    },
    /** Wall time including nested parallel work — use for sequential sections only. */
    async timeAsync<T>(scope: string, phase: string, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        this.record(scope, phase, performance.now() - t0);
      }
    },
    /** Sync wall time for CPU-only steps (e.g. rank). */
    timeSync<T>(scope: string, phase: string, fn: () => T): T {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        this.record(scope, phase, performance.now() - t0);
      }
    },
    getRecords(): PerfRecord[] {
      return records;
    },
  };
}

/** Sum of recorded phase times (parallel branches double-count wall). */
export function sumPhaseMs(records: PerfRecord[], scopePrefix?: string): number {
  return records
    .filter((r) => (scopePrefix ? r.scope.startsWith(scopePrefix) : true))
    .reduce((s, r) => s + r.ms, 0);
}

function pickMs(records: PerfRecord[], scope: string, phase: string): number | undefined {
  return records.find((r) => r.scope === scope && r.phase === phase)?.ms;
}

/** Explains gaps: parallel work vs sequential searchApi wall. */
export function summarizeSearchPerf(records: PerfRecord[], requestWallMs: number) {
  const g = (scope: string, phase: string) => pickMs(records, scope, phase) ?? 0;

  const parse = g("searchApi", "parse_body");
  const embed = g("searchApi", "embed_query");
  const querySignalsLlm = g("searchApi", "query_signals_llm");
  /** Embed + analyzeQuery run in parallel when analyze_query:true. */
  const embedAndQuerySignalsParallelWall = Math.max(embed, querySignalsLlm);
  const fusedOuter = g("searchApi", "fused_search");
  const crossOuter = g("searchApi", "cross_encode");
  const rank = g("searchApi", "rank");
  const serialize = g("searchApi", "build_response");

  const fusedParallelWall = pickMs(records, "fusedSearch", "parallel_promise_all_wall") ?? 0;
  const fusedParallelBranchSum = sumPhaseMs(
    records.filter((r) => r.scope === "fusedSearch" && r.phase.startsWith("parallel."))
  );
  const crossParallelWall = pickMs(records, "crossEncode", "parallel_all_wall") ?? 0;
  const llmCandidateMs = records.filter((r) => r.scope === "crossEncode" && r.phase.startsWith("llm_candidate_"));
  const crossLlmSum =
    llmCandidateMs.length === 0 ? 0 : llmCandidateMs.reduce((s, r) => s + r.ms, 0);

  const searchApiSequentialSum =
    parse + embedAndQuerySignalsParallelWall + fusedOuter + crossOuter + rank + serialize;
  const naiveSumAllRecords = records.reduce((s, r) => s + r.ms, 0);

  return {
    request_wall_ms: requestWallMs,
    search_api_wall_ms: searchApiSequentialSum,
    vs_request_delta_ms: requestWallMs - searchApiSequentialSum,
    phases_search_api: {
      parse_body_ms: parse,
      embed_query_ms: embed,
      query_signals_llm_ms: querySignalsLlm,
      embed_query_plus_query_signals_parallel_wall_ms_approx: embedAndQuerySignalsParallelWall,
      fused_search_ms: fusedOuter,
      cross_encode_ms: crossOuter,
      rank_ms: rank,
      build_response_ms: serialize,
    },
    fused_search: {
      outer_wall_ms_includes_substeps: fusedOuter,
      parallel_wall_ms: fusedParallelWall,
      sum_parallel_branch_timers_ms_note_overlaps: fusedParallelBranchSum,
      vec_main_ms: pickMs(records, "fusedSearch", "parallel.vec_main"),
      vec_people_ms: pickMs(records, "fusedSearch", "parallel.vec_people"),
      vec_context_ms: pickMs(records, "fusedSearch", "parallel.vec_context"),
      vec_use_case_ms: pickMs(records, "fusedSearch", "parallel.vec_use_case"),
      bm25_ms: pickMs(records, "fusedSearch", "parallel.bm25_fts"),
      people_exact_sql_ms: pickMs(records, "fusedSearch", "parallel.people_exact_sql"),
      rrf_fuse_ms: pickMs(records, "fusedSearch", "rrf_fuse_and_sort_slice"),
      hydrate_fetch_memes_ms: pickMs(records, "fusedSearch", "hydrate_fetch_memes"),
      metadata_filter_ms: pickMs(records, "fusedSearch", "metadata_filter"),
    },
    cross_encode_llm: {
      reran: crossOuter > 0,
      outer_wall_ms_includes_substeps: crossOuter,
      parallel_llm_wall_ms: crossParallelWall,
      sum_llm_candidate_timers_ms_note_overlaps: crossLlmSum,
      rerank_candidate_count: llmCandidateMs.length,
      rest_filter_sort_ms: pickMs(records, "crossEncode", "rest_filter_sort"),
    },
    accounting: {
      naive_sum_all_records_ms: naiveSumAllRecords,
      note: "Sum of all `records` counts parallel sibling timers separately (>> wall). `cross_encode` only when rerank:true.",
    },
  };
}
