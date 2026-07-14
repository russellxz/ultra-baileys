import type { WAMessage, AnyMessageContent, MiscMessageGenerationOptions } from '../Types'
import type { Bot } from './Bot'
import makeWASocket from '../Socket'
import { MediaManager, type StickerMetadata } from './MediaManager'

export type WASocket = ReturnType<typeof makeWASocket>

export class Context {
	public readonly message: WAMessage
	public readonly bot: Bot
	public readonly remoteJid: string

	constructor(bot: Bot, message: WAMessage) {
		this.bot = bot
		this.message = message
		this.remoteJid = message.key.remoteJid || ''
	}

	public get text(): string | undefined {
		return this.message.message?.conversation || 
			this.message.message?.extendedTextMessage?.text || 
			undefined
	}
	
	public get session() {
		return {
			get: <T = any>() => this.bot.session.get<T>(this.remoteJid),
			set: <T = any>(data: T) => this.bot.session.set(this.remoteJid, data),
			update: <T = any>(data: Partial<T>) => this.bot.session.update(this.remoteJid, data),
			delete: () => this.bot.session.delete(this.remoteJid)
		}
	}

	public async reply(content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) {
		if (!this.remoteJid) {
			throw new Error('remoteJid is undefined')
		}
		return this.bot.sendMessage(this.remoteJid, content, { quoted: this.message, ...options })
	}

	public async react(emoji: string) {
		if (!this.remoteJid || !this.message.key) {
			throw new Error('Cannot react without remoteJid or message key')
		}
		return this.bot.sendMessage(this.remoteJid, {
			react: { text: emoji, key: this.message.key }
		})
	}

	public async replySticker(media: Buffer | string, metadata?: StickerMetadata) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		
		const webpBuffer = await MediaManager.convertToSticker(media, metadata)
		return this.bot.sendMessage(this.remoteJid, { sticker: webpBuffer }, { quoted: this.message })
	}

	public async replyVoiceNote(media: Buffer | string) {
		if (!this.remoteJid) throw new Error('remoteJid is undefined')
		
		const oggBuffer = await MediaManager.convertToVoiceNote(media)
		return this.bot.sendMessage(this.remoteJid, { 
			audio: oggBuffer, 
			mimetype: 'audio/ogg; codecs=opus', 
			ptt: true 
		}, { quoted: this.message })
	}
}
