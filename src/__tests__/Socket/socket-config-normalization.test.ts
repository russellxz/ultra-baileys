import type { Agent } from 'https'
import { normalizeSocketConfig } from '../../Socket'
import { initAuthCreds } from '../../Utils/auth-utils'

const baseConfig = {
	auth: {
		creds: initAuthCreds(),
		keys: {
			get: async () => ({}),
			set: async () => {}
		}
	}
}

describe('normalizeSocketConfig', () => {
	it('sets fetchAgent and options.agent from agent when provided', () => {
		const proxyAgent = {} as Agent
		const normalized = normalizeSocketConfig({
			...baseConfig,
			agent: proxyAgent
		})

		expect(normalized.fetchAgent).toBe(proxyAgent)
		expect(normalized.options.agent).toBe(proxyAgent)
	})

	it('sets dispatcher when fetchAgent is an undici-compatible dispatcher', () => {
		const dispatcherAgent = { dispatch: jest.fn() } as unknown as Agent
		const normalized = normalizeSocketConfig({
			...baseConfig,
			fetchAgent: dispatcherAgent
		})

		expect(normalized.options.dispatcher).toBe(dispatcherAgent)
	})

	it('derives proxyUrl from agent when available', () => {
		const proxyUrl = 'http://proxy.example.com:8080/'
		const proxyAgent = { proxy: new URL(proxyUrl) } as unknown as Agent
		const normalized = normalizeSocketConfig({
			...baseConfig,
			fetchAgent: proxyAgent
		})

		expect(normalized.options.proxyUrl).toBe(proxyUrl)
	})
})
