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
        minConsecutiveFrames
      } = req.body as {
        movieJobId: string;
        shortJobId: string;
        minSimilarity?: number;
        minConsecutiveFrames?: number;
      };

      if (!movieJobId || !shortJobId) {
        return res.status(400).json({ error: 'movieJobId and shortJobId are required' });
      }

      // Validate optional params
      const resolvedMinSim    = (typeof minSimilarity    === 'number' && minSimilarity    >= 40 && minSimilarity    <= 99) ? minSimilarity    : 82;
      const resolvedMinFrames = (typeof minConsecutiveFrames === 'number' && minConsecutiveFrames >= 3 && minConsecutiveFrames <= 200) ? minConsecutiveFrames : 9;

      const movieResultPath = path.join(uploadDir, `${movieJobId}_result.json`);
      const shortResultPath = path.join(uploadDir, `${shortJobId}_result.json`);

      if (!fs.existsSync(movieResultPath)) {
        return res.status(404).json({ error: `Movie result not found for job ${movieJobId}. Re-process the reference video.` });
      }
      if (!fs.existsSync(shortResultPath)) {
        return res.status(404).json({ error: `Short result not found for job ${shortJobId}. Re-process the target clip.` });
      }

      console.log(`[Match] Loading fingerprints: movie=${movieJobId} short=${shortJobId}`);

      const movieFps: FPData[] = JSON.parse(fs.readFileSync(movieResultPath, 'utf-8'));
      const shortFps: FPData[] = JSON.parse(fs.readFileSync(shortResultPath, 'utf-8'));

      console.log(`[Match] Loaded ${movieFps.length} movie frames, ${shortFps.length} short frames. Running matching…`);

      const segments = await groundMatchedSegments(shortFps, movieFps, resolvedMinSim, resolvedMinFrames);

      console.log(`[Match] Done: ${segments.length} segments found.`);
      res.json({ segments, movieFrames: movieFps.length, shortFrames: shortFps.length });
    } catch (err: any) {
      console.error('[Match] Error:', err);
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
