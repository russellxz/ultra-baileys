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
	rateLimitMs?: number
	autoReadMs?: number
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
	private sendQueue: EnqueuedMessage[] = []
	private isProcessingSendQueue: boolean = false

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
		return new Promise((resolve, reject) => {
			const msg: EnqueuedMessage = { jid, content, options, resolve, reject }
			if (this.isConnected && this.socket) {
				if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
					this.sendQueue.push(msg)
					this.processSendQueue()
				} else {
					this.socket.sendMessage(jid, content, options).then(resolve).catch(reject)
				}
			} else {
				// Queue the message for reconnection
				this.messageQueue.push(msg)
				console.log(`[Bot] Socket no conectado. Mensaje para ${jid} encolado. (Cola de reconexión: ${this.messageQueue.length})`)
			}
		})
	}

	private async processSendQueue() {
		if (this.isProcessingSendQueue || this.sendQueue.length === 0 || !this.isConnected || !this.socket) return
		
		this.isProcessingSendQueue = true
		
		while (this.sendQueue.length > 0 && this.isConnected && this.socket) {
			const msg = this.sendQueue.shift()
			if (msg) {
				try {
					const result = await this.socket.sendMessage(msg.jid, msg.content, msg.options)
					msg.resolve(result)
				} catch (err) {
					msg.reject(err)
				}
				
				if (this.sendQueue.length > 0 && this.config.rateLimitMs) {
					await new Promise(resolve => setTimeout(resolve, this.config.rateLimitMs))
				}
			}
		}
		
		this.isProcessingSendQueue = false
	}

	private drainQueue() {
		if (!this.isConnected || !this.socket || this.messageQueue.length === 0) return
		
		console.log(`[Bot] Drenando cola de reconexión: ${this.messageQueue.length} pendientes.`)
		const queueToProcess = [...this.messageQueue]
		this.messageQueue = []

		for (const msg of queueToProcess) {
			if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
				this.sendQueue.push(msg)
			} else {
				this.socket.sendMessage(msg.jid, msg.content, msg.options)
					.then(msg.resolve)
					.catch(msg.reject)
			}
		}
		
		if (this.config.rateLimitMs && this.config.rateLimitMs > 0) {
			this.processSendQueue()
		}
	}

	public async start() {
		this.socket = makeWASocket(this.config)
		
		this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				const ctx = new Context(this, msg)
				
				// Smart Read (Auto-Lectura)
				if (this.config.autoReadMs !== undefined && this.config.autoReadMs >= 0) {
					ctx.read(this.config.autoReadMs).catch(err => console.error('[Bot] Error en auto-lectura:', err))
				}

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
