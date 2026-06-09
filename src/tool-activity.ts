import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolActivity {
  id: string;
  name: string;
  alias: string;
  status: ToolStatus;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  turn: number;
}

const SUCCESS_TTL_MS = 3000;
const QUICK_TOOL_MS = 300;

const ALIASES: Record<string, string> = {
  exec_command: "exec",
  "functions.exec_command": "exec",
  apply_patch: "patch",
  "functions.apply_patch": "patch",
  ffgrep: "grep",
  "functions.ffgrep": "grep",
  fffind: "find",
  "functions.fffind": "find",
  web_search: "search",
  "functions.web_search": "search",
  web_fetch: "fetch",
  "functions.web_fetch": "fetch",
  "context7_query-docs": "docs",
  "functions.context7_query-docs": "docs",
  "context7_resolve-library-id": "docs id",
  "functions.context7_resolve-library-id": "docs id",
  document_parse: "parse",
  "functions.document_parse": "parse",
  document_search: "doc search",
  "functions.document_search": "doc search",
  document_screenshot: "shot",
  "functions.document_screenshot": "shot",
  bash: "exec",
  grep: "grep",
  find: "find",
  read: "read",
  edit: "edit",
  write: "write",
  ls: "ls",
};

function aliasTool(name: string): string {
  const clean = name.replace(/^multi_tool_use\./, "");
  if (ALIASES[clean]) return ALIASES[clean];
  const last = clean.split(/[.:/]/).filter(Boolean).pop() ?? clean;
  return last.length > 10 ? `${last.slice(0, 9)}…` : last;
}

