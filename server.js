import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 8080);
const publicDir = join(process.cwd(), "public");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolvePath(url) {
  const pathname = new URL(url, "http://localhost").pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  return join(publicDir, safePath === "/" ? "index.html" : safePath);
}

createServer(async (req, res) => {
  try {
    const filePath = resolvePath(req.url || "/");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": types[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    const data = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(data);
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`weight-room listening on ${port}`);
});
