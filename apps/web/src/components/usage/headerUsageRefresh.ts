/** Page entry and focus share a gate; the backend still enforces account backoff. */
export class HeaderUsageRefreshGate {
  private readonly due = new Map<string, number>();
  take(identity: string, now: number): boolean {
    if (now < (this.due.get(identity) ?? 0)) return false;
    this.due.set(identity, now + 30_000);
    if (this.due.size > 64) this.due.delete(this.due.keys().next().value!);
    return true;
  }
}

export const headerUsageViewRefreshGate = new HeaderUsageRefreshGate();
