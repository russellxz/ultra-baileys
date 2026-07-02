import { chmod, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AuthenticationCreds, KeyPair, SignalDataSet, SignedKeyPair } from '../Types'
import { jidDecode, jidEncode } from '../WABinary'
import { initAuthCreds } from './auth-utils'
import { Curve, generateSignalPubKey } from './crypto'
import { BufferJSON } from './generics'

export type BrowserAuthNoiseCandidate = {
	ivIndex: number
	value: string
}

export type BrowserAuthBufferJson = {
	__b64: string
}

export type BrowserAuthKeyPair = {
	keyId: number
	keyPair: {
		privKey: BrowserAuthBufferJson
		pubKey: BrowserAuthBufferJson
	}
	signature?: BrowserAuthBufferJson
}

export type BrowserAuthPreKey = {
	keyId: number
	keyPair: {
		privKey: BrowserAuthBufferJson
		pubKey: BrowserAuthBufferJson
	}
}

export type BrowserAuthExtract = {
	localStorage: {
		lastWidMd: string
		waLid: string
	}
	noise: {
		privateKeyCandidates: BrowserAuthNoiseCandidate[]
		publicKeyCandidates: BrowserAuthNoiseCandidate[]
		recoveryTokenCandidates?: BrowserAuthNoiseCandidate[]
		certificateChainBufferCandidates?: BrowserAuthNoiseCandidate[]
	}
	signal: {
		registrationId: number
		nextPreKeyId: number
		firstUnuploadedPreKeyId: number
		lastSignedPreKeyId?: number
		signedIdentityKey: {
			private: string
			public: string
		}
		advSignedIdentity: {
			details: BrowserAuthBufferJson
			accountSignatureKey: BrowserAuthBufferJson
			accountSignature: BrowserAuthBufferJson
			deviceSignature: BrowserAuthBufferJson
		}
		preKeys: BrowserAuthPreKey[]
		signedPreKeys: BrowserAuthKeyPair[]
	}
}

export type BrowserAuthImportOptions = {
	name?: string
	platform?: string
}

export type BrowserAuthImport = {
	creds: AuthenticationCreds
	keys: SignalDataSet
	selectedNoiseCandidate: {
		privateIvIndex: number
		publicIvIndex: number
		recoveryTokenIvIndex?: number
	}
}

type BrowserSignalMetaRecord = {
	key: string
	value: unknown
}

type BrowserEncryptedSignalStaticKey = {
	encKey: CryptoKey
	value: ArrayBuffer
}

const bufferFromB64 = (value: string) => Buffer.from(value, 'base64')
const bufferJsonToBuffer = (value: BrowserAuthBufferJson) => bufferFromB64(value.__b64)

const browserJidToBaileysJid = (jid: string) => {
	const decoded = jidDecode(jid)
	if (!decoded) {
		throw new Error(`Could not normalize browser JID: ${jid}`)
	}

	return jidEncode(decoded.user, decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server, decoded.device)
}

const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

const jidUser = (jid: string) => {
	const decoded = jidDecode(jid)
	if (!decoded) {
		throw new Error(`Could not decode JID: ${jid}`)
	}

	return decoded.user
}

const selectNoiseKeyPair = (noise: BrowserAuthExtract['noise']) => {
	for (const privateCandidate of noise.privateKeyCandidates) {
		const privateKey = bufferFromB64(privateCandidate.value)
		const derivedPublicKey = Curve.publicKeyFromPrivate(privateKey)
		for (const publicCandidate of noise.publicKeyCandidates) {
			const publicKey = bufferFromB64(publicCandidate.value)
			if (derivedPublicKey.equals(publicKey)) {
				return {
					keyPair: { private: privateKey, public: publicKey },
					privateIvIndex: privateCandidate.ivIndex,
					publicIvIndex: publicCandidate.ivIndex
				}
			}
		}
	}

	throw new Error('Could not match WhatsApp Web Noise private/public key candidates')
}

const selectRecoveryToken = (
	candidates: BrowserAuthNoiseCandidate[] | undefined,
	usedIvIndexes: Set<number>
): BrowserAuthNoiseCandidate | undefined => {
	if (!candidates?.length) {
		return undefined
	}

	return candidates.find(candidate => !usedIvIndexes.has(candidate.ivIndex)) || candidates[0]
}

const toKeyPair = (keyPair: BrowserAuthPreKey['keyPair']): KeyPair => ({
	private: bufferJsonToBuffer(keyPair.privKey),
	public: bufferJsonToBuffer(keyPair.pubKey)
})

