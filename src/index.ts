import app from "./search-api.ts";
import { getSearchPerfLogDir } from "./search-perf-log.ts";

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Search API running on http://localhost:${port}`);
console.log(`[perf] POST /search timing JSON → directory: ${getSearchPerfLogDir()} (override with MEME_PERF_LOG_DIR)`);