import { extractFingerprints } from './pipeline';
import * as fs from 'fs';

const videoPath = process.argv[2] || '../test_2m.mp4';
const outPath = process.argv[3] || 'server_fps_2m.json';

console.log(`Starting extraction on ${videoPath}...`);

extractFingerprints(videoPath, (decoded, processed) => {
  if (processed % 100 === 0 || processed === decoded) {
    console.log(`Progress: decoded ${decoded} frames, processed ${processed} frames`);
  }
}).then((results) => {
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Saved ${results.length} fingerprints to ${outPath}`);
  process.exit(0);
}).catch((err) => {
  console.error(`Extraction failed:`, err);
  process.exit(1);
});

