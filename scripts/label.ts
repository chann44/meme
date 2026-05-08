const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";
const folder = process.argv[2] || "./memes";

async function label() {
  console.log("=== Label Script ===\n");
  console.log(`Server: ${BASE_URL}`);
  console.log(`Folder: ${folder}\n`);

  console.log("Checking stats before labeling...");
  const statsRes = await fetch(`${BASE_URL}/stats`);
  const stats = await statsRes.json() as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Current: ${stats.total_memes} memes, ${stats.total_labeled} labeled, ${stats.total_embeddings} in memory\n`);

  console.log("Labeling memes...");
  const labelRes = await fetch(`${BASE_URL}/label`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, concurrency: 4 }),
  });
  const labelResult = await labelRes.json();
  console.log("Label result:", labelResult, "\n");

  console.log("Checking stats after labeling...");
  const finalStatsRes = await fetch(`${BASE_URL}/stats`);
  const finalStats = await finalStatsRes.json() as { total_memes: number; total_labeled: number; total_embeddings: number };
  console.log(`Final: ${finalStats.total_memes} memes, ${finalStats.total_labeled} labeled, ${finalStats.total_embeddings} in memory\n`);

  console.log("=== Labeling complete! ===");
}

label().catch(console.error);