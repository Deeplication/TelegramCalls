// build.mjs
// Robust builder for Vendetta/Kettu-style plugin repos.
// - Node 18+ (ESM)
// - Bundles each plugin with esbuild
// - Emits dist/plugins/<id>.js and dist/plugins/<id>.json
// - Generates dist/index.json that the client can use as a repo listing
// - Works in GitHub Actions (Pages) by deriving the base URL from env

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { build as esbuild } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const PLUGINS_DIR = path.join(ROOT, "plugins");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_PLUGINS_DIR = path.join(DIST_DIR, "plugins");

// Infer Pages base URL for repo JSON links
function getBaseUrl() {
  // Allow override from CI or local
  const explicit = process.env.REPO_BASE_URL || process.env.PAGES_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  // Derive from GitHub Actions env
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!repo) {
    // Fallback to local preview
    return "http://localhost:4173";
  }
  const [owner, repoName] = repo.split("/");
  // If the repo is <owner>.github.io, base is the root
  //if (repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
  //eturn `https://${owner  return `https://${owner}.github.io/${repoName}`;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJSON(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function writeJSON(p, obj) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function sha256File(p) {
  const hash = crypto.createHash("sha256");
  const stream = (await fs.open(p, "r")).createReadStream();
  return await new Promise((resolve, reject) => {
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function discoverPlugins() {
  const plugins = [];
  if (await exists(PLUGINS_DIR)) {
    const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(PLUGINS_DIR, ent.name);
      const manifestPath = path.join(dir, "manifest.json");
      if (await exists(manifestPath)) {
        plugins.push({ id: ent.name, dir, manifestPath });
      }
    }
  } else {
    // Single-plugin repo fallback: manifest at root
    const manifestPath = path.join(ROOT, "manifest.json");
    if (await exists(manifestPath)) {
      const manifest = await readJSON(manifestPath);
      const id = manifest.id || path.basename(ROOT);
      plugins.push({ id, dir: ROOT, manifestPath });
    }
  }
  if (!plugins.length) {
    throw new Error("No plugins found. Place them in ./plugins/<id>/manifest.json or provide ./manifest.json.");
  }
  return plugins;
}

function normalizeAuthor(a) {
  // Allow string or object, normalize to { name, id?, icon? }
  if (typeof a === "string") return { name: a };
  const out = { name: a.name ?? "Unknown" };
  if (a.id) out.id = a.id;
  if (a.icon) out.icon = a.icon;
  return out;
}

async function bundlePlugin(plugin, baseUrl) {
  const manifest = await readJSON(plugin.manifestPath);

  // Resolve entry point
  const main = manifest.main || "index.ts";
  const entry = path.resolve(plugin.dir, main);
  if (!(await exists(entry))) {
    throw new Error(`[${manifest.id || plugin.id}] Entry file not found: ${path.relative(ROOT, entry)}`);
  }

  // Output files
  const outJs = path.join(OUT_PLUGINS_DIR, `${manifest.id || plugin.id}.js`);
  await ensureDir(OUT_PLUGINS_DIR);

  // Optional tsconfig detection
  const tsconfigPath = (await exists(path.join(plugin.dir, "tsconfig.json")))
    ? path.join(plugin.dir, "tsconfig.json")
    : (await exists(path.join(ROOT, "tsconfig.json")))
    ? path.join(ROOT, "tsconfig.json")
    : undefined;

  // Bundle with esbuild
  await esbuild({
    entryPoints: [entry],
    outfile: outJs,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    sourcemap: false,
    tsconfig: tsconfigPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
      "global": "globalThis"
    },
    // Externalize Node-only modules if someone imported accidentally
    external: ["fs", "path", "os", "crypto"],
  });

  // Hash for integrity
  const hashHex = await sha256File(outJs);
  const hash = `SHA-256:${hashHex}`;

  const id = manifest.id || plugin.id;
  const jsUrl = `${baseUrl}/plugins/${id}.js`;

  // Normalize authors and shape a repo-friendly JSON
  const authors = Array.isArray(manifest.authors)
    ? manifest.authors.map(normalizeAuthor)
    : manifest.authors
    ? [normalizeAuthor(manifest.authors)]
    : [];

  const pluginJson = {
    id,
    name: manifest.name ?? id,
    description: manifest.description ?? "",
    version: manifest.version ?? "0.0.0",
    authors,
    // Optional fields often used by loaders
    updateUrl: `${baseUrl}/index.json`,
    // Where to fetch the JS bundle
    js: jsUrl,
    hash,
    // Pass through any extra keys people commonly add
    // icon, source, license, etc.
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    ...(manifest.source ? { source: manifest.source } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
  };

  // Emit per-plugin JSON descriptor
  const outJson = path.join(OUT_PLUGINS_DIR, `${id}.json`);
  await writeJSON(outJson, pluginJson);

  return pluginJson;
}

async function buildAll() {
  const baseUrl = getBaseUrl();

  // Clean dist
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await ensureDir(OUT_PLUGINS_DIR);

  // Copy a minimal 404.html for Pages SPA-friendly routing (optional)
  await fs.writeFile(path.join(DIST_DIR, "404.html"), "<!doctype html><meta charset=utf-8>Not Found\n");

  // Bundle plugins
  const plugins = await discoverPlugins();
  const results = [];
  for (const plugin of plugins) {
    const out = await bundlePlugin(plugin, baseUrl);
    results.push(out);
    console.log(`✔ Built ${out.id} -> ${path.relative(ROOT, path.join(OUT_PLUGINS_DIR, `${out.id}.js`))}`);
  }

  // Build root index.json (repo listing)
  // Many loaders expect either an array or an object with "plugins" field.
  // We provide both for compatibility.
  const indexObj = {
    name: (await safePkgName()) || "Plugin Repo",
    baseUrl,
    plugins: results,
  };
  await writeJSON(path.join(DIST_DIR, "index.json"), indexObj);

  // Also emit a flat array for older loaders
  await writeJSON(path.join(DIST_DIR, "plugins.json"), results);

  console.log(`\nRepo ready: ${baseUrl}/index.json`);
}

async function safePkgName() {
  try {
    const pkg = await readJSON(path.join(ROOT, "package.json"));
    return pkg.name;
  } catch {
    return null;
  }
}

// Run
buildAll().catch((err) => {
  console.error("Build failed:", err?.message || err);
  process.exitCode = 1;
});
