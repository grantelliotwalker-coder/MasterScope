// =====================================================================
// MasterScope DSP core. Pure functions: every analysis takes a
// buffer-like object { sampleRate, numberOfChannels, length,
// getChannelData(c) } and returns plain data. No DOM access in here.
// =====================================================================
const DSP = (() => {

  // ---------- Filters ----------
  function designBandpass(fs, f0, q) {
    const w0 = 2 * Math.PI * f0 / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: -2 * Math.cos(w0) / a0, a2: (1 - alpha) / a0 };
  }

  function applyBiquad(data, c) {
    const out = new Float32Array(data.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }

  function bandpassFilter(data, fs, lo, hi, cascades) {
    const f0 = Math.sqrt(lo * hi);
    const coef = designBandpass(fs, f0, f0 / (hi - lo));
    let out = data;
    for (let c = 0; c < (cascades || 2); c++) out = applyBiquad(out, coef);
    return out;
  }

  // ITU-R BS.1770-4 K-weighting (pre-filter shelf + RLB high-pass), using the
  // bilinear-transform derivation that reproduces the standard's 48 kHz
  // coefficients exactly and generalises to any sample rate.
  function kWeightCoefs(fs) {
    let K = Math.tan(Math.PI * 1681.974450955533 / fs);
    const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), Q1 = 0.7071752369554196;
    let a0 = 1 + K / Q1 + K * K;
    const s1 = { b0: (Vh + Vb * K / Q1 + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q1 + K * K) / a0,
                 a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q1 + K * K) / a0 };
    K = Math.tan(Math.PI * 38.13547087602444 / fs);
    const Q2 = 0.5003270373238773;
    a0 = 1 + K / Q2 + K * K;
    const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q2 + K * K) / a0 };
    return [s1, s2];
  }
  function kWeightChannel(data, fs) {
    const [s1, s2] = kWeightCoefs(fs);
    return applyBiquad(applyBiquad(data, s1), s2);
  }

  // ---------- FFT (in-place radix-2) ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  function mixToMono(buffer) {
    const mono = new Float32Array(buffer.length);
    const n = buffer.numberOfChannels;
    for (let c = 0; c < n; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / n;
    }
    return mono;
  }

  const toLufs = z => z > 1e-12 ? -0.691 + 10 * Math.log10(z) : -Infinity;
  const fromLufs = l => Math.pow(10, (l + 0.691) / 10);

  function percentileSorted(sorted, p) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  }

  // ---------- Loudness (BS.1770-4 integrated, EBU Tech 3342 LRA) ----------
  // Works on 100 ms K-weighted segments: momentary = 4 segments (400 ms),
  // short-term = 30 segments (3 s), both stepped every 100 ms.
  function loudness(buffer) {
    const fs = buffer.sampleRate, nCh = buffer.numberOfChannels;
    const seg = Math.round(0.1 * fs);
    const nSeg = Math.floor(buffer.length / seg);
    const segMS = new Float64Array(nSeg);
    for (let c = 0; c < nCh; c++) {
      const kw = kWeightChannel(buffer.getChannelData(c), fs);
      for (let s = 0; s < nSeg; s++) {
        let sum = 0;
        const start = s * seg, end = start + seg;
        for (let i = start; i < end; i++) sum += kw[i] * kw[i];
        segMS[s] += sum / seg; // channel weight 1.0 for L/R
      }
    }
    const prefix = new Float64Array(nSeg + 1);
    for (let s = 0; s < nSeg; s++) prefix[s + 1] = prefix[s] + segMS[s];
    const windowed = n => {
      const out = new Float64Array(Math.max(0, nSeg - n + 1));
      for (let i = 0; i < out.length; i++) out[i] = (prefix[i + n] - prefix[i]) / n;
      return out;
    };
    const momZ = windowed(4), stZ = windowed(30);

    // Integrated: absolute gate -70 LUFS, relative gate -10 LU
    const absZ = fromLufs(-70);
    const gatedAbs = Array.from(momZ).filter(z => z > absZ);
    let integrated = -Infinity;
    if (gatedAbs.length) {
      const relZ = fromLufs(toLufs(gatedAbs.reduce((a, b) => a + b, 0) / gatedAbs.length) - 10);
      const gatedRel = gatedAbs.filter(z => z > relZ);
      if (gatedRel.length) integrated = toLufs(gatedRel.reduce((a, b) => a + b, 0) / gatedRel.length);
    }

    // LRA: short-term values, absolute gate -70, relative gate -20 LU, 10th..95th percentile
    let lra = 0, lraLow = null, lraHigh = null;
    const stAbs = Array.from(stZ).filter(z => z > absZ);
    if (stAbs.length > 1) {
      const relZ = fromLufs(toLufs(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20);
      const vals = stAbs.filter(z => z > relZ).map(toLufs).sort((a, b) => a - b);
      if (vals.length > 1) {
        lraLow = percentileSorted(vals, 0.10);
        lraHigh = percentileSorted(vals, 0.95);
        lra = lraHigh - lraLow;
      }
    }

    const momentary = Float32Array.from(momZ, toLufs);
    const shortTerm = Float32Array.from(stZ, toLufs);
    let maxM = -Infinity, maxS = -Infinity;
    momentary.forEach(v => { if (v > maxM) maxM = v; });
    shortTerm.forEach(v => { if (v > maxS) maxS = v; });
    return { integrated, lra, lraLow, lraHigh, momentary, shortTerm, hopSec: 0.1,
             maxMomentary: maxM, maxShortTerm: maxS };
  }

  // ---------- True peak: 4x oversampling with a windowed-sinc interpolator ----------
  const TP_HALF = 8;
  const TP_PHASES = (() => {
    const phases = [];
    for (let p = 1; p < 4; p++) {
      const frac = p / 4, taps = new Float64Array(2 * TP_HALF);
      let sum = 0;
      for (let j = 0; j < 2 * TP_HALF; j++) {
        const k = j - (TP_HALF - 1);           // k = -7..8
        const t = frac - k;
        const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const x = t / TP_HALF;                 // Blackman window over |t| < 8
        const win = Math.abs(x) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
        taps[j] = sinc * win; sum += taps[j];
      }
      for (let j = 0; j < taps.length; j++) taps[j] /= sum;
      phases.push(taps);
    }
    return phases;
  })();

  function truePeak(buffer) {
    let samplePeak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > samplePeak) samplePeak = a; }
    }
    // Inter-sample overs only matter near the loudest samples, so skip quiet stretches
    const thresh = samplePeak * 0.5;
    let peak = samplePeak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = TP_HALF - 1; i < d.length - TP_HALF; i++) {
        if (Math.abs(d[i]) < thresh && Math.abs(d[i + 1]) < thresh) continue;
        const base = i - (TP_HALF - 1);
        for (let p = 0; p < 3; p++) {
          const taps = TP_PHASES[p];
          let v = 0;
          for (let j = 0; j < taps.length; j++) v += d[base + j] * taps[j];
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
      }
    }
    return { truePeakDb: 20 * Math.log10(peak || 1e-10), samplePeakDb: 20 * Math.log10(samplePeak || 1e-10) };
  }

  // ---------- Codec peak estimate ----------
  // Lossy encoders drop content above ~16 kHz, and removing it changes the waveform's shape,
  // so peaks can rise. Estimate: 8th-order Butterworth low-pass at 16 kHz, then true peak.
  function codecPeak(buffer) {
    const fs = buffer.sampleRate; if (fs < 34000) return NaN;
    const w0 = 2 * Math.PI * 16000 / fs, c = Math.cos(w0), sn = Math.sin(w0);
    const stages = [0.5098, 0.6013, 0.9000, 2.5629].map(q => { const al = sn / (2 * q), a0 = 1 + al; return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 }; });
    const chans = [];
    for (let k = 0; k < buffer.numberOfChannels; k++) { let x = buffer.getChannelData(k); for (const s of stages) x = applyBiquad(x, s); chans.push(x); }
    return truePeak({ sampleRate: fs, numberOfChannels: chans.length, length: chans[0].length, getChannelData: i => chans[i] }).truePeakDb;
  }

  // ---------- Level statistics (all channels) ----------
  function levels(buffer, mono) {
    let sumSq = 0, peak = 0, n = 0, clipped = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const v = d[i], a = Math.abs(v);
        sumSq += v * v; if (a > peak) peak = a; if (a >= 0.999) clipped++;
      }
      n += d.length;
    }
    let dc = 0;
    for (let i = 0; i < mono.length; i++) dc += mono[i];
    const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / n) || 1e-10);
    const peakDb = 20 * Math.log10(peak || 1e-10);
    return { rmsDb, samplePeakDb: peakDb, crest: peakDb - rmsDb, dcOffset: dc / mono.length,
             clippedSamples: clipped, clipPct: clipped / n * 100 };
  }

  // ---------- Tonal balance (power-based, pink noise reads flat) ----------
  function averagePsd(mono, fftSize, maxFrames) {
    const w = hann(fftSize), half = fftSize / 2;
    const psd = new Float64Array(half);
    const usable = mono.length - fftSize;
    if (usable < 0) return psd;
    const frames = Math.max(1, Math.min(maxFrames, Math.floor(usable / (fftSize / 2)) + 1));
    const step = frames > 1 ? usable / (frames - 1) : 0;
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    for (let f = 0; f < frames; f++) {
      const start = Math.round(f * step);
      for (let i = 0; i < fftSize; i++) { re[i] = mono[start + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < half; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    }
    for (let k = 0; k < half; k++) psd[k] /= frames;
    return psd;
  }

  // Total power between f0 and f1. Where a band is narrower than one FFT bin,
  // fall back to that bin's power density times the band width.
  function bandPower(psd, binHz, f0, f1) {
    const kLo = Math.ceil(f0 / binHz), kHi = Math.min(psd.length - 1, Math.floor(f1 / binHz - 1e-9));
    let sum = 0, count = 0;
    for (let k = Math.max(1, kLo); k <= kHi; k++) { sum += psd[k]; count++; }
    if (count >= 2) return sum;
    const kc = Math.min(psd.length - 1, Math.max(1, Math.round(Math.sqrt(f0 * f1) / binHz)));
    return psd[kc] * (f1 - f0) / binHz;
  }
  const db10 = v => 10 * Math.log10(v || 1e-20);
  const perOctaveDb = (psd, binHz, f0, f1) => db10(bandPower(psd, binHz, f0, f1) / Math.log2(f1 / f0));

  const OCTAVE_CENTRES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  function tonal(mono, fs) {
    const fftSize = 8192, psd = averagePsd(mono, fftSize, 3000), binHz = fs / fftSize, nyq = fs / 2;
    const octaveDb = OCTAVE_CENTRES.map(c => {
      // every frame of the song (up to 3000, half-overlapped): sampling fewer misses
      // sparse sub-bass notes and under-reads the low end
      // top band stops at 18 kHz: almost no music has content above it, and including
      // the empty region would make every track look darker than it sounds
      const f0 = c / Math.SQRT2, f1 = Math.min(nyq * 0.999, c * Math.SQRT2, 18000);
      return f1 > f0 ? perOctaveDb(psd, binHz, f0, f1) : -Infinity;
    });
    const refIdx = [2, 3, 4, 5, 6, 7]; // 125 Hz .. 4 kHz
    const ref = refIdx.reduce((a, i) => a + octaveDb[i], 0) / refIdx.length;
    const octaveRel = octaveDb.map(v => v - ref);
    // least-squares slope (dB per octave) across 63 Hz .. 8 kHz
    const xs = [], ys = [];
    for (let i = 1; i <= 8; i++) if (isFinite(octaveRel[i])) { xs.push(Math.log2(OCTAVE_CENTRES[i])); ys.push(octaveRel[i]); }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) * (x - mx); });
    const tilt = den > 0 ? num / den : 0;

    const po = (a, b) => perOctaveDb(psd, binHz, a, b);
    const lowMid = po(250, 500), presence = po(2000, 5000);
    return {
      psd, binHz, fftSize, octaveCentres: OCTAVE_CENTRES, octaveRel, tilt,
      lowMidPresenceGap: presence - lowMid,
      subBassGap: po(20, 60) - po(60, 250),
      lowMidBump: lowMid - (po(125, 250) + po(500, 1000)) / 2,
      airGap: po(8000, Math.min(16000, nyq * 0.999)) - po(1000, 4000),
    };
  }

  // Log-spaced bars of equal octave width -> pink noise draws flat
  function logBars(psd, binHz, fMin, fMax, nBars) {
    const out = new Float32Array(nBars), r = fMax / fMin;
    for (let i = 0; i < nBars; i++) {
      const f0 = fMin * Math.pow(r, i / nBars), f1 = fMin * Math.pow(r, (i + 1) / nBars);
      out[i] = db10(bandPower(psd, binHz, f0, f1) / Math.log2(f1 / f0));
    }
    return out;
  }

  // ---------- Stereo ----------
  function correlation(buffer) {
    if (buffer.numberOfChannels < 2) return 1;
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    let lr = 0, ll = 0, rr = 0;
    const step = Math.max(1, Math.floor(L.length / 2000000));
    for (let i = 0; i < L.length; i += step) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
    return lr / (Math.sqrt(ll * rr) + 1e-12);
  }

  function stereoField(buffer) {
    if (buffer.numberOfChannels < 2) return null;
    const fs = buffer.sampleRate, L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    const fftSize = 2048, half = fftSize / 2, w = hann(fftSize);
    const mid = new Float64Array(half), side = new Float64Array(half);
    const totalFrames = Math.floor(L.length / fftSize);
    if (totalFrames < 1) return null;
    const frames = Math.min(totalFrames, 6000), step = totalFrames / frames;
    const mRe = new Float64Array(fftSize), mIm = new Float64Array(fftSize);
    const sRe = new Float64Array(fftSize), sIm = new Float64Array(fftSize);
    for (let f = 0; f < frames; f++) {
      const start = Math.floor(f * step) * fftSize;
      for (let i = 0; i < fftSize; i++) {
        const l = L[start + i], r = R[start + i];
        mRe[i] = (l + r) / 2 * w[i]; sRe[i] = (l - r) / 2 * w[i]; mIm[i] = 0; sIm[i] = 0;
      }
      fft(mRe, mIm); fft(sRe, sIm);
      for (let k = 0; k < half; k++) {
        mid[k] += mRe[k] * mRe[k] + mIm[k] * mIm[k];
        side[k] += sRe[k] * sRe[k] + sIm[k] * sIm[k];
      }
    }
    const binHz = fs / fftSize;
    const freqBins = new Float32Array(half), widthPct = new Float32Array(half), energyDb = new Float32Array(half);
    let maxEnergyDb = -Infinity, ws = 0, wt = 0, bs = 0, bw = 0;
    for (let k = 0; k < half; k++) {
      freqBins[k] = k * binHz;
      const total = mid[k] + side[k];
      widthPct[k] = total > 1e-12 ? side[k] / total * 100 : 0;
      energyDb[k] = db10(total);
      if (energyDb[k] > maxEnergyDb) maxEnergyDb = energyDb[k];
      if (k > 0) {
        ws += widthPct[k] * total; wt += total;
        if (freqBins[k] < 200) { bs += widthPct[k] * total; bw += total; }
      }
    }
    // The low bass range on its own (60–200 Hz), plus its widest third-octave.
    // A mono sub can hide stereo content here if everything below 200 Hz is averaged.
    const widthBetween = (f0, f1) => {
      let s = 0, t = 0;
      for (let k = 1; k < half; k++) if (freqBins[k] >= f0 && freqBins[k] < f1) { const e = mid[k] + side[k]; s += widthPct[k] * e; t += e; }
      return t > 0 ? s / t : 0;
    };
    let lowPeakWidth = 0, lowPeakFreq = 0;
    [63, 80, 100, 125, 160].forEach(c => {
      const w = widthBetween(c / Math.pow(2, 1 / 6), c * Math.pow(2, 1 / 6));
      if (w > lowPeakWidth) { lowPeakWidth = w; lowPeakFreq = c; }
    });
    return { freqBins, widthPct, energyDb, maxEnergyDb, fs,
             overallWidth: wt > 0 ? ws / wt : 0, bassWidth: bw > 0 ? bs / bw : 0,
             lowWidth: widthBetween(60, 200), lowPeakWidth, lowPeakFreq };
  }

  function vectorscopePoints(buffer, maxPoints) {
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const step = Math.max(1, Math.floor(L.length / maxPoints)), n = Math.floor(L.length / step);
    const xs = new Float32Array(n), ys = new Float32Array(n);
    for (let j = 0, i = 0; j < n; j++, i += step) {
      xs[j] = (L[i] - R[i]) / Math.SQRT2; ys[j] = (L[i] + R[i]) / Math.SQRT2;
    }
    return { xs, ys };
  }

  // ---------- Spectrogram ----------
  function spectrogram(mono, fs, duration, numColumns, fftSize) {
    const w = hann(fftSize), half = fftSize / 2;
    const hop = Math.max(1, Math.floor((mono.length - fftSize) / numColumns));
    const columns = [];
    let maxDb = -Infinity;
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    for (let col = 0; col < numColumns; col++) {
      const start = col * hop;
      if (start + fftSize > mono.length) break;
      for (let i = 0; i < fftSize; i++) { re[i] = mono[start + i] * w[i]; im[i] = 0; }
      fft(re, im);
      const c = new Float32Array(half);
      for (let k = 0; k < half; k++) {
        const db = db10(re[k] * re[k] + im[k] * im[k]);
        c[k] = db; if (db > maxDb) maxDb = db;
      }
      columns.push(c);
    }
    return { columns, fs, fftSize, maxDb, duration };
  }

  // ---------- Transients ----------
  // RMS envelope sampled every 1 ms (window in ms)
  function envelope(data, fs, winMs) {
    const hop = Math.max(1, Math.round(fs / 1000)), n = Math.floor(data.length / hop);
    const prefix = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = j * hop, e = i + hop; i < e; i++) s += data[i] * data[i];
      prefix[j + 1] = prefix[j] + s;
    }
    const half = Math.max(0, Math.floor(winMs / 2)), env = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const lo = Math.max(0, j - half), hi = Math.min(n, j + half + 1);
      env[j] = Math.sqrt((prefix[hi] - prefix[lo]) / ((hi - lo) * hop));
    }
    return env;
  }

  // For each hit: level just before it (floor), peak, rise above the floor,
  // and time to fall back to within 3 dB of the floor (or -20 dB below peak).
  function hitShape(env, hits) {
    const res = [];
    for (const p of hits) {
      if (p < 100 || p + 600 >= env.length) continue;
      const pre = [];
      for (let j = p - 90; j <= p - 15; j++) pre.push(env[j]);
      const floor = median(pre) || 1e-9;
      let peak = 0, peakIdx = p;
      for (let j = p - 10; j <= p + 50; j++) if (env[j] > peak) { peak = env[j]; peakIdx = j; }
      const riseDb = 20 * Math.log10(peak / floor);
      const target = Math.max(peak * 0.1, floor * 1.4125);
      let decay = null;
      for (let j = peakIdx; j < peakIdx + 600 && j < env.length; j++) if (env[j] < target) { decay = j - peakIdx; break; }
      res.push({ riseDb, decay });
    }
    const rises = res.map(r => r.riseDb);
    const separable = res.filter(r => r.riseDb >= 6 && r.decay !== null);
    return {
      medianRiseDb: median(rises),
      separableFraction: res.length ? separable.length / res.length : 0,
      decayMs: separable.length >= 3 ? median(separable.map(r => r.decay)) : null,
      measured: res.length,
    };
  }

  function transients(mono, fs) {
    const broad = envelope(mono, fs, 10);
    const decim = [];
    for (let j = 0; j < broad.length; j += 4) decim.push(broad[j]);
    decim.sort((a, b) => a - b);
    const thresh = percentileSorted(decim, 0.85);
    const peaks = [];
    let last = -1e9;
    for (let j = 1; j < broad.length - 1; j++) {
      if (broad[j] > thresh && broad[j] >= broad[j - 1] && broad[j] >= broad[j + 1] && j - last >= 300) { peaks.push(j); last = j; }
    }
    if (peaks.length < 3) return null;

    let sumSq = 0;
    for (let i = 0; i < mono.length; i++) sumSq += mono[i] * mono[i];
    const overallRms = Math.sqrt(sumSq / mono.length);
    const hitVsRmsDb = 20 * Math.log10(median(peaks.map(p => broad[p])) / overallRms);

    // up to 120 hits spread evenly across the track
    const used = [];
    const stride = Math.max(1, peaks.length / 120);
    for (let i = 0; i < peaks.length && used.length < 120; i += stride) used.push(peaks[Math.floor(i)]);

    const kick = hitShape(envelope(bandpassFilter(mono, fs, 50, 90, 2), fs, 5), used);
    const bass = hitShape(envelope(bandpassFilter(mono, fs, 60, 250, 2), fs, 5), used);
    const click = hitShape(envelope(bandpassFilter(mono, fs, 1000, 3000, 2), fs, 5), used);

    // Low end vs mids at the moment of each hit, per octave (pink = 0 dB)
    const fftLen = 1 << Math.ceil(Math.log2(Math.round(0.08 * fs)));
    const w = hann(fftLen), binHz = fs / fftLen;
    const re = new Float64Array(fftLen), im = new Float64Array(fftLen);
    const psd = new Float64Array(fftLen / 2);
    let count = 0;
    const hop = Math.round(fs / 1000);
    for (const p of used) {
      const start = Math.max(0, p * hop - Math.round(0.005 * fs));
      if (start + fftLen > mono.length) continue;
      for (let i = 0; i < fftLen; i++) { re[i] = mono[start + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < fftLen / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
      count++;
    }
    const lowVsMidDb = count ? perOctaveDb(psd, binHz, 40, 100) - perOctaveDb(psd, binHz, 500, 3000) : null;

    return {
      hitCount: peaks.length,
      hitVsRmsDb,
      kickDecay: kick.decayMs, kickRiseDb: kick.medianRiseDb, kickSeparable: kick.separableFraction,
      bassDecay: bass.decayMs, bassRiseDb: bass.medianRiseDb,
      clickDecay: click.decayMs,
      lowVsMidDb,
      hitTimesSec: peaks.map(p => p / 1000),
    };
  }

  // ---------- −14 readiness ----------
  // At −14 LUFS with a −1 dBTP ceiling, peaks can stand at most 13 dB above the
  // integrated loudness. PLR above that budget means the track can't reach −14.
  const TARGET_LUFS = -14, CEILING_DB = -1, PLR_BUDGET = TARGET_LUFS * -1 + CEILING_DB; // 13 dB

  // Encoded peaks should stay at or below −1 dBTP. Without an estimate, fall back to Spotify's
  // advice of −2 dBTP for masters louder than −14.
  function hotForCodec(m) {
    if (isFinite(m.codecPeak)) return m.codecPeak > CEILING_DB + 0.1;
    return m.lufs > TARGET_LUFS + 0.5 && m.truePeak > -2.05;
  }
  function safeCeilingFor(m) {
    const over = isFinite(m.codecPeak) ? m.codecPeak - CEILING_DB : m.truePeak + 2;
    return Math.floor((m.truePeak - Math.max(0, over)) * 10) / 10; // round down to 0.1 dB
  }
  function readiness(m) {
    const peakCut = Math.max(0, m.plr - PLR_BUDGET);
    const raise = m.lufs < TARGET_LUFS ? Math.max(0, Math.min(TARGET_LUFS - m.lufs, CEILING_DB - m.truePeak)) : 0;
    const playbackLufs = m.lufs > TARGET_LUFS ? TARGET_LUFS : m.lufs + raise; // on a normaliser that never limits
    const atTarget = Math.abs(m.lufs - TARGET_LUFS) <= 0.5;
    const tpOk = m.truePeak <= CEILING_DB + 0.05;
    const density = m.plr < 8 ? 'squashed' : m.plr <= 12 ? 'competitive' : m.plr <= PLR_BUDGET ? 'open' : 'too-dynamic';
    let status, headline;
    if (peakCut > 0.05) { status = peakCut > 2 ? 'danger' : 'warn'; headline = `Needs ${peakCut.toFixed(1)} dB of peak control to reach −14`; }
    else if (!tpOk && m.lufs > TARGET_LUFS + 0.05 && m.truePeak - (m.lufs - TARGET_LUFS) <= CEILING_DB + 0.05) {
      // louder than −14 with hot peaks: one output trim fixes both
      status = 'warn'; headline = `Turn it down ${(m.lufs - TARGET_LUFS).toFixed(1)} dB to land on −14`;
    }
    else if (!tpOk) { status = 'warn'; headline = `Peaks are above −1 dBTP`; }
    else if (m.lufs > TARGET_LUFS + 0.5 && m.plr >= 8) {
      if (hotForCodec(m)) { status = 'warn'; headline = 'Louder master, but peaks are too hot for encoding'; }
      else { status = 'ok'; headline = `Ready: a louder master at ${(m.lufs < 0 ? '−' : '') + Math.abs(m.lufs).toFixed(1)} LUFS`; }
    }
    else if (!atTarget) { status = 'warn'; headline = m.lufs < TARGET_LUFS ? `Turn up ${(TARGET_LUFS - m.lufs).toFixed(1)} dB to reach −14` : `${(m.lufs - TARGET_LUFS).toFixed(1)} dB louder than −14`; }
    else { status = 'ok'; headline = density === 'open' ? 'Ready for −14, with open dynamics' : density === 'squashed' ? 'At −14, but heavily limited' : 'Ready for −14'; }
    const trimOnly = !tpOk && peakCut <= 0.05 && m.lufs > TARGET_LUFS + 0.05 && m.truePeak - (m.lufs - TARGET_LUFS) <= CEILING_DB + 0.05;
    // Louder than −14 with safe peaks and a competitive PLR: a deliberate choice of density,
    // which plays the same as a −14 master on streaming and louder where nothing normalises.
    const louderByChoice = tpOk && peakCut <= 0.05 && m.lufs > TARGET_LUFS + 0.5 && m.plr >= 8;
    const codecHot = hotForCodec(m), safeCeiling = safeCeilingFor(m);
    return { peakCut, raise, playbackLufs, trimOnly, louderByChoice, codecHot, safeCeiling, shortfall: TARGET_LUFS - playbackLufs, atTarget, tpOk, density, status, headline,
             budget: PLR_BUDGET, target: TARGET_LUFS, ceiling: CEILING_DB };
  }

  // ---------- What causes the loudest peaks ----------
  function lowpassCoefs(fs, f0) {
    const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  function peakSources(buffer, mono, hitTimesSec, needDb) {
    const fs = buffer.sampleRate, n = buffer.length, nCh = buffer.numberOfChannels;
    const ch = []; for (let c = 0; c < nCh; c++) ch.push(buffer.getChannelData(c));
    const absMax = i => { let a = 0; for (let c = 0; c < nCh; c++) { const v = Math.abs(ch[c][i]); if (v > a) a = v; } return a; };
    let peak = 0; for (let i = 0; i < n; i++) { const a = absMax(i); if (a > peak) peak = a; }
    if (!peak) return null;
    const thr = peak * Math.pow(10, -3 / 20), sep = Math.round(0.05 * fs), look = Math.round(0.01 * fs);
    let events = [];
    for (let i = 0; i < n; i++) {
      if (absMax(i) <= thr) continue;
      let best = i, bv = 0;
      for (let j = i, e = Math.min(n, i + look); j < e; j++) { const v = absMax(j); if (v > bv) { bv = v; best = j; } }
      let chMax = 0, cv = 0; for (let c = 0; c < nCh; c++) { const v = Math.abs(ch[c][best]); if (v > cv) { cv = v; chMax = c; } }
      events.push({ idx: best, val: bv, ch: chMax });
      i = best + sep;
    }
    if (events.length > 3000) events = events.sort((a, b) => b.val - a.val).slice(0, 3000);
    const lp = lowpassCoefs(fs, 150), low = applyBiquad(applyBiquad(mono, lp), lp);
    const hits = (hitTimesSec || []).slice().sort((a, b) => a - b);
    const nearHit = t => {
      let lo = 0, hi = hits.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (hits[mid] < t) lo = mid + 1; else hi = mid - 1; }
      return [hits[lo - 1], hits[lo]].some(h => h !== undefined && Math.abs(h - t) <= 0.04);
    };
    // A peak is percussive if the level jumps sharply just before it (any snare, clap, hat or
    // pluck, not only the main hits detected earlier), and low-driven if most of it is below 150 Hz.
    const env = envelope(mono, fs, 20); // 20 ms window: smooth enough not to ripple on bass notes
    const w = Math.round(0.003 * fs), counts = { hits: 0, kickbass: 0, low: 0, other: 0 };
    events.forEach(ev => {
      let la = 0, ma = 0;
      for (let j = Math.max(0, ev.idx - w), e = Math.min(n, ev.idx + w); j < e; j++) {
        const l = Math.abs(low[j]), m = Math.abs(mono[j]); if (l > la) la = l; if (m > ma) ma = m;
      }
      const t = Math.round(ev.idx / fs * 1000);
      let pre = Infinity, at = 0;
      for (let j = Math.max(0, t - 80); j <= t - 30 && j < env.length; j++) if (env[j] < pre) pre = env[j];
      for (let j = Math.max(0, t - 10); j <= t + 10 && j < env.length; j++) if (env[j] > at) at = env[j];
      const rise = isFinite(pre) && pre > 0 ? 20 * Math.log10(at / pre) : 0;
      const percussive = rise >= 6 || nearHit(ev.idx / fs);
      const lowDriven = la / (ma + 1e-9) > 0.55;
      ev.cat = percussive ? (lowDriven ? 'kickbass' : 'hits') : (lowDriven ? 'low' : 'other');
      counts[ev.cat]++;
    });
    const total = events.length || 1;
    const shares = {}; Object.keys(counts).forEach(k => shares[k] = counts[k] / total);
    const dominant = Object.keys(shares).sort((a, b) => shares[b] - shares[a])[0];
    // how much of the track would a limiter/clipper actually touch to remove the needed dB
    const cut = Math.max(0.5, needDb || 0), thrCut = peak * Math.pow(10, -cut / 20);
    let above = 0; for (let i = 0; i < n; i++) if (absMax(i) > thrCut) above++;
    const list = events.map(e => ({ idx: e.idx, ch: e.ch, t: e.idx / fs, cat: e.cat })).sort((a, b) => a.idx - b.idx);
    return { counts, shares, dominant, events: events.length, list, cutDb: cut, pctAbove: above / n * 100,
             eventsPerMin: events.length / (n / fs / 60) };
  }

  // ---------- Louder at −14: where loudness comes from, and what costs peak room ----------
  // At a fixed ceiling, loudness is limited by peaks. Each band is scored by its share of
  // the height of the loudest peaks (unweighted, as a limiter sees them) against its share
  // of the K-weighted energy that LUFS counts.
  const BUDGET_BANDS = [
    { key: 'sub', name: 'Sub', range: '20–60 Hz', lo: 0, hi: 60 },
    { key: 'bass', name: 'Bass', range: '60–200 Hz', lo: 60, hi: 200 },
    { key: 'lowmid', name: 'Low mids', range: '200–800 Hz', lo: 200, hi: 800 },
    { key: 'mid', name: 'Mids', range: '800 Hz–2.5 kHz', lo: 800, hi: 2500 },
    { key: 'presence', name: 'Presence', range: '2.5–6 kHz', lo: 2500, hi: 6000 },
    { key: 'high', name: 'Highs', range: '6 kHz and up', lo: 6000, hi: Infinity },
  ];
  function highpassCoefs(fs, f0) {
    const w0 = 2 * Math.PI * f0 / fs, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
  }
  function biquadMag2(c, f, fs) {
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
    const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  // Loudest peaks (within 3 dB of the maximum, 50 ms apart), with the channel that made each one
  function findPeakEvents(buffer) {
    const n = buffer.length, nCh = buffer.numberOfChannels, ch = [];
    for (let c = 0; c < nCh; c++) ch.push(buffer.getChannelData(c));
    let peak = 0; for (const d of ch) for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (!peak) return [];
    const thr = peak * Math.pow(10, -3 / 20), sep = Math.round(0.05 * buffer.sampleRate), look = Math.round(0.01 * buffer.sampleRate);
    let out = [];
    for (let i = 0; i < n; i++) {
      let a = 0; for (const d of ch) { const v = Math.abs(d[i]); if (v > a) a = v; }
      if (a <= thr) continue;
      let best = i, bv = 0, bc = 0;
      for (let j = i, e = Math.min(n, i + look); j < e; j++) for (let c = 0; c < nCh; c++) { const v = Math.abs(ch[c][j]); if (v > bv) { bv = v; best = j; bc = c; } }
      out.push({ idx: best, ch: bc, val: bv });
      i = best + sep;
    }
    if (out.length > 3000) out = out.sort((x, y) => y.val - x.val).slice(0, 3000).sort((x, y) => x.idx - y.idx);
    return out;
  }
  // (loudnessBudget is defined with bandMoves below: they share one band split)

  // RBJ biquads, matching the Web Audio filter types used by the live EQ (shelves use S = 1)
  function rbjCoefs(type, f0, gainDb, q, fs) {
    const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') {
      const al = sw / (2 * q);
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    } else {
      const al = sw / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
        a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
        a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
      }
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  // Common mix moves, each tried on the real audio. "Freed" is how much the peak-to-loudness
  // ratio drops: the same loudness with that much less limiting, or that much louder at the
  // same limiting. eqBand/eqFreq/eqQ load the move into the live EQ.
  const MIX_MOVES = [
    { key: 'sub', label: 'Tame the sub', detail: 'Low shelf −3 dB at 50 Hz', type: 'lowshelf', f: 50, g: -3, q: 0.8, eqBand: 0 },
    { key: 'low', label: 'Lighten the low end', detail: 'Low shelf −2 dB at 120 Hz', type: 'lowshelf', f: 120, g: -2, q: 0.8, eqBand: 0 },
    { key: 'lowmid', label: 'Clear the low mids', detail: '−2 dB at 350 Hz', type: 'peaking', f: 350, g: -2, q: 1.1, eqBand: 1 },
    { key: 'presence', label: 'Add presence', detail: '+2 dB at 3.2 kHz', type: 'peaking', f: 3200, g: 2, q: 0.9, eqBand: 3 },
  ];
  // How hard a limiter has to work to bring audio to a given density at its own loudness:
  // average gain reduction (dB, across the whole track) from 5 ms block peaks, 60 ms release.
  const MOVE_BLOCK_SEC = 0.005;
  function blockPeaks(chans, fs, into) {
    const blk = Math.max(1, Math.round(MOVE_BLOCK_SEC * fs)), n = chans[0].length, nb = Math.ceil(n / blk);
    const out = into || new Float32Array(nb);
    for (const x of chans) for (let b = 0; b < nb; b++) { let pk = out[b]; for (let i = b * blk, e = Math.min(n, i + blk); i < e; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; } out[b] = pk; }
    return out;
  }
  function workFromPeaks(pk, lufs, plrTarget) {
    const ceil = Math.pow(10, (lufs + plrTarget) / 20), rel = Math.exp(-MOVE_BLOCK_SEC * 1000 / 60);
    let gr = 0, sum = 0, max = 0, active = 0;
    for (let b = 0; b < pk.length; b++) {
      const need = pk[b] > ceil ? 20 * Math.log10(pk[b] / ceil) : 0;
      gr = need > gr ? need : gr * rel;
      sum += gr; if (gr > 0.05) active++; if (gr > max) max = gr;
    }
    return { avg: sum / pk.length, max, pct: active / pk.length * 100 };
  }
  // A file whose loudest peaks are packed close together at a moderate PLR has already been
  // limited, so its peaks no longer show everything the mix would ask of a limiter.
  function looksLimited(plr, peaks) { return isFinite(plr) && plr <= 12.5 && !!peaks && peaks.eventsPerMin >= 120; }
  // Density the moves are judged at: a competitive PLR of 10 for an open mix, or 2 dB denser
  // than a master that is already there.
  const moveTarget = plr => plr > 12 ? 10 : Math.max(5, Math.round((plr - 2) * 2) / 2);

  // Tone moves (EQ), each re-measured at its own loudness.
  function mixMoves(buffer, base) {
    const fs = buffer.sampleRate, src = [];
    for (let k = 0; k < buffer.numberOfChannels; k++) src.push(buffer.getChannelData(k));
    const target = moveTarget(base.plr), baseWork = workFromPeaks(blockPeaks(src, fs), base.lufs, target), out = [];
    for (const mv of MIX_MOVES) {
      if (mv.f > fs * 0.45) continue;
      const c = rbjCoefs(mv.type, mv.f, mv.g, mv.q, fs), chans = src.map(x => applyBiquad(x, c));
      const lufs = loudness(asBuffer(chans, fs)).integrated, work = workFromPeaks(blockPeaks(chans, fs), lufs, target);
      const saved = baseWork.avg - work.avg;
      out.push({ ...mv, lufs, dLufs: lufs - base.lufs, work, saved, pct: baseWork.avg > 0.01 ? saved / baseWork.avg * 100 : 0, savedMax: baseWork.max - work.max });
    }
    return { target, base: baseWork, moves: out.sort((a, b) => b.saved - a.saved) };
  }

  // One band split per channel serves two questions:
  //  1. Budget: each band's share of the height of the loudest peaks (decomposed at the peak
  //     sample) against its share of the K-weighted energy LUFS counts.
  //  2. Peak-control moves (when `base` is given): take cutDb off the loudest 2% of moments in
  //     one band (a fast band limiter, like a drum-bus clipper, bass compressor or de-esser),
  //     recombine, and measure how much less the master limiter has to do.
  const BAND_CUT_DB = 4, BAND_PCT = 0.98;
  function louder(buffer, tone, events, base) {
    const fs = buffer.sampleRate, n = buffer.length, nCh = buffer.numberOfChannels, nyq = fs / 2;
    const bands = BUDGET_BANDS.filter(b => b.lo < nyq * 0.95), B = bands.length;
    const lr4 = (x, c) => applyBiquad(applyBiquad(x, c), c);
    // budget: loudness share from the K-weighted average spectrum
    const [k1, k2] = kWeightCoefs(fs), loud = new Float64Array(B);
    for (let k = 1; k < tone.psd.length; k++) {
      const f = k * tone.binHz; if (f < 20) continue;
      const bi = bands.findIndex(b => f >= b.lo && f < b.hi); if (bi >= 0) loud[bi] += tone.psd[k] * biquadMag2(k1, f, fs) * biquadMag2(k2, f, fs);
    }
    const evs = (events && events.length ? events : findPeakEvents(buffer)).filter(e => e.idx > 64 && e.idx < n - 64);
    const W = Math.max(2, Math.round(0.0005 * fs)), span = 2 * W + 1, vals = evs.map(() => new Float32Array(B * span));
    // moves
    const blk = Math.max(1, Math.round(MOVE_BLOCK_SEC * fs)), nb = Math.ceil(n / blk), rel = Math.exp(-MOVE_BLOCK_SEC * 1000 / 60);
    const basePk = base ? new Float32Array(nb) : null, varPk = base ? bands.map(() => new Float32Array(nb)) : null;
    let msBase = 0; const msVar = new Float64Array(B);
    for (let c = 0; c < nCh; c++) {
      let rest = buffer.getChannelData(c); const parts = [];
      for (let b = 0; b < B; b++) {
        if (b < B - 1) { const fc = bands[b].hi; parts.push(lr4(rest, lowpassCoefs(fs, fc))); rest = lr4(rest, highpassCoefs(fs, fc)); }
        else parts.push(rest);
      }
      evs.forEach((e, i) => { if ((e.ch || 0) !== c && nCh > 1) return; const base0 = e.idx - W, v = vals[i]; for (let b = 0; b < B; b++) for (let j = 0; j < span; j++) v[b * span + j] = parts[b][base0 + j]; });
      if (!base) continue;
      const sum = new Float32Array(n);
      for (const p of parts) for (let i = 0; i < n; i++) sum[i] += p[i];
      blockPeaks([sum], fs, basePk);
      for (let i = 0; i < n; i++) msBase += sum[i] * sum[i];
      const v = new Float32Array(n);
      for (let b = 0; b < B; b++) {
        const p = parts[b], env = blockPeaks([p], fs);
        const sorted = Float32Array.from(env).sort(), thr = (sorted[Math.floor(sorted.length * BAND_PCT)] || 0) * Math.pow(10, -BAND_CUT_DB / 20);
        let grDb = 0, ms = 0;
        for (let k = 0; k < nb; k++) {
          const need = thr > 0 && env[k] > thr ? 20 * Math.log10(env[k] / thr) : 0;
          grDb = need > grDb ? need : grDb * rel;
          const lose = 1 - Math.pow(10, -grDb / 20);
          for (let i = k * blk, e = Math.min(n, i + blk); i < e; i++) { const y = sum[i] - p[i] * lose; v[i] = y; ms += y * y; }
        }
        msVar[b] += ms;
        blockPeaks([v], fs, varPk[b]);
      }
    }
    // budget result
    let budget = null;
    const contrib = new Float64Array(B), led = new Float64Array(B), ledHits = new Float64Array(B); let used = 0;
    for (let i = 0; i < evs.length; i++) {
      const v = vals[i]; let bj = 0, bs = 0;
      for (let j = 0; j < span; j++) { let s = 0; for (let b = 0; b < B; b++) s += v[b * span + j]; if (Math.abs(s) > Math.abs(bs)) { bs = s; bj = j; } }
      if (!bs) continue;
      let lead = 0, leadV = -Infinity;
      for (let b = 0; b < B; b++) { const c = v[b * span + bj] / bs; contrib[b] += c; if (c > leadV) { leadV = c; lead = b; } }
      if (evs[i].cat) { led[lead]++; if (evs[i].cat === 'hits' || evs[i].cat === 'kickbass') ledHits[lead]++; }
      used++;
    }
    if (used) {
      const loudTot = loud.reduce((a, b) => a + b, 0) || 1;
      const pos = Array.from(contrib, x => Math.max(0, x / used)), posTot = pos.reduce((a, b) => a + b, 0) || 1;
      // hitShare: of the peaks this band leads, how many are drum hits rather than sustained parts
      const out = bands.map((b, i) => ({ key: b.key, name: b.name, range: b.range, peakShare: pos[i] / posTot, loudShare: loud[i] / loudTot,
        hitShare: led[i] >= 5 ? ledHits[i] / led[i] : null, led: led[i] }));
      out.forEach(b => { b.ratio = b.peakShare / Math.max(0.005, b.loudShare); });
      budget = { bands: out, peaksUsed: used,
        costly: out.filter(b => b.peakShare >= 0.1 && b.ratio >= 1.8).sort((a, b) => (b.peakShare - b.loudShare) - (a.peakShare - a.loudShare)),
        efficient: out.filter(b => b.loudShare >= 0.1 && b.ratio <= 0.6).sort((a, b) => (b.loudShare - b.peakShare) - (a.loudShare - a.peakShare)) };
    }
    let moves = null;
    if (base) {
      const target = moveTarget(base.plr), baseWork = workFromPeaks(basePk, base.lufs, target);
      const list = bands.map((bd, b) => {
        const dLufs = 10 * Math.log10((msVar[b] || 1e-20) / (msBase || 1e-20)), work = workFromPeaks(varPk[b], base.lufs + dLufs, target);
        const saved = baseWork.avg - work.avg;
        const hb = budget && budget.bands.find(x => x.key === bd.key);
        return { key: bd.key, name: bd.name, range: bd.range, hitShare: hb ? hb.hitShare : null, cutDb: BAND_CUT_DB, dLufs, work, saved, pct: baseWork.avg > 0.01 ? saved / baseWork.avg * 100 : 0, savedMax: baseWork.max - work.max };
      });
      moves = { target, base: baseWork, moves: list.sort((a, b) => b.saved - a.saved) };
    }
    return { budget, moves };
  }
  const loudnessBudget = (buffer, tone, events) => louder(buffer, tone, events, null).budget;

  // Stretches where the 3 s loudness sags well below the track's average (intro and outro excluded)
  function energyDips(loud, duration, thresholdLu = 3, minSec = 4) {
    const st = loud.shortTerm, I = loud.integrated, hop = loud.hopSec || 0.1, off = 1.5;
    if (!st || !isFinite(I)) return [];
    const runs = []; let s = -1;
    for (let i = 0; i <= st.length; i++) {
      const low = i < st.length && isFinite(st[i]) && st[i] < I - thresholdLu && st[i] > I - 40;
      if (low && s < 0) s = i;
      if (!low && s >= 0) { runs.push([s, i - 1]); s = -1; }
    }
    const merged = [];
    runs.forEach(r => { const last = merged[merged.length - 1]; if (last && (r[0] - last[1]) * hop <= 1) last[1] = r[1]; else merged.push(r.slice()); });
    return merged.map(([a, b]) => {
      let min = Infinity, sum = 0; for (let i = a; i <= b; i++) { min = Math.min(min, st[i]); sum += st[i]; }
      return { start: Math.max(0, a * hop + off - 1.5), end: Math.min(duration, b * hop + off + 1.5), depth: I - min, avg: I - sum / (b - a + 1) };
    }).reduce((acc, d) => { // padding can make neighbours overlap: join them
      const last = acc[acc.length - 1];
      if (last && d.start <= last.end + 0.5) { last.end = Math.max(last.end, d.end); last.depth = Math.max(last.depth, d.depth); }
      else acc.push(d);
      return acc;
    }, []).filter(d => d.end - d.start >= minSec && d.start > 3 && d.end < duration - 3);
  }

  // Five-second windows where the loudest peaks cluster
  function peakHotspots(list, duration, winSec = 5) {
    if (!list || list.length < 5 || duration < winSec * 2) return [];
    const rate = list.length / duration, cands = [];
    for (let t = 0; t + winSec <= duration; t += 1) {
      const inWin = list.filter(e => e.t >= t && e.t < t + winSec);
      if (inWin.length < Math.max(5, rate * winSec * 1.6)) continue;
      const c = {}; inWin.forEach(e => c[e.cat] = (c[e.cat] || 0) + 1);
      cands.push({ start: t, end: t + winSec, count: inWin.length, ratio: inWin.length / (rate * winSec), dominant: Object.keys(c).sort((a, b) => c[b] - c[a])[0] });
    }
    const picked = [];
    cands.sort((a, b) => b.count - a.count).forEach(c => { if (picked.length < 3 && picked.every(p => c.end <= p.start || c.start >= p.end)) picked.push(c); });
    return picked.sort((a, b) => a.start - b.start);
  }

  // Why does the reference sound louder or fuller at the same −14?
  function loudnessVerdict(mine, ref) {
    const f = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
    const parts = [];
    const dp = mine.plr - ref.plr;
    if (Math.abs(dp) >= 1) parts.push({ kind: 'density', w: Math.abs(dp) / 1, text: dp > 0 ? `it is ${f(dp)} dB denser (PLR ${f(ref.plr)} vs your ${f(mine.plr)})` : `yours is ${f(-dp)} dB denser (PLR ${f(mine.plr)} vs ${f(ref.plr)}), so density isn't the gap` , theirs: dp > 0 });
    const dpr = ref.lowMidPresenceGap - mine.lowMidPresenceGap;
    if (Math.abs(dpr) >= 1.5) parts.push({ kind: 'tone', w: Math.abs(dpr) / 1.5, text: dpr > 0 ? `it has ${f(dpr)} dB more presence against its low mids` : `you have ${f(-dpr)} dB more presence`, theirs: dpr > 0 });
    const ds = mine.subBassGap - ref.subBassGap;
    if (Math.abs(ds) >= 2) parts.push({ kind: 'tone', w: Math.abs(ds) / 2, text: ds > 0 ? `your sub is ${f(ds)} dB heavier, which spends peak room without adding much loudness` : `its sub is ${f(-ds)} dB heavier`, theirs: ds > 0 });
    if (mine.budget && ref.budget) {
      const sm = mine.budget.bands.find(b => b.key === 'sub'), sr = ref.budget.bands.find(b => b.key === 'sub');
      if (sm && sr && sm.peakShare - sr.peakShare >= 0.1) parts.push({ kind: 'tone', w: (sm.peakShare - sr.peakShare) / 0.1, text: `sub makes ${Math.round(sm.peakShare * 100)}% of your peak height vs ${Math.round(sr.peakShare * 100)}% of the reference's`, theirs: true });
    }
    const dl = mine.lra - ref.lra;
    if (dl >= 2) parts.push({ kind: 'arrangement', w: dl / 2, text: `your sections vary more (loudness range ${f(mine.lra)} vs ${f(ref.lra)} LU), so yours has more quiet stretches`, theirs: true });
    const helps = parts.filter(p => p.theirs).sort((a, b) => b.w - a.w);
    const score = k => helps.filter(p => p.kind === k).reduce((a, p) => a + p.w, 0);
    const kinds = ['tone', 'density', 'arrangement'].map(k => [k, score(k)]).sort((a, b) => b[1] - a[1]);
    let headline;
    if (!helps.length) headline = 'At −14 your track should sound about as full as the reference';
    else headline = { tone: 'The gap is mostly tone, not limiting', density: 'The gap is mostly density', arrangement: 'The gap is mostly arrangement' }[kinds[0][0]];
    return { headline, reasons: helps.map(p => p.text), notes: parts.filter(p => !p.theirs).map(p => p.text), main: helps.length ? kinds[0][0] : null };
  }

  // ---------- Mastering: soft clipper + true-peak limiter ----------
  function softClip(chans, thrLin) {
    const k = thrLin * 0.7, r = thrLin - k;
    let touched = 0, maxRedDb = 0;
    for (const x of chans) for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]);
      if (a > k) {
        const y = k + r * Math.tanh((a - k) / r);
        if (a > y * 1.0116) { touched++; const d = 20 * Math.log10(a / y); if (d > maxRedDb) maxRedDb = d; }
        x[i] = x[i] < 0 ? -y : y;
      }
    }
    return { touchedPct: touched / (chans.length * chans[0].length) * 100, maxRedDb };
  }

  function tpEnvelope(chans, gate) {
    const n = chans[0].length, env = new Float32Array(n);
    for (const x of chans) {
      for (let i = 0; i < n; i++) {
        let a = Math.abs(x[i]);
        const b = i + 1 < n ? Math.abs(x[i + 1]) : 0;
        if ((a > gate || b > gate) && i >= TP_HALF - 1 && i < n - TP_HALF) {
          const base = i - (TP_HALF - 1);
          for (let p = 0; p < 3; p++) {
            const taps = TP_PHASES[p]; let v = 0;
            for (let j = 0; j < taps.length; j++) v += x[base + j] * taps[j];
            v = Math.abs(v); if (v > a) a = v;
          }
        }
        if (a > env[i]) env[i] = a;
      }
    }
    return env;
  }

  // Look-ahead true-peak limiter (offline, so it can look both ways).
  function limitTruePeak(chans, fs, ceilLin, releaseMs = 80) {
    const n = chans[0].length, L = Math.max(1, Math.round(0.0015 * fs));
    const env = tpEnvelope(chans, ceilLin * 0.5);
    const req = new Float32Array(n);
    for (let i = 0; i < n; i++) req[i] = env[i] > ceilLin ? ceilLin / env[i] : 1;
    // minimum over ±L, then a moving average over ±L: smooth, and never above what any sample needs
    const mn = new Float32Array(n), dq = new Int32Array(n);
    let h = 0, t = 0, j = 0;
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + L);
      while (j <= hi) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; j++; }
      while (dq[h] < i - L) h++;
      mn[i] = req[dq[h]];
    }
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + mn[i];
    const rel = Math.exp(-1 / (releaseMs / 1000 * fs));
    let g = 1, sumGr = 0, maxGr = 0, limited = 0;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - L), hi = Math.min(n, i + L + 1);
      const target = (pre[hi] - pre[lo]) / (hi - lo);
      g = target < g ? target : target - (target - g) * rel;
      if (g < 0.9988) { limited++; const gr = -20 * Math.log10(g); sumGr += gr; if (gr > maxGr) maxGr = gr; }
      for (const x of chans) x[i] *= g;
    }
    return { limitedPct: limited / n * 100, avgGrDb: limited ? sumGr / limited : 0, maxGrDb: maxGr };
  }

  const CLIP_THRESH_DB = { off: null, gentle: 2, medium: 0.8 };
  // One mastering pass at a given input gain. Returns new channel arrays and stats.
  function processMaster(src, fs, gainDb, ceilingDb, clipMode) {
    const g = Math.pow(10, gainDb / 20), ceil = Math.pow(10, ceilingDb / 20);
    const chans = src.map(x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * g; return y; });
    let clip = { touchedPct: 0, maxRedDb: 0 };
    if (CLIP_THRESH_DB[clipMode] !== null && CLIP_THRESH_DB[clipMode] !== undefined) clip = softClip(chans, ceil * Math.pow(10, CLIP_THRESH_DB[clipMode] / 20));
    const lim = limitTruePeak(chans, fs, ceil);
    return { chans, clip, lim };
  }
  const asBuffer = (chans, fs) => ({ sampleRate: fs, numberOfChannels: chans.length, length: chans[0].length, getChannelData: c => chans[c] });

  // ---------- Ranked differences from a reference ----------
  const OCT_NAMES = ['deep sub (31 Hz)', 'low bass (63 Hz)', 'bass (125 Hz)', 'low mids (250 Hz)', 'body (500 Hz)', 'mids (1 kHz)', 'upper mids (2 kHz)', 'presence (4 kHz)', 'brilliance (8 kHz)', 'air (16 kHz)'];
  const OCT_LESS = ['less deep sub', 'less low-end weight', 'less bass warmth', 'thinner low mids', 'less body', 'less midrange', 'less upper-mid energy', 'less presence and bite', 'less brilliance', 'less air'];
  const OCT_MORE = ['more deep sub, which uses headroom', 'a heavier low end', 'more bass', 'thicker, possibly muddy low mids', 'more body, possibly boxy', 'more midrange, possibly honky', 'more upper mids, possibly harsh', 'more presence, possibly harsh', 'more brilliance', 'more air'];
  function referenceDiffs(mine, ref) {
    const out = [];
    const f = (v, d = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
    const push = (key, label, d, thr, text) => { if (isFinite(d) && Math.abs(d) >= thr) out.push({ key, label, diff: d, score: Math.abs(d) / thr, text }); };
    const dp = mine.plr - ref.plr;
    push('density', 'Density', dp, 1.5, dp > 0
      ? `Your track is ${f(dp)} dB more dynamic (PLR ${f(mine.plr)} vs ${f(ref.plr)} dB). At −14 it will sound less dense than the reference; about ${f(dp)} dB more peak control would match it.`
      : `Your track is ${f(-dp)} dB more limited (PLR ${f(mine.plr)} vs ${f(ref.plr)} dB). It may sound flatter than the reference; easing the limiter by about ${f(-dp)} dB would match it.`);
    const dt = mine.tilt - ref.tilt;
    push('tilt', 'Overall balance', dt, 0.6, `Your overall balance is ${dt < 0 ? 'darker' : 'brighter'} than the reference (tilt ${f(mine.tilt)} vs ${f(ref.tilt)} dB per octave).`);
    for (let i = 0; i < 10; i++) {
      const d = mine.octaveRel[i] - ref.octaveRel[i], thr = (i === 0 || i === 9) ? 4 : 2;
      push('oct' + i, OCT_NAMES[i][0].toUpperCase() + OCT_NAMES[i].slice(1), d, thr,
        `In the ${OCT_NAMES[i]} octave your track is ${f(Math.abs(d))} dB ${d < 0 ? 'below' : 'above'} the reference: ${d < 0 ? OCT_LESS[i] : OCT_MORE[i]}.`);
    }
    const dl = mine.lra - ref.lra;
    push('lra', 'Section contrast', dl, 2, `Your loudness range is ${f(Math.abs(dl))} LU ${dl > 0 ? 'wider' : 'narrower'} than the reference (${f(mine.lra)} vs ${f(ref.lra)} LU), so sections ${dl > 0 ? 'vary more' : 'vary less'} in level.`);
    const dw = mine.width - ref.width;
    push('width', 'Stereo width', dw, 6, `Your mix is ${dw > 0 ? 'wider' : 'narrower'} overall (${mine.width.toFixed(0)}% vs ${ref.width.toFixed(0)}% side energy).`);
    const dlw = mine.lowWidth - ref.lowWidth;
    push('lowWidth', 'Bass width', dlw, 6, `Your 60–200 Hz range is ${dlw > 0 ? 'wider' : 'narrower'} than the reference (${mine.lowWidth.toFixed(0)}% vs ${ref.lowWidth.toFixed(0)}%).`);
    return out.sort((a, b) => b.score - a.score);
  }

  // ---------- Full analysis used for reference tracks / processed previews ----------
  function summary(buffer) {
    const mono = mixToMono(buffer);
    const loud = loudness(buffer);
    const tp = truePeak(buffer);
    const lv = levels(buffer, mono);
    const tone = tonal(mono, buffer.sampleRate);
    const sf = stereoField(buffer);
    return {
      lufs: loud.integrated, lra: loud.lra, truePeak: tp.truePeakDb, crest: lv.crest,
      plr: tp.truePeakDb - loud.integrated,
      tilt: tone.tilt, lowMidPresenceGap: tone.lowMidPresenceGap, subBassGap: tone.subBassGap,
      corr: correlation(buffer), width: sf ? sf.overallWidth : 0, bassWidth: sf ? sf.bassWidth : 0,
      lowWidth: sf ? sf.lowWidth : 0, lowPeakWidth: sf ? sf.lowPeakWidth : 0, lowPeakFreq: sf ? sf.lowPeakFreq : 0,
      tone,
    };
  }

  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  // What to reach for, by range and by whether that range's peaks are drum hits or sustained parts
  const BAND_ADVICE = {
    sub: { hits: ['Clip or fast-limit the kick, and sidechain the sub to it', 'Those peaks land on the kick, so clipping or fast-limiting the kick a little, and sidechaining the sub or 808 to it, takes them off.'],
           sustained: ['Compress or saturate the sub and 808', 'Those peaks come from sustained sub notes, so compressing or saturating the sub and 808 evens them out.'] },
    bass: { hits: ['Clip the kick, and sidechain the bass to it', 'Those peaks land on the kick, so a little kick clipping and sidechaining the bass to the kick takes them off.'],
            sustained: ['Compress or saturate the bass', 'Those peaks come from sustained bass notes, so compressing or saturating the bass evens them out.'] },
    lowmid: { hits: ['Tame the body of the kick and snare', 'Those peaks are drum hits, so taming the body of the kick and snare (a clipper or fast compressor on the drum bus) takes them off.'],
              sustained: ['Compress the busiest guitars, keys or low vocals', 'Those peaks come from sustained parts, so compressing the busiest guitars, keys or low vocals evens them out.'] },
    mid: { hits: ['A little snare clipping, or a drum-bus clipper', 'Those peaks are drum hits, mostly snare, so a little clipping on the snare or the drum bus takes them off.'],
           sustained: ['Compress vocals and leads', 'Those peaks come from sustained parts, usually vocals and leads, so compressing or clip-gaining them evens them out.'] },
    presence: { hits: ['Drum-bus clipper or fast limiter on the snare and hats', 'Those peaks are drum hits, mostly snare and hat attacks, so a clipper or fast limiter on the drum bus takes them off cleanly.'],
                sustained: ['De-esser or compression on vocals and bright leads', 'Those peaks come from sustained parts rather than drum hits: usually vocal sibilance or a bright lead or synth, so a de-esser or compression on that part takes them off. Check which part is bright at the peak clusters on the Loudness timeline.'] },
    high: { hits: ['Drum-bus clipper or fast limiter on hats and cymbals', 'Those peaks are drum hits, mostly hats and cymbals, so a clipper or fast limiter on the drum bus takes them off cleanly.'],
            sustained: ['De-esser on vocals, or tame bright cymbals and synths', 'Those peaks come from sustained parts rather than sharp hits: usually sibilance, ringing cymbals or a bright synth, so a de-esser or a gentle high-shelf compressor on that part takes them off. Check which part is bright at the peak clusters on the Loudness timeline.'] },
  };
  // hitShare null (unknown) leans on the drum-bus advice, which fits most mixes
  function bandAdvice(key, hitShare, long) {
    const a = BAND_ADVICE[key]; if (!a) return '';
    const kind = hitShare === null || hitShare === undefined ? null : hitShare >= 0.5 ? 'hits' : 'sustained';
    if (kind) return a[kind][long ? 1 : 0];
    return long ? `${a.hits[1]} If they come from sustained parts instead, ${a.sustained[0].charAt(0).toLowerCase() + a.sustained[0].slice(1)}.` : `${a.hits[0]}, or ${a.sustained[0].charAt(0).toLowerCase() + a.sustained[0].slice(1)}`;
  }


  // When the limiter is already fighting the presence range, boosting it there costs headroom.
  function presenceClash(m) {
    const mv = m.louder && m.louder.moves && m.louder.moves.moves;
    if (!mv || !mv.length || mv[0].pct < 10 || !['presence', 'high'].includes(mv[0].key)) return '';
    const hs = mv[0].hitShare;
    if (hs !== null && hs !== undefined && hs < 0.5) return ' Your loudest peaks also come from this range, mostly from a bright sustained part, so de-ess or compress that part first, then lift the parts that sit underneath it (pads, backing vocals, guitars) rather than the whole mix; together you get the presence without extra limiting.';
    return ' Your loudest peaks also come from this range, so lift the sustained parts (vocals, leads, pads) rather than the whole mix, and clip or fast-limit the drum transients there; together you get the presence without extra limiting.';
  }

  // ---------- Findings ----------
  // Every finding: { cat, status: ok|warn|danger|info, title, body }
  function findings(m) {
    const out = [];
    const f = (v, d = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
    const add = (cat, status, title, body) => out.push({ cat, status, title, body });

    // Loudness: judged against a −14 LUFS master with a −1 dBTP ceiling
    const SRC_FIX = {
      hits: 'Most of them are drum hits, so gentle clipping or fast limiting on the drum bus (or a soft clipper before the master limiter) is the cleanest way to take them off.',
      kickbass: 'Most of them are kick or other low-end hits, so clipping or fast-limiting the kick a little, and sidechaining the bass to it where they overlap, lowers them.',
      low: 'Most of them come from sustained bass or sub notes, so compressing or saturating the bass, or taming the deepest sub, will free the most room.',
      other: 'Most of them come from sustained parts rather than hits (often vocals, leads or pads), so compress or clip-gain the loudest part before the master limiter.',
    };
    if (isFinite(m.lufs) && isFinite(m.plr)) {
      const R = readiness(m);
      const pk = m.peaks ? ` ${SRC_FIX[m.peaks.dominant]}` : '';
      if (R.peakCut > 0.05 && m.peaks && m.peaks.pctAbove < 0.1 && m.truePeak > -1.3) add('loudness', 'warn', 'Just short of −14',
        `Peaks stand ${f(m.plr)} dB above the integrated loudness, ${R.peakCut.toFixed(1)} dB more than the ${PLR_BUDGET} dB a −14 master allows under −1 dBTP. Only ${m.peaks.pctAbove < 0.01 ? 'under 0.01%' : m.peaks.pctAbove.toFixed(2) + '%'} of the audio is in that top ${R.peakCut.toFixed(1)} dB, so raise your master limiter's input by ${(TARGET_LUFS - m.lufs).toFixed(1)} dB with the ceiling at −1 dBTP and it will land on −14 with no audible change.` +
        (R.shortfall > 0.2 ? ` As it stands, peak-limited services such as Spotify play it ${R.shortfall.toFixed(1)} dB quieter than tracks mastered to −14.` : ''));
      else if (R.peakCut > 0.05) add('loudness', R.peakCut > 2 ? 'danger' : 'warn', 'Peaks are too tall to reach −14',
        `Peaks stand ${f(m.plr)} dB above the integrated loudness, but −14 LUFS under a −1 dBTP ceiling leaves room for only ${PLR_BUDGET} dB. Take about ${R.peakCut.toFixed(1)} dB off the peaks, then raise the level into the limiter until it reads −14.${pk}` +
        (R.shortfall > 0.2 ? ` As it stands, peak-limited services such as Spotify play it ${R.shortfall.toFixed(1)} dB quieter than tracks mastered to −14.` : ''));
      else if (R.atTarget) add('loudness', 'ok', 'On target for −14',
        `Integrated loudness is ${f(m.lufs)} LUFS, within half a dB of the −14 target, so services will play it at full level without changing its sound.`);
      else if (m.lufs < TARGET_LUFS) add('loudness', 'warn', 'Below −14',
        `Integrated loudness is ${f(m.lufs)} LUFS. Your peaks leave room to raise it by ${(TARGET_LUFS - m.lufs).toFixed(1)} dB and still stay under −1 dBTP, so turn up the limiter input.`);
      else if (m.plr >= 8 && m.truePeak <= CEILING_DB + 0.05) add('loudness', 'ok', 'Louder master with competitive density',
        `Integrated loudness is ${f(m.lufs)} LUFS at a PLR of ${f(m.plr)} dB. Streaming services turn it down ${(m.lufs - TARGET_LUFS).toFixed(1)} dB, where it plays like any −14 track with this density; where nothing normalises (Bandcamp, downloads, DJ sets) it plays louder. Mastering at −14 instead only makes sense if you want a more open sound.`);
      else add('loudness', m.lufs > -11 ? 'warn' : 'info', 'Louder than −14',
        `Integrated loudness is ${f(m.lufs)} LUFS, so services will turn it down ${(m.lufs - TARGET_LUFS).toFixed(1)} dB. It will play at −14 like everything else, but with the extra limiting baked in. Mastering to −14 would let you keep about ${(m.lufs - TARGET_LUFS).toFixed(1)} dB more punch.`);
    }
    if (isFinite(m.truePeak)) {
      if (m.truePeak > -0.1) add('loudness', 'danger', 'No true-peak headroom',
        `True peak is ${f(m.truePeak)} dBTP. Lossy encoding (AAC, Ogg, MP3) can push this into audible clipping. Set the limiter ceiling to −1 dBTP.`);
      else if (m.truePeak > CEILING_DB + 0.05) add('loudness', 'warn', 'Tight true-peak headroom',
        `True peak is ${f(m.truePeak)} dBTP. −1 dBTP is the usual ceiling for streaming delivery.`);
      else add('loudness', 'ok', 'True-peak headroom is safe',
        `True peak is ${f(m.truePeak)} dBTP, below the −1 dBTP streaming guideline.`);
    }
    if (isFinite(m.codecPeak)) {
      const sc = safeCeilingFor(m), fc = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
      if (m.codecPeak > 0.05) add('loudness', m.codecPeak > 0.5 ? 'danger' : 'warn', 'Peaks will clip after encoding',
        `The codec peak estimate is ${m.codecPeak > 0 ? '+' : ''}${fc(m.codecPeak)} dBTP: once a lossy encoder (AAC, Ogg, MP3) removes the very top end, the peaks rise ${fc(m.codecPeak - m.truePeak)} dB and go over full scale, so players that don't turn the track down first (downloads, DJ software, Bluetooth) can distort on them. Lower the limiter ceiling to about ${fc(sc)} dBTP${m.lufs > TARGET_LUFS + 0.5 ? ` and Learn again at the same PLR (target ${fc(sc - m.plr)} LUFS)` : ''}. Spotify recommends −2 dBTP or lower for masters louder than −14.`);
      else if (m.codecPeak > CEILING_DB + 0.1) add('loudness', 'warn', 'Tight headroom after encoding',
        `The codec peak estimate is ${fc(m.codecPeak)} dBTP, above the −1 dBTP guideline: encoding raises the peaks ${fc(m.codecPeak - m.truePeak)} dB. A ceiling of about ${fc(sc)} dBTP keeps the encoded peaks under −1.`);
      else add('loudness', 'ok', 'Safe after encoding',
        `The codec peak estimate is ${fc(m.codecPeak)} dBTP, so the peaks stay under −1 dBTP after lossy encoding.`);
    }
    if (m.clippedSamples > 0) add('loudness', m.clipPct > 0.01 ? 'danger' : 'warn', 'Samples at full scale',
      `${m.clippedSamples.toLocaleString()} samples (${m.clipPct.toFixed(4)}%) are at or above full scale, which usually means the bounce clipped. Re-export with more headroom.`);
    if (Math.abs(m.dcOffset) > 0.003) add('loudness', 'warn', 'DC offset',
      `The waveform sits ${(m.dcOffset * 100).toFixed(2)}% off centre. A DC-removal filter or a ~5 Hz high-pass on the master clears it.`);

    // Dynamics
    if (isFinite(m.plr)) {
      if (m.plr < 8) add('dynamics', 'warn', 'Heavily limited',
        `Peak-to-loudness ratio is ${f(m.plr)} dB. Below about 8 dB the drums usually lose their snap. At −14 a denser master isn't any louder, so easing the limiter 1–2 dB costs nothing.`);
      else if (m.plr <= 12) add('dynamics', 'ok', 'Competitive density',
        `Peak-to-loudness ratio is ${f(m.plr)} dB, in the 8–12 dB range typical of competitive releases at −14.`);
      else if (m.plr <= PLR_BUDGET) add('dynamics', 'info', 'Open dynamics',
        `Peak-to-loudness ratio is ${f(m.plr)} dB. It fits −14, but most competitive releases sit around 9–12 dB, so they will sound denser next to it. Another 1–2 dB of peak control would close the gap, at the cost of some transient snap.`);
      else add('dynamics', 'info', 'Too dynamic for a −14 master',
        `Peak-to-loudness ratio is ${f(m.plr)} dB, more than the ${PLR_BUDGET} dB a −14 LUFS master has under a −1 dBTP ceiling. See the Loudness tab for what is causing the peaks.`);
    }
    if (m.peaks) {
      const s = m.peaks.shares, pc = v => Math.round(v * 100) + '%';
      add('dynamics', 'info', 'Where the peaks come from',
        `Of the loudest moments, ${pc(s.hits)} are drum hits and other transients, ${pc(s.kickbass)} are kick or low-end hits, ${pc(s.low)} are sustained bass notes and ${pc(s.other)} are other sustained parts.`);
    }
    if (isFinite(m.lra) && m.lra > 12) add('dynamics', 'info', 'Wide loudness range',
      `Loudness range is ${f(m.lra)} LU, so quiet and loud sections differ a lot. Check the Loudness timeline to see where.`);

    const t = m.transient;
    if (t) {
      if (t.hitVsRmsDb > 13) add('dynamics', 'warn', 'Hits jump well above the mix',
        `Detected hits peak ${f(t.hitVsRmsDb)} dB above the average level, so they may poke out on small speakers.`);
      else if (t.hitVsRmsDb < 3) add('dynamics', 'warn', 'Hits barely rise above the mix',
        `Detected hits are only ${f(t.hitVsRmsDb)} dB above the average level. If the drums should drive the track, they may be buried or over-compressed.`);
      else add('dynamics', 'ok', 'Hit level sits well in the mix',
        `Detected hits peak ${f(t.hitVsRmsDb)} dB above the average level.`);

      if (t.kickRiseDb !== null && t.kickRiseDb < 6) add('dynamics', 'warn', 'Low end doesn’t clear between hits',
        `In the 50–90 Hz range, each hit rises only ${f(t.kickRiseDb)} dB above what was already playing. Something (usually the bass or an 808) sustains under the kick, so the kick can’t be measured on its own and the low end may feel congested. Shorter bass notes or sidechain ducking to the kick will help, unless the sustained low end is the intended style.`);
      else if (t.kickDecay !== null && t.kickDecay > 180) add('dynamics', 'warn', 'Kick tail rings long',
        `The 50–90 Hz content takes about ${t.kickDecay} ms to settle after each hit. Try a shorter decay on the kick or a faster compressor release.`);
      else if (t.kickDecay !== null) add('dynamics', 'ok', 'Kick clears cleanly',
        `The low end settles about ${t.kickDecay} ms after each hit.`);

      if (t.lowVsMidDb !== null && t.lowVsMidDb > 24) add('tone', 'warn', 'Low end dominates each hit',
        `At the moment of each hit, 40–100 Hz is ${f(t.lowVsMidDb)} dB per octave above 500 Hz–3 kHz. Mid-range parts may dip in and out with the kick.`);
    }

    // Tone (rules of thumb, genre-dependent: compare against a reference)
    if (isFinite(m.tilt)) {
      if (m.tilt < -4.5) add('tone', 'danger', 'Very dark overall balance',
        `The spectrum falls ${f(-m.tilt)} dB per octave faster than pink noise between 63 Hz and 8 kHz. Most releases sit somewhere around 0 to −3. Lift presence and air, or reduce the low end.`);
      else if (m.tilt < -3) add('tone', 'warn', 'Dark-leaning balance',
        `The spectrum tilts ${f(m.tilt)} dB per octave relative to pink noise. A little more 2–5 kHz presence or 8 kHz+ air may help it sound more open. Check against a reference in your genre.`);
      else if (m.tilt > 1.5) add('tone', 'danger', 'Very bright overall balance',
        `The spectrum rises ${f(m.tilt)} dB per octave relative to pink noise. This can sound harsh or thin on full-range systems.`);
      else if (m.tilt > 0.5) add('tone', 'warn', 'Bright-leaning balance',
        `The spectrum tilts +${m.tilt.toFixed(1)} dB per octave relative to pink noise, brighter than most releases. Watch for harshness at higher playback levels.`);
      else add('tone', 'ok', 'Overall tonal balance is in a typical range',
        `The spectrum tilts ${f(m.tilt)} dB per octave relative to pink noise, within the range most releases fall in.`);
    }
    if (isFinite(m.lowMidBump) && m.lowMidBump > 3) add('tone', 'warn', 'Build-up in the low mids',
      `250–500 Hz is ${f(m.lowMidBump)} dB per octave above its neighbouring bands. That bump often reads as muddy or boxy. Try a broad cut around 300–400 Hz on the busiest parts.`);
    if (isFinite(m.subBassGap)) {
      if (m.subBassGap > 4) add('tone', 'warn', 'Sub-heavy low end',
        `20–60 Hz is ${f(m.subBassGap)} dB per octave hotter than 60–250 Hz. Small speakers can’t reproduce it, but it still uses limiter headroom.`);
      else if (m.subBassGap < -8) add('tone', 'info', 'Light sub-bass',
        `20–60 Hz is ${f(-m.subBassGap)} dB per octave below 60–250 Hz. Fine on small speakers; it may feel light on a club system.`);
    }

    // Louder at −14: presence, what the limiter is fighting, energy dips
    if (isFinite(m.lowMidPresenceGap) && m.lowMidPresenceGap < -7.5 && !(m.tilt < -3)) add('tone', 'warn', 'Presence sits low',
      `2–5 kHz is ${f(-m.lowMidPresenceGap)} dB per octave below 250–500 Hz; most releases sit around 3 to 6 dB below. The ear is most sensitive to presence, so a mix this dark sounds smaller at −14 than its loudness suggests. Try +1.5 to 2 dB around 3 kHz on vocals and leads (or the mix bus), or a little less around 300 Hz, and compare with a reference.` + presenceClash(m));
    const LM = m.louder;
    if (LM && LM.moves && LM.moves.moves.length && LM.moves.base.avg > 0.02) {
      const mv = LM.moves.moves, top = mv[0], second = mv[1], worst = mv[mv.length - 1];
      const pair = second && second.pct >= top.pct * 0.7 && second.pct >= 10;
      const where = pair ? `${top.name.toLowerCase()} and ${second.name.toLowerCase()}` : top.name.toLowerCase();
      if (top.pct >= 10) add('loudness', top.pct >= 20 ? 'warn' : 'info', `Your limiter is mostly fighting the ${where}`,
        `Taking ${top.cutDb} dB off the loudest moments in the ${top.name.toLowerCase()} (${top.range}) would cut the master limiting by about ${Math.round(top.pct)}%` +
        (pair ? `, and in the ${second.name.toLowerCase()} by ${Math.round(second.pct)}%` : '') + `, measured on this track at a PLR of ${LM.moves.target}. ${bandAdvice(top.key, top.hitShare, true)}` +
        (worst.pct <= -5 ? ` Controlling the ${worst.name.toLowerCase()} instead would make it worse: it removes more loudness than peak.` : '') +
        (m.limited ? ' This file is already limited, so for the clearest answer, analyse your mix before the master limiter.' : ''));
    }
    if (m.dips && m.dips.length) {
      const list = m.dips.slice(0, 3).map(d => `${mmss(d.start)}–${mmss(d.end)} (${f(d.depth)} LU down)`).join(', ');
      add('dynamics', 'info', `${m.dips.length} stretch${m.dips.length > 1 ? 'es' : ''} where the energy drops`,
        `The 3-second loudness falls more than 3 LU below the track's average at ${list}${m.dips.length > 3 ? ' and more' : ''}. That's right for a breakdown. If those parts should drive, they will feel smaller next to other releases at −14; more energy in the arrangement, or level automation, closes the gap.`);
    }

    // Stereo
    if (isFinite(m.corr)) {
      if (m.corr < -0.1) add('stereo', 'danger', 'Mono compatibility risk',
        `Phase correlation is ${f(m.corr, 2)}. Parts of the mix cancel when summed to mono (phones, Bluetooth speakers, clubs). Check wideners and polarity.`);
      else if (m.corr < 0.25) add('stereo', 'warn', 'Very wide stereo image',
        `Phase correlation is ${f(m.corr, 2)}. Listen with the Mono button to make sure nothing important disappears.`);
      else add('stereo', 'ok', 'Mono-safe',
        `Phase correlation is ${f(m.corr, 2)}, with no sign of cancellation in mono.`);
    }
    if (isFinite(m.lowWidth) && (m.lowWidth > 12 || m.lowPeakWidth > 25)) add('stereo', 'warn', 'Stereo content in the bass',
      `Between 60 and 200 Hz, ${m.lowWidth.toFixed(0)}% of the energy is in the sides, widest around ${m.lowPeakFreq} Hz (${m.lowPeakWidth.toFixed(0)}%). Wide bass loses weight on mono systems and can sound loose. Make the low end mono below about 150 Hz, or narrow whichever bass, keys or reverb sits there.`);
    else if (isFinite(m.bassWidth) && m.bassWidth > 15) add('stereo', 'warn', 'Stereo content in the bass',
      `${m.bassWidth.toFixed(0)}% of the energy below 200 Hz is in the sides. Wide bass loses weight in mono. Consider making it mono below about 150 Hz.`);
    else if (isFinite(m.lowWidth)) add('stereo', 'ok', 'Low end is centred',
      `Only ${m.lowWidth.toFixed(0)}% of the 60–200 Hz energy is in the sides.`);
    if (isFinite(m.width) && m.width < 5) add('stereo', 'info', 'Nearly mono',
      `Only ${m.width.toFixed(0)}% of the energy is in the sides. If you want a bigger image, add width to pads, doubles or reverbs above ~300 Hz.`);

    return out;
  }

  return {
    applyBiquad, kWeightChannel, fft, codecPeak, mixToMono, loudness, truePeak, levels, tonal, logBars,
    averagePsd, bandPower, correlation, stereoField, vectorscopePoints, spectrogram, transients,
    summary, findings, OCTAVE_CENTRES, loudnessBudget, mixMoves, energyDips, peakHotspots, loudnessVerdict, findPeakEvents, bandAdvice, MIX_MOVES, rbjCoefs, looksLimited, louder, readiness, peakSources, processMaster, asBuffer, referenceDiffs, TARGET_LUFS, CEILING_DB, PLR_BUDGET,
  };
})();
