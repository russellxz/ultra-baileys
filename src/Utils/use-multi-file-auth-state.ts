import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'
import { makeKeyedMutex } from './make-mutex'

// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Keyed mutex: serializes access per file path and ref-counts its entries, so an
// idle path is freed instead of leaking a Mutex per key file for the process' life.
const fileMutex = makeKeyedMutex()

// PATCH: a stuck fs op leaks its FSReqPromise/Promise forever (heap → OOM).
// Wrap each read/write in AbortController+timeout so the stuck one is aborted and freed.
const FS_TIMEOUT_MS = 15000
const withFsTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), FS_TIMEOUT_MS)
	try {
		return await run(ac.signal)
	} finally {
		clearTimeout(timer)
	}
}

/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (
	folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)

		return fileMutex.mutex(filePath, async () => {
			// PATCH: atomic write (tmp + rename) with timeout. An abort mid-write
			const tmpPath = `${filePath}.tmp`
			try {
				await withFsTimeout(signal => writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer), { signal }))
				await rename(tmpPath, filePath)
			} catch (error) {
				await unlink(tmpPath).catch(() => {})
				throw error
			}
		})
	}

	const readData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)

			return await fileMutex.mutex(filePath, async () => {
				// PATCH: timeout via signal — a stuck readFile is aborted.
				const data = await withFsTimeout<string>(signal => readFile(filePath, { encoding: 'utf-8', signal }))
				return JSON.parse(data, BufferJSON.reviver)
			})
		} catch (error) {
			return null
		}
	}

	const removeData = async (file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)

			return fileMutex.mutex(filePath, async () => {
				try {
					await unlink(filePath)
				} catch {}
			})
		} catch {}
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(
				`found something that is not a directory at ${folder}, either delete it or specify a different location`
			)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}

	const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

	const creds: AuthenticationCreds = (await readData('creds.json')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.json`)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)

					return data
				},
				set: async data => {
					const tasks: Promise<void>[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const file = `${category}-${id}.json`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}

					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.json')
		}
	}
}
