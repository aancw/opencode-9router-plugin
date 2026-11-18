import { spawn, type ChildProcess } from "node:child_process";
import { Model, Plugin, Provider } from "@opencode/plugin";

type AnyCfg = Record<string, any>;

const PROVIDER_ID = "9router";
const PROVIDER_NAME = "9Router";
// v1 config `npm` field loads an AI SDK provider package; v2 uses `package` in Provider.Info.
const PROVIDER_NPM_V1 = "@ai-sdk/openai-compatible";
const PROVIDER_PACKAGE_V2 = "@opencode/ai/providers/openai-compatible";

const DEFAULT_BASE = "http://localhost:20128/v1";
const DEFAULT_TIMEOUT_MS = 5000;

// Levels 9router advertises in `thinking_levels` that opencode accepts as
// reasoning efforts (ReasoningEfforts union). "ultra" has no opencode mapping
// and is skipped; "thinking" is a toggle handled separately.
const EFFORT_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface LiveCapabilities {
  reasoning?: boolean;
  tools?: boolean;
  vision?: boolean;
  pdf?: boolean;
  thinkingCanDisable?: boolean;
  contextWindow?: number;
  maxOutput?: number;
}

interface LiveModel {
  id: string;
  capabilities?: LiveCapabilities;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number; input_cache_write?: string | number };
  thinking_levels?: string[];
}

// Mutable overlay merged onto Model.Info.default() at registration time.
// Fields stay loosely typed; the spread casts into opencode's branded schemas.
interface InfoPatch {
  limit?: Record<string, any>;
  cost?: any[];
  capabilities?: Record<string, any>;
  variants: Model.Variant[];
}

interface DiscoveredModel {
  id: string;
  info: InfoPatch;
}

interface Discovery {
  baseUrl: string;
  apiKey: string;
  models: DiscoveredModel[];
  defaultModel: string | null;
  // True when the opencode process could not reach the gateway directly and
  // the catalog was fetched out-of-process (curl). Request traffic then has to
  // flow through a local relay to be reachable at all.
  directConnection: boolean;
}

function readEnv(): { baseUrl: string; apiKey: string; timeoutMs: number } {
  const baseUrl = process.env.OPENCODE_9ROUTER_URL || DEFAULT_BASE;
  const apiKey = process.env.OPENCODE_9ROUTER_API_KEY || "";
  const timeoutMs = Number(process.env.OPENCODE_9ROUTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return { baseUrl, apiKey, timeoutMs };
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function describeError(err: unknown): string {
  const e = err as any;
  return e?.cause?.code || e?.code || e?.message || String(err);
}

async function fetchJson(url: string, timeoutMs: number, apiKey: string): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: buildHeaders(apiKey),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

function extractEntries(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.models)) return json.models;
  if (Array.isArray(json.data)) return json.data;
  return [];
}

