import type { Command } from '../../generated/schema'
import {
  executeCommand,
  getCommandResponse,
  getCoreStatus,
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
  async submit(command: Command) {
    return executeCommand(command)
  },
}
