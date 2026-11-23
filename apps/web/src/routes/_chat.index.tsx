import { workspaceAreaProps } from "../lib/workspaceFocus";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { HomeHeaderUsageStats } from "../components/usage/HeaderUsageStats";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useVisibleThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { takeDesktopThreadResume } from "../lib/desktopThreadResume";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

function IndexDraftLanding() {
  const projects = useProjects();
  const { isReady: environmentsReady, presentationById } = useEnvironments();
  const threads = useVisibleThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const launchThread = useRef<ReturnType<typeof takeDesktopThreadResume> | undefined>(undefined);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject =
    sortScopedProjectsForSidebar(
      projects.filter((project) => project.archivedAt == null),
      threads,
      "updated_at",
    )[0] ?? null;
  const attempt = startState.retryRequest;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the most recent project and navigates to it while still on the index
  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (startedAttemptRef.current === attempt || !isStillOnIndex()) return;
    if (launchThread.current === undefined) launchThread.current = takeDesktopThreadResume();
    const resume = launchThread.current;
    if (resume?.kind === "server" && !environmentsReady) return;
    if (resume !== null) {
      launchThread.current = null;
      if (resume.kind === "draft") {
        startedAttemptRef.current = attempt;
        void router.navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(resume.draftId),
          replace: true,
        });
        return;
      }
      if (presentationById.get(resume.threadRef.environmentId)?.entry.enabled) {
        startedAttemptRef.current = attempt;
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(resume.threadRef),
          replace: true,
        });
        return;
      }
    }
    if (mostRecentProject === null) return;
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    if (readProject(projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [attempt, environmentsReady, handleNewThread, mostRecentProject, presentationById, router]);

  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      data-miuix-home=""
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader data-miuix-home-header="" electron={isElectron}>
        <div className="min-w-3 flex-1" />
        <HomeHeaderUsageStats />
      </WorkspacePageHeader>
      <Empty className="flex-1">
        <div data-miuix-home-card="" className="w-full max-w-md px-6 py-8">
          <EmptyHeader className="max-w-none">
            <EmptyTitle data-miuix-home-title="" role="heading" aria-level={1}>
              Couldn’t start a new thread
            </EmptyTitle>
            <EmptyDescription>
              The project is still available. Try opening the draft again.
            </EmptyDescription>
            <div className="mt-5 flex justify-center">
              <Button size="sm" onClick={onRetry}>
                <RefreshIcon size="md" />
                Try again
              </Button>
            </div>
          </EmptyHeader>
        </div>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
