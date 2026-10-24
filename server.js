import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import routeHandler from "./api/route.js";
import modelsHandler from "./api/models.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function makeResponse(res) {
  const response = {
    setHeader: function (name, value) { res.setHeader(name, value); },
    status: function (code) { res.statusCode = code; return response; },
    json: function (payload) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
      return response;
    }
  };
  return response;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 150000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async function (req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const response = makeResponse(res);

  if (url.pathname === "/api/models") {
    req.method = req.method || "GET";
    return modelsHandler(req, response);
  }

  if (url.pathname === "/api/route") {
    try {
      req.body = await readBody(req);
    } catch (error) {
      return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    return routeHandler(req, response);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return response.status(405).json({ error: "Method not allowed." });
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (error) { pathname = "/"; }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filename = path.resolve(root, requested);
  if (!filename.startsWith(root + path.sep) && filename !== path.join(root, "index.html")) {
    return response.status(403).json({ error: "Forbidden." });
  }

  try {
    const contents = await readFile(filename);
    res.setHeader("Content-Type", mime[path.extname(filename)] || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.method === "HEAD") return res.end();
    return res.end(contents);
  } catch (error) {
    return response.status(404).json({ error: "Not found." });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", function () {
  process.stdout.write("ModelRouter is running at http://127.0.0.1:" + port + "\n");
});
