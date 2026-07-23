import { spawn, execSync } from 'child_process';
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FrameSignature } from '../src/shared/fingerprint';

const getDirname = () => {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  try {
    const metaUrl = typeof import.meta !== 'undefined' && import.meta.url ? import.meta.url : '';
    if (metaUrl) {
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch (e) {
    // ignore
  }
  return process.cwd();
};

const currentDirname = getDirname();

export const NUM_WORKERS = Math.max(1, Math.min(os.cpus().length, 128));

export interface FingerprintResult {
  frameIndex: number;
  timestamp: number;
  variants: Record<string, { hash: string }>;
  signature?: FrameSignature;
}

export function extractFingerprints(
  videoPath: string,
  onProgress?: (decoded: number, processed: number) => void
): Promise<FingerprintResult[]> {
  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let idleWorkers: Worker[] = [];
    const activeTasks = new Map<number, { resolve: Function; reject: Function }>();
    let taskIdCounter = 0;
    let decoded = 0;
    let processed = 0;
    // Each entry: { variants, signature? }
    const fingerprints = new Map<number, { variants: any; signature?: FrameSignature }>();
    const taskQueue: { id: number; frameBuffer: Buffer; width: number; height: number; frameIndex: number }[] = [];
    let ffmpegProcess: any = null;
    let isFinished = false;

    const cleanupWorkers = () => {
      for (const w of workers) {
        w.terminate().catch(() => {});
      }
    };

    function assignTasks() {
      while (idleWorkers.length > 0 && taskQueue.length > 0) {
        const worker = idleWorkers.pop()!;
        const task = taskQueue.shift()!;
        worker.postMessage({
          id: task.id,
          frameBuffer: task.frameBuffer,
          width: task.width,
          height: task.height
        });
      }
      if (taskQueue.length < 50 && ffmpegProcess && ffmpegProcess.stdout.isPaused()) {
        ffmpegProcess.stdout.resume();
      }
    }

    try {
      const isProd = process.env.NODE_ENV === 'production';
      const workerPath = isProd 
        ? path.join(currentDirname, 'worker.cjs')
        : path.join(currentDirname, 'worker.ts');
      
      for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(workerPath, isProd ? {} : {
          execArgv: ['-r', 'tsx/cjs']
        });
        
        worker.on('message', (msg) => {
          idleWorkers.push(worker);
          const task = activeTasks.get(msg.id);
          if (task) {
            activeTasks.delete(msg.id);
            if (msg.error) {
              task.reject(new Error(msg.error));
            } else {
              processed++;
              task.resolve(msg.result);
              if (onProgress) {
                onProgress(decoded, processed);
              }
            }
          }
          assignTasks();
        });

        worker.on('error', (err) => {
          console.error(`Worker error:`, err);
          const index = workers.indexOf(worker);
          if (index !== -1) workers.splice(index, 1);
          const idleIndex = idleWorkers.indexOf(worker);
          if (idleIndex !== -1) idleWorkers.splice(idleIndex, 1);
          assignTasks();
        });

        workers.push(worker);
        idleWorkers.push(worker);
      }

      // Query video dimensions via ffprobe
      let width = 0;
      let height = 0;
      try {
        const ffprobeOutput = execSync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`
        ).toString().trim();
        const [w, h] = ffprobeOutput.split('x').map(Number);
        if (!w || !h || isNaN(w) || isNaN(h)) {
          throw new Error(`Failed to parse resolution: ${ffprobeOutput}`);
        }
        width = w;
        height = h;
      } catch (err: any) {
        console.error(`ffprobe error on ${videoPath}:`, err);
        throw new Error(`Could not determine video dimensions: ${err.message}`);
      }

      console.log(`Pipeline starting for ${videoPath} (${width}x${height})`);

      ffmpegProcess = spawn('ffmpeg', [
        '-i', videoPath,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-r', '25',
        '-'
      ]);

      let buffer = Buffer.alloc(0);
      const frameSize = width * height * 4;

      ffmpegProcess.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= frameSize) {
          const frameBuffer = buffer.slice(0, frameSize);
          buffer = buffer.slice(frameSize);

          decoded++;
          const id = ++taskIdCounter;
          const currentFrame = decoded;

          const p = new Promise<{ variants: any; signature?: FrameSignature }>((res, rej) => {
            activeTasks.set(id, { resolve: res, reject: rej });
          });

          p.then((result) => {
            fingerprints.set(currentFrame, result);
          }).catch((err) => {
            console.error(`Error processing frame ${currentFrame}:`, err);
            processed++;
            if (onProgress) {
              onProgress(decoded, processed);
            }
          });

          taskQueue.push({
            id,
            frameBuffer,
            width,
            height,
            frameIndex: currentFrame
          });

          if (taskQueue.length >= 100 && !ffmpegProcess.stdout.isPaused()) {
            ffmpegProcess.stdout.pause();
          }

          assignTasks();
        }
      });

      ffmpegProcess.stderr.on('data', (_data: Buffer) => {
        // suppress ffmpeg stderr
      });

      ffmpegProcess.on('error', (err: any) => {
        console.error('ffmpeg process error:', err);
        cleanupWorkers();
        reject(err);
      });

      ffmpegProcess.on('close', (_code: any) => {
        const checkInterval = setInterval(() => {
          if (processed >= decoded) {
            clearInterval(checkInterval);
            if (!isFinished) {
              isFinished = true;
              cleanupWorkers();

              const sortedFp: FingerprintResult[] = [];
              for (let i = 1; i <= decoded; i++) {
                const fp = fingerprints.get(i);
                if (fp) {
                  sortedFp.push({
                    frameIndex: i,
                    timestamp: (i - 1) / 25,
                    variants: fp.variants,
                    signature: fp.signature
                  });
                }
              }
              resolve(sortedFp);
            }
          }
        }, 100);
      });

    } catch (err) {
      cleanupWorkers();
      reject(err);
    }
  });
}
