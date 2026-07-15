import Database from 'better-sqlite3'
import type { CacheStore } from '../../Types'

export class SQLiteStore implements CacheStore {
	public db: Database.Database
	private getStmt: Database.Statement
	private setStmt: Database.Statement
	private delStmt: Database.Statement
	private flushStmt: Database.Statement

	constructor(dbPath = 'baileys_store.db') {
		this.db = new Database(dbPath)
		this.db.pragma('journal_mode = WAL')
		this.db.pragma('synchronous = NORMAL')
		this.db.pragma('cache_size = -20000')

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`)

		this.getStmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?')
		this.setStmt = this.db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)')
		this.delStmt = this.db.prepare('DELETE FROM kv_store WHERE key = ?')
		this.flushStmt = this.db.prepare('DELETE FROM kv_store')
	}

	get<T>(key: string): T | undefined {
		const row = this.getStmt.get(key) as { value: string } | undefined
		if (row) {
			try {
				return JSON.parse(row.value) as T
			} catch {
				return row.value as unknown as T
			}
		}

		return undefined
	}

	set<T>(key: string, value: T): void {
		const strValue = typeof value === 'string' ? value : JSON.stringify(value)
		this.setStmt.run(key, strValue)
	}

	del(key: string): void {
		this.delStmt.run(key)
	}

	flushAll(): void {
		this.flushStmt.run()
	}

	close(): void {
		this.db.close()
	}
}