export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${Math.max(0.1, clamped / 1000).toFixed(1)}s`;
  if (clamped < 10000) return `${(clamped / 1000).toFixed(1)}s`;
  if (clamped < 60000) return `${Math.round(clamped / 1000)}s`;
  const m = Math.floor(clamped / 60000);
  const s = Math.round((clamped % 60000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function glyph(status: ToolStatus): string {
  if (status === "pending") return "…";
  if (status === "running") return "●";
  if (status === "success") return "✓";
  return "×";
}

function statusColor(theme: Theme, status: ToolStatus, text: string): string {
  try {
    if (status === "error") return theme.fg("error", text);
    if (status === "success") return theme.fg("success", text);
    if (status === "running") return theme.fg("accent", text);
    return theme.fg("muted", text);
  } catch {
    return text;
  }
}

function dim(theme: Theme, text: string): string {
  try { return theme.fg("dim", text); } catch { return text; }
}

export class ToolActivityStore {
  private activities = new Map<string, ToolActivity>();
  private order: string[] = [];
  private tombstones = new Set<string>();
  private turn = 0;
  private requestRender: (() => void) | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  setRenderer(requestRender: (() => void) | undefined): void {
    this.requestRender = requestRender;
    this.syncTimer();
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.tickTimer = undefined;
    this.clearTimer = undefined;
    this.requestRender = undefined;
  }

  turnStart(): void {
    this.turn++;
    this.activities.clear();
    this.order = [];
    this.invalidate();
  }

  turnEnd(): void {
    this.scheduleClear();
  }

  input(): void {
    for (const [id, a] of this.activities) {
      if (a.status === "error") {
        this.activities.delete(id);
        this.tombstones.add(id);
      }
    }
    this.order = this.order.filter((id) => this.activities.has(id));
    this.invalidate();
  }

  call(id: string, name: string): void {
    this.upsert(id, name, "pending");
  }

  start(id: string, name: string): void {
    const now = Date.now();
    const prev = this.activities.get(id);
    if (prev?.status === "running" && prev.startedAt !== undefined) return;
    const a = this.upsert(id, name, "running");
    a.startedAt ??= now;
    a.endedAt = undefined;
    this.syncTimer();
  }

  end(id: string, name: string, isError: boolean): void {
    const now = Date.now();
    const nextStatus: ToolStatus = isError ? "error" : "success";
    const prev = this.activities.get(id);
    if (prev?.status === nextStatus && prev.endedAt !== undefined) return;
    const a = this.upsert(id, name, nextStatus);
    a.startedAt ??= now;
    a.endedAt = now;
    a.isError = isError;
    this.syncTimer();
    this.scheduleClear();
  }

  syncFromComponent(component: any): void {
    const id = String(component?.toolCallId ?? "");
    const name = String(component?.toolName ?? "tool");
    if (!id) return;
    if (component?.result) {
      if (!this.activities.has(id)) return;
      this.end(id, name, Boolean(component.result.isError));
    } else if (component?.executionStarted) {
      this.start(id, name);
    } else {
      this.call(id, name);
    }
  }

  shouldRenderFor(id: string): boolean {
    const visible = this.visibleActivities();
    return visible.length > 0 && visible[0]!.id === id;
  }

  render(theme: Theme, width: number): string[] {
    const visible = this.visibleActivities();
    if (visible.length === 0) return [];

    if (width < 28) {
      const running = visible.filter((a) => a.status === "running" || a.status === "pending").length;
      const done = visible.filter((a) => a.status === "success").length;
      const err = visible.filter((a) => a.status === "error").length;
      const parts = [];
      if (running) parts.push(`${running} running`);
      if (done) parts.push(`${done} done`);
      if (err) parts.push(`${err} failed`);
      return [truncateToWidth(dim(theme, `tools  ${parts.join(" · ")}`), width, "")];
    }

    const prefix = dim(theme, "tools  ");
    const pills: string[] = [];
    let used = visibleWidth(prefix);
    const maxPills = width < 60 ? 2 : 3;
    let hidden = 0;

    for (const a of visible) {
      if (pills.length >= maxPills) { hidden++; continue; }
      const dur = a.startedAt ? formatDuration((a.endedAt ?? Date.now()) - a.startedAt) : "";
      const body = `${a.alias} ${glyph(a.status)}${dur ? ` ${dur}` : ""}`;
      const pill = `[${statusColor(theme, a.status, body)}]`;
      const nextW = visibleWidth(pill) + (pills.length ? 1 : 0);
      const reserve = hidden || visible.length > pills.length + 1 ? 4 : 0;
      if (used + nextW + reserve > width) { hidden++; continue; }
      pills.push(pill);
      used += nextW;
    }

    hidden += Math.max(0, visible.length - pills.length - hidden);
    let line = prefix + pills.join(" ");
    if (hidden > 0) line += dim(theme, ` +${hidden}`);

    const failed = visible.some((a) => a.status === "error");
    const running = visible.some((a) => a.status === "running" || a.status === "pending");
    if (failed && visibleWidth(line) + 8 <= width) line += dim(theme, "  failed");
    if (!failed && !running && visible.length > 1) {
      const total = visible.reduce((sum, a) => sum + ((a.endedAt ?? Date.now()) - (a.startedAt ?? a.endedAt ?? Date.now())), 0);
      const summary = dim(theme, `  ${visible.length} done · ${formatDuration(total)}`);
      if (visibleWidth(line) + visibleWidth(summary) <= width) line += summary;
    }

    return [truncateToWidth(line, width, "")];
  }

  private upsert(id: string, name: string, status: ToolStatus): ToolActivity {
    let a = this.activities.get(id);
    let changed = false;
    if (!a) {
      a = { id, name, alias: aliasTool(name), status, turn: this.turn };
      this.activities.set(id, a);
      this.order.push(id);
      changed = true;
    } else {
      const nextAlias = aliasTool(name);
      changed = a.name !== name || a.alias !== nextAlias || a.status !== status;
      a.name = name;
      a.alias = nextAlias;
      a.status = status;
    }
    if (changed) this.invalidate();
    return a;
  }

  private visibleActivities(): ToolActivity[] {
    const now = Date.now();
    return this.order
      .map((id) => this.activities.get(id))
      .filter((a): a is ToolActivity => Boolean(a))
      .filter((a) => {
        if (a.status === "error") return true;
        if (a.status === "running" || a.status === "pending") return true;
        const dur = (a.endedAt ?? now) - (a.startedAt ?? a.endedAt ?? now);
        if (dur < QUICK_TOOL_MS) return now - (a.endedAt ?? now) < 1200;
        return now - (a.endedAt ?? now) < SUCCESS_TTL_MS;
      });
  }

  private scheduleClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      const before = this.activities.size;
      const visible = new Set(this.visibleActivities().map((a) => a.id));
      for (const [id, a] of this.activities) {
        if (!visible.has(id)) {
          this.activities.delete(id);
          if (a.status === "success" || a.status === "error") this.tombstones.add(id);
        }
      }
      this.order = this.order.filter((id) => this.activities.has(id));
      if (this.tombstones.size > 500) this.tombstones = new Set(Array.from(this.tombstones).slice(-250));
      if (this.activities.size !== before) this.invalidate();
      this.syncTimer();
    }, SUCCESS_TTL_MS + 100);
  }

  private syncTimer(): void {
    const needsTick = this.visibleActivities().some((a) => a.status === "running" || a.status === "pending");
    if (needsTick && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.invalidate(), 1000);
    } else if (!needsTick && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private invalidate(): void {
    this.requestRender?.();
  }
}

const PATCHED = Symbol.for("pi-pane:toolExecutionPatched");
const STORE = Symbol.for("pi-pane:toolActivityStore");
const THEME = Symbol.for("pi-pane:toolActivityGetTheme");

export function patchToolExecutionComponent(store: ToolActivityStore, getTheme: () => Theme): void {
  (globalThis as any)[STORE] = store;
  (globalThis as any)[THEME] = getTheme;
  import("@mariozechner/pi-coding-agent").then(({ ToolExecutionComponent }: any) => {
    if (!ToolExecutionComponent || ToolExecutionComponent[PATCHED]) return;
    if (typeof ToolExecutionComponent.prototype.render !== "function") {
      console.warn("[pi-pane] ToolExecutionComponent shape changed — skipping patch");
      return;
    }
    ToolExecutionComponent[PATCHED] = true;
    const originalRender = ToolExecutionComponent.prototype.render;
    ToolExecutionComponent.prototype.render = function (width: number): string[] {
      try {
        const activeStore = (globalThis as any)[STORE] as ToolActivityStore;
        const activeGetTheme = ((globalThis as any)[THEME] as (() => Theme) | undefined) ?? getTheme;
        activeStore.syncFromComponent(this);
        const id = String(this?.toolCallId ?? "");
        if (!activeStore.shouldRenderFor(id)) return [];
        return activeStore.render(activeGetTheme(), width);
      } catch {
        return originalRender.call(this, width);
      }
    };
  }).catch(() => undefined);
}
