import { describe, expect, it } from 'vitest'
import { normalizeWorldViewModel } from './worldViewModel'

describe('normalizeWorldViewModel', () => {
  it('补齐 Provider 无关 Viewer 默认值', () => {
    expect(normalizeWorldViewModel({})).toEqual({
      splatUrl: undefined,
      colliderUrl: undefined,
      panoUrl: undefined,
      audioUrls: [],
      metricScaleFactor: 1,
      groundPlaneOffset: 0,
      flipY: false,
    })
  })

  it('拒绝无效世界尺度', () => {
    expect(normalizeWorldViewModel({ metricScaleFactor: 0 }).metricScaleFactor).toBe(1)
    expect(normalizeWorldViewModel({ metricScaleFactor: Number.NaN }).metricScaleFactor).toBe(1)
  })
})
