import { isWorkspaceCatalogPending, type WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  gt: (message: string) => string = (message) => message,
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount, gt);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  gt: (message: string) => string,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: gt("Loading environments"),
      detail: gt("Checking saved environments on this device."),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: gt("No environments connected"),
      detail: gt("Add an environment to load projects and start coding sessions."),
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? gt("Client not supported")
          : gt("Environment unavailable"),
      detail:
        catalogState.connectionError ??
        gt("The saved environment is offline. Check the URL or start the environment, then retry."),
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment
        ? gt("Loading threads")
        : gt("Connecting to environment"),
      detail: gt("Loading projects and threads from the saved environment."),
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: gt("No projects found"),
      detail: gt("The connected environment did not report any projects."),
      loading: false,
    };
  }

  return {
    title: gt("No threads yet"),
    detail: gt("Create a task to start a new coding runtime in one of your connected projects."),
    loading: false,
  };
}
