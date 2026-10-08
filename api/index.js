import worker from "../index.js";

// Single Node.js entrypoint for the whole API (see vercel.json). The Edge
// entrypoint (api/handler.js) was removed so the project has exactly one
// runtime, and it is Node.
//
// vercel.json rewrites every API path to this function and passes the original
// pathname in the `__anivexa_path` query parameter, because a rewrite replaces
// the path the function sees. We restore it here (and drop the helper param)
// before handing the request to the worker, so route matching is unchanged.
export default async function handler(req, res) {
  const host = req.headers["host"] ?? "localhost";
  const url = new URL(req.url, `https://${host}`);

  const originalPath = url.searchParams.get("__anivexa_path");
  if (originalPath) {
    url.searchParams.delete("__anivexa_path");
    url.pathname = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: body?.length ? body : undefined,
    duplex: "half",
  });

  const response = await worker.fetch(request, {});


  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.setHeader(k, v);

  const buf = await response.arrayBuffer();
  res.end(Buffer.from(buf));
}
