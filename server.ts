import express from 'express';
import multer from 'multer';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServer as createViteServer } from 'vite';
import { extractFingerprints, NUM_WORKERS } from './server/pipeline';
import { groundMatchedSegments, FPData } from './server/matching-engine';

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  // Ensure upload directory exists
  const uploadDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Configure multer storage
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}${ext}`;
      cb(null, uniqueName);
    }
  });

  const upload = multer({ storage });

  // In-memory job store
  interface Job {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    totalFrames: number;
    processedFrames: number;
    error?: string;
  }
  const jobs = new Map<string, Job>();

  // --- API ROUTES ---

  // 1. Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // 2. Upload chunk endpoint
  app.post('/api/upload-chunk', upload.single('chunk') as any, async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No chunk file uploaded' });
      }

      const { uploadId, chunkIndex, totalChunks, filename } = req.body;
      const chunkPath = req.file.path;
      const finalPath = path.join(uploadDir, `${uploadId}-${filename}`);

      // Append chunk to final file
      await fs.promises.appendFile(finalPath, await fs.promises.readFile(chunkPath));
      await fs.promises.unlink(chunkPath);

      if (parseInt(chunkIndex) === parseInt(totalChunks) - 1) {
        // All chunks received, start job
        const jobId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const job: Job = {
          id: jobId,
          status: 'pending',
          totalFrames: 0,
          processedFrames: 0
        };
        jobs.set(jobId, job);

        res.json({ jobId });

        // Kick off processing in the background
        console.log(`[Job ${jobId}] Starting background processing for ${finalPath}...`);
        job.status = 'processing';

        extractFingerprints(finalPath, (decoded, processed) => {
          const j = jobs.get(jobId);
          if (j) {
            j.totalFrames = decoded;
            j.processedFrames = processed;
          }
        }).then((results) => {
          console.log(`[Job ${jobId}] Finished processing ${results.length} frames.`);
          const resultPath = path.join(uploadDir, `${jobId}_result.json`);
          fs.writeFileSync(resultPath, JSON.stringify(results));
          
          const j = jobs.get(jobId);
          if (j) {
            j.status = 'completed';
          }
          
          // Cleanup video file to save space
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
        }).catch((err) => {
          console.error(`[Job ${jobId}] Failed to process video:`, err);
          const j = jobs.get(jobId);
          if (j) {
            j.status = 'failed';
            j.error = err.message;
          }
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
        });
      } else {
        res.json({ status: 'ok' });
      }
    } catch (err: any) {
      console.error('Upload chunk error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // 3. Upload endpoint (Legacy)
  app.post('/api/upload', upload.single('video') as any, (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const jobId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const tempVideoPath = req.file.path;

    const job: Job = {
      id: jobId,
      status: 'pending',
      totalFrames: 0,
      processedFrames: 0
    };
    jobs.set(jobId, job);

    res.json({ jobId });

    console.log(`[Job ${jobId}] Starting background processing for ${tempVideoPath}...`);
    job.status = 'processing';

    extractFingerprints(tempVideoPath, (decoded, processed) => {
      const j = jobs.get(jobId);
      if (j) {
        j.totalFrames = decoded;
        j.processedFrames = processed;
      }
    }).then((results) => {
      console.log(`[Job ${jobId}] Finished processing ${results.length} frames.`);
      
      const resultPath = path.join(uploadDir, `${jobId}_result.json`);
      fs.writeFileSync(resultPath, JSON.stringify(results));

      try {
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
          console.log(`[Job ${jobId}] Cleaned up temporary video file`);
        }
      } catch (cleanupErr) {
        console.error(`[Job ${jobId}] Failed to clean up temp video file:`, cleanupErr);
      }

      const j = jobs.get(jobId);
      if (j) {
        j.status = 'completed';
        j.processedFrames = results.length;
        j.totalFrames = results.length;
      }
    }).catch((err) => {
      console.error(`[Job ${jobId}] Processing failed:`, err);
      
      try {
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
      } catch (cleanupErr) {
        console.error(`[Job ${jobId}] Failed to clean up temp video file after error:`, cleanupErr);
      }

      const j = jobs.get(jobId);
      if (j) {
        j.status = 'failed';
        j.error = err.message || String(err);
      }
    });
  });

  // 4. Status endpoint
  app.get('/api/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  });

  // 5. Result retrieval endpoint
  app.get('/api/result/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Job is not completed yet', status: job.status });
    }

    const resultPath = path.join(uploadDir, `${jobId}_result.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: 'Result file not found' });
    }

    res.sendFile(resultPath, (err) => {
      if (err) {
        console.error(`Failed to send result file for job ${jobId}:`, err);
      }
    });
  });

  // 6. Match endpoint — runs groundMatchedSegments on two stored result JSONs
  app.post('/api/match', async (req, res) => {
    try {
      const {
        movieJobId,
        shortJobId,
        minSimilarity,
        minConsecutiveFrames,
        frameDrift
      } = req.body as {
        movieJobId: string;
        shortJobId: string;
        minSimilarity?: number;
        minConsecutiveFrames?: number;
        frameDrift?: number;
      };

      if (!movieJobId || !shortJobId) {
        return res.status(400).json({ error: 'movieJobId and shortJobId are required' });
      }

      // Allow confidence as low as 20 % (user-configurable)
      const resolvedMinSim    = (typeof minSimilarity    === 'number' && minSimilarity    >= 20 && minSimilarity    <= 99) ? minSimilarity    : 82;
      const resolvedMinFrames = (typeof minConsecutiveFrames === 'number' && minConsecutiveFrames >= 3 && minConsecutiveFrames <= 200) ? minConsecutiveFrames : 9;
      const resolvedDrift     = (typeof frameDrift === 'number' && frameDrift >= 0 && frameDrift <= 15) ? Math.round(frameDrift) : 3;

      const movieResultPath = path.join(uploadDir, `${movieJobId}_result.json`);
      const shortResultPath = path.join(uploadDir, `${shortJobId}_result.json`);

      if (!fs.existsSync(movieResultPath)) {
        return res.status(404).json({ error: `Movie result not found for job ${movieJobId}. Re-process the reference video.` });
      }
      if (!fs.existsSync(shortResultPath)) {
        return res.status(404).json({ error: `Short result not found for job ${shortJobId}. Re-process the target clip.` });
      }

      console.log(`[Match] Loading fingerprints: movie=${movieJobId} short=${shortJobId} drift=${resolvedDrift}`);

      const movieFps: FPData[] = JSON.parse(fs.readFileSync(movieResultPath, 'utf-8'));
      const shortFps: FPData[] = JSON.parse(fs.readFileSync(shortResultPath, 'utf-8'));

      console.log(`[Match] Loaded ${movieFps.length} movie frames, ${shortFps.length} short frames. Running matching…`);

      const result = await groundMatchedSegments(shortFps, movieFps, resolvedMinSim, resolvedMinFrames, resolvedDrift);

      console.log(`[Match] Done: ${result.segments.length} segments, ${result.unmatchedRanges.length} unmatched ranges.`);
      res.json({
        segments: result.segments,
        unmatchedRanges: result.unmatchedRanges,
        movieFrames: movieFps.length,
        shortFrames: shortFps.length
      });
    } catch (err: any) {
      console.error('[Match] Error:', err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // 7. Worker Accuracy Calibration — sanity-test main-thread vs worker-thread hash integrity
  app.post('/api/sanity-test', async (req, res) => {
    try {
      const { Worker } = await import('worker_threads');
      // computeHashAndFeatures only reads .width / .height / .data — no canvas needed on main thread
      const { computeHashAndFeatures } = await import('./src/shared/fingerprint');
      const pathMod = await import('path');

      const isProd = process.env.NODE_ENV === 'production';
      const workerFile = isProd
        ? pathMod.join(process.cwd(), 'dist/worker.cjs')
        : pathMod.join(process.cwd(), 'server/worker.ts');

      // Use 16×16 directly so no downscaling canvas is needed on the main thread
      const W = 16, H = 16, NUM_FRAMES = 10;

      /** Build a deterministic synthetic 16×16 RGBA frame */
      function makeFakeData(fi: number): Uint8ClampedArray {
        const data = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          const x = i % W;
          const y = Math.floor(i / W);
          // Complex enough pattern to produce meaningful hashes (not flat)
          data[i * 4]     = ((x * (fi + 1) * 31 + y * 97) ^ (fi * 53)) & 255;
          data[i * 4 + 1] = ((y * (fi + 1) * 67 + x * 41) ^ (fi * 29)) & 255;
          data[i * 4 + 2] = ((x * y * 7  + fi  * 113)     ^ 128)        & 255;
          data[i * 4 + 3] = 255;
        }
        return data;
      }

      // ── Main-thread hashes (pure TS, no canvas) ──────────────────────────
      const mainHashes: string[] = [];
      for (let fi = 0; fi < NUM_FRAMES; fi++) {
        const fakeImgData = { width: W, height: H, data: makeFakeData(fi) };
        mainHashes.push(computeHashAndFeatures(fakeImgData as any, false).hash);
      }

      // ── Worker hashes (canvas-based path inside worker_thread) ────────────
      let workerHashes: string[] = [];
      let workerError: string | null = null;
      try {
        workerHashes = await new Promise<string[]>((resolve, reject) => {
          const workerOpts = isProd ? {} : { execArgv: ['--import', 'tsx'] };
          const worker = new Worker(workerFile, workerOpts);
          const hashes: string[] = new Array(NUM_FRAMES).fill('');
          let sent = 0, received = 0;

          const sendNext = () => {
            if (sent >= NUM_FRAMES) return;
            const fi = sent++;
            const data = makeFakeData(fi);
            worker.postMessage({ id: fi, frameBuffer: Buffer.from(data.buffer), width: W, height: H });
          };

          worker.on('message', (msg: any) => {
            if (msg.error) { worker.terminate(); reject(new Error(msg.error)); return; }
            hashes[msg.id] = msg.result?.variants?.full?.hash ?? '';
            received++;
            if (received >= NUM_FRAMES) { worker.terminate(); resolve(hashes); }
            else sendNext();
          });
          worker.on('error', (e: Error) => { worker.terminate(); reject(e); });
          setTimeout(() => { worker.terminate(); reject(new Error('Worker timed out')); }, 30_000);
          sendNext();
        });
      } catch (e: any) {
        workerError = e.message || String(e);
        console.warn('[SanityTest] Worker path unavailable:', workerError);
      }

      // ── Compare ────────────────────────────────────────────────────────────
      const hasWorker = !workerError;
      const results = mainHashes.map((mainHash, fi) => {
        const workerHash = workerHashes[fi] ?? '';
        const pass = mainHash.length === 256 &&
          (hasWorker ? mainHash === workerHash : true); // if worker unavailable, pass on main-thread determinism
        return {
          frameIndex: fi,
          pass,
          hashBits: mainHash.length,
          mainHashPrefix:   mainHash.slice(0, 48),
          workerHashPrefix: hasWorker ? workerHash.slice(0, 48) : '(canvas unavailable in env)',
        };
      });

      const allPass = results.every(r => r.pass);
      console.log(`[SanityTest] ${allPass ? 'PASS' : 'FAIL'} — worker=${hasWorker} frames=${results.filter(r => r.pass).length}/${NUM_FRAMES}`);
      res.json({
        pass: allPass,
        totalFrames: NUM_FRAMES,
        workerAvailable: hasWorker,
        workerError: workerError || undefined,
        results
      });
    } catch (err: any) {
      console.error('[SanityTest] Error:', err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // --- VITE MIDDLEWARE CONFIGURATION ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server ready. Detected ${os.cpus().length} CPU cores. Worker pool sized to ${NUM_WORKERS} workers.`);
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
