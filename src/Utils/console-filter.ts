/**
 * The bundled libsignal library logs every Signal session it opens/closes
 * straight to the global console ("Closing session: SessionEntry { ... }",
 * key buffers, prekey dumps, etc). That noise is useless to bot developers
 * and floods hosting panels, so we filter those exact messages out here.
 *
 * Set ULTRA_BAILEYS_VERBOSE=1 to disable the filter and see everything.
 */

const SIGNAL_NOISE = [
	'Closing session:',
	'Opening session:',
	'Closing open session',
	'Closing stale open session',
	'Removing old closed session',
	'Session already closed',
	'Session already open',
	'Migrating session to:',
	'Duplicate PreKeyWhisperMessage',
	'SessionEntry {'
]

const isNoise = (args: unknown[]): boolean =>
	args.some(arg => {
		if (typeof arg === 'string') {
			return SIGNAL_NOISE.some(pattern => arg.includes(pattern))
		}

		return typeof arg === 'object' && arg !== null && arg.constructor?.name === 'SessionEntry'
	})

const INSTALLED = Symbol.for('ultra-baileys.console-filter')

export const installConsoleFilter = () => {
	const globalAny = globalThis as Record<PropertyKey, unknown>
	if (globalAny[INSTALLED] || process.env.ULTRA_BAILEYS_VERBOSE) {
		return
	}

	globalAny[INSTALLED] = true

	for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		const original = console[level].bind(console)
		console[level] = (...args: unknown[]) => {
			if (isNoise(args)) {
				return
			}

			original(...args)
		}
	}
}
