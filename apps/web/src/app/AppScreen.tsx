import { AppHeader } from "./layout/AppHeader";
import { AppSidebar } from "./layout/AppSidebar";
import { RuntimeWorkspace } from "./layout/RuntimeWorkspace";
import { StorageWorkspace } from "./storage/StorageWorkspace";
import { useAppController } from "./use-app-controller";

export function AppScreen() {
  const controller = useAppController();

  return (
    <main className="app-shell">
      <div className="app-frame">
        <AppHeader {...controller.headerProps} />

        <div className="app-content-grid min-h-0">
          <AppSidebar {...controller.sidebarSurfaceProps} />

          <section className="app-main-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {controller.errorMessage ? (
              <div className="border-b border-rose-200/80 bg-rose-50/75 px-6 py-3 text-sm text-rose-700">{controller.errorMessage}</div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-hidden px-4 py-4 md:px-5 md:py-5">
              {controller.surfaceMode === "storage" ? (
                <StorageWorkspace {...controller.storageSurfaceProps} />
              ) : (
                <RuntimeWorkspace {...controller.runtimeDetailSurfaceProps} />
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
