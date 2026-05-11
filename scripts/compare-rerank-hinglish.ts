/**
 * Compare POST /search in four scoring modes:
 *   1) default — RRF + rank(rrf/similarity)
 *   2) facet_rescore — weighted cosine across 4 aspect vectors (cheap, inline)
 *   3) analyze_query — one query-understanding LLM + metadata overlap boosts in rank()
 *   4) rerank — LLM cross-encoder (slow)
 *
 * Repo root with API already running:
 *   bun run compare:rerank
 *   SEARCH_API_URL=http://127.0.0.1:3005 bun run compare:rerank
 *
 * Writes an HTML file with thumbnails for side-by‑side visual comparison unless
 *   SEARCH_COMPARE_HTML=0|false|no
 * Optional SEARCH_COMPARE_HTML=/path/out.html overrides output path (default timestamped report in cwd).
 */

import path from "node:path";

const BASE = process.env.SEARCH_API_URL ?? "http://127.0.0.1:3000";
const LIMIT = Number(process.env.SEARCH_COMPARE_LIMIT ?? 10);
/** How many ranking slots to render as `<img>` per mode column */
const VISUAL_TOP = Number(process.env.SEARCH_COMPARE_VISUAL_TOP ?? Math.min(LIMIT, 10));

const QUERIES = [
  "aree yaar kya hua sab theek na?",
  "bhai kal exam hai ab tak padhai nahi hui send something 🤡",
  "crush ne hi dp change ki yaar i'm dead meme do",
  "office me boss ne bola sunday bhi aa jana 💀",
  "paisa khatam hogya broke wala kuch forward kar",
];

