import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Buffer } from 'node:buffer'
import type { SubprocessCollect, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

let spillRoot: string | undefined
let spillCounter = 0

function root(): string {
  spillRoot ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-native-'))
  return spillRoot
}

/** Bounded native subprocess output window with optional spill-file retention. */
export class NativeOutputCollector implements SubprocessOutputReader {
  private readonly chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private spillFd: number | undefined
  private spillPath: string | undefined
  private spillDisabled = false
  private sealed = false

  constructor(private readonly spec: SubprocessCollect, private readonly label: string) {
    if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes <= 0) throw new Error('subprocess-native: collect maxBytes must be a positive safe integer')
    if (spec.spill !== undefined && (!Number.isSafeInteger(spec.spill.maxBytes) || spec.spill.maxBytes <= 0)) {
      throw new Error('subprocess-native: spill maxBytes must be a positive safe integer')
    }
  }

  /**
   * Append one output chunk while enforcing memory and spill limits.
   * @param chunk - raw subprocess output bytes.
   */
  push(chunk: Buffer): void {
    if (this.sealed || chunk.length === 0) return
    this.totalBytes += chunk.length
    const overflowsMemory = this.retainedBytes + chunk.length > this.spec.maxBytes
    if (this.spec.spill !== undefined && !this.spillDisabled && (overflowsMemory || this.spillFd !== undefined)) {
      if (this.totalBytes > this.spec.spill.maxBytes) this.discardSpill()
      else this.appendSpill(chunk)
    }
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.spec.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.spec.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  readFrom(fromByte: number): ReturnType<SubprocessOutputReader['readFrom']> {
    const windowStart = this.totalBytes - this.retainedBytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(Math.max(0, fromByte - windowStart))
    return {
      text: slice.toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(this.spillPath !== undefined ? { spillPath: this.spillPath } : {}),
    }
  }

  /** Finalize output collection and close any active spill file. */
  seal(): void {
    if (this.sealed) return
    this.sealed = true
    if (this.spillFd !== undefined) {
      try { closeSync(this.spillFd) } catch { this.spillPath = undefined }
      this.spillFd = undefined
    }
  }

  private appendSpill(chunk: Buffer): void {
    if (this.spillFd === undefined) {
      this.spillPath = join(root(), `${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`)
      this.spillFd = openSync(this.spillPath, 'wx', 0o600)
      for (const previous of this.chunks) writeSync(this.spillFd, previous)
    }
    writeSync(this.spillFd, chunk)
  }

  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillPath
    this.spillFd = undefined
    this.spillPath = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* no trusted spill remains */ }
    }
    if (file !== undefined) {
      try { unlinkSync(file) } catch { /* bounded orphan only */ }
    }
  }
}
