import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { World } from '../../generated/schema'
import { coreClient, createCommand } from '../../services/core/coreClient'
import { useAppState } from '../../state/appState'

function worldFromResult(result: unknown): World {
  if (!result || typeof result !== 'object' || !('id' in result)) {
    throw new Error('Core 未返回有效世界')
  }
  return result as World
}

export function ProjectPanel() {
  const queryClient = useQueryClient()
  const selectedWorldId = useAppState((state) => state.selectedWorldId)
  const selectWorld = useAppState((state) => state.selectWorld)
  const appendLog = useAppState((state) => state.appendLog)
  const [name, setName] = useState('')

  const worlds = useQuery({
    queryKey: ['worlds'],
    queryFn: coreClient.listWorlds,
  })

  const createWorld = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('请输入世界名称')
      const response = await coreClient.submit(createCommand('CREATE_WORLD', null, { name: trimmed }))
      if (response.status !== 'COMPLETED') {
        throw new Error('创建世界失败')
      }
      return worldFromResult(response.result)
    },
    onSuccess: (world) => {
      selectWorld(world.id)
      setName('')
      appendLog(`已创建世界：${world.name}`)
      void queryClient.invalidateQueries({ queryKey: ['worlds'] })
    },
    onError: (error) => appendLog(`创建世界失败：${String(error)}`),
  })

  const openWorld = useMutation({
    mutationFn: async (world: World) => {
      const response = await coreClient.submit(createCommand('OPEN_WORLD', world.id, {}))
      if (response.status !== 'COMPLETED') {
        throw new Error('打开世界失败')
      }
      return worldFromResult(response.result)
    },
    onSuccess: (world) => {
      selectWorld(world.id)
      appendLog(`已打开世界：${world.name}`)
    },
    onError: (error) => appendLog(`打开世界失败：${String(error)}`),
  })

  return (
    <section className="panel">
      <div className="panel-title">项目</div>
      <div className="panel-body">
        <div className="panel-row">
          <input
            className="panel-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="新世界名称"
          />
          <button
            className="panel-button"
            disabled={!name.trim() || createWorld.isPending}
            onClick={() => createWorld.mutate()}
          >
            创建
          </button>
        </div>

        <div className="panel-list">
          {(worlds.data ?? []).map((world) => (
            <button
              key={world.id}
              className={`panel-item ${selectedWorldId === world.id ? 'active' : ''}`}
              onClick={() => openWorld.mutate(world)}
            >
              <span>{world.name}</span>
              <small>{world.id.slice(0, 8)}</small>
            </button>
          ))}
          {!worlds.isLoading && (worlds.data?.length ?? 0) === 0 && (
            <span className="panel-muted">尚未创建世界</span>
          )}
        </div>
      </div>
    </section>
  )
}