const toSignedKeyPair = (signedPreKey: BrowserAuthKeyPair, identityKey: KeyPair): SignedKeyPair => {
	const keyPair = toKeyPair(signedPreKey.keyPair)
	const signature = Curve.sign(identityKey.private, generateSignalPubKey(keyPair.public))
	return {
		keyPair,
		signature,
		keyId: signedPreKey.keyId
	}
}

export const makeBrowserAuthImport = (
	extract: BrowserAuthExtract,
	options: BrowserAuthImportOptions = {}
): BrowserAuthImport => {
	const selectedNoise = selectNoiseKeyPair(extract.noise)
	const recoveryToken = selectRecoveryToken(
		extract.noise.recoveryTokenCandidates,
		new Set([selectedNoise.privateIvIndex, selectedNoise.publicIvIndex])
	)
	if (!recoveryToken) {
		throw new Error('WhatsApp Web auth export did not include a recovery token')
	}

	const signedPreKey =
		extract.signal.lastSignedPreKeyId === undefined
			? extract.signal.signedPreKeys[0]
			: extract.signal.signedPreKeys.find(key => key.keyId === extract.signal.lastSignedPreKeyId)

	if (!signedPreKey) {
		throw new Error('WhatsApp Web auth export did not include a signed pre-key')
	}

	const signedIdentityKey = {
		private: bufferFromB64(extract.signal.signedIdentityKey.private),
		public: bufferFromB64(extract.signal.signedIdentityKey.public)
	}
	const creds = initAuthCreds()
	Object.assign(creds, {
		noiseKey: selectedNoise.keyPair,
		signedIdentityKey,
		signedPreKey: toSignedKeyPair(signedPreKey, signedIdentityKey),
		registrationId: extract.signal.registrationId,
		advSecretKey: recoveryToken.value,
		processedHistoryMessages: [],
		nextPreKeyId: extract.signal.nextPreKeyId,
		firstUnuploadedPreKeyId: extract.signal.firstUnuploadedPreKeyId,
		accountSyncCounter: 0,
		accountSettings: { unarchiveChats: false },
		registered: false,
		account: {
			details: bufferJsonToBuffer(extract.signal.advSignedIdentity.details),
			accountSignatureKey: bufferJsonToBuffer(extract.signal.advSignedIdentity.accountSignatureKey),
			accountSignature: bufferJsonToBuffer(extract.signal.advSignedIdentity.accountSignature),
			deviceSignature: bufferJsonToBuffer(extract.signal.advSignedIdentity.deviceSignature)
		},
		me: {
			id: browserJidToBaileysJid(extract.localStorage.lastWidMd),
			lid: extract.localStorage.waLid,
			name: options.name
		},
		signalIdentities: [
			{
				identifier: { name: extract.localStorage.waLid, deviceId: 0 },
				identifierKey: generateSignalPubKey(signedIdentityKey.public)
			}
		],
		platform: options.platform || 'web'
	} satisfies Partial<AuthenticationCreds>)

	const preKeys: SignalDataSet['pre-key'] = {}
	for (const preKey of extract.signal.preKeys) {
		preKeys[preKey.keyId] = toKeyPair(preKey.keyPair)
	}

	const pnUser = jidUser(browserJidToBaileysJid(extract.localStorage.lastWidMd))
	const lidUser = jidUser(extract.localStorage.waLid)

	return {
		creds,
		keys: {
			'pre-key': preKeys,
			'lid-mapping': {
				[pnUser]: lidUser,
				[`${lidUser}_reverse`]: pnUser
			}
		},
		selectedNoiseCandidate: {
			privateIvIndex: selectedNoise.privateIvIndex,
			publicIvIndex: selectedNoise.publicIvIndex,
			recoveryTokenIvIndex: recoveryToken?.ivIndex
		}
	}
}

export const writeBrowserAuthToMultiFile = async (
	folder: string,
	extract: BrowserAuthExtract,
	options: BrowserAuthImportOptions = {}
) => {
	const authImport = makeBrowserAuthImport(extract, options)
	await mkdir(folder, { recursive: true, mode: 0o700 })
	await chmod(folder, 0o700)

	const writePrivateJson = async (file: string, value: unknown) => {
		const filePath = join(folder, file)
		await writeFile(filePath, JSON.stringify(value, BufferJSON.replacer), { mode: 0o600 })
		await chmod(filePath, 0o600)
	}

	await writePrivateJson('creds.json', authImport.creds)
	for (const category in authImport.keys) {
		const values = authImport.keys[category as keyof SignalDataSet]
		for (const id in values) {
			const value = values[id]
			if (value) {
				await writePrivateJson(fixFileName(`${category}-${id}.json`), value)
			}
		}
	}

	return authImport
}