type Mode = "default" | "facet" | "signals" | "llm";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Map API `memes/…` paths to URLs the same Bun server serves (`/memes/:file`). */
function memeImageUrl(apiBase: string, imagePath: string): string {
  const base = apiBase.replace(/\/$/, "");
  const p = imagePath.replace(/^\//, "");
  if (p.startsWith("memes/")) return `${base}/${p}`;
  return `${base}/memes/${encodeURIComponent(p)}`;
}

function bodyForMode(mode: Mode, query: string): Record<string, unknown> {
  const base = { query, limit: LIMIT };
  if (mode === "default") return { ...base, rerank: false, facet_rescore: false, analyze_query: false };
  if (mode === "facet") return { ...base, rerank: false, facet_rescore: true, analyze_query: false };
  if (mode === "signals") return { ...base, rerank: false, facet_rescore: false, analyze_query: true };
  return { ...base, rerank: true, facet_rescore: false, analyze_query: false };
}

async function search(mode: Mode, query: string): Promise<{ client_ms: number; ids: string[] }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyForMode(mode, query)),
  });
  const client_ms = performance.now() - t0;
  const raw = await res.text();
  let j: {
    memes?: { image_path?: string; id?: string }[];
    error?: string;
  };
  try {
    j = JSON.parse(raw) as typeof j;
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON body — ${raw.slice(0, 240)}`);
  }
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  const ids = (j.memes ?? []).map((m) => String(m.image_path ?? m.id ?? ""));
  return { client_ms, ids };
}

function topKJaccard(a: string[], b: string[], k: number): number {
  const sa = new Set(a.slice(0, k).filter(Boolean));
  const sb = new Set(b.slice(0, k).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

type QueryCompareBlock = {
  query: string;
  modes: Record<
    Mode,
    {
      label: string;
      client_ms: number;
      paths: string[];
    }
  >;
};

function htmlReport(blocks: QueryCompareBlock[]): string {
  const modeDefs: [Mode, string][] = [
    ["default", "default (RRF)"],
    ["facet", "facet_rescore"],
    ["signals", "analyze_query"],
    ["llm", "llm rerank"],
  ];
  const thumbs = `${VISUAL_TOP} top thumbnails per column`;
  let body = "";

  for (const b of blocks) {
    body += `<section class="q"><h2>${escapeHtml(b.query)}</h2>`;
    body += '<div class="mode-grid">';
    for (const [mid, hdr] of modeDefs) {
      const m = b.modes[mid]!;
      body += `<div class="mode-col"><header>${escapeHtml(hdr)} <span class="ms">${Math.round(
        m.client_ms
      )}ms</span></header>`;
      body += '<ol class="thumbs">';
      const slice = m.paths.slice(0, VISUAL_TOP);
      slice.forEach((p, idx) => {
        const rank = idx + 1;
        const src = memeImageUrl(BASE, p);
        body += `<li title="${escapeHtml(p)} (#${rank})">`;
        body += `<span class="rk">#${rank}</span>`;
        body += `<a href="${escapeHtml(src)}" target="_blank" rel="noopener">`;
        body += `<img loading="lazy" alt="" src="${escapeHtml(src)}" width="140" /></a>`;
        body += `<code>${escapeHtml(p)}</code></li>`;
      });
      body += "</ol></div>";
    }
    body += "</div></section>";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Search modes — ranked images (${escapeHtml(thumbs)})</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.25rem; max-width: 1400px; background: #0f1115; color: #e8eaed; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    h2 { font-size: 1rem; margin: 1.5rem 0 0.75rem; word-break: break-word; border-bottom: 1px solid #333; padding-bottom: 0.35rem; }
    .meta { color: #9aa0a6; font-size: 0.85rem; margin-bottom: 1rem; word-break: break-all; }
    .mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem 1.25rem; align-items: start; }
    @media (max-width: 900px) { .mode-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .mode-col header { font-weight: 600; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .ms { color: #9aa0a6; font-weight: 400; }
    ol.thumbs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.65rem; }
    ol.thumbs li { border: 1px solid #2d3238; border-radius: 6px; overflow: hidden; background: #1a1d23; padding: 0.35rem; position: relative; }
    ol.thumbs li:hover { border-color: #5f6368; }
    ol.thumbs li img { width: 100%; max-width: 180px; height: auto; display: block; border-radius: 4px; }
    ol.thumbs li code { font-size: 0.62rem; color: #9aa0a6; word-break: break-all; display: block; margin-top: 0.25rem; }
    .rk { position: absolute; top: 0.35rem; left: 0.35rem; background: rgba(0,0,0,.72); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.7rem; }
  </style>
</head>
<body>
<h1>Reranking / search mode comparison (${escapeHtml(`${QUERIES.length} queries`)})</h1>
<p class="meta">API ${escapeHtml(BASE)} · top ${VISUAL_TOP} images · open images in new tab via click</p>
${body}
</body>
</html>`;
}

function visualReportPath(raw: string | undefined): string | null {
  if (raw == null || raw === "") return path.resolve(process.cwd(), `compare-rerank-visual-${Date.now()}.html`);
  const t = raw.trim().toLowerCase();
  if (t === "0" || t === "false" || t === "no" || t === "off") return null;
  return path.isAbsolute(raw!.trim())
    ? raw!.trim()
    : path.resolve(process.cwd(), raw!.trim());
}

async function main() {
  console.log(
    `→ ${BASE}/search — ${QUERIES.length} queries × 4 modes (default / facet_rescore / analyze_query / llm rerank)\n`
  );

  let sumDef = 0;
  let sumFacet = 0;
  let sumSignals = 0;
  let sumLlm = 0;
  let j5Df = 0;
  let j5Ds = 0;
  let j5Dl = 0;
  let j3Df = 0;
  let j3Ds = 0;
  let j3Dl = 0;

  const htmlBlocks: QueryCompareBlock[] = [];

  for (const query of QUERIES) {
    const d = await search("default", query);
    const f = await search("facet", query);
    const s = await search("signals", query);
    const l = await search("llm", query);
    sumDef += d.client_ms;
    sumFacet += f.client_ms;
    sumSignals += s.client_ms;
    sumLlm += l.client_ms;

    const jac5Df = topKJaccard(d.ids, f.ids, 5);
    const jac5Ds = topKJaccard(d.ids, s.ids, 5);
    const jac5Dl = topKJaccard(d.ids, l.ids, 5);
    const jac3Df = topKJaccard(d.ids, f.ids, 3);
    const jac3Ds = topKJaccard(d.ids, s.ids, 3);
    const jac3Dl = topKJaccard(d.ids, l.ids, 3);
    j5Df += jac5Df;
    j5Ds += jac5Ds;
    j5Dl += jac5Dl;
    j3Df += jac3Df;
    j3Ds += jac3Ds;
    j3Dl += jac3Dl;

    console.log(`―― ${query}`);
    console.log(`  default         ${d.client_ms.toFixed(0)}ms │ ${d.ids.slice(0, 8).join(", ")}`);
    console.log(`  facet_rescore   ${f.client_ms.toFixed(0)}ms │ ${f.ids.slice(0, 8).join(", ")}`);
    console.log(`  analyze_query   ${s.client_ms.toFixed(0)}ms │ ${s.ids.slice(0, 8).join(", ")}`);
    console.log(`  llm rerank      ${l.client_ms.toFixed(0)}ms │ ${l.ids.slice(0, 8).join(", ")}`);
    console.log(
      `  vs default — top‑3 Jaccard: facet=${jac3Df.toFixed(2)} signals=${jac3Ds.toFixed(2)} llm=${jac3Dl.toFixed(2)} │ top‑5: facet=${jac5Df.toFixed(2)} signals=${jac5Ds.toFixed(2)} llm=${jac5Dl.toFixed(2)}`
    );

    htmlBlocks.push({
      query,
      modes: {
        default: { label: "default", client_ms: d.client_ms, paths: d.ids },
        facet: { label: "facet_rescore", client_ms: f.client_ms, paths: f.ids },
        signals: { label: "analyze_query", client_ms: s.client_ms, paths: s.ids },
        llm: { label: "llm rerank", client_ms: l.client_ms, paths: l.ids },
      },
    });
  }

  const outCfg = visualReportPath(process.env.SEARCH_COMPARE_HTML);
  if (outCfg) {
    const htmlOut = htmlReport(htmlBlocks);
    await Bun.write(outCfg, htmlOut);
    console.log(`\n[visual] Wrote thumbnail report (${VISUAL_TOP} ranks): ${outCfg}`);
    console.log("           Serve the API at the same SEARCH_API_URL while viewing (same-origin img).");
  }

  const n = QUERIES.length;
  const fmt = (x: number) => (x / n).toFixed(0);
  const fmtJac = (x: number) => (x / n).toFixed(2);
  const ratio = (num: number) => `×${(num / sumDef || 1).toFixed(2)} vs default`;

  console.log(`
== Summary (${n} queries)
Avg client latency (ms):
  default          ${fmt(sumDef)}
  facet_rescore    ${fmt(sumFacet)}  (${ratio(sumFacet)})
  analyze_query    ${fmt(sumSignals)}  (${ratio(sumSignals)})
  llm rerank       ${fmt(sumLlm)}  (${ratio(sumLlm)})
Mean vs-default top‑Jaccard:
  facet:    top‑3=${fmtJac(j3Df)}  top‑5=${fmtJac(j5Df)}
  signals:  top‑3=${fmtJac(j3Ds)}  top‑5=${fmtJac(j5Ds)}
  llm:      top‑3=${fmtJac(j3Dl)}  top‑5=${fmtJac(j5Dl)}`);
}

await main().catch((e) => {
  console.error(e);
  process.exit(1);
});