// Out-of-process fetch. macOS blocks some binaries from local-network access
// (System Settings → Privacy & Security → Local Network); opencode's embedded
// runtime can get ECONNREFUSED for LAN gateways while /usr/bin/curl still
// reaches them. The catalog is small enough that a one-shot curl is fine.
async function fetchJsonViaCurl(url: string, timeoutMs: number, apiKey: string): Promise<any> {
  const { spawnSync } = await import("node:child_process");
  const args = [
    "-sSf",
    "--max-time",
    String(Math.max(2, Math.ceil(timeoutMs / 1000))),
    "-H",
    "Accept: application/json",
  ];
  if (apiKey) args.push("-H", `Authorization: Bearer ${apiKey}`);
  args.push(url);
  const binaries = ["/usr/bin/curl", "curl"];
  let lastError: unknown;
  for (const bin of binaries) {
    try {
      const result = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs + 2000, windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`curl exit ${result.status}: ${(result.stderr || "").trim()}`);
      return JSON.parse(result.stdout);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchEntries(baseUrl: string, timeoutMs: number, apiKey: string): Promise<{ entries: any[]; direct: boolean }> {
  const tries = [`${baseUrl}/models`, `${baseUrl}/model`, `${baseUrl}`];
  for (const direct of [true, false]) {
    for (const url of tries) {
      try {
        const data = direct ? await fetchJson(url, timeoutMs, apiKey) : await fetchJsonViaCurl(url, timeoutMs, apiKey);
        const entries = extractEntries(data);
        if (entries.length > 0) return { entries, direct };
      } catch {
        // try next endpoint / next transport
      }
    }
  }
  return { entries: [], direct: false };
}

// 9router exposes thinking either as dedicated `-thinking` model ids or as
// reasoning-capable upstreams. Models matching these hints get effort variants
// (`9router/<model>#low|#medium|#high`) that set `reasoning_effort` on requests.
// Only used as a fallback when the endpoint returns bare ids without metadata.
const REASONING_HINTS: RegExp[] = [
  /thinking/i, // grok-4.1-thinking, kimi-k2-thinking-251104, gemini-2.5-flash-thinking
  /reasoning/i, // grok-4-fast-reasoning
  /(^|\/)o[134](-|$)/i, // o1, o3, o4-mini (channel-prefixed ids allowed)
  /gpt-5/i, // gpt-5.x are all reasoning models
  /deepseek-r|deepseek-reasoner/i,
  /qwq/i,
  /gemini-[23]/i, // gemini 2.5+ / 3.x support thinking
  /grok-3-mini|grok-[4-9]/i,
  /glm-4\.[5-9]|glm-[5-9]/i,
  /minimax-m[2-9]/i,
];

function isReasoningId(id: string): boolean {
  return REASONING_HINTS.some((hint) => hint.test(id));
}

function heuristicVariants(id: string): Model.Variant[] {
  if (!isReasoningId(id)) return [];
  return ["low", "medium", "high"].map((effort) => ({
    id: Model.VariantID.make(effort),
    settings: { reasoningEffort: effort },
  }));
}

// Variants from the live catalog: `thinking_levels` advertises exactly which
// levels a model accepts, `capabilities.reasoning` gates them. Effort levels
// map to opencode's reasoningEffort (the gateway translates to the upstream
// dialect per model via thinkingFormat); the `thinking` level is a toggle for
// always-reasoning upstreams (zai/minimax).
function catalogVariants(entry: LiveModel): Model.Variant[] | null {
  const caps = entry.capabilities ?? {};
  if (caps.reasoning !== true) return null;
  const levels = Array.isArray(entry.thinking_levels) ? entry.thinking_levels : [];
  if (levels.length === 0) return null;
  const canDisable = caps.thinkingCanDisable !== false;
  const variants: Model.Variant[] = [];
  for (const level of levels) {
    if (level === "none") {
      if (canDisable) {
        variants.push({ id: Model.VariantID.make("none"), settings: { reasoningEffort: "none" } });
      }
      continue;
    }
    if (EFFORT_LEVELS.has(level)) {
      variants.push({ id: Model.VariantID.make(level), settings: { reasoningEffort: level } });
      continue;
    }
    if (level === "thinking") {
      variants.push({ id: Model.VariantID.make("thinking"), settings: { thinking: { type: "enabled" } } });
    }
    // Unknown levels have no opencode mapping; skip them.
  }
  return variants;
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 9router prices per token; opencode wants USD per million tokens.
function perMillion(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n === undefined) return undefined;
  return n < 1000 ? n * 1_000_000 : n;
}

function buildInfo(entry: LiveModel): InfoPatch {
  const caps = entry.capabilities ?? {};
  const info: InfoPatch = { variants: [] };

  const context = toNumber(caps.contextWindow) ?? toNumber(entry.context_length);
  const output = toNumber(caps.maxOutput) ?? toNumber(entry.max_completion_tokens);
  if (context || output) {
    info.limit = {
      context: context ?? 200_000,
      ...(output ? { output } : {}),
    };
  }

  const input = toNumber(entry.pricing?.prompt);
  const outputCost = toNumber(entry.pricing?.completion);
  if (input !== undefined && outputCost !== undefined) {
    info.cost = [
      {
        input: perMillion(entry.pricing?.prompt)!,
        output: perMillion(entry.pricing?.completion)!,
        cache: {
          read: perMillion(entry.pricing?.input_cache_read) ?? 0,
          write: perMillion(entry.pricing?.input_cache_write) ?? 0,
        },
      },
    ];
  }

  const inputModalities = ["text", ...(caps.vision ? ["image"] : []), ...(caps.pdf ? ["pdf"] : [])];
  info.capabilities = {
    tools: caps.tools !== false,
    input: inputModalities,
    output: ["text"],
  };

  return info;
}

function pickDefaultModel(models: string[]): string | null {
  if (!models.length) return null;
  const priorities = ["gpt", "claude", "gemini", "deepseek", "small"];
  for (const p of priorities) {
    const found = models.find((m) => m.toLowerCase().includes(p));
    if (found) return found;
  }
  return models[0] ?? null;
}

async function discover(): Promise<Discovery> {
  const { baseUrl, apiKey, timeoutMs } = readEnv();
  try {
    const { entries, direct } = await fetchEntries(baseUrl, timeoutMs, apiKey);
    const models: DiscoveredModel[] = entries
      .map((raw: any): LiveModel | string | null => (typeof raw === "string" ? raw : raw && typeof raw === "object" ? { ...raw, id: raw.id ?? raw.name } : null))
      .filter((item: any): item is LiveModel | string => Boolean(item?.id))
      .map((item) => {
        if (typeof item === "string") {
          // Bare id (older gateways): fall back to id heuristics.
          return { id: item, info: { variants: heuristicVariants(item) } };
        }
        const variants = catalogVariants(item) ?? heuristicVariants(item.id);
        return { id: item.id, info: { ...buildInfo(item), variants } };
      });
    if (!direct && models.length === 0) {
      console.warn("opencode-9router plugin: gateway unreachable from the opencode process and curl fallback returned no models");
    }
    return {
      baseUrl,
      apiKey,
      models,
      defaultModel: pickDefaultModel(models.map((m) => m.id)),
      directConnection: direct,
    };
  } catch (err) {
    console.warn("opencode-9router plugin: failed to discover models:", describeError(err));
    return { baseUrl, apiKey, models: [], defaultModel: null, directConnection: true };
  }
}

// ---------------------------------------------------------------------------
// Local relay
//
// When the opencode process cannot open connections to the gateway (macOS
// local-network permission denying the binary), both catalog discovery AND
// chat traffic fail with ECONNREFUSED. curl still works, and so does node:
// spawn a tiny node forwarder on loopback and point the provider's baseURL at
// it. The relay never buffers responses, so streaming (SSE) passes through.
// ---------------------------------------------------------------------------

const RELAY_CODE = `
const HOP = new Set(["host","connection","keep-alive","transfer-encoding","upgrade","proxy-authenticate","proxy-authorization","te","trailer","content-length"]);
const origin = process.env.RELAY_TARGET || "";
// Die with the parent: when the plugin host goes away, its stdin pipe closes.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
const { createServer } = await import("node:http");
const server = createServer(async (req, res) => {
  try {
    if (req.url?.endsWith("/__9router_health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (!origin) throw new Error("relay started without target origin");
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const controller = new AbortController();
    req.on("error", () => controller.abort());
    res.on("close", () => controller.abort());
    const upstream = await fetch(origin + req.url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      duplex: "half",
      signal: controller.signal,
      redirect: "manual",
    });
    const outHeaders = {};
    upstream.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) outHeaders[k] = v; });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      await upstream.body.pipeTo(new WritableStream({
        write: (chunk) => new Promise((done, fail) => res.write(chunk, (e) => (e ? fail(e) : done()))),
        close: () => res.end(),
        abort: () => res.destroy(),
      }));
    } else {
      res.end();
    }
  } catch (e) {
    try {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "relay_error", message: "9router relay: " + (e?.message || e) } }));
    } catch {}
  }
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
`;

const relays = new Map<string, { child: ChildProcess; baseURL: string }>();

async function resolveNodeBinary(): Promise<string | null> {
  const { spawnSync } = await import("node:child_process");
  const { globSync } = await import("node:fs");
  const candidates = [
    process.env.OPENCODE_9ROUTER_NODE,
    "node",
    // Login shell PATH (nvm, volta, etc. are often absent from a service's PATH).
    "/bin/sh",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/local/bin/node",
    ...globSync(`${process.env.HOME || "~"}/.nvm/versions/node/*/bin/node`).sort().reverse(),
  ].filter(Boolean) as string[];

  const works = (bin: string): boolean => {
    try {
      if (bin === "/bin/sh") return false; // handled below
      const result = spawnSync(bin, ["-v"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  };

  for (const bin of candidates) {
    if (bin === "/bin/sh") {
      try {
        const result = spawnSync("/bin/sh", ["-lc", "command -v node"], { encoding: "utf8", timeout: 5000, windowsHide: true });
        const found = result.status === 0 ? (result.stdout || "").trim().split(/\r?\n/)[0] : "";
        if (found && works(found)) return found;
      } catch {
        // next candidate
      }
      continue;
    }
    if (works(bin)) return bin;
  }
  return null;
}

function probeRelay(baseURL: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${baseURL}/__9router_health`, { signal: controller.signal })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => clearTimeout(id));
}

// Returns a loopback baseURL forwarding to the gateway origin, or null when no
// usable node runtime exists to host the relay.
async function ensureRelay(targetOrigin: string, timeoutMs: number): Promise<string | null> {
  const existing = relays.get(targetOrigin);
  if (existing && (await probeRelay(existing.baseURL, timeoutMs))) return existing.baseURL;

  const node = await resolveNodeBinary();
  if (!node) {
    console.warn("opencode-9router plugin: no node runtime found for the local relay; install node or grant opencode local-network access");
    return null;
  }

  const child = spawn(node, ["--input-type=module", "-e", RELAY_CODE], {
    env: { ...process.env, RELAY_TARGET: targetOrigin },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  const baseURL = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(timeoutMs, 5000));
    let buffer = "";
    const onStdout = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onStdout);
        child.stdout?.resume(); // keep draining so the child never blocks
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout?.on("data", onStdout);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(null);
      if (code !== 0) console.warn(`opencode-9router plugin: relay exited with code ${code}`);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve(null);
      console.warn("opencode-9router plugin: relay failed to start:", err.message);
    });
  });

  if (!baseURL) {
    child.kill();
    return null;
  }
  if (!(await probeRelay(baseURL, timeoutMs))) {
    child.kill();
    console.warn("opencode-9router plugin: relay did not become healthy on loopback");
    return null;
  }

  relays.set(targetOrigin, { child, baseURL });
  return baseURL;
}

async function stopRelays(): Promise<void> {
  for (const [origin, entry] of relays) {
    relays.delete(origin);
    entry.child.kill();
  }
}

// Shared by both entrypoints: what each host version injects into the provider config.
async function providerOptions(d: Discovery): Promise<Record<string, any>> {
  let baseURL = d.baseUrl;
  if (!d.directConnection) {
    // The opencode process cannot reach the gateway directly; route through a
    // loopback relay so chat requests (not just discovery) keep working.
    const origin = new URL(d.baseUrl).origin;
    const relay = await ensureRelay(origin, DEFAULT_TIMEOUT_MS);
    if (relay) {
      // The relay forwards paths verbatim, so the base path (/v1) stays intact.
      baseURL = `${relay}${new URL(d.baseUrl).pathname.replace(/\/$/, "")}`;
    }
  }
  const options: Record<string, any> = {
    name: PROVIDER_NAME,
    baseURL,
  };
  if (d.apiKey) options.apiKey = d.apiKey;
  return options;
}

export default {
  // ---- OpenCode v2 entrypoint ----
  ...Plugin.define({
    id: PROVIDER_ID,
    async setup(ctx) {
      // Discovery runs BEFORE registering transforms: transforms must be
      // synchronous, cheap and replayable (they capture this data in closure).
      const discovery = await discover();
      if (discovery.models.length === 0) {
        console.warn("opencode-9router plugin: no models discovered; check the gateway URL / API key and connectivity");
        return;
      }

      const providerID = Provider.ID.make(PROVIDER_ID);
      const options = await providerOptions(discovery);
      const models = discovery.models.map(({ id, info }) => ({
        ...Model.Info.default(providerID, Model.ID.make(id)),
        ...info,
      }) as Model.Info);

      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: PROVIDER_NAME,
            activation: "enabled",
            package: PROVIDER_PACKAGE_V2,
            settings: options,
          },
          models,
        });
      });

      if (discovery.defaultModel) {
        const defaultModel = discovery.defaultModel;
        await ctx.model.transform((editor) => {
          // Only set a default when the user has not chosen one.
          if (!editor.default.get()) {
            editor.default.set(providerID, Model.ID.make(defaultModel));
          }
        });
      }

      return stopRelays;
    },
  }),

  // ---- OpenCode v1 entrypoint (supported since 1.18.29) ----
  async server() {
    const discovery = await discover();
    const options = await providerOptions(discovery);

    return {
      config: async (cfg: AnyCfg) => {
        cfg.provider ||= {};
        cfg.provider[PROVIDER_ID] ||= {};
        cfg.provider[PROVIDER_ID].npm ||= PROVIDER_NPM_V1;
        cfg.provider[PROVIDER_ID].options ||= {};
        for (const [key, value] of Object.entries(options)) {
          cfg.provider[PROVIDER_ID].options[key] ??= value;
        }

        cfg.provider[PROVIDER_ID].models ||= {};
        for (const model of discovery.models) {
          cfg.provider[PROVIDER_ID].models[model.id] ||= {};
        }

        if (!cfg.model && discovery.defaultModel) {
          cfg.model = `${PROVIDER_ID}/${discovery.defaultModel}`;
        }
      },
    };
  },
};
