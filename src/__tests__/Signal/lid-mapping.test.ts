import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataSet, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

let lidMappingRecords: Record<string, string> = {}
let getCalls: Array<{ type: keyof SignalDataTypeMap; ids: string[] }> = []
let setCalls: SignalDataSet[] = []
let transactionKeys: string[] = []

const setLidMappingRecords = (records: Record<string, string>) => {
	lidMappingRecords = { ...records }
}

const mockKeys: SignalKeyStoreWithTransaction = {
	async get<T extends keyof SignalDataTypeMap>(
		type: T,
		ids: string[]
	): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
		getCalls.push({ type, ids })
		const result: { [id: string]: SignalDataTypeMap[T] } = {}
		if (type === 'lid-mapping') {
			for (const id of ids) {
				const value = lidMappingRecords[id]
				if (value !== undefined) {
					result[id] = value as SignalDataTypeMap[T]
				}
			}
		}

		return result
	},
	async set(data: SignalDataSet): Promise<void> {
		setCalls.push(data)
		const mappings = data['lid-mapping']
		if (!mappings) return

		for (const [id, value] of Object.entries(mappings)) {
			if (value === null) {
				delete lidMappingRecords[id]
			} else {
				lidMappingRecords[id] = value
			}
		}
	},
	async transaction<T>(work: () => Promise<T>, key: string): Promise<T> {
		transactionKeys.push(key)
		return work()
	},
	isInTransaction: () => false
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		setLidMappingRecords({})
		getCalls = []
		setCalls = []
		transactionKeys = []
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getStoredLIDForPN', () => {
		it('should return a locally stored LID without calling USync', async () => {
			setLidMappingRecords({ '12345': '98765' })

			const result = await lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')

			expect(result).toBe('98765@lid')
			expect(getCalls).toContainEqual({ type: 'lid-mapping', ids: ['12345'] })
			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
		})

		it('should preserve the PN device on a locally stored LID', async () => {
			setLidMappingRecords({ '12345': '98765' })

			const result = await lidMappingStore.getStoredLIDForPN('12345:7@s.whatsapp.net')

			expect(result).toBe('98765:7@lid')
			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
		})

		it('should return a hosted LID for a locally stored hosted PN mapping', async () => {
			setLidMappingRecords({ '12345': '98765' })

			const result = await lidMappingStore.getStoredLIDForPN('12345@hosted')

			expect(result).toBe('98765@hosted.lid')
			expect(getCalls).toContainEqual({ type: 'lid-mapping', ids: ['12345'] })
			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
		})

		it('should reject a malformed locally stored LID user', async () => {
			setLidMappingRecords({ '12345': '98765:7' })

			const result = await lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')

			expect(result).toBeNull()
			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
		})

		it('should return null when no local mapping is stored', async () => {
			const result = await lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')

			expect(result).toBeNull()
			expect(mockPnToLIDFunc).not.toHaveBeenCalled()
		})

		it('should cache local misses until a mapping is stored', async () => {
			await expect(lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')).resolves.toBeNull()
			await expect(lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')).resolves.toBeNull()
			expect(getCalls).toHaveLength(1)

			await lidMappingStore.storeLIDPNMappings([{ lid: '98765@lid', pn: '12345@s.whatsapp.net' }])
			await expect(lidMappingStore.getStoredLIDForPN('12345@s.whatsapp.net')).resolves.toBe('98765@lid')
			expect(getCalls).toHaveLength(2)
			expect(setCalls).toHaveLength(1)
			expect(transactionKeys).toEqual(['lid-mapping'])
		})
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			setLidMappingRecords({ [`12345_reverse`]: pnUser })

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})
	})
})
