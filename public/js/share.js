/**
 * The shareable map image.
 *
 * The old version drew its flags from a 74 KB blob of base64 PNGs embedded in
 * the page — half the document. Every one of those 199 images was corrupt:
 * invalid chunk CRCs throughout, ten with base64 that was not even a valid
 * length, and only 23 distinct images between 199 countries, one of them reused
 * for 118 of them. None of them loaded in any browser, and because the failure
 * path resolved to null, the share image had been rendering with no flags at
 * all, silently, for a year.
 *
 * flagcdn serves the same flags the picker already uses, with permissive CORS
 * headers, so the canvas stays untainted and `toBlob` works. The blob is gone.
 */

const FLAG_HEIGHT = 44;
const PADDING = 22;

function loadFlag(code) {
  return new Promise((resolve) => {
    const img = new Image();
    // Without this the canvas is tainted and toBlob throws a security error.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://flagcdn.com/w80/${code.toLowerCase()}.png`;
  });
}

/**
 * Compose the map with a caption strip.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.mapCanvas
 * @param {string[]} options.passports
 * @param {object} options.meta
 * @param {string} [options.caption]
 * @returns {Promise<Blob|null>}
 */
export async function renderShareImage({ mapCanvas, passports, meta, caption }) {
  const flags = await Promise.all(passports.map(loadFlag));

  const canvas = document.createElement('canvas');
  canvas.width = mapCanvas.width;
  canvas.height = mapCanvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#f0f2f5';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(mapCanvas, 0, 0);

  const scale = canvas.width / (mapCanvas.clientWidth || canvas.width);
  const flagH = FLAG_HEIGHT * scale;
  const pad = PADDING * scale;
  const gap = 8 * scale;

  const drawable = flags.filter(Boolean);
  const widths = drawable.map((img) => (img.naturalWidth / img.naturalHeight) * flagH);
  const stripWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, drawable.length - 1);

  const text = caption ?? 'passportpicker.com';
  ctx.font = `${Math.round(15 * scale)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textWidth = ctx.measureText(text).width;

  const boxWidth = Math.max(stripWidth, textWidth) + pad * 2;
  const boxHeight = flagH + pad * 2 + 22 * scale;
  const boxX = pad;
  const boxY = canvas.height - boxHeight - pad;

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(17,24,39,0.10)';
  ctx.lineWidth = scale;
  const radius = 12 * scale;
  ctx.beginPath();
  ctx.roundRect?.(boxX, boxY, boxWidth, boxHeight, radius);
  if (!ctx.roundRect) ctx.rect(boxX, boxY, boxWidth, boxHeight);
  ctx.fill();
  ctx.stroke();

  let x = boxX + pad;
  drawable.forEach((img, i) => {
    const w = widths[i];
    ctx.drawImage(img, x, boxY + pad, w, flagH);
    ctx.strokeStyle = 'rgba(17,24,39,0.18)';
    ctx.strokeRect(x, boxY + pad, w, flagH);
    x += w + gap;
  });

  ctx.fillStyle = '#374151';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, boxX + pad, boxY + boxHeight - pad * 0.7);

  // Report which flags could not be fetched rather than silently dropping them,
  // which is precisely how the previous bug stayed hidden.
  const missing = passports.filter((_, i) => !flags[i]);
  if (missing.length) console.warn('[share] flags unavailable:', missing.join(', '));

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Offer the image: the system share sheet where there is one, a download
 * otherwise.
 * @returns {Promise<'shared'|'downloaded'|'failed'>}
 */
export async function offerShareImage(blob, { filename = 'passport-picker.png', title = 'Passport Picker' } = {}) {
  if (!blob) return 'failed';

  const file = new File([blob], filename, { type: 'image/png' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (error) {
      // A cancelled share sheet is not a failure worth falling back from.
      if (error?.name === 'AbortError') return 'shared';
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
