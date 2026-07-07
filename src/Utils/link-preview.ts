import type Long from 'long'
import type { proto } from '../../WAProto/index.js'
import type { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import { toNumber } from './generics'
import type { ILogger } from './logger'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192
type LinkPreviewResponse =
	proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url: string, { thumbnailWidth, fetchOpts }: URLGenerationOptions) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: HeadersInit
	}
	uploadImage?: WAMediaUploadFunction
	logger?: ILogger
}

const bufferFromStringHash = (hash?: string | null) => {
	if (!hash) {
		return undefined
	}

	const normalized = hash.replace(/-/g, '+').replace(/_/g, '/')
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
	const buffer = Buffer.from(padded, 'base64')
	return buffer.length ? buffer : undefined
}

const mediaKeyTimestampFromMs = (timestampMs: Long | number | null | undefined) => {
	const timestamp = toNumber(timestampMs)
	if (!timestamp) {
		return undefined
	}

	return timestamp > 9_999_999_999 ? Math.floor(timestamp / 1000) : timestamp
}

export const linkPreviewResponseToUrlInfo = (
	matchedText: string,
	response: LinkPreviewResponse | null | undefined
): WAUrlInfo | undefined => {
	if (!response?.url || !response.title) {
		return undefined
	}

	const urlInfo: WAUrlInfo = {
		'canonical-url': response.url,
		'matched-text': response.matchText || matchedText,
		title: response.title,
		description: response.description || undefined,
		jpegThumbnail: response.thumbData ? Buffer.from(response.thumbData) : undefined
	}

	const hqThumbnail = response.hqThumbnail
	if (hqThumbnail?.directPath && hqThumbnail.mediaKey) {
		urlInfo.highQualityThumbnail = {
			directPath: hqThumbnail.directPath,
			fileSha256: bufferFromStringHash(hqThumbnail.thumbHash),
			fileEncSha256: bufferFromStringHash(hqThumbnail.encThumbHash),
			jpegThumbnail: urlInfo.jpegThumbnail,
			mediaKey: Buffer.from(hqThumbnail.mediaKey),
			mediaKeyTimestamp: mediaKeyTimestampFromMs(hqThumbnail.mediaKeyTimestampMs),
			mimetype: 'image/jpeg',
			width: hqThumbnail.thumbWidth || undefined,
			height: hqThumbnail.thumbHeight || undefined
		}
	}

	return urlInfo
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async (
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}
): Promise<WAUrlInfo | undefined> => {
	try {
		// retries
		let retries = 0
		const maxRetry = 5

		const { getLinkPreview } = await import('link-preview-js')
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		const info = await getLinkPreview(previewLink, {
			...opts.fetchOpts,
			followRedirects: 'follow',
			handleRedirects: (baseURL: string, forwardedURL: string) => {
				const urlObj = new URL(baseURL)
				const forwardedURLObj = new URL(forwardedURL)
				if (retries >= maxRetry) {
					return false
				}

				if (
					forwardedURLObj.hostname === urlObj.hostname ||
					forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
					'www.' + forwardedURLObj.hostname === urlObj.hostname
				) {
					retries += 1
					return true
				} else {
					return false
				}
			},
			headers: opts.fetchOpts?.headers as {}
		})
		if (info && 'title' in info && info.title) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			if (opts.uploadImage) {
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: { url: image! } },
					{
						upload: opts.uploadImage,
						mediaTypeOverride: 'thumbnail-link',
						options: opts.fetchOpts
					}
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined
				} catch (error: any) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}

			return urlInfo
		}
	} catch (error: any) {
		if (!error.message.includes('receive a valid')) {
			throw error
		}
	}
}
