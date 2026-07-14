import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import * as os from 'os'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

// node-webpmux usa commonjs en su mayoría
const webpmux = require('node-webpmux')

// Configurar la ruta de FFmpeg automáticamente
ffmpeg.setFfmpegPath(ffmpegStatic as string)

export interface StickerMetadata {
	packname?: string
	author?: string
}

export class MediaManager {
	private static getTempFile(ext: string) {
		return path.join(os.tmpdir(), `${randomBytes(6).toString('hex')}.${ext}`)
	}

	public static async convertToSticker(inputPathOrBuffer: string | Buffer, metadata?: StickerMetadata): Promise<Buffer> {
		const tempInput = this.getTempFile('in')
		const tempOutput = this.getTempFile('webp')

		if (Buffer.isBuffer(inputPathOrBuffer)) {
			fs.writeFileSync(tempInput, inputPathOrBuffer)
		} else {
			fs.copyFileSync(inputPathOrBuffer, tempInput)
		}

		try {
			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempInput)
					.inputOptions(['-y'])
					.outputOptions([
						'-vcodec libwebp',
						'-vf scale=\'min(320,iw)\':min\'(320,ih)\':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse',
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
					.on('error', (err: any) => reject(err))
			})

			// Añadir metadatos EXIF para el paquete de stickers
			if (metadata?.packname || metadata?.author) {
				const img = new webpmux.Image()
				await img.load(tempOutput)
				
				const json = {
					'sticker-pack-id': `baileys-fork-${randomBytes(4).toString('hex')}`,
					'sticker-pack-name': metadata.packname || 'Bot',
					'sticker-pack-publisher': metadata.author || 'WhatsApp Bot',
					emojis: ['🤖']
				}
				
				const exif = Buffer.concat([
					Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]),
					Buffer.from(JSON.stringify(json), 'utf-8')
				])
				
				img.exif = exif
				await img.save(tempOutput)
			}

			return fs.readFileSync(tempOutput)
		} finally {
			if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput)
			if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput)
		}
	}

	public static async convertToVoiceNote(inputPathOrBuffer: string | Buffer): Promise<Buffer> {
		const tempInput = this.getTempFile('in')
		const tempOutput = this.getTempFile('ogg')

		if (Buffer.isBuffer(inputPathOrBuffer)) {
			fs.writeFileSync(tempInput, inputPathOrBuffer)
		} else {
			fs.copyFileSync(inputPathOrBuffer, tempInput)
		}

		try {
			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempInput)
					.inputOptions(['-y'])
					.audioCodec('libopus')
					.toFormat('ogg')
					.save(tempOutput)
					.on('end', () => resolve())
					.on('error', (err: any) => reject(err))
			})

			return fs.readFileSync(tempOutput)
		} finally {
			if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput)
			if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput)
		}
	}
}
