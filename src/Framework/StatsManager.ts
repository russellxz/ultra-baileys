import type Database from 'better-sqlite3'
import type { SQLiteStore } from './Store/SQLiteStore'
import type { Bot } from './Bot'

export interface UserStats {
	userJid: string
	messageCount: number
	stickerCount: number
	lastActive: number
}

export interface GhostEntry {
	jid: string
	isTotalGhost: boolean
	lastActive?: number
}

interface PendingStat {
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
	private getUserStatsStmt: Database.Statement
	private getGroupStatsStmt: Database.Statement

	// In-memory batching to prevent SQLite I/O bottleneck under heavy load
	private pendingUpdates = new Map<string, PendingStat>()
	private flushInterval: NodeJS.Timeout

	constructor(bot: Bot, store: SQLiteStore) {
		this.bot = bot
		this.db = store.db

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS group_stats (
				group_jid TEXT NOT NULL,
				user_jid TEXT NOT NULL,
				message_count INTEGER DEFAULT 0,
				sticker_count INTEGER DEFAULT 0,
				last_active INTEGER NOT NULL,
				PRIMARY KEY (group_jid, user_jid)
			)
		`)

		// Create an index for faster ghost queries
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_group_stats_group
			ON group_stats (group_jid)
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

		this.getUserStatsStmt = this.db.prepare(
			'SELECT user_jid as userJid, message_count as messageCount, sticker_count as stickerCount, last_active as lastActive FROM group_stats WHERE group_jid = ? AND user_jid = ?'
		)

		this.getGroupStatsStmt = this.db.prepare(
			'SELECT user_jid as userJid, last_active as lastActive FROM group_stats WHERE group_jid = ?'
		)

		// Flush stats to disk every 5 seconds
		this.flushInterval = setInterval(() => this.flushStats(), 5000)
	}

	/** Record an incoming message for analytics (Debounced in memory) */
	public observeMessage(groupJid: string, userJid: string, isSticker: boolean) {
		const key = `${groupJid}|${userJid}`
		const existing = this.pendingUpdates.get(key) || { messageCount: 0, stickerCount: 0, lastActive: 0 }

		existing.messageCount += 1
		if (isSticker) existing.stickerCount += 1
		existing.lastActive = Date.now()

		this.pendingUpdates.set(key, existing)
	}

	/** Write all pending updates to SQLite in a single transaction */
	public flushStats() {
		if (this.pendingUpdates.size === 0) return

		const updates = Array.from(this.pendingUpdates.entries())
		this.pendingUpdates.clear()

		try {
			const transaction = this.db.transaction((entries: [string, PendingStat][]) => {
				for (const [key, stat] of entries) {
					const [groupJid, userJid] = key.split('|')
					this.insertStmt.run(groupJid, userJid, stat.messageCount, stat.stickerCount, stat.lastActive)
				}
			})

			transaction(updates)
		} catch (error) {
			this.bot.logger.error({ err: error, count: updates.length }, 'Failed to flush group stats to SQLite')
			// Optional: restore updates to memory if critical to not lose data
			// for (const [key, stat] of updates) { ... }
		}
	}

	/** Stop the background interval (call this during shutdown) */
	public stop() {
		clearInterval(this.flushInterval)
		this.flushStats()
	}

	/** Get the most active users in a group, sorted by message count */
	public getTopUsers(groupJid: string, limit: number = 10): UserStats[] {
		this.flushStats() // Ensure latest stats are returned
		return this.getTopUsersStmt.all(groupJid, limit) as UserStats[]
	}

	/** Get the top sticker senders in a group */
	public getTopStickers(groupJid: string, limit: number = 10): UserStats[] {
		this.flushStats() // Ensure latest stats are returned
		return this.getTopStickersStmt.all(groupJid, limit) as UserStats[]
	}

	/**
	 * Find "ghosts" — group members who haven't sent any messages
	 * within the specified number of days. Requires an active socket
	 * connection to fetch the current participant list.
	 */
	public async getGhosts(groupJid: string, inactiveDays: number = 30): Promise<GhostEntry[]> {
		if (!this.bot.socket) {
			throw new Error('Socket not connected — cannot fetch group metadata')
		}

		this.flushStats() // Ensure latest stats are evaluated

		const metadata = await this.bot.socket.groupMetadata(groupJid)
		const currentParticipants = metadata.participants.map(p => p.id)

		const stats = this.getGroupStatsStmt.all(groupJid) as { userJid: string, lastActive: number }[]

		const statsMap = new Map(stats.map(s => [s.userJid, s.lastActive]))

		const ghosts: GhostEntry[] = []
		const thresholdMs = inactiveDays * 24 * 60 * 60 * 1000
		const now = Date.now()

		for (const jid of currentParticipants) {
			const lastActive = statsMap.get(jid)
			if (!lastActive) {
				ghosts.push({ jid, isTotalGhost: true })
			} else if (now - lastActive > thresholdMs) {
				ghosts.push({ jid, isTotalGhost: false, lastActive })
			}
		}

		return ghosts
	}

	/** Get the total message count for a specific user in a group */
	public getUserStats(groupJid: string, userJid: string): UserStats | undefined {
		this.flushStats()
		return this.getUserStatsStmt.get(groupJid, userJid) as UserStats | undefined
	}
}
