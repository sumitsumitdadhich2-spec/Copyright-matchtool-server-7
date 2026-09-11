import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getScan } from '@/lib/store'
import { renderOutputPath } from '@/lib/render'

export const runtime = 'nodejs'

/** Serve the rendered MP4 with HTTP Range support (seekable preview) and
 *  Content-Disposition so ?download=1 saves the file. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return new Response('Not found', { status: 404 })

  const file = renderOutputPath(id)
  if (!fs.existsSync(file) || scan.renderJob?.status !== 'done') {
    return new Response('Rendered file not found', { status: 404 })
  }

  const url = new URL(req.url)
  const asDownload = url.searchParams.get('download') === '1'
  const baseName = (scan.movieName || 'render').replace(/\.[^.]+$/, '')
  const fileName = `${baseName}-stitched-${scan.renderJob.settings?.resolution || 'export'}.mp4`

  const dispo: Record<string, string> = asDownload
    ? { 'Content-Disposition': `attachment; filename="${fileName.replace(/[^\w.\- ]+/g, '_')}"` }
    : {}

  const stat = fs.statSync(file)
  const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`
  const lastModified = stat.mtime.toUTCString()

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
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      }
      const requestedEnd = m[2] ? Number(m[2]) : undefined
      const maxChunk = 16 * 1024 * 1024
      const end = requestedEnd !== undefined
        ? Math.min(requestedEnd, stat.size - 1)
        : Math.min(start + maxChunk - 1, stat.size - 1)

      const stream = fs.createReadStream(file, { start, end })
      return new Response(toWeb(stream), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/mp4',
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'public, max-age=3600, must-revalidate',
          ...dispo,
        },
      })
    }
  }

  const stream = fs.createReadStream(file)
  return new Response(toWeb(stream), {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'public, max-age=3600, must-revalidate',
      ...dispo,
    },
  })
}

/** BACKPRESSURE-SAFE adapter: Readable.toWeb only pulls the next chunk when the
 *  client is ready. The old hand-rolled version enqueued every 'data' event
 *  immediately, so a slow client buffered the ENTIRE file in server memory —
 *  that was the crash on big downloads. */
function toWeb(stream: fs.ReadStream): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream
}
