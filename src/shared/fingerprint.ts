export interface FrameFingerprint {
  frameIndex: number;
  timestamp: number;
  variants: Record<string, { hash: string }>;
}

export interface CropRect {
  name: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function getCropRects(width: number, height: number): CropRect[] {
  const rects: CropRect[] = [];
  
  // 1. Full variant
  rects.push({ name: 'full', sx: 0, sy: 0, sw: width, sh: height });
  
  // 2. 9:16 variants (5 crops)
  let cropWidth = Math.round(height * (9 / 16));
  if (cropWidth % 2 !== 0) cropWidth--; // Ensure even crop width
  
  if (cropWidth <= width) {
    const step = (width - cropWidth) / 4;
    for (let i = 0; i < 5; i++) {
      let sx = Math.round(i * step);
      if (sx % 2 !== 0) sx--; // Ensure even step offset
      rects.push({
        name: `crop_9_16_${i}`,
        sx,
        sy: 0,
        sw: cropWidth,
        sh: height
      });
    }
  } else {
    // Fallback if width is already less than cropWidth
    for (let i = 0; i < 5; i++) {
      rects.push({
        name: `crop_9_16_${i}`,
        sx: 0,
        sy: 0,
        sw: width,
        sh: height
      });
    }
  }

  // 3. Zoom crops helper
  const addZoomCrops = (zoom: number, namePrefix: string) => {
    let sw = Math.min(width, Math.max(1, Math.round(width / zoom)));
    let sh = Math.min(height, Math.max(1, Math.round(height / zoom)));
    if (sw % 2 !== 0) sw--;
    if (sh % 2 !== 0) sh--;
    
    // Center-weighted vertical offset
    let sy = Math.min(height - sh, Math.max(0, Math.round((height - sh) / 2)));
    if (sy % 2 !== 0) sy--;
    
    // Center position
    let sxCenter = Math.min(width - sw, Math.max(0, Math.round((width - sw) / 2)));
    if (sxCenter % 2 !== 0) sxCenter--;
    
    rects.push({
      name: `${namePrefix}_center`,
      sx: sxCenter,
      sy,
      sw,
      sh
    });
    
    // Left position
    rects.push({
      name: `${namePrefix}_left`,
      sx: 0,
      sy,
      sw,
      sh
    });
    
    // Right position
    let sxRight = Math.min(width - sw, Math.max(0, width - sw));
    if (sxRight % 2 !== 0) sxRight--;
    rects.push({
      name: `${namePrefix}_right`,
      sx: sxRight,
      sy,
      sw,
      sh
    });
  };

  // 1.25x zoom (Center, Left, Right)
  addZoomCrops(1.25, 'zoom_1_25');

  // 1.5x zoom (Center, Left, Right)
  addZoomCrops(1.5, 'zoom_1_5');

  // 2.0x zoom (Center only)
  let sw2 = Math.min(width, Math.max(1, Math.round(width / 2.0)));
  let sh2 = Math.min(height, Math.max(1, Math.round(height / 2.0)));
  if (sw2 % 2 !== 0) sw2--;
  if (sh2 % 2 !== 0) sh2--;
  
  let sx2 = Math.min(width - sw2, Math.max(0, Math.round((width - sw2) / 2)));
  if (sx2 % 2 !== 0) sx2--;
  
  let sy2 = Math.min(height - sh2, Math.max(0, Math.round((height - sh2) / 2)));
  if (sy2 % 2 !== 0) sy2--;
  
  rects.push({
    name: 'zoom_2_0_center',
    sx: sx2,
    sy: sy2,
    sw: sw2,
    sh: sh2
  });
  
  return rects;
}

export function processSubtitles(imageData: ImageData, forceFullPass: boolean): boolean {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);
  let hasSubtitles = false;
  let subtitlePixelCount = 0;
  
  // Subtitles are generally in the bottom 25% of the frame
  const startY = Math.floor(height * 0.75);
  
  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      
      // White and Yellow subtitle detection
      // Yellow: High R & G, lower B
      // White: High R & G & B
      if (r > 180 && g > 180) {
        mask[y * width + x] = 1;
        hasSubtitles = true;
        subtitlePixelCount++;
      }
    }
  }
  
  const bottomArea = width * (height - startY);
  if (subtitlePixelCount < 8 || subtitlePixelCount > bottomArea * 0.25) {
    hasSubtitles = false;
  }
  
  if (!hasSubtitles && !forceFullPass) {
    return false;
  }
  
  // Dilation (radius 2)
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              dilated[ny * width + nx] = 1;
            }
          }
        }
      }
    }
  }
  
  // Vertical Inpainting: replace with nearest non-dilated pixel above
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x] === 1) {
        let sourceY = -1;
        for (let sy = y - 1; sy >= 0; sy--) {
          if (dilated[sy * width + x] === 0) {
            sourceY = sy;
            break;
          }
        }
        
        if (sourceY !== -1) {
          const targetIdx = (y * width + x) * 4;
          const sourceIdx = (sourceY * width + x) * 4;
          data[targetIdx] = data[sourceIdx];
          data[targetIdx + 1] = data[sourceIdx + 1];
          data[targetIdx + 2] = data[sourceIdx + 2];
          data[targetIdx + 3] = data[sourceIdx + 3];
        }
      }
    }
  }
  
  return true;
}

