import { useAppState } from '../../state/appState'

export function LogPanel() {
  const lines = useAppState((state) => state.logLines)

  return (
    <section className="log-panel">
      <div className="panel-title">日志</div>
      <div className="log-content">
        {lines.length === 0 ? (
          <span className="panel-muted">暂无运行日志</span>
        ) : (
          lines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)
        )}
      </div>
    </section>
  )
}
