import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageSnapshot {
  plan: string;
  usedMs: number;
  limitMs: number;
  resetInMs?: number;
  resetAt?: number;
  primaryPercent?: number;
  secondaryPercent?: number;
  secondaryResetInMs?: number;
  secondaryResetAt?: number;
  available: boolean;
  estimated?: boolean;
  source?: "api" | "env" | "file" | "local";
}

const DEFAULT_LIMIT_MS = 5 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_GAP_MS = 15 * 60 * 1000;
const DEFAULT_RESPONSE_FLOOR_MS = 30 * 1000;
const FILE_CACHE_TTL_MS = 15 * 1000;
const API_CACHE_TTL_MS = 60 * 1000;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface UsageEvent {
  sessionId: string;
  timestamp: number;
  assistant: boolean;
}

interface FileEventCache {
  at: number;
  events: UsageEvent[];
}

let fileEventCache: FileEventCache | undefined;
let apiCache: { at: number; snapshot: UsageSnapshot } | undefined;
let apiInFlight: Promise<void> | undefined;
let apiUpdate: (() => void) | undefined;

export function setUsageUpdateRenderer(fn: (() => void) | undefined): void {
  apiUpdate = fn;
}

function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function strEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function parseDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  const compound = raw.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/i);
  if (!m) {
    if (compound && (compound[1] || compound[2])) {
      return (Number(compound[1] ?? 0) * 60 + Number(compound[2] ?? 0)) * 60 * 1000;
    }
    return undefined;
  }
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60 * 1000;
  return value * 60 * 60 * 1000;
}

function readUsageFile(): Partial<UsageSnapshot> | undefined {
  const path = strEnv("PI_PANE_USAGE_FILE") ?? join(codexDir(), "usage-limits.json");
  if (!path) return undefined;
  try {
    // JSON shape may match UsageSnapshot or use snake-ish keys.
    const data = JSON.parse(readFileSync(path, "utf8"));
    const fiveH = data["5h"];
    const sevenD = data["7d"];
    const resetAt = Number.isFinite(data.resetAt) ? data.resetAt : Number.isFinite(data.reset_at) ? data.reset_at : parseTimeMs(fiveH?.resets_at);
    const secondaryResetAt = parseTimeMs(sevenD?.resets_at);
    const primaryPercent = num(data.primaryPercent) ?? num(data.primary_percent) ?? num(fiveH?.pct);
    const secondaryPercent = num(data.secondaryPercent) ?? num(data.secondary_percent) ?? num(sevenD?.pct);
    const limitMs = Number.isFinite(data.limitMs) ? data.limitMs : Number.isFinite(data.limit_ms) ? data.limit_ms : num(fiveH?.window_secs) ? Number(fiveH.window_secs) * 1000 : undefined;
    return {
      plan: typeof data.plan === "string" ? data.plan : undefined,
      usedMs: Number.isFinite(data.usedMs) ? data.usedMs : Number.isFinite(data.used_ms) ? data.used_ms : primaryPercent !== undefined && limitMs ? (primaryPercent / 100) * limitMs : undefined,
      limitMs,
      resetInMs: Number.isFinite(data.resetInMs) ? data.resetInMs : Number.isFinite(data.reset_in_ms) ? data.reset_in_ms : resetAt ? resetAt - Date.now() : undefined,
      resetAt,
      primaryPercent,
      secondaryPercent,
      secondaryResetAt,
      secondaryResetInMs: secondaryResetAt ? secondaryResetAt - Date.now() : undefined,
      source: data.source === "api" ? "api" : "file",
    };
  } catch {
    return undefined;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function codexDir(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function readCodexAuth(): any | undefined {
  try { return JSON.parse(readFileSync(strEnv("PI_PANE_CODEX_AUTH_FILE") ?? join(codexDir(), "auth.json"), "utf8")); }
  catch { return undefined; }
}

function jwtPlan(auth: any): string | undefined {
  const idToken = auth?.tokens?.id_token;
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
    const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return typeof plan === "string" && plan ? plan : undefined;
  } catch {
    return undefined;
  }
}

async function refreshAccessToken(auth: any): Promise<string | undefined> {
  const refreshToken = auth?.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) return undefined;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_CLIENT_ID });
  const res = await fetch(CODEX_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) return undefined;
  const data: any = await res.json();
  return typeof data.access_token === "string" ? data.access_token : undefined;
}

