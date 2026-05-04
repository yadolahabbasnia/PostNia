const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const STORE = path.join(baseDir, "requests.json");
const PORT = Number(process.env.PORT) || 8900;
const HOST = process.env.HOST || "127.0.0.1";

async function loadStore() {
  try {
    const raw = await fs.readFile(STORE, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

let storeChain = Promise.resolve();
function updateStore(mutator) {
  const next = storeChain.then(async () => {
    const data = await loadStore();
    const updated = (await mutator(data)) ?? data;
    await fs.writeFile(STORE, JSON.stringify(updated, null, 2));
    return updated;
  });
  storeChain = next.catch(() => {});
  return next;
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.post(
  "/api/send",
  asyncHandler(async (req, res) => {
    const { method, url, headers, body } = req.body ?? {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url is required" });
    }
    const init = { method, headers };
    if (method === "POST" || method === "PUT") init.body = body;

    try {
      const response = await fetch(url, init);
      const text = await response.text();
      res.json({
        timestamp: Date.now(),
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
      });
    } catch (err) {
      res.status(502).json({
        timestamp: Date.now(),
        error: err?.message ?? "fetch failed",
        code: err?.code ?? err?.errno ?? null,
      });
    }
  })
);

app.post(
  "/api/save",
  asyncHandler(async (req, res) => {
    const incoming = req.body ?? {};
    let saved;
    await updateStore((requests) => {
      const request = { id: Date.now(), ...incoming };
      if (!request.name || request.name.toLowerCase() === "unnamed") {
        let derived;
        try {
          if (request.url) derived = new URL(request.url).pathname;
        } catch {
          /* fall through to Unnamed-N */
        }
        if (!derived) {
          const n =
            requests.filter((r) =>
              r.name?.toLowerCase()?.includes("unnamed")
            ).length + 1;
          derived = `Unnamed-${n}`;
        }
        request.name = derived;
      }
      requests.push(request);
      saved = request;
      return requests;
    });
    res.json({ ok: true, request: saved });
  })
);

app.put(
  "/api/request/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const incoming = req.body ?? {};
    let updated = null;
    await updateStore((requests) =>
      requests.map((r) => {
        if (r.id !== id) return r;
        updated = { ...r, ...incoming, id };
        return updated;
      })
    );
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, request: updated });
  })
);

app.get(
  "/api/requests",
  asyncHandler(async (_req, res) => {
    res.json(await loadStore());
  })
);

app.get(
  "/api/collections",
  asyncHandler(async (_req, res) => {
    const requests = await loadStore();
    const set = new Set(
      requests.map((r) => (r.collection && String(r.collection).trim()) || "Uncategorized")
    );
    res.json([...set]);
  })
);

app.get(
  "/api/postman",
  asyncHandler(async (req, res) => {
    const requests = await loadStore();
    const wanted = req.query.collection;
    if (typeof wanted === "string" && wanted.length) {
      const filtered = requests.filter(
        (r) => ((r.collection && String(r.collection).trim()) || "Uncategorized") === wanted
      );
      return res.json(buildPostmanCollection(filtered, wanted));
    }
    const groups = new Map();
    for (const r of requests) {
      const key = (r.collection && String(r.collection).trim()) || "Uncategorized";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    res.json({
      info: {
        name: "PostNia Workspace",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [...groups.entries()].map(([name, reqs]) => ({
        name,
        item: buildPostmanCollection(reqs, name).item,
      })),
    });
  })
);

app.post(
  "/api/import/postman",
  asyncHandler(async (req, res) => {
    const data = req.body ?? {};
    const items = flattenPostmanCollection(data);
    if (!items.length) {
      return res.status(400).json({ error: "no requests found in collection" });
    }
    const base = Date.now();
    await updateStore((requests) => {
      items.forEach((item, idx) => {
        requests.push({ id: base + idx, ...item });
      });
      return requests;
    });
    res.json({ ok: true, imported: items.length });
  })
);

app.delete(
  "/api/request/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    await updateStore((requests) => requests.filter((r) => r.id !== id));
    res.json({ ok: true });
  })
);

function flattenPostmanCollection(data) {
  const out = [];
  const rootName =
    (data && data.info && typeof data.info.name === "string" && data.info.name.trim()) ||
    "Imported";

  const walk = (node, collection) => {
    if (!node) return;
    if (Array.isArray(node.item)) {
      const sub = (node.name && String(node.name).trim()) || collection;
      for (const child of node.item) walk(child, sub);
    } else if (node.request) {
      out.push(postmanItemToRequest(node, collection));
    }
  };

  for (const child of Array.isArray(data?.item) ? data.item : []) {
    walk(child, rootName);
  }
  return out;
}

function postmanItemToRequest(item, collection) {
  const r = item.request || {};
  if (typeof r === "string") {
    return {
      name: item.name || "Imported",
      collection,
      method: "GET",
      url: r,
      headers: "{}",
      body: "",
    };
  }

  const method = String(r.method || "GET").toUpperCase();
  const url =
    typeof r.url === "string"
      ? r.url
      : (r.url && (r.url.raw || "")) || "";

  const headers = {};
  if (Array.isArray(r.header)) {
    for (const h of r.header) {
      if (h && h.key && !h.disabled) headers[h.key] = String(h.value ?? "");
    }
  }

  let body = "";
  const b = r.body;
  if (b && typeof b === "object") {
    if (b.mode === "raw") {
      body = String(b.raw || "");
    } else if (b.mode === "urlencoded" && Array.isArray(b.urlencoded)) {
      body = b.urlencoded
        .filter((p) => p && !p.disabled && p.key)
        .map(
          (p) =>
            `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? "")}`
        )
        .join("&");
    } else if (b.mode === "formdata" && Array.isArray(b.formdata)) {
      body = JSON.stringify(
        b.formdata.filter((p) => p && !p.disabled),
        null,
        2
      );
    } else if (b.mode === "graphql" && b.graphql) {
      body = JSON.stringify(b.graphql, null, 2);
    } else if (b.mode === "file" && b.file) {
      body = JSON.stringify(b.file, null, 2);
    }
  }

  return {
    name: item.name || "Imported",
    collection,
    method,
    url,
    headers: JSON.stringify(headers, null, 2),
    body,
  };
}

function buildPostmanCollection(requests, name) {
  return {
    info: {
      name: name || "PostNia Collection",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: requests.map((r) => {
      let headers = {};
      if (r.headers && typeof r.headers === "string") {
        try {
          headers = JSON.parse(r.headers) || {};
        } catch {
          headers = {};
        }
      } else if (r.headers && typeof r.headers === "object") {
        headers = r.headers;
      }

      let urlObj;
      try {
        const u = new URL(r.url);
        urlObj = {
          raw: r.url,
          protocol: u.protocol.replace(":", ""),
          host: u.hostname.split("."),
          path: u.pathname.split("/").filter(Boolean),
          query: [...u.searchParams].map(([key, value]) => ({ key, value })),
        };
        if (u.port) urlObj.port = u.port;
      } catch {
        urlObj = { raw: r.url || "" };
      }

      const method = (r.method || "GET").toUpperCase();
      const item = {
        name: r.name || "Unnamed",
        request: {
          method,
          header: Object.entries(headers).map(([key, value]) => ({
            key,
            value: String(value),
          })),
          url: urlObj,
        },
      };
      if (r.body && method !== "GET" && method !== "HEAD") {
        item.request.body = { mode: "raw", raw: String(r.body) };
      }
      return item;
    }),
  };
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err?.message ?? "internal error" });
});

app.listen(PORT, HOST, () =>
  console.log(`Tester running on http://${HOST}:${PORT}`)
);
