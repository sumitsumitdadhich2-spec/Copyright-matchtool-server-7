import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { ensureLocalMedia, ensureLocalPreviewMedia } from '@/lib/media'
import { getSession } from '@/lib/users'

export const runtime = 'nodejs'

/** Serve uploaded videos with HTTP Range support so previews are seekable.
 *  Supports ?preview=1 for instant, lightweight 480p preview streaming.
 *  If the local file is missing it is pulled back from S3 first. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })
  const { id } = await ctx.params
  if (!getScan(id)) await restoreScans(SCANS_DIR)
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) return new Response('Not found', { status: 404 })

  const url = new URL(req.url)
  const isPreview = url.searchParams.get('preview') === '1' || url.searchParams.get('preview') === 'true'
  const kind = url.searchParams.get('kind') === 'short' ? 'short' : 'movie'

  let file: string | null = null
  if (isPreview) {
    file = await ensureLocalPreviewMedia(id, kind)
  }
  if (!file) {
    file = await ensureLocalMedia(id, kind)
  }
  if (!file || !fs.existsSync(/*turbopackIgnore: true*/ file)) return new Response('File not found', { status: 404 })

  const stat = fs.statSync(/*turbopackIgnore: true*/ file)
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`
  const lastModified = stat.mtime.toUTCString()

  // 304 Not Modified validation
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
      },
    })
  }

  const range = req.headers.get('range')

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const start = Number(m[1])
      if (start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${stat.size}`,
            'Accept-Ranges': 'bytes',
          },
        })
      }

      // If client requested an explicit end byte, honor it.
      // For open-ended ranges "bytes=X-", supply a generous 16 MB chunk buffer so
      // HTML5 video players buffer smoothly ahead without stuttering or stalling.
      const requestedEnd = m[2] ? Number(m[2]) : undefined
      const maxChunk = 16 * 1024 * 1024
      const end = requestedEnd !== undefined
        ? Math.min(requestedEnd, stat.size - 1)
        : Math.min(start + maxChunk - 1, stat.size - 1)

      const contentLength = end - start + 1
      const stream = fs.createReadStream(/*turbopackIgnore: true*/ file, { start, end })

      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(contentLength),
          'Content-Type': 'video/mp4',
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'public, max-age=3600, must-revalidate',
        },
      })
    }
  }

  const stream = fs.createReadStream(/*turbopackIgnore: true*/ file)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  })
}