export const extractWhatsAppWebAuthFromBrowser = async (): Promise<BrowserAuthExtract> => {
	const b64ToBytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
	const bytesToB64 = (value: ArrayBuffer | ArrayBufferView) => {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		let binary = ''
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
		}

		return btoa(binary)
	}

	const request = <T>(req: IDBRequest<T>) =>
		new Promise<T>((resolve, reject) => {
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})

	const openDb = (name: string) =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(name)
			req.onupgradeneeded = () => {
				req.transaction?.abort()
			}

			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error || new Error(`IndexedDB database not found: ${name}`))
		})

	const get = async <T>(dbName: string, storeName: string, key: IDBValidKey) => {
		const db = await openDb(dbName)
		try {
			return await request<T>(db.transaction(storeName, 'readonly').objectStore(storeName).get(key))
		} finally {
			db.close()
		}
	}

	const getAll = async <T>(dbName: string, storeName: string) => {
		const db = await openDb(dbName)
		try {
			return await request<T[]>(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())
		} finally {
			db.close()
		}
	}

	const localStorageJson = <T>(key: string) => {
		const value = localStorage.getItem(key)
		if (value === null) {
			throw new Error(`WhatsApp Web localStorage is missing ${key}`)
		}

		return JSON.parse(value) as T
	}

	const requireString = (value: unknown, label: string) => {
		if (typeof value !== 'string' || !value.length) {
			throw new Error(`WhatsApp Web auth export did not include ${label}`)
		}

		return value
	}

	const requireArray = <T>(value: unknown, label: string) => {
		if (!Array.isArray(value)) {
			throw new Error(`WhatsApp Web auth export did not include ${label}`)
		}

		return value as T[]
	}

	const requireNonEmptyArray = <T>(value: unknown, label: string) => {
		const values = requireArray<T>(value, label)
		if (!values.length) {
			throw new Error(`WhatsApp Web auth export did not include ${label}`)
		}

		return values
	}

	const requireRecord = (value: unknown, label: string) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`WhatsApp Web auth export did not include ${label}`)
		}

		return value as Record<string, unknown>
	}

	const requireSafeInteger = (value: unknown, label: string) => {
		const number = Number(value)
		if (!Number.isSafeInteger(number)) {
			throw new Error(`WhatsApp Web auth export did not include a valid ${label}`)
		}

		return number
	}

	const requireEncryptedStaticKey = (value: unknown, label: string) => {
		const record = requireRecord(value, label) as Partial<BrowserEncryptedSignalStaticKey>
		if (!(record.value instanceof ArrayBuffer) && !ArrayBuffer.isView(record.value)) {
			throw new Error(`WhatsApp Web auth export did not include ${label} ciphertext`)
		}

		if (!(record.encKey instanceof CryptoKey)) {
			throw new Error(`WhatsApp Web auth export did not include ${label} decryption key`)
		}

		return record as BrowserEncryptedSignalStaticKey
	}

	const requireBufferJson = (value: unknown, label: string) => {
		const record = requireRecord(value, label)
		if (typeof record.__b64 !== 'string' || !record.__b64.length) {
			throw new Error(`WhatsApp Web auth export did not include ${label}`)
		}

		return record as BrowserAuthBufferJson
	}

	const lastWidMd = requireString(localStorageJson('last-wid-md'), 'last-wid-md')
	const waLid = requireString(localStorageJson('WALid'), 'WALid')
	const salt = b64ToBytes(requireString(localStorageJson('WAWebEncKeySalt'), 'WAWebEncKeySalt'))
	const noiseIvs = requireNonEmptyArray<string>(localStorageJson('WANoiseInfoIv'), 'WANoiseInfoIv').map((iv, index) =>
		requireString(iv, `WANoiseInfoIv[${index}]`)
	)
	const encryptedNoise = requireRecord(localStorageJson('WANoiseInfo'), 'WANoiseInfo') as Record<string, string>
	for (const field of ['privKey', 'pubKey', 'recoveryToken']) {
		requireString(encryptedNoise[field], `WANoiseInfo.${field}`)
	}

	const encryptedKeyRecord = await get<{ key?: CryptoKey }>('wawc_db_enc', 'keys', 1)
	if (!(encryptedKeyRecord?.key instanceof CryptoKey)) {
		throw new Error('WhatsApp Web auth export did not include the encrypted storage key')
	}

	const noiseAesKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array([0]) },
		encryptedKeyRecord.key,
		{ name: 'AES-CBC', length: 128 },
		false,
		['decrypt']
	)
	const decryptNoiseCandidates = async (field: string): Promise<BrowserAuthNoiseCandidate[]> => {
		const encryptedValue = encryptedNoise[field]
		if (!encryptedValue) {
			return []
		}

		const candidates: BrowserAuthNoiseCandidate[] = []
		await Promise.all(
			noiseIvs.map(async (iv, ivIndex) => {
				try {
					const value = await crypto.subtle.decrypt(
						{ name: 'AES-CBC', iv: b64ToBytes(iv) },
						noiseAesKey,
						b64ToBytes(encryptedValue)
					)
					candidates.push({ ivIndex, value: bytesToB64(value) })
				} catch {}
			})
		)

		return candidates.sort((left, right) => left.ivIndex - right.ivIndex)
	}

	const requireCandidates = async (field: string) => {
		const candidates = await decryptNoiseCandidates(field)
		if (!candidates.length) {
			throw new Error(`WhatsApp Web auth export did not include decryptable WANoiseInfo.${field}`)
		}

		return candidates
	}

	const privateKeyCandidates = await requireCandidates('privKey')
	const publicKeyCandidates = await requireCandidates('pubKey')
	const recoveryTokenCandidates = await requireCandidates('recoveryToken')
	const certificateChainBufferCandidates = await decryptNoiseCandidates('certificateChainBuffer')

	const signalMetaRows = requireNonEmptyArray<BrowserSignalMetaRecord>(
		await getAll<BrowserSignalMetaRecord>('signal-storage', 'signal-meta-store'),
		'signal meta records'
	)
	const signalMeta = Object.fromEntries(signalMetaRows.map(row => [row.key, row.value])) as Record<string, unknown>
	const decryptStaticKey = async (record: BrowserEncryptedSignalStaticKey) =>
		bytesToB64(
			await crypto.subtle.decrypt(
				{ name: 'AES-CTR', counter: new Uint8Array(16), length: 64 },
				record.encKey,
				record.value
			)
		)
	const mapBuffer = (value: unknown): unknown => {
		if (value === null || value === undefined) {
			return value
		}

		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			return { __b64: bytesToB64(value) }
		}

		if (Array.isArray(value)) {
			return value.map(mapBuffer)
		}

		if (typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, child]) => !(child instanceof CryptoKey))
					.map(([key, child]) => [key, mapBuffer(child)])
			)
		}

		return value
	}

	const advSignedIdentity = requireRecord(mapBuffer(signalMeta.adv_signed_identity), 'adv signed identity')
	const preKeys = requireNonEmptyArray<BrowserAuthPreKey>(
		(await getAll('signal-storage', 'prekey-store')).map(mapBuffer),
		'pre-key records'
	)
	const signedPreKeys = requireNonEmptyArray<BrowserAuthKeyPair>(
		(await getAll('signal-storage', 'signed-prekey-store')).map(mapBuffer),
		'signed pre-key records'
	)
	const lastSignedPreKeyId =
		signalMeta.signal_last_spk_id === undefined
			? undefined
			: requireSafeInteger(signalMeta.signal_last_spk_id, 'last signed pre-key id')

	return {
		localStorage: { lastWidMd, waLid },
		noise: { privateKeyCandidates, publicKeyCandidates, recoveryTokenCandidates, certificateChainBufferCandidates },
		signal: {
			registrationId: requireSafeInteger(signalMeta.signal_reg_id, 'registration id'),
			nextPreKeyId: requireSafeInteger(signalMeta.signal_next_pk_id, 'next pre-key id'),
			firstUnuploadedPreKeyId: requireSafeInteger(
				signalMeta.signal_first_unupload_pk_id,
				'first unuploaded pre-key id'
			),
			lastSignedPreKeyId,
			signedIdentityKey: {
				private: await decryptStaticKey(
					requireEncryptedStaticKey(signalMeta.signal_static_privkey, 'static private key')
				),
				public: await decryptStaticKey(requireEncryptedStaticKey(signalMeta.signal_static_pubkey, 'static public key'))
			},
			advSignedIdentity: {
				details: requireBufferJson(advSignedIdentity.details, 'adv signed identity details'),
				accountSignatureKey: requireBufferJson(
					advSignedIdentity.accountSignatureKey,
					'adv signed identity account signature key'
				),
				accountSignature: requireBufferJson(
					advSignedIdentity.accountSignature,
					'adv signed identity account signature'
				),
				deviceSignature: requireBufferJson(advSignedIdentity.deviceSignature, 'adv signed identity device signature')
			},
			preKeys,
			signedPreKeys
		}
	}
}
