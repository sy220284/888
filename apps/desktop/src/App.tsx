import { WorldViewer } from './viewer/WorldViewer'
import type { WorldViewModel } from './viewer/worldViewModel'

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

export function App() {
  return (
    <main className="app-shell">
      <header className="viewer-header">
        <strong>888 World Viewer</strong>
        <span>Image Blaster 首批复用能力</span>
      </header>
      <section className="viewer-stage">
        <WorldViewer world={worldFromQuery()} />
      </section>
    </main>
  )
}
