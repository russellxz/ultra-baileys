import Database from 'better-sqlite3'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

/**
 * Stores the full authentication state in a single SQLite database.
 * Far more efficient than useMultiFileAuthState for high-concurrency environments
 * as it avoids creating thousands of files and bypasses Mutex locking bottlenecks.
 * 
 * @param databasePath The path to the SQLite database file (e.g. 'baileys_auth.db')
 */
export const useSQLiteAuthState = async (
	databasePath: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	
	const db = new Database(databasePath)
	db.pragma('journal_mode = WAL')
	
	db.exec(`
		CREATE TABLE IF NOT EXISTS auth_state (
			id TEXT PRIMARY KEY,
			data TEXT NOT NULL
		)
	`)

	const getStmt = db.prepare('SELECT data FROM auth_state WHERE id = ?')
	const setStmt = db.prepare('INSERT OR REPLACE INTO auth_state (id, data) VALUES (?, ?)')
	const delStmt = db.prepare('DELETE FROM auth_state WHERE id = ?')

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = (data: any, id: string) => {
		const json = JSON.stringify(data, BufferJSON.replacer)
		setStmt.run(id, json)
	}

	const readData = (id: string) => {
		try {
			const row = getStmt.get(id) as { data: string } | undefined
			if (row) {
				return JSON.parse(row.data, BufferJSON.reviver)
			}
			return null
		} catch (error) {
			return null
		}
	}

	const removeData = (id: string) => {
		try {
			delStmt.run(id)
		} catch {}
	}

	let creds: AuthenticationCreds
	const existingCreds = readData('creds')
	if (existingCreds) {
		creds = existingCreds
	} else {
		creds = initAuthCreds()
		writeData(creds, 'creds')
	}

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					for (const id of ids) {
						let value = readData(`${type}-${id}`)
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}
						data[id] = value
					}
					return data
				},
				set: async data => {
					// We can use a transaction for batch inserts to maximize SQLite performance
					const batchWrite = db.transaction((operations: { type: 'set' | 'del', id: string, value?: any }[]) => {
						for (const op of operations) {
							if (op.type === 'set') {
								setStmt.run(op.id, JSON.stringify(op.value, BufferJSON.replacer))
							} else {
								delStmt.run(op.id)
							}
						}
					})
					
					const operations: { type: 'set' | 'del', id: string, value?: any }[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const keyId = `${category}-${id}`
							if (value) {
								operations.push({ type: 'set', id: keyId, value })
							} else {
								operations.push({ type: 'del', id: keyId })
							}
						}
					}
					
					if (operations.length > 0) {
						batchWrite(operations)
					}
				}
			}
		},
		saveCreds: async () => {
			writeData(creds, 'creds')
		}
	}
}

/**
 * Utility to easily and safely wipe an SQLite auth state database.
 * @param databasePath The path to the SQLite database file
 */
export const clearSQLiteAuthState = (databasePath: string): void => {
	try {
		const db = new Database(databasePath)
		db.exec('DROP TABLE IF EXISTS auth_state')
		db.close()
	} catch (error) {
		console.warn(`Failed to clear SQLite auth state at ${databasePath}:`, error)
	}
}
