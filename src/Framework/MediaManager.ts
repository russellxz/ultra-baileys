import { writeFile, copyFile, readFile, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

export interface StickerMetadata {
	packname?: string
	author?: string
}

// Set ffmpeg path once at module load — guard against null
if (ffmpegStatic) {
	ffmpeg.setFfmpegPath(ffmpegStatic)
}

export class MediaManager {
	private static getTempFile(ext: string) {
		return path.join(os.tmpdir(), `baileys_${randomBytes(8).toString('hex')}.${ext}`)
	}

	/**
	 * Converts an image or short video to a WhatsApp-compatible
	 * WebP sticker with optional EXIF metadata (pack name, author).
	 */
	public static async convertToSticker(inputPathOrBuffer: string | Buffer, metadata?: StickerMetadata): Promise<Buffer> {
		const tempInput = this.getTempFile('in')
		const tempOutput = this.getTempFile('webp')

		if (Buffer.isBuffer(inputPathOrBuffer)) {
			await writeFile(tempInput, inputPathOrBuffer)
		} else {
			await copyFile(inputPathOrBuffer, tempInput)
		}

		try {
			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempInput)
					.inputOptions(['-y'])
					.outputOptions([
						'-vcodec libwebp',
						'-vf', "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse",
						'-lossless 1',
						'-qscale 100',
						'-preset default',
						'-loop 0',
						'-an',
						'-vsync 0'
					])
					.toFormat('webp')
					.save(tempOutput)
					.on('end', () => resolve())
					.on('error', (err: Error) => reject(err))
			})

			// Add EXIF metadata for sticker pack identity
			if (metadata?.packname || metadata?.author) {
				try {
					// Dynamic import — node-webpmux is an optional peer dependency
				// eslint-disable-next-line @typescript-eslint/no-require-imports
					const webpmux = require('node-webpmux') as { Image: new () => { load: (path: string) => Promise<void>, save: (path: string) => Promise<void>, exif: Buffer } }
					const img = new webpmux.Image()
					await img.load(tempOutput)

					const json = JSON.stringify({
						'sticker-pack-id': `baileys-next-${randomBytes(4).toString('hex')}`,
						'sticker-pack-name': metadata.packname || 'Bot',
						'sticker-pack-publisher': metadata.author || '',
						emojis: ['🤖']
					})

					const jsonBuffer = Buffer.from(json, 'utf-8')
					const headerLen = 22
					const exifHeader = Buffer.alloc(headerLen)
					// TIFF Little-Endian header
					exifHeader.writeUInt8(0x49, 0)
					exifHeader.writeUInt8(0x49, 1)
					exifHeader.writeUInt16LE(0x002A, 2)
					exifHeader.writeUInt32LE(0x08, 4)
					exifHeader.writeUInt16LE(0x01, 8)
					exifHeader.writeUInt16LE(0x5741, 10)
					exifHeader.writeUInt16LE(0x07, 12)
					exifHeader.writeUInt32LE(jsonBuffer.length, 14)
					exifHeader.writeUInt32LE(headerLen, 18)

					const exif = Buffer.concat([exifHeader, jsonBuffer])
					img.exif = exif
					await img.save(tempOutput)
				} catch {
					// If node-webpmux is not installed, skip metadata gracefully
				}
			}

			return await readFile(tempOutput)
		} finally {
			// Always clean up temp files
			await unlink(tempInput).catch(() => {})
			await unlink(tempOutput).catch(() => {})
		}
	}

	/**
	 * Converts any audio file to Opus/OGG format compatible
	 * with WhatsApp Push-To-Talk (voice notes).
	 */
	public static async convertToVoiceNote(inputPathOrBuffer: string | Buffer): Promise<Buffer> {
		const tempInput = this.getTempFile('in')
		const tempOutput = this.getTempFile('ogg')

		if (Buffer.isBuffer(inputPathOrBuffer)) {
			await writeFile(tempInput, inputPathOrBuffer)
		} else {
			await copyFile(inputPathOrBuffer, tempInput)
		}

		try {
			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempInput)
					.inputOptions(['-y'])
					.audioCodec('libopus')
					.audioChannels(1)
					.audioFrequency(48000)
					.toFormat('ogg')
					.save(tempOutput)
					.on('end', () => resolve())
					.on('error', (err: Error) => reject(err))
			})

			return await readFile(tempOutput)
		} finally {
			await unlink(tempInput).catch(() => {})
			await unlink(tempOutput).catch(() => {})
		}
	}
}
