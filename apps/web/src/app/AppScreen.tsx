import { AppHeader } from "./layout/AppHeader";
import { AppSidebar } from "./layout/AppSidebar";
import { RuntimeWorkspace } from "./layout/RuntimeWorkspace";
import { RuntimeConsolePanel } from "./console/RuntimeConsolePanel";
import { ProviderWorkspace } from "./provider/ProviderWorkspace";
import { StorageWorkspace } from "./storage/StorageWorkspace";
import { useAppController } from "./use-app-controller";

export function AppScreen() {
  const controller = useAppController();

  return (
    <div className="app-shell h-screen flex flex-col overflow-x-hidden">
      <AppHeader {...controller.headerProps} />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <AppSidebar {...controller.sidebarSurfaceProps} />

          <main className="app-main-surface flex-1 min-h-0 flex flex-col min-w-0">
            {controller.errorMessage ? (
              <div className="flex items-center justify-between gap-3 border-b border-rose-200/80 bg-rose-50/75 px-6 py-3 text-sm text-rose-700 dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-400">
                <span className="min-w-0 flex-1 truncate">{controller.errorMessage}</span>
                <button
                  type="button"
                  onClick={() => {
                    controller.headerProps.onSurfaceModeChange("runtime");
                    controller.consolePanelProps.openErrors();
                  }}
                  className="rounded-full border border-rose-200/80 bg-white/80 px-3 py-1 text-xs font-medium text-rose-700 transition hover:bg-white dark:border-rose-800/80 dark:bg-rose-950/40 dark:text-rose-300"
                >
                  View details
                </button>
              </div>
            ) : null}

            {controller.surfaceMode === "storage" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <StorageWorkspace {...controller.storageSurfaceProps} />
              </div>
            ) : controller.surfaceMode === "provider" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ProviderWorkspace {...controller.providerSurfaceProps} />
              </div>
            ) : (
              <RuntimeWorkspace {...controller.runtimeDetailSurfaceProps} />
            )}
          </main>
        </div>

        <RuntimeConsolePanel {...controller.consolePanelProps} />
      </div>
    </div>
  );
}
