import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AuthenticationCreds, KeyPair, SignalDataSet, SignedKeyPair } from '../Types'
import { jidDecode } from '../WABinary'
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

const browserJidToBaileysJid = (jid: string) => jid.replace('@c.us', '@s.whatsapp.net')

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
	const signedPreKey =
		extract.signal.signedPreKeys.find(key => key.keyId === extract.signal.lastSignedPreKeyId) ||
		extract.signal.signedPreKeys[0]

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
		advSecretKey: recoveryToken?.value || creds.advSecretKey,
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
	await mkdir(folder, { recursive: true })
	await writeFile(join(folder, 'creds.json'), JSON.stringify(authImport.creds, BufferJSON.replacer))
	for (const category in authImport.keys) {
		const values = authImport.keys[category as keyof SignalDataSet]
		for (const id in values) {
			const value = values[id]
			if (value) {
				await writeFile(join(folder, fixFileName(`${category}-${id}.json`)), JSON.stringify(value, BufferJSON.replacer))
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
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})

	const get = async <T>(dbName: string, storeName: string, key: IDBValidKey) => {
		const db = await openDb(dbName)
		const value = await request<T>(db.transaction(storeName, 'readonly').objectStore(storeName).get(key))
		db.close()

		return value
	}

	const getAll = async <T>(dbName: string, storeName: string) => {
		const db = await openDb(dbName)
		const value = await request<T[]>(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())
		db.close()

		return value
	}

	const encryptedKey = (await get<{ key: CryptoKey }>('wawc_db_enc', 'keys', 1)).key
	const salt = b64ToBytes(JSON.parse(localStorage.getItem('WAWebEncKeySalt') || '""'))
	const noiseIvs: string[] = JSON.parse(localStorage.getItem('WANoiseInfoIv') || '[]')
	const encryptedNoise: Record<string, string> = JSON.parse(localStorage.getItem('WANoiseInfo') || '{}')
	const noiseAesKey = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array([0]) },
		encryptedKey,
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

	const signalMetaRows = await getAll<BrowserSignalMetaRecord>('signal-storage', 'signal-meta-store')
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

	return {
		localStorage: {
			lastWidMd: JSON.parse(localStorage.getItem('last-wid-md') || '""'),
			waLid: JSON.parse(localStorage.getItem('WALid') || '""')
		},
		noise: {
			privateKeyCandidates: await decryptNoiseCandidates('privKey'),
			publicKeyCandidates: await decryptNoiseCandidates('pubKey'),
			recoveryTokenCandidates: await decryptNoiseCandidates('recoveryToken'),
			certificateChainBufferCandidates: await decryptNoiseCandidates('certificateChainBuffer')
		},
		signal: {
			registrationId: Number(signalMeta.signal_reg_id),
			nextPreKeyId: Number(signalMeta.signal_next_pk_id),
			firstUnuploadedPreKeyId: Number(signalMeta.signal_first_unupload_pk_id),
			lastSignedPreKeyId:
				signalMeta.signal_last_spk_id === undefined ? undefined : Number(signalMeta.signal_last_spk_id),
			signedIdentityKey: {
				private: await decryptStaticKey(signalMeta.signal_static_privkey as BrowserEncryptedSignalStaticKey),
				public: await decryptStaticKey(signalMeta.signal_static_pubkey as BrowserEncryptedSignalStaticKey)
			},
			advSignedIdentity: mapBuffer(signalMeta.adv_signed_identity) as BrowserAuthExtract['signal']['advSignedIdentity'],
			preKeys: (await getAll('signal-storage', 'prekey-store')).map(mapBuffer) as BrowserAuthPreKey[],
			signedPreKeys: (await getAll('signal-storage', 'signed-prekey-store')).map(mapBuffer) as BrowserAuthKeyPair[]
		}
	}
}
