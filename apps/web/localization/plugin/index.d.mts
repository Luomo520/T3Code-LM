import type { Plugin } from "vite-plus";

export function t3zhPlugin(options: {
  monorepoRoot: string;
  dictPath?: string;
  allowSuspiciousPath?: string;
  statsFile?: string | false;
}): Plugin;
