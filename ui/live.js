(function () {
	'use strict';

	const SAMPLE_RATE = 16000;
	const ANALYSIS_INTERVAL = 40; // ms
	const DEFAULT_WINDOW_SECONDS = 5;
	const MAX_WINDOW_SECONDS = 60;
	const MIN_CLARITY = 0.7;

	const $button = document.querySelector('button.live-toggle');
	const $graph = document.querySelector('voice-graph-2d');
	const $panel = document.querySelector('section.details .live-details');
	const $details = $panel.closest('section.details');

	const graph = $graph.voiceGraph;

	let session = null;
	let configPromise = null;
	let sharedContext = null;
	let lastStopTime = 0;
	let lastDeviceId = null;
	let parkedSession = null;
	let parkTimer = null;
	const PARK_MS = 10000;
	const TAB_ID = Math.random().toString(36).slice(2);
	let micChannel = null;
	try {
		micChannel = new BroadcastChannel('acoustic-live-mic');
		micChannel.onmessage = event => {
			const data = event.data;
			if (!data || data.id === TAB_ID || data.type !== 'claim') return;
			// another tab
			if (session) stop();
			if (parkedSession) releaseCapture(parkedSession);
		};
	} catch (error) {
		micChannel = null;
	}
	function claimMicrophone() {
		if (!micChannel) return Promise.resolve();
		try { micChannel.postMessage({ type: 'claim', id: TAB_ID }); } catch (error) { }
		return new Promise(resolve => setTimeout(resolve, 300));
	}

	function loadConfig() {
		if (!configPromise) {
			configPromise = Promise.all([
				fetch('./stats.json').then(response => {
					if (!response.ok) throw new Error('stats.json: ' + response.status);
					return response.json();
				}),
				fetch('./weights.json').then(response => {
					if (!response.ok) throw new Error('weights.json: ' + response.status);
					return response.json();
				})
			]).then(([stats, weights]) => ({
				stats,
				weights,
				keys: window.LiveDSP.vowelKeys(stats)
			})).catch(error => {
				console.warn('Live resonance disabled:', error);
				return null;
			});
		}
		return configPromise;
	}

	function setStatus(session, text, isError) {
		if (!session.readout) return;
		session.readout.classList.toggle('error', !!isError);
		const status = session.readout.querySelector('[data-live="status"]');
		if (status.textContent !== text) status.textContent = text;
	}

	function setText(session, key, text) {
		const element = session.readout.querySelector('[data-live="' + key + '"]');
		if (element && element.textContent !== text) element.textContent = text;
	}

	function addMarker(session, extraClass, label) {
		const marker = graph.addMarker(0.5, 0.5, ' ', null);
		marker.classList.add('live-marker', extraClass);
		marker.classList.add('hidden');
		marker.dataset.label = label;
		marker.title = label === 'A' ? 'Average over the window' : 'Current frame';
		marker.style.pointerEvents = 'none';
		marker.setAttribute('aria-hidden', 'true');
		return marker;
	}

	function removeMarkers(session) {
		for (const marker of [session.averageMarker, session.nowMarker]) {
			if (marker && marker.parentNode) marker.parentNode.removeChild(marker);
		}
	}

	function resetPanel() {
		for (const element of $panel.querySelectorAll('[data-live]')) {
			element.textContent = '--';
		}
		$panel.classList.remove('error');
	}

	const windowInput = $panel.querySelector('input');
	if (windowInput) {
		windowInput.addEventListener('input', () => {
			if (!session) return;
			const value = Number(windowInput.value);
			if (!isFinite(value) || value <= 0) return;
			session.windowSeconds = Math.max(
				1, Math.min(MAX_WINDOW_SECONDS, Math.round(value))
			);
			pruneSamples(session, performance.now());
			updateReadout(session, performance.now());
		});
		windowInput.addEventListener('change', () => {
			windowInput.value = session ? session.windowSeconds : DEFAULT_WINDOW_SECONDS;
		});
	}

	function createAnalyser(context) {
		const analyser = context.createAnalyser();
		analyser.fftSize = context.sampleRate >= 32000 ? 4096 : 2048;
		analyser.smoothingTimeConstant = 0;
		return analyser;
	}

	const resampleScratch = new Float32Array(4096);

	function to16k(input, inputRate) {
		if (inputRate === SAMPLE_RATE) return input;
		const length = Math.floor(input.length * SAMPLE_RATE / inputRate);
		const ratio = inputRate / SAMPLE_RATE;
		let output = resampleScratch.length >= length
			? resampleScratch.subarray(0, length)
			: (resampleScratch = new Float32Array(length));
		for (let i = 0; i < length; i++) {
			const position = i * ratio;
			const index = Math.floor(position);
			const fraction = position - index;
			const a = input[index];
			const b = input[index + 1] == null ? a : input[index + 1];
			output[i] = a + (b - a) * fraction;
		}
		return output;
	}

	function getAudioContext() {
		if (!sharedContext || sharedContext.state === 'closed') {
			const AudioContext = window.AudioContext || window.webkitAudioContext;
			sharedContext = new AudioContext();
		}
		if (sharedContext.state !== 'running') {
			sharedContext.resume().catch(() => { });
		}
		return sharedContext;
	}

	async function acquireMicrophone(simple) {
		await claimMicrophone();
		const remaining = 250 - (performance.now() - lastStopTime);
		if (remaining > 0) {
			await new Promise(resolve => setTimeout(resolve, remaining));
		}
		const audio = {
			channelCount: 1,
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false
		};
		if (lastDeviceId) audio.deviceId = { exact: lastDeviceId };
		const constraints = { audio };
		const attempt = async (preferred) => {
			try {
				return await navigator.mediaDevices.getUserMedia(
					preferred && !simple ? constraints : { audio: true }
				);
			} catch (error) {
				if (error && error.name === 'NotAllowedError') throw error;
				if (preferred && !simple) return attempt(false);
				throw error;
			}
		};
		try {
			return await attempt(true);
		} catch (error) {
			if (error && ['NotReadableError', 'AbortError', 'OverconstrainedError'].includes(error.name)) {
				await new Promise(resolve => setTimeout(resolve, 300));
				return attempt(true);
			}
			throw error;
		}
	}

	function connectStream(session, stream) {
		const track = stream.getAudioTracks()[0];
		if (track) {
			track.onmute = () => { session.muted = true; };
			track.onunmute = () => { session.muted = false; };
			track.onended = () => { session.ended = true; };
			const settings = track.getSettings ? track.getSettings() : null;
			if (settings && settings.deviceId) lastDeviceId = settings.deviceId;
		}
		session.muted = false;
		session.ended = false;
		session.stream = stream;
		try {
			const source = session.context.createMediaStreamSource(stream);
			source.connect(session.analyser);
			return source;
		} catch (error) {
			console.error('Live: cannot connect microphone stream', error);
			throw error;
		}
	}

	async function recoverStream(session) {
		if (session.recovering || !session.active) return;
		if (session.recoveryAttempts >= 3) {
			setStatus(session, 'no microphone signal?', true);
			return;
		}
		const current = session;
		current.recovering = true;
		current.recoveryAttempts++;
		setStatus(current, 'reconnecting microphone...');
		try {
			if (current.stream) {
				const oldTrack = current.stream.getAudioTracks()[0];
				if (oldTrack) {
					oldTrack.onmute = null;
					oldTrack.onunmute = null;
					oldTrack.onended = null;
				}
				current.stream.getTracks().forEach(track => track.stop());
			}
			if (current.source) {
				try { current.source.disconnect(); } catch (error) {
					if (current.recoveryErrors++ < 3) console.error(error);
				}
			}
			await new Promise(resolve => setTimeout(resolve, 450));
			const stream = await acquireMicrophone(current.recoveryAttempts === 2);
			if (session !== current || !current.active) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			if (current.context.state !== 'running') await current.context.resume();
			current.source = connectStream(current, stream);
			current.lastSignal = performance.now();
		} catch (error) {
			if (current.recoveryErrors++ < 3) console.error('Live: microphone recovery failed', error);
			setStatus(current, 'microphone is not producing audio', true);
		} finally {
			current.recovering = false;
		}
	}

	function peakOf(samples) {
		let peak = 0;
		for (let i = 0; i < samples.length; i++) {
			const value = Math.abs(samples[i]);
			if (value > peak) peak = value;
		}
		return peak;
	}

	function analyze(session) {
		session.ticks = (session.ticks || 0) + 1;
		if (!session.active || !session.analyser || !session.context ||
			session.context.state === 'closed') return;

		const now = performance.now();
		let peak = 0;
		try {
			session.analyser.getFloatTimeDomainData(session.raw);
			peak = peakOf(session.raw);
		} catch (error) {
			session.lastPeak = 0;
			if (session.audioErrors++ < 3) console.error('Live: cannot read the analyser', error);
			return;
		}
		session.lastPeak = peak;
		if (peak > 0.001) {
			session.lastSignal = now;
			session.hadSignal = true;
			session.recoveryAttempts = 0;
		}

		const frame = { time: now, pitch: 0, resonance: null };
		try {
			const rate = session.context.sampleRate;
			const newest = session.raw.subarray(session.raw.length - Math.min(
				session.raw.length, Math.round(0.064 * rate)
			));
			const samples = to16k(newest, rate);
			const dsp = window.LiveDSP;

			if (dsp) {
				const pitch = dsp.detectPitch(samples, SAMPLE_RATE, {
					minHz: 75,
					maxHz: 600
				});
				if (pitch.hz && pitch.clarity >= MIN_CLARITY) {
					frame.pitch = pitch.hz;
				}

				if (session.config) {
					const formants = dsp.estimateFormants(samples, SAMPLE_RATE);
					if (formants) {
						const result = dsp.resonanceFromFormants(
							formants, session.config.stats, session.config.weights, session.config.keys
						);
						if (result) frame.resonance = result.resonance;
					}
				}
			} else if (session.dspErrors++ < 1) {
				console.error('Live: live-dsp.js is missing; pitch is disabled');
			}
		} catch (error) {
			if (session.dspErrors++ < 3) console.error('Live: pitch/formant analysis failed', error);
		}

		if (frame.pitch) {
			session.samples.push(frame);
			session.lastVoiced = now;
		}
		pruneSamples(session, now);

		try {
			updateMarkers(session);
		} catch (error) {
			if (session.uiErrors++ < 3) console.error('Live marker failed:', error);
		}
		try {
			if (now - session.lastSignal > 2000) recoverStream(session);
		} catch (error) {
			if (session.recoveryErrors++ < 3) console.error('Live recovery failed:', error);
		}
		if (now - session.lastUi > 100) {
			try {
				updateReadout(session, now);
			} catch (error) {
				if (session.uiErrors++ < 3) console.error('Live readout failed:', error);
			}
			session.lastUi = now;
		}
	}

	function average(values) {
		if (!values.length) return null;
		let sum = 0;
		for (const value of values) sum += value;
		return sum / values.length;
	}

	function summarize(values) {
		const count = values.length;
		if (!count) return { mean: null, median: null, sd: null, count };
		let total = 0;
		for (const value of values) total += value;
		const mean = total / count;
		const sorted = [...values].sort((a, b) => a - b);
		const middle = Math.floor(count / 2);
		const median = count % 2
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
		let sd = null;
		if (count > 1) {
			let squares = 0;
			for (const value of values) squares += (value - mean) * (value - mean);
			sd = Math.sqrt(squares / (count - 1));
		}
		return { mean, median, sd, count };
	}

	function pruneSamples(session, now) {
		const cutoff = now - session.windowSeconds * 1000;
		while (session.samples.length && session.samples[0].time < cutoff) {
			session.samples.shift();
		}
	}

	function latestValues(samples) {
		let pitch = null;
		let resonance = null;
		if (samples.length) pitch = samples[samples.length - 1].pitch || null;
		for (let i = samples.length - 1; i >= 0; i--) {
			if (samples[i].resonance != null) {
				resonance = samples[i].resonance;
				break;
			}
		}
		return { pitch, resonance };
	}

	function updateReadout(session, now) {
		const samples = session.samples;
		const pitchValues = [];
		const resonanceValues = [];
		for (const sample of samples) {
			if (sample.pitch) pitchValues.push(sample.pitch);
			if (sample.resonance != null) resonanceValues.push(sample.resonance);
		}

		const pitch = summarize(pitchValues);
		const resonance = summarize(resonanceValues);
		const latest = latestValues(samples);
		const pitchNow = latest.pitch;
		const resonanceNow = latest.resonance;
		const hz = value => value == null ? '--' : Math.round(value) + ' Hz';
		const percent = value => value == null ? '--' : Math.round(value * 100) + '%';

		setText(session, 'pitch-mean', hz(pitch.mean));
		setText(session, 'pitch-median', hz(pitch.median));
		setText(session, 'pitch-sd', hz(pitch.sd));
		setText(session, 'pitch-now', hz(pitchNow));

		if (session.config) {
			setText(session, 'res-mean', percent(resonance.mean));
			setText(session, 'res-median', percent(resonance.median));
			setText(session, 'res-sd', percent(resonance.sd));
			setText(session, 'res-now', percent(resonanceNow));
		} else {
			for (const key of ['res-now', 'res-mean', 'res-median', 'res-sd']) {
				setText(session, key, 'n/a');
			}
		}

		const silentFor = now - session.lastVoiced;
		if (session.recovering) {
			setStatus(session, 'reconnecting microphone...');
		} else if (!session.context || session.context.state !== 'running') {
			setStatus(session, 'audio is suspended. click Live again', true);
		} else if (session.ended) {
			setStatus(session, 'microphone disconnected', true);
		} else if (session.muted) {
			setStatus(session, 'microphone is muted', true);
		} else if (session.recoveryAttempts >= 3) {
			setStatus(session, 'no microphone signal?', true);
		} else if (now - session.lastSignal > 2000) {
			setStatus(session, 'no signal from microphone');
		} else if (silentFor > 1500) {
			setStatus(session, samples.length ? 'waiting for voice...' : 'listening...');
		} else {
			setStatus(session, `${samples.length} frames · ${session.windowSeconds} s window`);
		}
	}

	function updateMarkers(session) {
		const samples = session.samples;
		if (!samples.length) {
			for (const marker of [session.averageMarker, session.nowMarker]) {
				marker.classList.add('hidden');
			}
			return;
		}

		const averagePitch = average(samples.map(sample => sample.pitch).filter(Boolean));
		const averageResonance = average(
			samples.map(sample => sample.resonance).filter(value => value != null)
		);
		const latest = latestValues(samples);
		const nowPitch = latest.pitch;
		const nowResonance = latest.resonance;

		const place = (marker, pitch, resonance, show) => {
			if (!show || pitch == null) {
				marker.classList.add('hidden');
				return;
			}
			marker.classList.remove('hidden');
			marker.setAttribute('data-pitch', pitchPercent(pitch));
			marker.setAttribute('data-resonance', resonance == null ? 0.5 : resonance);
			graph.update(marker);
		};

		place(session.averageMarker, averagePitch, averageResonance, averagePitch != null && averageResonance != null);
		place(session.nowMarker, nowPitch, nowResonance, nowPitch != null && nowResonance != null);
	}

	function median(values) {
		if (!values.length) return null;
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	function pitchPercent(pitch) {
		return Math.max(0, Math.min(1, (pitch - 50) / 250));
	}

	function permissionMessage(error) {
		if (!window.isSecureContext) {
			return 'Microphone needs https:// or localhost.';
		}
		if (error && error.name === 'NotAllowedError') {
			return 'Microphone permission denied.';
		}
		if (error && error.name === 'NotFoundError') {
			return 'No microphone found.';
		}
		if (error && error.name === 'AudioBlocked') {
			return 'Audio is blocked; click Live again.';
		}
		if (error && error.message) {
			return 'Could not start microphone: ' + error.message;
		}
		return 'Could not start microphone.';
	}

	function beginLoop(newSession) {
		if (session !== newSession || !newSession.active) return;
		newSession.lastVoiced = performance.now();
		newSession.lastSignal = performance.now();
		const tick = () => {
			if (!newSession.active) return;
			try {
				analyze(newSession);
			} catch (error) {
				if (newSession.loopErrors++ < 3) {
					console.error('Live: analysis loop failed', error);
				}
			}
			if (newSession.active) newSession.timer = setTimeout(tick, ANALYSIS_INTERVAL);
		};
		newSession.timer = setTimeout(tick, ANALYSIS_INTERVAL);
		setStatus(newSession, 'listening...');
		const probe = () => {
			if (session !== newSession) return;
			const track = newSession.stream && newSession.stream.getAudioTracks()[0];
			let probePeak = 0;
			if (newSession.analyser && newSession.raw) {
				const probeRaw = new Float32Array(newSession.raw.length);
				newSession.analyser.getFloatTimeDomainData(probeRaw);
				for (let i = 0; i < probeRaw.length; i++) {
					probePeak = Math.max(probePeak, Math.abs(probeRaw[i]));
				}
			}
			const line =
				'ctx=' + (newSession.context && newSession.context.state) +
				' rate=' + (newSession.context && newSession.context.sampleRate) +
				' track=' + (track && track.readyState) +
				' enabled=' + (track && track.enabled) +
				' muted=' + newSession.muted +
				' ctxTime=' + Number((newSession.context && newSession.context.currentTime || 0).toFixed(2)) +
				' peak=' + Number((newSession.lastPeak || 0).toFixed(5)) +
				' probePeak=' + Number(probePeak.toFixed(5)) +
				' ticks=' + newSession.ticks +
				' analyser=' + !!newSession.analyser +
				' raw=' + (newSession.raw ? newSession.raw.length : 0) +
				' frames=' + newSession.samples.length +
				' signalAge=' + Math.round(performance.now() - newSession.lastSignal) + 'ms' +
				' recovering=' + newSession.recovering +
				' attempts=' + newSession.recoveryAttempts;
			console.info('Live probe:', line);
			if (newSession.samples.length === 0) {
				newSession.probeTimer = setTimeout(probe, 2000);
			}
		};
		newSession.probeTimer = setTimeout(probe, 2000);
	}

	function releaseCapture(capture, closeContext = false) {
		if (!capture) return;
		capture.active = false;
		clearTimeout(capture.timer);
		clearTimeout(capture.probeTimer);
		capture.timer = null;
		capture.probeTimer = null;
		if (capture.stream) {
			for (const track of capture.stream.getTracks()) {
				track.onmute = null;
				track.onunmute = null;
				track.onended = null;
				track.stop();
			}
		}
		for (const node of [capture.source, capture.analyser, capture.sink]) {
			if (node) { try { node.disconnect(); } catch (error) { } }
		}
		if (capture.context) {
			if (capture.context !== sharedContext || closeContext) {
				if (sharedContext === capture.context) sharedContext = null;
				capture.context.close().catch(() => { });
			}
		}
		capture.stream = null;
		capture.source = null;
		capture.analyser = null;
		capture.sink = null;
		capture.context = null;
		if (parkedSession === capture) {
			parkedSession = null;
			clearTimeout(parkTimer);
			parkTimer = null;
		}
	}

	function releaseEverything(closeContext = true) {
		const current = session;
		if (current) {
			session = null;
			current.active = false;
			clearTimeout(current.timer);
			clearTimeout(current.probeTimer);
			current.timer = null;
			current.probeTimer = null;
			removeMarkers(current);
			$details.classList.remove('live');
			$button.classList.remove('active');
			$button.setAttribute('aria-pressed', 'false');
			releaseCapture(current, closeContext);
		}
		if (parkedSession) releaseCapture(parkedSession, closeContext);
	}

	function parkCurrent(capture) {
		if (parkedSession && parkedSession !== capture) releaseCapture(parkedSession);
		parkedSession = capture;
		clearTimeout(parkTimer);
		parkTimer = setTimeout(() => {
			if (parkedSession === capture) releaseCapture(capture);
		}, PARK_MS);
	}

	function reviveParked() {
		const current = parkedSession;
		if (!current) return false;
		const track = current.stream && current.stream.getAudioTracks()[0];
		if (!current.context || current.context.state === 'closed' ||
			!current.analyser || !current.raw || !track ||
			track.readyState !== 'live' || current.ended) {
			releaseCapture(current);
			return false;
		}

		clearTimeout(parkTimer);
		parkTimer = null;
		parkedSession = null;
		session = current;
		current.active = true;
		track.enabled = true;
		console.info('Live: reusing the parked microphone stream');
		current.readout = $panel;
		current.samples = [];
		current.lastVoiced = performance.now();
		current.lastSignal = performance.now();
		current.lastUi = 0;
		current.recovering = false;
		current.muted = false;
		current.ended = false;
		current.lastPeak = 0;
		current.ticks = 0;
		current.audioErrors = 0;
		current.dspErrors = 0;
		current.uiErrors = 0;
		current.recoveryErrors = 0;
		current.recoveryAttempts = 0;
		current.loopErrors = 0;
		current.averageMarker = addMarker(current, 'live-average', 'A');
		current.nowMarker = addMarker(current, 'live-now', 'N');

		$button.setAttribute('aria-pressed', 'true');
		$button.classList.add('active');
		$details.classList.add('live');
		resetPanel();
		if (windowInput) windowInput.value = current.windowSeconds;
		$('.tab-set button.details').click();
		if (window.globalState && globalState.get('playing')) {
			globalState.set('playing', false);
		}
		if (current.context.state !== 'running') current.context.resume().catch(() => { });
		setStatus(current, 'listening...');
		setTimeout(() => beginLoop(current), 150);
		return true;
	}

	async function start() {
		if (session) return;
		if (parkedSession && reviveParked()) return;

		$button.setAttribute('aria-pressed', 'true');
		$button.classList.add('active');
		const readout = $panel;
		$details.classList.add('live');
		resetPanel();

		let initialWindow = DEFAULT_WINDOW_SECONDS;
		if (windowInput) {
			const value = Number(windowInput.value);
			if (isFinite(value) && value > 0) {
				initialWindow = Math.max(1, Math.min(MAX_WINDOW_SECONDS, Math.round(value)));
			}
			windowInput.value = initialWindow;
		}
		$('.tab-set button.details').click();

		if (window.globalState && globalState.get('playing')) {
			globalState.set('playing', false);
		}

		const newSession = {
			readout,
			active: true,
			config: null,
			context: null,
			stream: null,
			source: null,
			analyser: null,
			sink: null,
			raw: null,
			timer: null,
			windowSeconds: initialWindow,
			samples: [],
			lastVoiced: performance.now(),
			lastSignal: performance.now(),
			lastUi: 0,
			recovering: false,
			muted: false,
			ended: false,
			lastPeak: 0,
			ticks: 0,
			audioErrors: 0,
			dspErrors: 0,
			uiErrors: 0,
			recoveryErrors: 0,
			recoveryAttempts: 0,
			hadSignal: false,
			loopErrors: 0,
			probeTimer: null,
			averageMarker: null,
			nowMarker: null
		};
		session = newSession;
		setStatus(session, 'starting...');
		newSession.averageMarker = addMarker(session, 'live-average', 'A');
		newSession.nowMarker = addMarker(session, 'live-now', 'N');

		try {
			console.info('Live UA:', navigator.userAgent);
			const config = loadConfig();
			if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				throw new Error('getUserMedia unavailable');
			}

			const context = getAudioContext();
			newSession.context = context;

			const [stream, loaded] = await Promise.all([acquireMicrophone(), config]);
			if (session !== newSession) {
				stream.getTracks().forEach(track => track.stop());
				context.close().catch(() => { });
				return;
			}
			newSession.stream = stream;
			newSession.config = loaded;
			if (!loaded) setStatus(session, 'resonance needs stats.json');

			if (context.state === 'suspended') await context.resume();
			if (session !== newSession) {
				stream.getTracks().forEach(track => track.stop());
				context.close().catch(() => { });
				return;
			}

			const analyser = createAnalyser(context);
			newSession.analyser = analyser;
			newSession.raw = new Float32Array(analyser.fftSize);

			const sink = context.createGain();

			sink.gain.value = 0.0001;
			newSession.sink = sink;

			newSession.source = connectStream(newSession, stream);
			analyser.connect(sink);
			sink.connect(context.destination);

			if (context.state !== 'running') {
				throw Object.assign(new Error('AudioContext is ' + context.state), { name: 'AudioBlocked' });
			}
			const track = stream.getAudioTracks()[0];
			const settings = track && track.getSettings ? track.getSettings() : null;
			console.info('Live audio:', context.state, context.sampleRate + 'Hz',
				track ? track.readyState + '/' + ((settings && settings.sampleRate) || 'n/a') : 'no track');

			setTimeout(() => {
				beginLoop(newSession);
			}, 150);
		} catch (error) {
			console.error(error);
			if (session !== newSession) {
				releaseCapture(newSession);
				removeMarkers(newSession);
				return;
			}
			releaseCapture(newSession);
			removeMarkers(newSession);
			session = null;
			$button.classList.remove('active');
			$button.setAttribute('aria-pressed', 'false');
			setStatus(newSession, permissionMessage(error), true);
		}
	}

	function stop(resetButton = true) {
		if (!session) return;
		const current = session;
		session = null;
		current.active = false;
		lastStopTime = performance.now();
		clearTimeout(current.timer);
		clearTimeout(current.probeTimer);
		current.timer = null;
		current.probeTimer = null;
		removeMarkers(current);
		$details.classList.remove('live');
		if (resetButton) {
			$button.classList.remove('active');
			$button.setAttribute('aria-pressed', 'false');
		}
		const track = current.stream && current.stream.getAudioTracks()[0];
		if (current.hadSignal && current.context && current.context.state !== 'closed' &&
			current.analyser && current.stream && track && track.readyState === 'live' &&
			!current.ended) {
			parkCurrent(current);
		} else {
			releaseCapture(current);
		}
	}

	$button.addEventListener('click', () => {
		if (session) {
			stop();
		} else {
			start();
		}
	});

	window.LiveCapture = {
		release: function () {
			releaseEverything(false);
		},
		claim: claimMicrophone
	};

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') releaseEverything(true);
	});

	document.addEventListener('freeze', () => {
		releaseEverything(true);
	});

	window.addEventListener('pagehide', () => {
		releaseEverything(true);
	});
})();
