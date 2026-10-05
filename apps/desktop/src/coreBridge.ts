import { invoke } from '@tauri-apps/api/core'
import type { Command, CommandResponse } from './generated/schema'

export interface CoreStatus {
  status: string
  worker_protocol_version: number
}

export async function getCoreStatus(): Promise<CoreStatus> {
  return invoke<CoreStatus>('core_status')
}

export async function executeCommand(command: Command): Promise<CommandResponse> {
  return invoke<CommandResponse>('execute_command', { command })
}

export async function getCommandResponse(commandId: string): Promise<CommandResponse | null> {
  return invoke<CommandResponse | null>('get_command_response', { commandId })
}
