import type Database from 'better-sqlite3'
import type { SQLiteStore } from './Store/SQLiteStore'
import type { Bot } from './Bot'

export interface UserStats {
	userJid: string
	messageCount: number
	stickerCount: number
	lastActive: number
}

export class StatsManager {
	private db: Database.Database
	private bot: Bot

	private insertStmt: Database.Statement
	private getTopUsersStmt: Database.Statement
	private getTopStickersStmt: Database.Statement

	constructor(bot: Bot, store: SQLiteStore) {
		this.bot = bot
		this.db = store.db

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS group_stats (
				group_jid TEXT,
				user_jid TEXT,
				message_count INTEGER DEFAULT 0,
				sticker_count INTEGER DEFAULT 0,
				last_active INTEGER,
				PRIMARY KEY (group_jid, user_jid)
			)
		`)

		this.insertStmt = this.db.prepare(`
			INSERT INTO group_stats (group_jid, user_jid, message_count, sticker_count, last_active)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(group_jid, user_jid) DO UPDATE SET
				message_count = message_count + excluded.message_count,
				sticker_count = sticker_count + excluded.sticker_count,
				last_active = excluded.last_active
		`)

		this.getTopUsersStmt = this.db.prepare(`
			SELECT user_jid as userJid, message_count as messageCount, sticker_count as stickerCount, last_active as lastActive
			FROM group_stats
			WHERE group_jid = ?
			ORDER BY message_count DESC
			LIMIT ?
		`)

		this.getTopStickersStmt = this.db.prepare(`
			SELECT user_jid as userJid, message_count as messageCount, sticker_count as stickerCount, last_active as lastActive
			FROM group_stats
			WHERE group_jid = ?
			ORDER BY sticker_count DESC
			LIMIT ?
		`)
	}

	public observeMessage(groupJid: string, userJid: string, isSticker: boolean) {
		const msgCount = 1
		const stickerCount = isSticker ? 1 : 0
		const now = Date.now()

		this.insertStmt.run(groupJid, userJid, msgCount, stickerCount, now)
	}

	public getTopUsers(groupJid: string, limit: number = 10): UserStats[] {
		return this.getTopUsersStmt.all(groupJid, limit) as UserStats[]
	}

	public getTopStickers(groupJid: string, limit: number = 10): UserStats[] {
		return this.getTopStickersStmt.all(groupJid, limit) as UserStats[]
	}

	public async getGhosts(groupJid: string, inactiveDays: number = 30): Promise<{ jid: string, isTotalGhost: boolean, lastActive?: number }[]> {
		if (!this.bot.socket) {
			throw new Error('Socket not connected')
		}

		// Fetch current participants from WhatsApp
		const metadata = await this.bot.socket.groupMetadata(groupJid)
		const currentParticipants = metadata.participants.map(p => p.id)

		// Fetch stats for this group
		const stats = this.db.prepare(`SELECT user_jid as userJid, last_active as lastActive FROM group_stats WHERE group_jid = ?`).all(groupJid) as { userJid: string, lastActive: number }[]
		
		const statsMap = new Map(stats.map(s => [s.userJid, s.lastActive]))
		
		const ghosts: { jid: string, isTotalGhost: boolean, lastActive?: number }[] = []
		const thresholdMs = inactiveDays * 24 * 60 * 60 * 1000
		const now = Date.now()

		for (const jid of currentParticipants) {
			const lastActive = statsMap.get(jid)
			if (!lastActive) {
				// User is in the group but has never sent a message (since bot is running)
				ghosts.push({ jid, isTotalGhost: true })
			} else if (now - lastActive > thresholdMs) {
				// User sent messages in the past, but is now inactive
				ghosts.push({ jid, isTotalGhost: false, lastActive })
			}
		}

		return ghosts
	}
}