export function computeHashAndFeatures(imageData: ImageData): { hash: string } {
  const { width, height, data } = imageData;
  let totalGray = 0;
  const grays = new Float32Array(width * height);
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    
    // Grayscale conversion
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    grays[i] = gray;
    totalGray += gray;
  }
  
  const avgGray = totalGray / (width * height);
  
  // Calculate variance to detect low-entropy/flat/uniform solid-color frames
  let sumSqDiff = 0;
  for (let i = 0; i < width * height; i++) {
    const diff = grays[i] - avgGray;
    sumSqDiff += diff * diff;
  }
  const variance = sumSqDiff / (width * height);
  
  let hash = '';
  if (variance < 1.0) {
    // Completely uniform or low-entropy frame - return deterministic flat hash
    hash = '0'.repeat(width * height);
  } else {
    // Apply a 3-pass 3x3 box blur to filter out sub-pixel high-frequency rendering and scaling noise
    let currentGrays = grays;
    for (let pass = 0; pass < 3; pass++) {
      const smoothedGrays = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ny = y + dy;
              const nx = x + dx;
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                sum += currentGrays[ny * width + nx];
                count++;
              }
            }
          }
          smoothedGrays[y * width + x] = sum / count;
        }
      }
      currentGrays = smoothedGrays;
    }
    
    for (let i = 0; i < width * height; i++) {
      hash += currentGrays[i] >= avgGray ? '1' : '0';
    }
  }
  
  return { hash };
}

export function computeFingerprint(
  ctx: any,
  width: number,
  height: number,
  frameIndex: number,
  timestamp: number
): FrameFingerprint {
  const rects = getCropRects(width, height);
  const variants: Record<string, { hash: string }> = {};
  
  // Downscale full frame to a standard intermediate size (e.g., standard height 120)
  const H_down = 120;
  const W_down = Math.round(width * (H_down / height));
  
  const fullDownCanvas = new OffscreenCanvas(W_down, H_down);
  const fullDownCtx = fullDownCanvas.getContext('2d', { willReadFrequently: true });
  if (!fullDownCtx) throw new Error('Failed to get 2d context for fullDownCanvas');
  fullDownCtx.imageSmoothingEnabled = true;
  fullDownCtx.imageSmoothingQuality = 'high';
  
  fullDownCtx.fillStyle = '#000000';
  fullDownCtx.fillRect(0, 0, W_down, H_down);
  fullDownCtx.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, W_down, H_down);
  
  const imgData = fullDownCtx.getImageData(0, 0, W_down, H_down);
  const changed = processSubtitles(imgData, false);
  console.log(`[FINGERPRINT_WORKER] width=${width} height=${height} W_down=${W_down} H_down=${H_down} changed=${changed}`);
  if (changed) {
    fullDownCtx.putImageData(imgData, 0, 0);
  }
  
  const finalCanvas = new OffscreenCanvas(16, 16);
  const finalCtx = finalCanvas.getContext('2d', { willReadFrequently: true });
  if (!finalCtx) throw new Error('Failed to get 2d context for final canvas');
  finalCtx.imageSmoothingEnabled = true;
  finalCtx.imageSmoothingQuality = 'high';
  
  const scaleX = W_down / width;
  const scaleY = H_down / height;
  
  for (const rect of rects) {
    finalCtx.fillStyle = '#000000';
    finalCtx.fillRect(0, 0, 16, 16);
    if (!changed) {
      finalCtx.drawImage(ctx.canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, 16, 16);
    } else {
      const sx = rect.sx * scaleX;
      const sy = rect.sy * scaleY;
      const sw = rect.sw * scaleX;
      const sh = rect.sh * scaleY;
      finalCtx.drawImage(fullDownCanvas, sx, sy, sw, sh, 0, 0, 16, 16);
    }
    
    const finalImgData = finalCtx.getImageData(0, 0, 16, 16);
    const features = computeHashAndFeatures(finalImgData);
    variants[rect.name] = features;
  }
  
  return {
    frameIndex,
    timestamp,
    variants
  };
}
