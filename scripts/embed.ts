const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";
const batchSize = parseInt(process.argv[2] || "10", 10);

async function embed() {
  console.log("=== Embed Script ===\n");
  console.log(`Server: ${BASE_URL}`);
  console.log(`Batch size: ${batchSize}\n`);

  console.log("Checking stats before embedding...");
  const statsRes = await fetch(`${BASE_URL}/stats`);
  const stats = await statsRes.json() as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Current: ${stats.total_memes} memes, ${stats.total_labeled} labeled, ${stats.total_embeddings} in memory\n`);

  console.log("Generating embeddings...");
  const embedRes = await fetch(`${BASE_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchSize }),
  });
  const embedResult = await embedRes.json();
  console.log("Embed result:", embedResult, "\n");

  console.log("Reloading vector store...");
  const reloadRes = await fetch(`${BASE_URL}/reload`, { method: "POST" });
  const reloadResult = await reloadRes.json();
  console.log("Reload result:", reloadResult, "\n");

  console.log("Checking stats after embedding...");
  const finalStatsRes = await fetch(`${BASE_URL}/stats`);
  const finalStats = await finalStatsRes.json() as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Final: ${finalStats.total_memes} memes, ${finalStats.total_labeled} labeled, ${finalStats.total_embeddings} in memory\n`);

  console.log("=== Embedding complete! ===");
}

embed().catch(console.error);