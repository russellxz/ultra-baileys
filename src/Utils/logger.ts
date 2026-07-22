import P from 'pino'

export interface ILogger {
	level: string
	child(obj: Record<string, unknown>): ILogger
	trace(obj: unknown, msg?: string): void
	debug(obj: unknown, msg?: string): void
	info(obj: unknown, msg?: string): void
	warn(obj: unknown, msg?: string): void
	error(obj: unknown, msg?: string): void
}

// silent by default: pino serializes every log call to JSON, which burns CPU
// and floods hosting panels on busy bots. Set BAILEYS_LOG_LEVEL (e.g. 'info',
// 'debug') or pass your own `logger` in the socket config to see logs again.
export default P({
	timestamp: () => `,"time":"${new Date().toJSON()}"`,
	level: process.env.BAILEYS_LOG_LEVEL || 'silent'
})
