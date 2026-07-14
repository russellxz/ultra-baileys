import { Boom } from '@hapi/boom'
import makeWASocket from '../Socket'
import { DisconnectReason } from '../Types'
import { isJidGroup } from '../WABinary'
import type { UserFacingSocketConfig, AnyMessageContent, MiscMessageGenerationOptions } from '../Types'
import { Context } from './Context'
import type { WASocket } from './Context'
import { SQLiteStore } from './Store/SQLiteStore'
import { SessionManager } from './SessionManager'
import { StatsManager } from './StatsManager'

export type MiddlewareFn = (ctx: Context, next: () => Promise<void>) => Promise<void> | void

export type BotConfig = UserFacingSocketConfig & {
	enableStats?: boolean
}

type EnqueuedMessage = {
	jid: string
	content: AnyMessageContent
	options: MiscMessageGenerationOptions
	resolve: (value: any) => void
	reject: (reason?: any) => void
}

export class Bot {
	public socket: WASocket | undefined
	private middlewares: MiddlewareFn[] = []
	private config: BotConfig
	
	// Database and Managers
	public readonly store: SQLiteStore
	public readonly session: SessionManager
	public readonly stats?: StatsManager

	// Connection state
	public isConnected: boolean = false
	private reconnectAttempts: number = 0
	private readonly MAX_RECONNECT_DELAY = 60000 // 60s
	private readonly BASE_RECONNECT_DELAY = 2000 // 2s

	// Message Queue
	private messageQueue: EnqueuedMessage[] = []

	constructor(config: BotConfig) {
		this.store = new SQLiteStore()
		this.session = new SessionManager(this.store)
		
		if (config.enableStats !== false) {
			this.stats = new StatsManager(this, this.store)
		}

		this.config = {
			...config,
			msgRetryCounterCache: this.store
		}
	}

	public use(middleware: MiddlewareFn) {
		this.middlewares.push(middleware)
	}

	public command(cmd: string, handler: (ctx: Context) => Promise<void> | void) {
		this.use(async (ctx, next) => {
			if (ctx.text?.startsWith(cmd)) {
				await handler(ctx)
			}
			await next()
		})
	}

	public onText(handler: (ctx: Context) => Promise<void> | void) {
		this.use(async (ctx, next) => {
			if (ctx.text) {
				await handler(ctx)
			}
			await next()
		})
	}

	public async sendMessage(jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}): Promise<any> {
		if (this.isConnected && this.socket) {
			return this.socket.sendMessage(jid, content, options)
		} else {
			// Queue the message
			return new Promise((resolve, reject) => {
				this.messageQueue.push({ jid, content, options, resolve, reject })
				console.log(`[Bot] Socket no conectado. Mensaje para ${jid} encolado. (Cola: ${this.messageQueue.length})`)
			})
		}
	}

	private drainQueue() {
		if (!this.isConnected || !this.socket || this.messageQueue.length === 0) return
		
		console.log(`[Bot] Drenando cola de mensajes: ${this.messageQueue.length} pendientes.`)
		const queueToProcess = [...this.messageQueue]
		this.messageQueue = []

		for (const msg of queueToProcess) {
			this.socket.sendMessage(msg.jid, msg.content, msg.options)
				.then(msg.resolve)
				.catch(msg.reject)
		}
	}

	public async start() {
		this.socket = makeWASocket(this.config)
		
		this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				const ctx = new Context(this, msg)

				// Analíticas: Observar el mensaje antes de los middlewares
				if (this.stats && ctx.remoteJid && isJidGroup(ctx.remoteJid)) {
					const participant = msg.key.participant || msg.participant
					if (participant) {
						const isSticker = !!msg.message?.stickerMessage
						this.stats.observeMessage(ctx.remoteJid, participant, isSticker)
					}
				}

				try {
					await this.executeMiddlewares(ctx)
				} catch (err) {
					console.error('Error executing middleware:', err)
				}
			}
		})

		this.socket.ev.on('connection.update', (update) => {
			const { connection, lastDisconnect } = update
			
			if (connection === 'open') {
				console.log('[Bot] Conectado exitosamente.')
				this.isConnected = true
				this.reconnectAttempts = 0
				this.drainQueue()
			}

			if (connection === 'close') {
				this.isConnected = false
				const error = lastDisconnect?.error as Boom | undefined
				const statusCode = error?.output?.statusCode
				const shouldReconnect = statusCode !== DisconnectReason.loggedOut
				
				console.log(`[Bot] Conexión cerrada. Razón: ${statusCode}`)
				
				if (shouldReconnect) {
					this.reconnectAttempts++
					const delay = Math.min(this.MAX_RECONNECT_DELAY, this.BASE_RECONNECT_DELAY * (2 ** (this.reconnectAttempts - 1)))
					console.log(`[Bot] Intentando reconectar en ${delay}ms (Intento ${this.reconnectAttempts})...`)
					
					setTimeout(() => {
						this.start()
					}, delay)
				} else {
					console.log('[Bot] Sesión cerrada (LoggedOut). No se reconectará automáticamente.')
				}
			}
		})
	}

	private async executeMiddlewares(ctx: Context) {
		let index = -1
		const dispatch = async (i: number): Promise<void> => {
			if (i <= index) throw new Error('next() called multiple times')
			index = i
			const middleware = this.middlewares[i]
			if (middleware) {
				await middleware(ctx, () => dispatch(i + 1))
			}
		}
		await dispatch(0)
	}
}
