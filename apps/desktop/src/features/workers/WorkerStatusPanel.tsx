import { useQuery } from '@tanstack/react-query'
import { readCoreStatus } from '../../services/core/coreClient'

export function WorkerStatusPanel() {
  const status = useQuery({
    queryKey: ['core-status'],
    queryFn: readCoreStatus,
    refetchInterval: 5_000,
  })

  const label = status.data
    ? `Core ${status.data.status} · Worker 协议 v${status.data.worker_protocol_version}`
    : '浏览器预览：Tauri Core 未连接'

  return (
    <section className="panel">
      <div className="panel-title">运行状态</div>
      <div className="panel-body">
        <span className="panel-muted">{label}</span>
      </div>
    </section>
  )
}
