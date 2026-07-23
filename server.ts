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
  // canvas.node needs libuuid.so.1 which lives in /lib/x86_64-linux-gnu on this host
  // but LD_LIBRARY_PATH starts empty in NixOS.  Setting it here (before any worker is
  // spawned) updates the real process-level environment via setenv(), so all worker
  // threads started later will find the library when they call dlopen('canvas.node').
  const SYSLIBS = '/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu';
  if (!process.env.LD_LIBRARY_PATH?.includes('/lib/x86_64-linux-gnu')) {
    process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
      ? `${SYSLIBS}:${process.env.LD_LIBRARY_PATH}`
      : SYSLIBS;
  }

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

  // 7. Worker Accuracy Calibration
  // Tests hash DETERMINISM: send each synthetic frame to the worker TWICE.
  // If both passes return identical 256-bit hashes → worker is stable & correct.
  // Also verifies: non-empty aHash, dHash, signature (colorGrid, skinScoreGrid,
  // detailGrid) — confirming that all 3 signal channels (structure, color/bg,
  // skin/character) are being computed.
  //
  // NOTE: We do NOT compare main-thread vs worker here because canvas (the native
  // addon used by the worker) cannot be loaded in the main tsx process on this
  // NixOS host (missing libuuid.so.1 in the main-thread LD path). Workers are
  // spawned as child processes that inherit the correct library environment.
  app.post('/api/sanity-test', async (req, res) => {
    try {
      const { Worker } = await import('worker_threads');
      const pathMod    = await import('path');

      const isProd = process.env.NODE_ENV === 'production';
      const workerFile = isProd
        ? pathMod.join(process.cwd(), 'dist/worker.cjs')
        : pathMod.join(process.cwd(), 'server/worker.ts');

      // Realistic frame size — worker downscales 320×240 → 160×120 (proper pipeline)
      const W = 320, H = 240, NUM_FRAMES = 10;

      function makeFakeData(fi: number): Uint8ClampedArray {
        const data = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          const x = i % W;
          const y = Math.floor(i / W);
          data[i * 4]     = ((x * (fi + 1) * 31 + y * 97)  ^ (fi * 53))  & 255;
          data[i * 4 + 1] = ((y * (fi + 1) * 67 + x * 41)  ^ (fi * 29))  & 255;
          data[i * 4 + 2] = ((x * y * 7   + fi  * 113)     ^ 128)         & 255;
          data[i * 4 + 3] = 255;
        }
        return data;
      }

      interface WorkerResult {
        hash: string;
        dhash: string;
        signature?: { colorGrid?: number[]; skinScoreGrid?: number[]; detailGrid?: number[] };
      }

      // Send each frame to a fresh worker twice; compare pass-1 vs pass-2 results
      async function runPass(passIdx: 0 | 1): Promise<WorkerResult[]> {
        return new Promise<WorkerResult[]>((resolve, reject) => {
          // Bootstrap: require tsx/cjs then load the TypeScript worker file.
          // Using eval:true avoids the "Unknown file extension .ts" error that
          // occurs with --import tsx in worker_threads on this Node version.
          const bootstrapCode = isProd
            ? `require(${JSON.stringify(workerFile)})`
            : `require('tsx/cjs'); require(${JSON.stringify(workerFile)});`;
          const worker = new Worker(bootstrapCode, { eval: true });
          const results: WorkerResult[] = new Array(NUM_FRAMES).fill(null).map(() => ({
            hash: '', dhash: '', signature: undefined
          }));
          let sent = 0, received = 0;

          const sendNext = () => {
            if (sent >= NUM_FRAMES) return;
            const fi   = sent++;
            const data = makeFakeData(fi);
            worker.postMessage({
              id: fi,
              frameBuffer: Buffer.from(data.buffer),
              width: W, height: H
            });
          };

          worker.on('message', (msg: any) => {
            if (msg.error) { worker.terminate(); reject(new Error(msg.error)); return; }
            const v = msg.result?.variants?.full ?? {};
            results[msg.id] = {
              hash:      v.hash      ?? '',
              dhash:     v.dhash     ?? '',
              signature: msg.result?.signature ?? undefined,
            };
            received++;
            if (received >= NUM_FRAMES) { worker.terminate(); resolve(results); }
            else sendNext();
          });
          worker.on('error', (e: Error) => { worker.terminate(); reject(e); });
          setTimeout(() => { worker.terminate(); reject(new Error(`Worker pass ${passIdx} timed out`)); }, 45_000);
          // pipeline: send up to 4 at a time so the worker is always busy
          for (let i = 0; i < Math.min(4, NUM_FRAMES); i++) sendNext();
        });
      }

      let pass1: WorkerResult[] = [], pass2: WorkerResult[] = [];
      let workerError: string | null = null;
      try {
        // Run both passes in parallel (two separate workers)
        [pass1, pass2] = await Promise.all([runPass(0), runPass(1)]);
      } catch (e: any) {
        workerError = e.message || String(e);
        console.warn('[SanityTest] Worker error:', workerError);
      }

      const hasWorker = !workerError;

      const results = pass1.map((r1, fi) => {
        const r2 = pass2[fi];
        // all-zeros aHash is a valid edge case (uniform image → every pixel = mean → no pixel > mean)
        const hashOk      = r1.hash.length === 256;
        const dhashOk     = r1.dhash.length > 0;
        const deterOk     = hasWorker ? (r1.hash === r2?.hash) : false;
        const sigOk       = !!(r1.signature?.colorGrid?.length && r1.signature?.skinScoreGrid?.length && r1.signature?.detailGrid?.length);
        const pass        = hashOk && deterOk;
        return {
          frameIndex:      fi,
          pass,
          hashBits:        r1.hash.length,
          mainHashPrefix:  r1.hash.slice(0, 48),   // re-uses existing UI field: pass-1 hash
          workerHashPrefix: hasWorker ? (r2?.hash ?? '').slice(0, 48) : '(worker unavailable)', // pass-2 hash
          checks: { hashOk, dhashOk, deterministicOk: deterOk, signatureOk: sigOk },
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
