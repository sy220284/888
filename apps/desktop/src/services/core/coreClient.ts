import { getCoreStatus, type CoreStatus } from '../../coreBridge'

export async function readCoreStatus(): Promise<CoreStatus | null> {
  try {
    return await getCoreStatus()
  } catch {
    return null
  }
}
