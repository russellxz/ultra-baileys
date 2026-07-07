import Long from 'long'
import { linkPreviewResponseToUrlInfo } from '../../Utils/link-preview'

describe('linkPreviewResponseToUrlInfo', () => {
	it('maps phone-generated link previews to WAUrlInfo', () => {
		const thumbData = Buffer.from([1, 2, 3])
		const thumbHash = Buffer.from('thumb-hash').toString('base64')
		const encThumbHash = Buffer.from('enc-thumb-hash').toString('base64url')
		const mediaKey = Buffer.from('media-key')

		const urlInfo = linkPreviewResponseToUrlInfo('https://example.com/path', {
			url: 'https://example.com/',
			title: 'Example',
			description: 'Example description',
			thumbData,
			matchText: 'https://example.com/path',
			hqThumbnail: {
				directPath: '/o1/v/t62.7118-24/link-preview',
				thumbHash,
				encThumbHash,
				mediaKey,
				mediaKeyTimestampMs: Long.fromNumber(1_692_895_570_000),
				thumbWidth: 1200,
				thumbHeight: 630
			}
		})

		expect(urlInfo).toMatchObject({
			'canonical-url': 'https://example.com/',
			'matched-text': 'https://example.com/path',
			title: 'Example',
			description: 'Example description',
			jpegThumbnail: thumbData,
			highQualityThumbnail: {
				directPath: '/o1/v/t62.7118-24/link-preview',
				fileSha256: Buffer.from('thumb-hash'),
				fileEncSha256: Buffer.from('enc-thumb-hash'),
				jpegThumbnail: thumbData,
				mediaKey,
				mediaKeyTimestamp: 1_692_895_570,
				mimetype: 'image/jpeg',
				width: 1200,
				height: 630
			}
		})
	})

	it('returns undefined for incomplete responses', () => {
		expect(linkPreviewResponseToUrlInfo('https://example.com', { url: 'https://example.com' })).toBeUndefined()
		expect(linkPreviewResponseToUrlInfo('https://example.com', { title: 'Example' })).toBeUndefined()
	})
})
