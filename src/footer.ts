import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getContextSnapshot } from "./context-meter.js";
import { getUsageSnapshot, type UsageSnapshot } from "./usage.js";

const FULL_BLOCK = "▰";
const EMPTY_BLOCK = "▱";

function color(theme: Theme, key: string, text: string): string {
  try { return theme.fg(key as any, text); } catch { return text; }
}

function severity(percent: number | undefined): "normal" | "warning" | "error" {
  if (percent === undefined) return "normal";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "normal";
}

function percentOf(used: number, limit: number): number {
  return limit > 0 ? Math.max(0, Math.min(999, (used / limit) * 100)) : 0;
}

function bar(percent: number | undefined, cells: number): string {
  if (percent === undefined) return EMPTY_BLOCK.repeat(cells);
  const full = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return FULL_BLOCK.repeat(full) + EMPTY_BLOCK.repeat(cells - full);
}

function fmtPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

function fmtHours(ms: number): string {
  const h = ms / (60 * 60 * 1000);
  return `${h.toFixed(1).replace(/\.0$/, "")}`;
}

function fmtEta(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ""}`;
  return `${m}m`;
}

function renderUsage(theme: Theme, usage: UsageSnapshot, width: number): string {
  const muted = (s: string) => color(theme, "muted", s);
  const dim = (s: string) => color(theme, "dim", s);
  const accent = (s: string) => color(theme, "accent", s);

  if (!usage.available) return muted("◆ Usage unavailable");

  const percent = usage.primaryPercent ?? percentOf(usage.usedMs, usage.limitMs);
  const sev = severity(percent);
  const sevColor = sev === "error" ? "error" : sev === "warning" ? "warning" : "muted";
  const plan = `${accent("◆")} ${color(theme, "accent", usage.plan)}`;
  const pct = color(theme, sevColor, fmtPercent(percent));
  const reset = fmtEta(usage.resetInMs);
  const week = usage.secondaryPercent !== undefined ? ` 7d ${fmtPercent(usage.secondaryPercent)}` : "";

  if (width < 22) return `${plan} ${pct}`;
  if (width < 44) {
    const b = color(theme, sevColor, bar(percent, 6));
    return `${plan} ${b} ${pct}${usage.secondaryPercent !== undefined ? dim(week) : ""}${reset ? ` ${dim(`↻${reset}`)}` : ""}`;
  }

  const b = color(theme, sevColor, bar(percent, 8));
  const hours = usage.source === "api"
    ? muted(`5h${usage.secondaryPercent !== undefined ? ` 7d ${fmtPercent(usage.secondaryPercent)}` : ""}`)
    : muted(`${usage.estimated ? "≈" : ""}${fmtHours(usage.usedMs)}/${fmtHours(usage.limitMs)}h`);
  return `${plan}  ${b}  ${pct}  ${hours}${reset ? `  ${dim(`↻${reset}`)}` : ""}`;
}

function renderCtx(theme: Theme, ctx: ReturnType<typeof getContextSnapshot>, width: number): string {
  const muted = (s: string) => color(theme, "muted", s);
  if (!ctx.available || ctx.percent === undefined) return muted(width < 20 ? "ctx ?" : "ctx unknown");
  const sev = severity(ctx.percent);
  const sevColor = sev === "error" ? "error" : sev === "warning" ? "warning" : "muted";
  const pct = color(theme, sevColor, fmtPercent(ctx.percent));
  if (width < 18) return `ctx ${pct}`;
  return `ctx ${color(theme, sevColor, bar(ctx.percent, 6))} ${pct}`;
}

export function renderPiPaneFooter(theme: Theme, ctx: any, width: number): string[] {
  const usage = renderUsage(theme, getUsageSnapshot(ctx), width);
  const ctxMeter = renderCtx(theme, getContextSnapshot(ctx), width);
  const gap = "   ";

  if (width <= 0) return [""];
  if (width < 34) return [truncateToWidth(`${usage} ${ctxMeter}`, width, "")];

  const needed = visibleWidth(usage) + visibleWidth(gap) + visibleWidth(ctxMeter);
  if (needed <= width) {
    return [usage + " ".repeat(width - visibleWidth(usage) - visibleWidth(ctxMeter)) + ctxMeter];
  }

  const compactUsage = renderUsage(theme, getUsageSnapshot(ctx), 20);
  const compactCtx = renderCtx(theme, getContextSnapshot(ctx), 14);
  const compactNeeded = visibleWidth(compactUsage) + visibleWidth(gap) + visibleWidth(compactCtx);
  if (compactNeeded <= width) {
    return [compactUsage + " ".repeat(width - visibleWidth(compactUsage) - visibleWidth(compactCtx)) + compactCtx];
  }

  const half = Math.max(10, Math.floor((width - 1) / 2));
  return [
    truncateToWidth(compactUsage, half, "") +
      " " +
      truncateToWidth(compactCtx, Math.max(0, width - half - 1), ""),
  ];
}
