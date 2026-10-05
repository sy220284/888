import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Observation } from '../../generated/schema'
import { coreClient, createCommand } from '../../services/core/coreClient'
import { useAppState } from '../../state/appState'

function analysisState(observation: Observation) {
  const value = observation.quality?.analysis_state
  return typeof value === 'string' ? value : 'PENDING'
}

export function ObservationPanel() {
  const queryClient = useQueryClient()
  const selectedWorldId = useAppState((state) => state.selectedWorldId)
  const appendLog = useAppState((state) => state.appendLog)

  const observations = useQuery({
    queryKey: ['observations', selectedWorldId],
    queryFn: () => coreClient.listObservations(selectedWorldId!),
    enabled: Boolean(selectedWorldId),
    refetchInterval: selectedWorldId ? 2_000 : false,
  })

  const importImages = useMutation({
    mutationFn: async () => {
      if (!selectedWorldId) throw new Error('请先打开世界')
      const paths = await coreClient.pickObservationImages()
      if (paths.length === 0) return null
      const response = await coreClient.submit(
        createCommand('IMPORT_OBSERVATIONS', selectedWorldId, { paths }),
      )
      if (response.status !== 'COMPLETED') {
        throw new Error('导入 Observation 失败')
      }
      return { count: paths.length, jobs: response.job_ids.length }
    },
    onSuccess: (result) => {
      if (!result) return
      appendLog(`已导入 ${result.count} 张图片，创建 ${result.jobs} 个分析任务`)
      void queryClient.invalidateQueries({ queryKey: ['observations', selectedWorldId] })
    },
    onError: (error) => appendLog(`导入失败：${String(error)}`),
  })

  return (
    <section className="panel">
      <div className="panel-title">观测</div>
      <div className="panel-body">
        <button
          className="panel-button panel-button-wide"
          disabled={!selectedWorldId || importImages.isPending}
          onClick={() => importImages.mutate()}
        >
          导入图片
        </button>

        <div className="panel-list">
          {(observations.data ?? []).slice(0, 24).map((observation) => (
            <div className="panel-item panel-item-static" key={observation.id}>
              <span>{observation.source_type}</span>
              <small>{analysisState(observation)}</small>
            </div>
          ))}
          {selectedWorldId && !observations.isLoading && (observations.data?.length ?? 0) === 0 && (
            <span className="panel-muted">暂无 Observation</span>
          )}
          {!selectedWorldId && <span className="panel-muted">先打开一个世界</span>}
        </div>
      </div>
    </section>
  )
}
