const app = {
  port: 3001,
  
  fetch: async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    
    if (url.pathname === "/random" && req.method === "GET") {
      const allFiles = Array.from({ length: 200 }, (_, i) => `${i}.jpg`).filter((name) => {
        return Bun.file(`memes/${name}`).exists();
      });

      if (allFiles.length === 0) {
        return Response.json({ error: "No memes found" }, { status: 404 });
      }

      const randomFile = allFiles[Math.floor(Math.random() * allFiles.length)]!;

      return Response.json({
        id: randomFile,
        image_path: randomFile,
        image_url: `http://localhost:3001/memes/${randomFile}`,
      });
    }

    if (url.pathname.startsWith("/memes/")) {
      const filename = url.pathname.replace("/memes/", "");
      const file = Bun.file(`memes/${filename}`);
      
      if (await file.exists()) {
        return new Response(file);
      }
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", port: app.port });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

Bun.serve({
  port: app.port,
  fetch: app.fetch,
});

console.log(`Raycast Test API running on http://localhost:${app.port}`);
console.log(`Usage: GET /random?text=<your-meme-text>`);