function usageFromApi(data: any, planFallback?: string): UsageSnapshot | undefined {
  const primary = data?.rate_limit?.primary_window;
  if (!primary) return undefined;
  const primaryPercent = num(primary.used_percent);
  const windowMs = (num(primary.limit_window_seconds) ?? 5 * 60 * 60) * 1000;
  const resetAt = parseTimeMs(primary.reset_at);
  const secondary = data?.rate_limit?.secondary_window;
  const secondaryResetAt = parseTimeMs(secondary?.reset_at);
  const plan = typeof data?.plan_type === "string" ? data.plan_type : planFallback ?? "Codex";
  return {
    plan,
    usedMs: primaryPercent !== undefined ? (primaryPercent / 100) * windowMs : 0,
    limitMs: windowMs,
    resetAt,
    resetInMs: resetAt ? resetAt - Date.now() : undefined,
    primaryPercent,
    secondaryPercent: num(secondary?.used_percent),
    secondaryResetAt,
    secondaryResetInMs: secondaryResetAt ? secondaryResetAt - Date.now() : undefined,
    available: primaryPercent !== undefined,
    source: "api",
  };
}

async function fetchCodexUsage(): Promise<UsageSnapshot | undefined> {
  const auth = readCodexAuth();
  const tokens = auth?.tokens ?? {};
  let accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  if (!accessToken) return undefined;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : "";
  const planFallback = jwtPlan(auth);

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "User-Agent": "pi-pane",
        Accept: "application/json",
      },
    });
    if (res.ok) return usageFromApi(await res.json(), planFallback);
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      accessToken = await refreshAccessToken(auth);
      if (accessToken) continue;
    }
    return undefined;
  }
  return undefined;
}

function apiUsage(): UsageSnapshot | undefined {
  if (process.env.PI_PANE_CODEX_USAGE_API === "0" || process.env.PI_PANE_CODEX_USAGE_API === "false") return undefined;
  const now = Date.now();
  if (apiCache && now - apiCache.at < API_CACHE_TTL_MS) return apiCache.snapshot;
  if (!apiInFlight) {
    apiInFlight = fetchCodexUsage()
      .then((snapshot) => { if (snapshot) { apiCache = { at: Date.now(), snapshot }; apiUpdate?.(); } })
      .catch(() => {})
      .finally(() => { apiInFlight = undefined; });
  }
  return apiCache?.snapshot;
}

function sessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

function collectJsonlFiles(dir: string, out: string[], cutoffMs: number): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(p, out, cutoffMs);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      if (statSync(p).mtimeMs >= cutoffMs) out.push(p);
    } catch {
      // ignore unreadable files
    }
  }
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

function addEvent(events: UsageEvent[], seen: Set<string>, sessionId: string, timestamp: number | undefined, assistant: boolean): void {
  if (!sessionId || timestamp === undefined || !Number.isFinite(timestamp)) return;
  const key = `${sessionId}:${timestamp}:${assistant ? "a" : "u"}`;
  if (seen.has(key)) return;
  seen.add(key);
  events.push({ sessionId, timestamp, assistant });
}

function collectCtxEvents(ctx: any, seen: Set<string>): UsageEvent[] {
  const events: UsageEvent[] = [];
  const sessionId = String(ctx?.sessionManager?.getSessionId?.() ?? "current");
  const entries = ctx?.sessionManager?.getEntries?.();
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const timestamp = toTimestampMs(entry.timestamp) ?? toTimestampMs(entry.message?.timestamp);
    addEvent(events, seen, sessionId, timestamp, role === "assistant");
  }
  return events;
}

function collectFileEvents(now: number): UsageEvent[] {
  if (fileEventCache && now - fileEventCache.at < FILE_CACHE_TTL_MS) return fileEventCache.events;

  const files: string[] = [];
  const cutoffMs = now - DEFAULT_LIMIT_MS - DEFAULT_ACTIVE_GAP_MS;
  collectJsonlFiles(sessionsDir(), files, cutoffMs);

  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let sessionId = "";
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") {
          sessionId = typeof entry.id === "string" ? entry.id : sessionId;
          continue;
        }
        if (entry.type !== "message") continue;
        const role = entry.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const timestamp = toTimestampMs(entry.timestamp) ?? toTimestampMs(entry.message?.timestamp);
        addEvent(events, seen, sessionId || file, timestamp, role === "assistant");
      } catch {
        // skip malformed lines
      }
    }
  }

  fileEventCache = { at: now, events };
  return events;
}

