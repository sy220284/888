import type { Command, CommandType } from '../../generated/schema'
import {
  executeCommand,
  getCommandResponse,
  getCoreStatus,
  listObservations,
  listWorlds,
  pickObservationImages,
  type CoreStatus,
} from '../../coreBridge'

export async function readCoreStatus(): Promise<CoreStatus | null> {
  try {
    return await getCoreStatus()
  } catch {
    return null
  }
}

export function createCommand(
  type: CommandType,
  worldId: string | null,
  payload: Record<string, unknown>,
): Command {
  return {
    command_id: crypto.randomUUID(),
    type,
    world_id: worldId,
    payload,
    schema_version: 1,
    caller_context: { actor_type: 'USER', surface: 'DESKTOP' },
    requested_at: new Date().toISOString(),
  }
}

export const coreClient = {
  executeCommand,
  getCommandResponse,
  listWorlds,
  listObservations,
  pickObservationImages,
  async submit(command: Command) {
    return executeCommand(command)
  },
}
