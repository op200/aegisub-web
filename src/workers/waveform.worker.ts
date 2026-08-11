/// <reference lib="webworker" />

interface WaveformRequest {
  samples?: Float32Array;
  durationMs?: number;
  buckets: number;
  /** 合成音频（dummy-audio:silence|noise）：不传 samples，直接生成峰值/频谱 */
  synthetic?: { kind: 'blank' | 'noise' };
}

interface SpectrumResult {
  width: number;
  height: number;
  data: Float32Array;
}

interface WaveformResponse {
  durationMs: number;
  peakMin: Float32Array;
  peakMax: Float32Array;
  spectrum: SpectrumResult | null;
}

/** 就地 radix-2 迭代 FFT（正变换，未归一化） */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** 把 FFT 幅值转为对数频率 bin（0..1），写入 data 的第 bucket 行 */
function fillLogBins(re: Float32Array, im: Float32Array, data: Float32Array, bucket: number, bins: number): void {
  const fftSize = re.length;
  const nyquist = fftSize / 2;
  for (let b = 0; b < bins; b++) {
    const lo = Math.max(1, Math.floor(Math.pow(2, (b / bins) * Math.log2(nyquist))));
    const hi = Math.min(nyquist, Math.floor(Math.pow(2, ((b + 1) / bins) * Math.log2(nyquist))));
    let mag = 0;
    for (let f = lo; f <= hi; f++) mag = Math.max(mag, Math.hypot(re[f], im[f]));
    data[bucket * bins + b] = Math.min(1, Math.max(0, Math.log10(1 + mag * 400) / 2.2));
  }
}

/** 计算频谱：每列 = 一个时间桶的对数频率幅值（归一化 0..1） */
function computeSpectrum(samples: Float32Array, buckets: number): SpectrumResult {
  const fftSize = 1024;
  const bins = 64;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const data = new Float32Array(buckets * bins);
  const bucketSize = Math.max(fftSize, Math.ceil(samples.length / buckets));
  for (let bucket = 0; bucket < buckets; bucket++) {
    const center = Math.min(samples.length - 1, Math.floor(((bucket + 0.5) * samples.length) / buckets));
    const start = Math.max(0, center - fftSize / 2);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const s = samples[Math.min(samples.length - 1, start + i)] ?? 0;
      re[i] = s * hann[i];
    }
    fft(re, im);
    fillLogBins(re, im, data, bucket, bins);
  }
  void bucketSize;
  return { width: buckets, height: bins, data };
}

/** 合成噪声频谱：每个时间桶用一段新鲜白噪声窗口做 FFT（不物化 1.6GB 样本） */
function computeNoiseSpectrum(buckets: number): SpectrumResult {
  const fftSize = 1024;
  const bins = 64;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  const data = new Float32Array(buckets * bins);
  for (let bucket = 0; bucket < buckets; bucket++) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = (Math.random() * 2 - 1) * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    fillLogBins(re, im, data, bucket, bins);
  }
  return { width: buckets, height: bins, data };
}

/** 合成静音频谱：全 0 */
function computeBlankSpectrum(buckets: number): SpectrumResult {
  const bins = 64;
  return { width: buckets, height: bins, data: new Float32Array(buckets * bins) };
}

self.onmessage = ({ data }: MessageEvent<WaveformRequest>) => {
  // 合成音频：不物化 samples
  if (data.synthetic) {
    const { kind } = data.synthetic;
    const buckets = data.buckets;
    const peakMin = new Float32Array(buckets);
    const peakMax = new Float32Array(buckets);
    let spectrum: SpectrumResult;
    if (kind === 'noise') {
      for (let b = 0; b < buckets; b++) {
        peakMin[b] = -(0.4 + Math.random() * 0.6);
        peakMax[b] = 0.4 + Math.random() * 0.6;
      }
      spectrum = computeNoiseSpectrum(buckets);
    } else {
      // blank：峰值全 0，频谱全 0
      spectrum = computeBlankSpectrum(buckets);
    }
    const response: WaveformResponse = { durationMs: data.durationMs ?? 0, peakMin, peakMax, spectrum };
    self.postMessage(response, [peakMin.buffer, peakMax.buffer, spectrum.data.buffer]);
    return;
  }

  const samples = data.samples ?? new Float32Array(0);
  const bucketSize = Math.max(1, Math.ceil(samples.length / data.buckets));
  const bucketCount = Math.ceil(samples.length / bucketSize);
  const peakMin = new Float32Array(bucketCount);
  const peakMax = new Float32Array(bucketCount);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    let minimum = 0;
    let maximum = 0;
    const end = Math.min(samples.length, (bucket + 1) * bucketSize);
    for (let index = bucket * bucketSize; index < end; index++) {
      minimum = Math.min(minimum, samples[index]);
      maximum = Math.max(maximum, samples[index]);
    }
    peakMin[bucket] = minimum;
    peakMax[bucket] = maximum;
  }
  const response: WaveformResponse = {
    durationMs: data.durationMs ?? 0,
    peakMin,
    peakMax,
    spectrum: computeSpectrum(samples, data.buckets),
  };
  const transfer: Transferable[] = [peakMin.buffer, peakMax.buffer];
  if (response.spectrum) transfer.push(response.spectrum.data.buffer);
  self.postMessage(response, transfer);
};
