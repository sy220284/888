import { describe, expect, it } from 'vitest'
import { CredentialPool, credentialRef } from '../src/index.ts'
import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from '../src/index.ts'

function fakeCredentials(): CredentialProvider & {
  values: Map<CredentialRef, ResolvedCredential>
} {
  const values = new Map<CredentialRef, ResolvedCredential>()
  return {
    values,
    resolve: (ref: CredentialRef) => Promise.resolve(values.get(ref)),
  } as unknown as CredentialProvider & {
    values: Map<CredentialRef, ResolvedCredential>
  }
}

describe('CredentialPool', () => {
  it('resolves secrets per operation and rotates configured references', async () => {
    const provider = fakeCredentials()
    const a = credentialRef('KEY_A')
    const b = credentialRef('KEY_B')
    provider.values.set(a, { value: 'a1', source: 'test' })
    provider.values.set(b, { value: 'b1', source: 'test' })
    const pool = new CredentialPool(provider, [a, b])
    const first = await pool.acquire()
    expect(first).toEqual({ ref: a, value: 'a1', source: 'test' })
    if (first !== undefined) pool.reportSuccess(first.ref)
    provider.values.set(a, { value: 'a2', source: 'test' })
    const second = await pool.acquire()
    expect(second).toEqual({ ref: b, value: 'b1', source: 'test' })
    if (second !== undefined) pool.reportSuccess(second.ref)
    const third = await pool.acquire()
    expect(third).toEqual({ ref: a, value: 'a2', source: 'test' })
    if (third !== undefined) pool.reportSuccess(third.ref)
  })

  it('cools failed references without persisting secret values', async () => {
    let now = 100
    const provider = fakeCredentials()
    const a = credentialRef('KEY_A')
    const b = credentialRef('KEY_B')
    provider.values.set(a, { value: 'a', source: 'test' })
    provider.values.set(b, { value: 'b', source: 'test' })
    const pool = new CredentialPool(provider, [a, b], {
      cooldownMs: 50,
      now: () => now,
    })
    const lease = await pool.acquire()
    expect(lease?.ref).toBe(a)
    if (lease !== undefined) pool.reportFailure(lease.ref)
    const fallback = await pool.acquire()
    expect(fallback?.ref).toBe(b)
    if (fallback !== undefined) pool.reportSuccess(fallback.ref)
    expect(JSON.stringify(pool.status())).not.toContain('"value"')
    now = 151
    const recovered = await pool.acquire()
    expect(recovered?.ref).toBe(a)
  })

  it('reserves references before async resolution so concurrent callers spread across the pool', async () => {
    const a = credentialRef('KEY_A')
    const b = credentialRef('KEY_B')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seen: CredentialRef[] = []
    const provider = {
      async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
        seen.push(ref)
        await gate
        return { value: String(ref), source: 'test' }
      },
    }
    const pool = new CredentialPool(provider, [a, b])
    const first = pool.acquire()
    const second = pool.acquire()
    await Promise.resolve()
    expect(seen).toEqual([a, b])
    release()
    const [left, right] = await Promise.all([first, second])
    expect(new Set([left?.ref, right?.ref])).toEqual(new Set([a, b]))
    if (right !== undefined) pool.reportFailure(right.ref)
    if (left !== undefined) pool.reportSuccess(left.ref)
    expect(pool.status().every(entry => entry.inFlight === 0)).toBe(true)
  })

  it('keeps in-flight accounting correct when results complete out of order', async () => {
    const provider = fakeCredentials()
    const a = credentialRef('KEY_A')
    const b = credentialRef('KEY_B')
    provider.values.set(a, { value: 'a', source: 'test' })
    provider.values.set(b, { value: 'b', source: 'test' })
    const pool = new CredentialPool(provider, [a, b])
    const [first, second] = await Promise.all([pool.acquire(), pool.acquire()])
    expect(pool.status().map(entry => entry.inFlight)).toEqual([1, 1])
    if (second !== undefined) pool.reportFailure(second.ref)
    if (first !== undefined) pool.reportSuccess(first.ref)
    expect(pool.status().map(entry => entry.inFlight)).toEqual([0, 0])
  })

  it('returns undefined while every configured reference is cooling down', async () => {
    const provider = fakeCredentials()
    const a = credentialRef('KEY_A')
    const b = credentialRef('KEY_B')
    provider.values.set(a, { value: 'a', source: 'test' })
    provider.values.set(b, { value: 'b', source: 'test' })
    const pool = new CredentialPool(provider, [a, b], { cooldownMs: 100 })
    const first = await pool.acquire()
    const second = await pool.acquire()
    if (first !== undefined) pool.reportFailure(first.ref)
    if (second !== undefined) pool.reportFailure(second.ref)
    await expect(pool.acquire()).resolves.toBeUndefined()
  })

  it('keeps a newer failure authoritative when the same credential settles out of order', async () => {
    let now = 100
    const provider = fakeCredentials()
    const a = credentialRef('KEY_A')
    provider.values.set(a, { value: 'a', source: 'test' })
    const pool = new CredentialPool(provider, [a], { cooldownMs: 50, now: () => now })
    const [older, newer] = await Promise.all([pool.acquire(), pool.acquire()])
    expect(pool.status()[0]?.inFlight).toBe(2)
    if (newer !== undefined) pool.reportFailure(newer)
    if (older !== undefined) pool.reportSuccess(older)
    expect(pool.status()[0]).toMatchObject({ coolingDown: true, inFlight: 0 })
    now = 151
    await expect(pool.acquire()).resolves.toMatchObject({ ref: a })
  })
})
