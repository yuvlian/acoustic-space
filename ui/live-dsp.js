(function (root) {
	'use strict';

	const clamp = (min, max, value) => Math.max(min, Math.min(value, max));

	const VOWEL = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)[0-2]?$/;

	function detectPitch(samples, sampleRate, options) {
		const opts = options || {};
		const minHz = opts.minHz || 50;
		const maxHz = opts.maxHz || 500;
		const threshold = opts.threshold == null ? 0.15 : opts.threshold;
		const n = samples.length;
		const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
		const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(n / 2) - 1);
		if (maxLag <= minLag + 2) return { hz: 0, clarity: 0 };

		let sum = 0;
		for (let i = 0; i < n; i++) sum += samples[i];
		const mean = sum / n;
		let energy = 0;
		for (let i = 0; i < n; i++) {
			const v = samples[i] - mean;
			energy += v * v;
		}
		const rms = Math.sqrt(energy / n);
		if (rms < (opts.minRms == null ? 0.0008 : opts.minRms)) {
			return { hz: 0, clarity: 0, rms };
		}

		const width = n - maxLag;
		const diff = new Float64Array(maxLag + 1);
		for (let tau = 1; tau <= maxLag; tau++) {
			let acc = 0;
			for (let i = 0; i < width; i++) {
				const d = samples[i] - samples[i + tau];
				acc += d * d;
			}
			diff[tau] = acc;
		}

		const cmnd = new Float64Array(maxLag + 1);
		let running = 0;
		for (let tau = 1; tau <= maxLag; tau++) {
			running += diff[tau];
			cmnd[tau] = running > 0 ? diff[tau] * tau / running : 1;
		}

		let tau = -1;
		let value = 1;
		for (let t = minLag; t <= maxLag; t++) {
			if (cmnd[t] < threshold) {
				while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
				tau = t;
				value = cmnd[t];
				break;
			}
		}
		if (tau < 0) {
			for (let t = minLag; t <= maxLag; t++) {
				if (cmnd[t] < value) {
					value = cmnd[t];
					tau = t;
				}
			}
			if (value > (opts.maxClarityLoss == null ? 0.35 : opts.maxClarityLoss)) {
				return { hz: 0, clarity: 0, rms };
			}
		}

		if (tau > 1 && tau < maxLag) {
			const a = cmnd[tau - 1];
			const b = cmnd[tau];
			const c = cmnd[tau + 1];
			const denom = a - 2 * b + c;
			if (Math.abs(denom) > 1e-12) tau += 0.5 * (a - c) / denom;
		}

		return {
			hz: sampleRate / tau,
			clarity: 1 - value,
			rms
		};
	}

	function lpcCoefficients(x, order) {
		const n = x.length;
		const r = new Float64Array(order + 1);
		for (let k = 0; k <= order; k++) {
			let acc = 0;
			for (let i = 0; i < n - k; i++) acc += x[i] * x[i + k];
			r[k] = acc;
		}
		if (r[0] <= 0) return null;
		r[0] *= 1.0001;

		const a = new Float64Array(order + 1);
		a[0] = 1;
		let error = r[0];
		const previous = new Float64Array(order + 1);
		for (let i = 1; i <= order; i++) {
			let acc = r[i];
			for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
			const k = -acc / error;
			if (!isFinite(k)) return null;
			previous.set(a);
			for (let j = 1; j < i; j++) a[j] = previous[j] + k * previous[i - j];
			a[i] = k;
			error *= 1 - k * k;
			if (!(error > 0)) break;
		}
		return a;
	}

	function polynomialRoots(a) {
		const p = a.length - 1;
		const roots = [];
		for (let i = 0; i < p; i++) {
			const angle = 2 * Math.PI * (i + 0.5) / p + 0.7;
			roots.push({ re: 0.92 * Math.cos(angle), im: 0.92 * Math.sin(angle) });
		}
		for (let iteration = 0; iteration < 100; iteration++) {
			let largest = 0;
			for (let i = 0; i < p; i++) {
				const zr = roots[i].re;
				const zi = roots[i].im;

				let pr = a[0];
				let pi = 0;
				for (let k = 1; k <= p; k++) {
					const nr = pr * zr - pi * zi + a[k];
					const ni = pr * zi + pi * zr;
					pr = nr;
					pi = ni;
				}

				let dr = 1;
				let di = 0;
				for (let j = 0; j < p; j++) {
					if (j === i) continue;
					const xr = zr - roots[j].re;
					const xi = zi - roots[j].im;
					const nr = dr * xr - di * xi;
					const ni = dr * xi + di * xr;
					dr = nr;
					di = ni;
				}
				const denominator = dr * dr + di * di;
				if (denominator < 1e-24) continue;
				const qr = (pr * dr + pi * di) / denominator;
				const qi = (pi * dr - pr * di) / denominator;
				roots[i].re = zr - qr;
				roots[i].im = zi - qi;
				const delta = Math.hypot(qr, qi);
				if (delta > largest) largest = delta;
			}
			if (largest < 1e-10) break;
		}
		return roots;
	}

	function estimateFormants(samples, sampleRate, options) {
		const opts = options || {};
		const order = opts.order || 16;
		const windowSeconds = opts.windowSeconds || 0.032;
		const maximumBandwidth = opts.maximumBandwidth || 600;
		const weight = opts.preEmphasis == null ? 0.97 : opts.preEmphasis;

		const length = Math.min(samples.length, Math.round(windowSeconds * sampleRate));
		if (length < order * 3) return null;
		const offset = samples.length - length;

		const x = new Float64Array(length);
		let previous = 0;
		for (let i = 0; i < length; i++) {
			const value = samples[offset + i];
			const emphasized = value - weight * previous;
			previous = value;
			x[i] = emphasized * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (length - 1)));
		}

		const a = lpcCoefficients(x, order);
		if (!a) return null;

		const candidates = [];
		for (const root of polynomialRoots(a)) {
			const radius = Math.hypot(root.re, root.im);
			if (radius >= 1 || root.im <= 0) continue;
			const hz = Math.atan2(root.im, root.re) * sampleRate / (2 * Math.PI);
			const bandwidth = -Math.log(radius) * sampleRate / Math.PI;
			if (hz > 90 && hz < 5000 && bandwidth < maximumBandwidth) {
				candidates.push({ hz, bandwidth });
			}
		}
		candidates.sort((p, q) => p.hz - q.hz);

		const merged = [];
		for (const candidate of candidates) {
			const last = merged[merged.length - 1];
			if (last && candidate.hz - last.hz < 80) {
				if (candidate.bandwidth < last.bandwidth) merged[merged.length - 1] = candidate;
			} else {
				merged.push(candidate);
			}
		}

		const formants = merged.slice(0, 4).map(candidate => candidate.hz);
		if (formants.length < 3) return null;
		if (formants[0] > 1300 || formants[1] > 3500) return null;
		return formants;
	}

	function vowelKeys(stats) {
		return Object.keys(stats).filter(key => VOWEL.test(key) &&
			stats[key] && stats[key][1] && stats[key][2] && stats[key][3]);
	}

	function matchVowel(formants, stats, keys) {
		let best = null;
		const candidates = keys || vowelKeys(stats);
		for (const key of candidates) {
			const phoneStats = stats[key];
			let distance = 0;
			const floors = [80, 120, 180];
			const weights = [1, 1, 0.35];
			for (let i = 0; i < 3; i++) {
				const mean = phoneStats[i + 1].mean;
				const stdev = Math.max(phoneStats[i + 1].stdev, floors[i]);
				const z = (formants[i] - mean) / stdev;
				distance += weights[i] * z * z;
			}
			if (best === null || distance < best.distance) {
				best = { key, distance };
			}
		}
		return best;
	}

	function resonanceFromFormants(formants, stats, weights, keys) {
		const match = matchVowel(formants, stats, keys);
		if (!match) return null;
		const phoneStats = stats[match.key];
		const z = [];
		for (let i = 0; i < 3; i++) {
			const stdev = phoneStats[i + 1].stdev;
			if (!(stdev > 0)) return null;
			z.push((formants[i] - phoneStats[i + 1].mean) / stdev);
		}
		const w = weights || [0.7321428571428571, 0.26785714285714285, 0];
		const value = (w[0] * z[0] + w[1] * z[1] + w[2] * z[2]) / 3 + 0.5;
		return {
			resonance: clamp(0, 1, value),
			vowel: match.key,
			z
		};
	}

	const api = {
		detectPitch,
		lpcCoefficients,
		estimateFormants,
		vowelKeys,
		matchVowel,
		resonanceFromFormants,
		clamp
	};

	root.LiveDSP = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
