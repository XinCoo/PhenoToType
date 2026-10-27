/**
 * viewer.js — 图像查看与轮廓叠加渲染
 */
export function drawImageView(canvas, batch, opts) {
  if (!batch?.imageData) return;
  const img = batch.imageData;
  const maxW = canvas.parentElement.clientWidth - 40;
  const maxH = canvas.parentElement.clientHeight - 40;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(batch.image, 0, 0, w, h);

  if (!opts.showMask && !opts.showContour && !opts.showIndex) return;
  const k = w / img.width;

  // 掩膜叠加：逐像素太慢，改为对每个样本画半透明填充
  if (opts.showMask && batch.mask) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#4d9fff';
    for (const s of batch.samples) {
      if (!s.contour) continue;
      ctx.beginPath();
      s.contour.forEach((p, i) => {
        const x = p.x * k, y = p.y * k;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  if (opts.showContour) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#4caf7d';
    batch.samples.forEach((s, i) => {
      if (!s.contour) return;
      ctx.beginPath();
      s.contour.forEach((p, j) => {
        const x = p.x * k, y = p.y * k;
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath(); ctx.stroke();
    });
  }
  if (opts.showIndex) {
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    ctx.lineWidth = 3;
    batch.samples.forEach((s, i) => {
      const x = s.cx * k, y = s.cy * k;
      const t = String(i + 1);
      ctx.strokeText(t, x + 4, y - 4);
      ctx.fillText(t, x + 4, y - 4);
    });
  }
  // 标尺
  if (opts.showScale && batch.calib?.mmPerPx) {
    drawScaleBar(ctx, batch, k, w, h);
  }
}

function drawScaleBar(ctx, batch, k, w, h) {
  const mmPerPx = batch.calib.mmPerPx;
  const candidates = [1, 2, 5, 10, 20, 50];
  let mm = candidates[candidates.length - 1];
  for (const c of candidates) {
    const px = c / mmPerPx;
    if (px * k < w * 0.3) { mm = c; break; }
  }
  const barPx = (mm / mmPerPx) * k;
  const x0 = w - barPx - 24, y0 = h - 26;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(x0 - 6, y0 - 15, barPx + 12, 30);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0, barPx, 4);
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${mm} mm`, x0 + barPx / 2, y0 - 3);
  ctx.restore();
}