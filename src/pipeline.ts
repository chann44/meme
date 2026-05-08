const folder = process.argv[2] || "./memes";
const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";

async function pipeline() {
  console.log("=== Meme Pipeline Client ===\n");
  console.log(`Server: ${BASE_URL}`);
  console.log(`Folder: ${folder}\n`);

  console.log("Step 0: Checking stats...");
  const statsRes = await fetch(`${BASE_URL}/stats`);
  const stats = (await statsRes.json()) as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Current: ${stats.total_memes} memes, ${stats.total_labeled} labeled, ${stats.total_embeddings} in memory\n`);

  console.log("Step 1: Labeling memes...");
  const labelRes = await fetch(`${BASE_URL}/label`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, concurrency: 4 }),
  });
  const labelResult = await labelRes.json();
  console.log("Label result:", labelResult, "\n");

  console.log("Step 2: Generating embeddings...");
  const embedRes = await fetch(`${BASE_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchSize: 10 }),
  });
  const embedResult = await embedRes.json();
  console.log("Embed result:", embedResult, "\n");

  console.log("Step 3: Reloading vector store...");
  const reloadRes = await fetch(`${BASE_URL}/reload`, { method: "POST" });
  const reloadResult = await reloadRes.json();
  console.log("Reload result:", reloadResult, "\n");

  console.log("Step 4: Final stats...");
  const finalStatsRes = await fetch(`${BASE_URL}/stats`);
  const finalStats = (await finalStatsRes.json()) as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Final: ${finalStats.total_memes} memes, ${finalStats.total_labeled} labeled, ${finalStats.total_embeddings} in memory\n`);

  console.log("=== Pipeline complete! ===");
}

pipeline().catch(console.error);