import { invoke } from '@tauri-apps/api/core'
import type { Command, CommandResponse, Observation, World } from './generated/schema'

export interface CoreStatus {
  status: string
  worker_protocol_version: number
  worker_count: number
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

export async function listWorlds(): Promise<World[]> {
  return invoke<World[]>('list_worlds')
}

export async function listObservations(worldId: string): Promise<Observation[]> {
  return invoke<Observation[]>('list_observations', { worldId })
}

export async function pickObservationImages(): Promise<string[]> {
  return invoke<string[]>('pick_observation_images')
}
