import app from "./search-api.ts";

Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch: app.fetch,
});

console.log("Search API running on http://localhost:3000");