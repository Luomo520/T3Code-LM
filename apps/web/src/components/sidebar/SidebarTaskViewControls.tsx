import type { SidebarTaskView } from "./sidebarTaskView";
import { cn } from "~/lib/utils";

export function SidebarTaskViewControls(props: {
  view: SidebarTaskView;
  onViewChange: (view: SidebarTaskView) => void;
}) {
  return (
    <div
      data-sidebar-task-controls=""
      className="mt-2 mb-1 flex min-w-0 flex-wrap items-center justify-between gap-x-1 gap-y-1 px-2"
    >
      <h2 className="shrink-0 text-sm font-semibold whitespace-nowrap text-sidebar-muted-foreground">
        Tasks
      </h2>
      <div
        role="group"
        aria-label="Thread list view"
        className="flex shrink-0 items-center gap-0.5"
      >
        {(
          [
            { view: "recent", label: "Recent" },
            { view: "project", label: "Projects" },
            { view: "status", label: "Status" },
          ] as const
        ).map((item) => (
          <button
            key={item.view}
            type="button"
            aria-pressed={props.view === item.view}
            onClick={() => props.onViewChange(item.view)}
            className={cn(
              "shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              props.view === item.view
                ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
