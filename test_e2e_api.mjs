import fs from 'fs';

async function processVideo(filePath) {
  const buffer = fs.readFileSync(filePath);
  const filename = filePath.split('/').pop();
  const file = new File([buffer], filename, { type: 'video/mp4' });
  const formData = new FormData();
  formData.append('video', file);
  
  const uploadRes = await fetch('http://localhost:8080/api/upload', {
    method: 'POST',
    body: formData,
  });
  
  const { jobId } = await uploadRes.json();
  console.log(`Uploaded ${filePath}, Job ID: ${jobId}`);
  
  while (true) {
    const statusRes = await fetch(`http://localhost:8080/api/status/${jobId}`);
    const status = await statusRes.json();
    console.log(`Job ${jobId} status: ${status.status}, processed: ${status.processedFrames}/${status.totalFrames}`);
    if (status.status === 'completed') {
      break;
    } else if (status.status === 'failed') {
      throw new Error(`Processing failed: ${status.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  const resultRes = await fetch(`http://localhost:8080/api/result/${jobId}`);
  const results = await resultRes.json();
  console.log(`Job ${jobId} finished. Fetched ${results.length} fingerprints.`);
  return results;
}

async function main() {
  console.log("Processing reference video...");
  const refFps = await processVideo('test_real.mp4');
  console.log("Reference processing done.");
  
  // Create a 10s clip for target (already have test_10s.mp4? Let's check or use test_2m.mp4 again but just 10s)
}
main().catch(console.error);
