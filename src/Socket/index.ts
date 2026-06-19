import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { SocketConfig, UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

const extractProxyUrlFromAgent = (agent: unknown) => {
	const proxy = (agent as { proxy?: URL | string } | undefined)?.proxy
	if (!proxy) {
		return undefined
	}

	return typeof proxy === 'string' ? proxy : proxy.toString()
}

export const normalizeSocketConfig = (config: UserFacingSocketConfig): SocketConfig => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	const proxyAgent = newConfig.fetchAgent ?? newConfig.agent
	if (!proxyAgent) {
		return newConfig
	}

	newConfig.fetchAgent = proxyAgent

	const options = { ...(newConfig.options || {}) }
	if (!options.agent) {
		options.agent = proxyAgent
	}

	if (!options.dispatcher && typeof (proxyAgent as { dispatch?: unknown }).dispatch === 'function') {
		options.dispatcher = proxyAgent
	}

	if (!options.proxyUrl) {
		options.proxyUrl = extractProxyUrlFromAgent(proxyAgent)
	}

	newConfig.options = options
	return newConfig
}

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	const newConfig = normalizeSocketConfig(config)

	return makeCommunitiesSocket(newConfig)
}

export default makeWASocket
