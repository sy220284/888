import { create } from 'zustand'

interface AppState {
  selectedWorldId: string | null
  logLines: string[]
  selectWorld: (worldId: string | null) => void
  appendLog: (line: string) => void
  clearLogs: () => void
}

export const useAppState = create<AppState>((set) => ({
  selectedWorldId: null,
  logLines: [],
  selectWorld: (selectedWorldId) => set({ selectedWorldId }),
  appendLog: (line) =>
    set((state) => ({
      logLines: [...state.logLines.slice(-199), line],
    })),
  clearLogs: () => set({ logLines: [] }),
}))
