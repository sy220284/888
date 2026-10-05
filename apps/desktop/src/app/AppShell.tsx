import { LogPanel } from '../features/logs/LogPanel'
import { ObservationPanel } from '../features/observations/ObservationPanel'
import { ProjectPanel } from '../features/projects/ProjectPanel'
import { WorkerStatusPanel } from '../features/workers/WorkerStatusPanel'
import { WorldWorkspace } from '../features/world/WorldWorkspace'

export function AppShell() {
  return (
    <main className="app-shell">
      <header className="viewer-header">
        <strong>888</strong>
        <span>证据锚定的联想式世界编译器</span>
      </header>

      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <ProjectPanel />
          <ObservationPanel />
          <WorkerStatusPanel />
        </aside>
        <section className="viewer-stage">
          <WorldWorkspace />
        </section>
      </div>

      <LogPanel />
    </main>
  )
}
