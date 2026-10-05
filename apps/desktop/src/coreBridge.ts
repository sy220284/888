import { invoke } from '@tauri-apps/api/core'
import type {
  Command,
  Anchor,
  CommandResponse,
  Entity,
  GeometryRepresentation,
  Portal,
  World,
  Zone,
} from './generated/schema'

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

export async function getWorld(worldId: string): Promise<World | null> {
  return invoke<World | null>('get_world', { worldId })
}

export async function listEntities(worldId: string): Promise<Entity[]> {
  return invoke<Entity[]>('list_entities', { worldId })
}

export async function getEntity(entityId: string): Promise<Entity | null> {
  return invoke<Entity | null>('get_entity', { entityId })
}

export async function listGeometry(worldId: string): Promise<GeometryRepresentation[]> {
  return invoke<GeometryRepresentation[]>('list_geometry', { worldId })
}

export async function listZones(worldId: string): Promise<Zone[]> {
  return invoke<Zone[]>('list_zones', { worldId })
}

export async function listAnchors(worldId: string): Promise<Anchor[]> {
  return invoke<Anchor[]>('list_anchors', { worldId })
}

export async function listPortals(worldId: string): Promise<Portal[]> {
  return invoke<Portal[]>('list_portals', { worldId })
}
