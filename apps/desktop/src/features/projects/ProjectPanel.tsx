import { useAppState } from '../../state/appState'

export function ProjectPanel() {
  const selectedWorldId = useAppState((state) => state.selectedWorldId)

  return (
    <section className="panel">
      <div className="panel-title">项目</div>
      <div className="panel-body">
        <span className="panel-muted">
          {selectedWorldId ? `当前世界：${selectedWorldId}` : '尚未打开世界'}
        </span>
      </div>
    </section>
  )
}
