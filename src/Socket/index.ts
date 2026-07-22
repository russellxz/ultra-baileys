import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { printBanner } from '../Utils/banner'
import { installConsoleFilter } from '../Utils/console-filter'
import { makeCommunitiesSocket } from './communities'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => {
	installConsoleFilter()
	printBanner('7.0.0-rc13')

	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	return makeCommunitiesSocket(newConfig)
}

export default makeWASocket