function computeActivity(events: UsageEvent[], now: number, windowMs: number): { usedMs: number; resetInMs?: number } | undefined {
  const activeGapMs = numEnv("PI_PANE_USAGE_ACTIVE_GAP_MS") ?? DEFAULT_ACTIVE_GAP_MS;
  const responseFloorMs = numEnv("PI_PANE_USAGE_RESPONSE_FLOOR_MS") ?? DEFAULT_RESPONSE_FLOOR_MS;
  const start = now - windowMs;
  const bySession = new Map<string, UsageEvent[]>();
  let oldest: number | undefined;

  for (const event of events) {
    if (event.timestamp < start || event.timestamp > now + 60_000) continue;
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
    oldest = oldest === undefined ? event.timestamp : Math.min(oldest, event.timestamp);
  }

  let usedMs = 0;
  for (const list of bySession.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    let last: UsageEvent | undefined;
    let assistantCount = 0;
    for (const event of list) {
      if (event.assistant) assistantCount++;
      if (last) {
        const gap = event.timestamp - last.timestamp;
        if (gap > 0 && gap <= activeGapMs) usedMs += gap;
      }
      last = event;
    }
    usedMs += assistantCount * responseFloorMs;
  }

  return {
    usedMs: Math.max(0, usedMs),
    resetInMs: oldest !== undefined ? Math.max(0, oldest + windowMs - now) : undefined,
  };
}

function localUsage(ctx: any, limitMs: number): Pick<UsageSnapshot, "usedMs" | "resetInMs"> | undefined {
  if (process.env.PI_PANE_USAGE_LOCAL === "0" || process.env.PI_PANE_USAGE_LOCAL === "false") return undefined;
  const now = Date.now();
  const seen = new Set<string>();
  const events = [...collectFileEvents(now), ...collectCtxEvents(ctx, seen)];

  // Deduplicate file + live session after combining.
  const deduped: UsageEvent[] = [];
  const allSeen = new Set<string>();
  for (const event of events) addEvent(deduped, allSeen, event.sessionId, event.timestamp, event.assistant);

  return computeActivity(deduped, now, limitMs);
}

function isUsingSubscription(ctx: any): boolean {
  try {
    return !!(ctx?.model && ctx?.modelRegistry?.isUsingOAuth?.(ctx.model));
  } catch {
    return false;
  }
}

export function getUsageSnapshot(ctx?: any): UsageSnapshot {
  const api = apiUsage();
  if (api?.available) return api;

  const file = readUsageFile() ?? {};
  const plan = strEnv("PI_PANE_USAGE_PLAN") ?? file.plan ?? (isUsingSubscription(ctx) ? "Pro" : "Local");
  const usedMs = numEnv("PI_PANE_USAGE_USED_MS") ?? parseDurationMs(process.env.PI_PANE_USAGE_USED) ?? file.usedMs;
  const limitMs = numEnv("PI_PANE_USAGE_LIMIT_MS") ?? parseDurationMs(process.env.PI_PANE_USAGE_LIMIT) ?? file.limitMs ?? DEFAULT_LIMIT_MS;
  const resetAt = numEnv("PI_PANE_USAGE_RESET_AT") ?? file.resetAt;
  const resetInMs = numEnv("PI_PANE_USAGE_RESET_IN_MS") ?? parseDurationMs(process.env.PI_PANE_USAGE_RESET_IN) ?? file.resetInMs ?? (resetAt ? resetAt - Date.now() : undefined);

  if (typeof usedMs !== "number" && Number.isFinite(limitMs) && limitMs > 0) {
    const local = localUsage(ctx, limitMs);
    if (local) {
      return {
        plan,
        usedMs: local.usedMs,
        limitMs,
        resetInMs: local.resetInMs,
        resetAt,
        primaryPercent: file.primaryPercent,
        secondaryPercent: file.secondaryPercent,
        secondaryResetInMs: file.secondaryResetInMs,
        secondaryResetAt: file.secondaryResetAt,
        available: true,
        estimated: true,
        source: "local",
      };
    }
  }

  if (typeof usedMs !== "number" || !Number.isFinite(usedMs) || !Number.isFinite(limitMs) || limitMs <= 0) {
    return { plan, usedMs: 0, limitMs, resetInMs, resetAt, available: false };
  }

  return {
    plan,
    usedMs: Math.max(0, usedMs),
    limitMs,
    resetInMs: resetInMs !== undefined ? Math.max(0, resetInMs) : undefined,
    resetAt,
    primaryPercent: file.primaryPercent,
    secondaryPercent: file.secondaryPercent,
    secondaryResetInMs: file.secondaryResetInMs !== undefined ? Math.max(0, file.secondaryResetInMs) : undefined,
    secondaryResetAt: file.secondaryResetAt,
    available: true,
    source: file.usedMs !== undefined ? file.source ?? "file" : "env",
  };
}
