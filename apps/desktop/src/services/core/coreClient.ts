import type { Command } from '../../generated/schema'
import {
  executeCommand,
  getCommandResponse,
  getCoreStatus,
  getEntity,
  getWorld,
  listAnchors,
  listEntities,
  listGeometry,
  listPortals,
  listZones,
  type CoreStatus,
} from '../../coreBridge'

export async function readCoreStatus(): Promise<CoreStatus | null> {
  try {
    return await getCoreStatus()
  } catch {
    return null
  }
}

export const coreClient = {
  executeCommand,
  getCommandResponse,
  getWorld,
  listEntities,
  listGeometry,
  listZones,
  listAnchors,
  listPortals,
  getEntity,
  async submit(command: Command) {
    return executeCommand(command)
  },
}
