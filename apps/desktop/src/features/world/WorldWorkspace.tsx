import { WorldViewer } from '../../viewer/WorldViewer'
import type { WorldViewModel } from '../../viewer/worldViewModel'

function worldFromQuery(): WorldViewModel {
  const query = new URLSearchParams(window.location.search)
  return {
    splatUrl: query.get('splat') ?? undefined,
    colliderUrl: query.get('collider') ?? undefined,
    panoUrl: query.get('pano') ?? undefined,
    metricScaleFactor: Number(query.get('scale') || 1),
    groundPlaneOffset: Number(query.get('ground') || 0),
    flipY: query.get('flipY') === 'true',
    audioUrls: query.getAll('audio'),
  }
}

export function WorldWorkspace() {
  return <WorldViewer world={worldFromQuery()} />
}
