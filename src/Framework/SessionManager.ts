import type { SQLiteStore } from './Store/SQLiteStore'

export class SessionManager {
	private store: SQLiteStore

	constructor(store: SQLiteStore) {
		this.store = store
	}

	private getSessionKey(jid: string): string {
		return `session_${jid}`
	}

	public get<T = any>(jid: string): T | undefined {
		return this.store.get<T>(this.getSessionKey(jid))
	}

	public set<T = any>(jid: string, data: T): void {
		this.store.set(this.getSessionKey(jid), data)
	}

	public delete(jid: string): void {
		this.store.del(this.getSessionKey(jid))
	}

	public update<T = any>(jid: string, partialData: Partial<T>): void {
		const current = this.get<T>(jid) || {} as T
		this.set(jid, { ...current, ...partialData })
	}
}
