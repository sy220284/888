import { invoke } from '@tauri-apps/api/core'

export interface CoreStatus {
  status: string
  worker_protocol_version: number
}

export async function getCoreStatus(): Promise<CoreStatus> {
  return invoke<CoreStatus>('core_status')
}
