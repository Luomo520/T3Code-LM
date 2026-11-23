import { isElectron } from "../env";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";

const LAST_THREAD_KEY = "t3code:desktop-last-thread:v1";

let startsAtIndex = isElectron && window.location.pathname === "/";

export function takeDesktopThreadResume(): ThreadRouteTarget | null {
  if (!startsAtIndex) return null;
  startsAtIndex = false;
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LAST_THREAD_KEY) ?? "null");
    if (stored === null || typeof stored !== "object") return null;
    return resolveThreadRouteTarget({
      environmentId:
        "environmentId" in stored && typeof stored.environmentId === "string"
          ? stored.environmentId
          : undefined,
      threadId:
        "threadId" in stored && typeof stored.threadId === "string" ? stored.threadId : undefined,
      draftId:
        "draftId" in stored && typeof stored.draftId === "string" ? stored.draftId : undefined,
    });
  } catch {
    return null;
  }
}

export function rememberDesktopThread(target: ThreadRouteTarget) {
  if (!isElectron) return;
  try {
    window.localStorage.setItem(
      LAST_THREAD_KEY,
      JSON.stringify(target.kind === "server" ? target.threadRef : { draftId: target.draftId }),
    );
  } catch {
    // 本地存储不可用时，下次启动沿用首页入口。
  }
}
