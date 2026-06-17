declare global {
	interface RequestInit {
		agent?: import('https').Agent
		dispatcher?: any
		proxyUrl?: string
		duplex?: 'half' | 'full'
	}
}

export {}
