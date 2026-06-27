import { Boom } from '@hapi/boom'
import type { AuthenticationCreds, Contact, SignalDataSet, SignalKeyStore } from '../../Types'
import { addTransactionCapability, assertMeId, initAuthCreds } from '../../Utils/auth-utils'
import type { ILogger } from '../../Utils/logger'

const credsWithMe = (me?: Partial<Contact>): AuthenticationCreds => ({
	...initAuthCreds(),
	me: me as Contact | undefined
})

const silentLogger = (): ILogger => {
	const logger: ILogger = {
		level: 'silent',
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger
	}
	return logger
}

const memoryStore = (): SignalKeyStore => {
	const data: Record<string, Record<string, unknown>> = {}
	return {
		get: (type, ids) => {
			const out: Record<string, unknown> = {}
			for (const id of ids) {
				const value = data[type]?.[id]
				if (value !== undefined) {
					out[id] = value
				}
			}

			return out as never
		},
		set: update => {
			for (const type in update) {
				data[type] = data[type] || {}
				Object.assign(data[type], update[type as keyof SignalDataSet])
			}
		}
	}
}

describe('assertMeId', () => {
	it('returns me.id when authenticated', () => {
		const creds = credsWithMe({ id: '5511999999999@s.whatsapp.net' })
		expect(assertMeId(creds)).toBe('5511999999999@s.whatsapp.net')
	})

	it('throws Boom 401 when creds.me is undefined', () => {
		const creds = credsWithMe(undefined)
		try {
			assertMeId(creds)
			throw new Error('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(Boom)
			expect((err as Boom).output.statusCode).toBe(401)
			expect((err as Error).message).toMatch(/not authenticated/)
		}
	})

	it('throws Boom 401 when me has no id', () => {
		const creds = credsWithMe({})
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})

	it('throws Boom 401 when me.id is empty string', () => {
		const creds = credsWithMe({ id: '' })
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})
})

describe('addTransactionCapability', () => {
	const opts = { maxCommitRetries: 1, delayBetweenTriesMs: 0 }
	const key = (n: number) => ({ '1': { keyId: n, publicKey: new Uint8Array([n]), keySignature: new Uint8Array([n]) } })

	it('isolates committed data across stores sharing the singleton', async () => {
		const backingA = memoryStore()
		const backingB = memoryStore()
		const a = addTransactionCapability(backingA, silentLogger(), opts)
		const b = addTransactionCapability(backingB, silentLogger(), opts)

		await a.transaction(async () => {
			await a.set({ 'app-state-sync-key': key(1) as never })
		}, 'app-state-sync-key')
		await b.transaction(async () => {
			await b.set({ 'app-state-sync-key': key(2) as never })
		}, 'app-state-sync-key')

		expect((await backingA.get('app-state-sync-key', ['1']))['1']).toMatchObject({ keyId: 1 })
		expect((await backingB.get('app-state-sync-key', ['1']))['1']).toMatchObject({ keyId: 2 })
	})

	it('reads buffered writes before commit and reuses nested transactions', async () => {
		const store = addTransactionCapability(memoryStore(), silentLogger(), opts)

		await store.transaction(async () => {
			expect(store.isInTransaction()).toBe(true)
			await store.set({ 'app-state-sync-key': key(7) as never })
			const buffered = await store.transaction(async () => store.get('app-state-sync-key', ['1']), 'app-state-sync-key')
			expect(buffered['1']).toMatchObject({ keyId: 7 })
		}, 'app-state-sync-key')

		expect(store.isInTransaction()).toBe(false)
	})

	it('reports no transaction outside of run scope', () => {
		const store = addTransactionCapability(memoryStore(), silentLogger(), opts)
		expect(store.isInTransaction()).toBe(false)
	})
})
