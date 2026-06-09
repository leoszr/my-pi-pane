export interface ContextSnapshot {
  percent?: number;
  usedTokens?: number;
  maxTokens?: number;
  available: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function getContextSnapshot(ctx?: any): ContextSnapshot {
  try {
    const usage = ctx?.getContextUsage?.();
    const modelMax = num(ctx?.model?.contextWindow);
    const maxTokens = num(usage?.contextWindow) ?? num(usage?.maxTokens) ?? modelMax;
    const usedTokens = num(usage?.tokens) ?? num(usage?.usedTokens) ?? num(usage?.contextTokens);
    let percent = num(usage?.percent);

    // Pi uses null percent after compaction until next response.
    if (usage?.percent === null) percent = undefined;
    if (percent !== undefined && percent <= 1) percent *= 100;
    if (percent === undefined && usedTokens !== undefined && maxTokens !== undefined && maxTokens > 0) {
      percent = (usedTokens / maxTokens) * 100;
    }

    if (percent === undefined) return { usedTokens, maxTokens, available: false };
    return {
      percent: Math.max(0, Math.min(999, percent)),
      usedTokens,
      maxTokens,
      available: true,
    };
  } catch {
    return { available: false };
  }
}
