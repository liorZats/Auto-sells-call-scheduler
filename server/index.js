const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

const config = require('./config');

// Optional Google Cloud clients
const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
app.use(express.json());
// Parse form-encoded bodies for Twilio webhooks
app.use(express.urlencoded({ extended: false }));
// Disable ETag caching to avoid 304 responses for dynamic endpoints
app.set('etag', false);

// Simple request logging middleware to aid debugging when using tunnels/proxies
app.use((req, res, next) => {
    try {
        console.log(`[REQ] ${req.method} ${req.originalUrl} - UA: ${req.get('user-agent') || 'unknown'} - X-Pinggy-No-Screen: ${req.get('X-Pinggy-No-Screen') || ''}`);
        res.on('finish', () => {
            console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
        });
    } catch (err) {
        // swallow logging errors
    }
    next();
});

// Simple health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', now: new Date().toISOString() });
});

// Optionally serve a static React build from the repo root `build` folder.
// If you run `npm run build` from your React app and place the output in
// the repository root `build` folder (next to server/), Express will serve it.
const buildDir = path.join(__dirname, '..', 'build');
if (fs.existsSync(buildDir)) {
    console.log('Serving static build from', buildDir);
    app.use(express.static(buildDir));

    // SPA fallback - but don't hijack API routes used by Twilio or the frontend
    app.get('*', (req, res, next) => {
        // If this looks like an API or webhook path, skip the SPA fallback so
        // our server-side routes can handle it.
        const apiPrefixes = ['/start-call', '/calls-status', '/call-status', '/twiml', '/audio'];
        if (apiPrefixes.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

        const indexHtml = path.join(buildDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
            res.sendFile(indexHtml);
        } else {
            next();
        }
    });
}

const PORT = config.PORT || 3000;
const PUBLIC_BASE_URL = config.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Twilio client
if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    console.warn('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set in environment. /start-call will not work until configured.');
}
const twilioClient = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

// Google clients (optional)
let speechClient = null;
let ttsClient = null;
if (config.STT_PROVIDER === 'google' || config.TTS_PROVIDER === 'google') {
    if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn('GOOGLE_APPLICATION_CREDENTIALS not set; Google STT/TTS will fail until configured.');
    }
    speechClient = new speech.SpeechClient();
    ttsClient = new textToSpeech.TextToSpeechClient();
}

// In-memory map of call sessions
const sessions = new Map();
// In-memory map of Twilio calls (callSid -> metadata)
const calls = new Map();

// --- /start-call endpoint ---
// Expects JSON: { name, phone }
app.post('/start-call', async (req, res) => {
    const { name, phone, leadId } = req.body;
    console.log('[START-CALL] Received request - name:', name, 'phone:', phone, 'leadId:', leadId);
    if (!name || !phone) return res.status(400).json({ error: 'Missing name or phone' });

    try {
        const url = `${PUBLIC_BASE_URL}/twiml?leadName=${encodeURIComponent(name)}&leadPhone=${encodeURIComponent(phone)}`;
        console.log('[START-CALL] TwiML URL:', url);

        const call = await twilioClient.calls.create({
            to: phone,
            from: config.TWILIO_CALLER_NUMBER,
            url,
            // Ask Twilio to POST status updates to our /call-status endpoint
            statusCallback: `${PUBLIC_BASE_URL}/call-status`,
            statusCallbackMethod: 'POST',
            // Only the following events are valid values for statusCallbackEvent
            // according to Twilio: initiated, ringing, answered, completed
            // (do not include terminal status names like 'no-answer'/'busy' here)
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });

        // Track the call locally so we can report status to the frontend
        calls.set(call.sid, {
            sid: call.sid,
            to: phone,
            from: config.TWILIO_CALLER_NUMBER,
            leadId: typeof leadId !== 'undefined' ? leadId : null,
            status: 'initiated',
            createdAt: new Date().toISOString()
        });

        res.json({ success: true, callSid: call.sid });
    } catch (err) {
        console.error('Error creating Twilio call:', err);
        res.status(500).json({ error: 'Failed to create call' });
    }
});

// Twilio will POST call status updates here (application/x-www-form-urlencoded)
app.post('/call-status', (req, res) => {
    try {
        const sid = req.body.CallSid || req.body.CallSid;
        const status = req.body.CallStatus || req.body.CallStatus;
        if (!sid) {
            console.warn('call-status webhook received without CallSid');
            return res.sendStatus(400);
        }

        const entry = calls.get(sid) || { sid };
        entry.status = status;
        entry.lastUpdate = new Date().toISOString();
        // Twilio provides a lot of useful fields; keep some for debugging
        entry.to = req.body.To || entry.to;
        entry.from = req.body.From || entry.from;
        entry.raw = req.body; // small convenience copy (not ideal for large scale)
        calls.set(sid, entry);

        console.log(`[CALL-STATUS] ${sid} -> ${status}`);
        res.sendStatus(200);
    } catch (err) {
        console.error('Error handling call-status webhook:', err);
        res.sendStatus(500);
    }
});

// Simple endpoint frontend can poll to get current known call statuses
app.get('/calls-status', (req, res) => {
    const arr = Array.from(calls.values()).map(c => ({
        sid: c.sid,
        status: c.status,
        to: c.to,
        leadId: c.leadId,
        outcome: c.outcome || null  // Include outcome if detected
    }));
    // ensure proxies and browsers don't cache this dynamic endpoint
    res.set('Cache-Control', 'no-store');
    console.log(`[CALLS-STATUS-REQ] returning ${arr.length} calls`);
    res.json(arr);
});

// --- /twiml endpoint ---
// Twilio will request this when the call is answered. We respond with TwiML that
// connects the call to a WebSocket Stream on our server (path /audio)
function twimlHandler(req, res) {
    // Support both query and body params. Twilio may POST but include query string
    // parameters (so prefer query then body).
    const leadName = (req.query && req.query.leadName) || (req.body && req.body.leadName) || 'Lead';
    const leadPhone = (req.query && req.query.leadPhone) || (req.body && req.body.leadPhone) || '';
    // Twilio expects a TwiML XML response
    const streamUrlRaw = `${(PUBLIC_BASE_URL).replace(/^http/, 'ws')}/audio?leadName=${encodeURIComponent(leadName)}&leadPhone=${encodeURIComponent(leadPhone)}`;
    const streamUrl = xmlEscape(streamUrlRaw);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\
<Response>\
    <Connect>\
        <Stream url="${streamUrl}"/>\
    </Connect>\
</Response>`;

    console.log('[TWIML] returning Stream URL ->', streamUrlRaw);
    console.log('[TWIML] escaping Stream URL ->', streamUrl);
    // Log request info to help debug Twilio parse failures (Document parse failure)
    try {
        console.log('[TWIML] request ->', { method: req.method, url: req.originalUrl, ua: req.get('user-agent') });
        try {
            console.log('[TWIML] parsed params ->', { query: req.query, body: req.body });
        } catch (e) { }
        // Log the exact TwiML body we're sending so we can compare with what Twilio received
        console.log('[TWIML] body ->', twiml);
    } catch (err) {
        // ignore logging errors
    }

    // Send TwiML as a UTF-8 Buffer with explicit Content-Length to avoid
    // transfer-encoding/charset ambiguities that can cause Twilio parse errors.
    const twimlBuff = Buffer.from(twiml, 'utf8');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Length', String(twimlBuff.length));
    res.status(200).send(twimlBuff);
}

app.get('/twiml', twimlHandler);
app.post('/twiml', twimlHandler);

// TEMP DEBUG: TwiML route that speaks a short prompt before connecting the Stream.
// This gives Twilio a small delay and forces the Stream to start after the Say,
// which can help debug timing-related issues with websocket upgrades.
function twimlDebugHandler(req, res) {
    const leadName = (req.query && req.query.leadName) || (req.body && req.body.leadName) || 'Lead';
    const leadPhone = (req.query && req.query.leadPhone) || (req.body && req.body.leadPhone) || '';
    const streamUrlRaw = `${(PUBLIC_BASE_URL).replace(/^http/, 'ws')}/audio?leadName=${encodeURIComponent(leadName)}&leadPhone=${encodeURIComponent(leadPhone)}`;
    const streamUrl = xmlEscape(streamUrlRaw);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>\
<Response>\
    <Say voice="alice">Connecting you to the AI agent now.</Say>\
    <Pause length="1"/>\
    <Connect>\
        <Stream url="${streamUrl}"/>\
    </Connect>\
</Response>`;

    console.log('[TWIML-DEBUG] returning Stream URL ->', streamUrlRaw);
    console.log('[TWIML-DEBUG] escaping Stream URL ->', streamUrl);
    try {
        console.log('[TWIML-DEBUG] request ->', { method: req.method, url: req.originalUrl, ua: req.get('user-agent') });
        console.log('[TWIML-DEBUG] parsed params ->', { query: req.query, body: req.body });
        console.log('[TWIML-DEBUG] body ->', twiml);
    } catch (err) { }
    const twimlDebugBuff = Buffer.from(twiml, 'utf8');
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Length', String(twimlDebugBuff.length));
    res.status(200).send(twimlDebugBuff);
}

app.get('/twiml-debug', twimlDebugHandler);
app.post('/twiml-debug', twimlDebugHandler);

// Static TwiML test endpoint — serves an unmodified XML file from disk. This
// helps rule out template/encoding issues when Twilio reports Document parse
// failures (12100). Point Twilio at /twiml-static to verify behavior.
app.get('/twiml-static', (req, res) => {
    const file = path.join(__dirname, 'static', 'twiml-test.xml');
    try {
        const body = fs.readFileSync(file, 'utf8');
        console.log('[TWIML-STATIC] serving static twiml ->', file);
        console.log('[TWIML-STATIC] body ->', body);
        res.set('Content-Type', 'text/xml; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.status(200).send(body);
    } catch (err) {
        console.error('Failed to read static TwiML file', err && err.message ? err.message : err);
        res.status(500).send('Server error');
    }
});

app.post('/twiml-static', (req, res) => {
    // Accept POSTs as Twilio will sometimes POST for TwiML. Serve same file.
    const file = path.join(__dirname, 'static', 'twiml-test.xml');
    try {
        const body = fs.readFileSync(file, 'utf8');
        console.log('[TWIML-STATIC] serving static twiml (POST) ->', file);
        console.log('[TWIML-STATIC] body ->', body);
        res.set('Content-Type', 'text/xml; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.status(200).send(body);
    } catch (err) {
        console.error('Failed to read static TwiML file (POST)', err && err.message ? err.message : err);
        res.status(500).send('Server error');
    }
});

// Create HTTP server and attach WS
const server = http.createServer(app);
// Disable permessage-deflate to avoid sending compressed frames which some
// proxies or endpoints may not handle as expected for Twilio Media Streams.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// Helper: mu-law to 16-bit PCM
function muLawTo16BitPCM(muLawBuffer) {
    const out = Buffer.alloc(muLawBuffer.length * 2);
    for (let i = 0; i < muLawBuffer.length; i++) {
        let mulaw = muLawBuffer[i];
        // Invert all bits (mu-law uses inverted encoding)
        mulaw = ~mulaw;

        // Extract sign, exponent, and mantissa
        const sign = (mulaw & 0x80) ? -1 : 1;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0f;

        // Calculate linear value using ITU-T G.711 formula
        // sample = sign * (2^(exponent+1) * (mantissa + 16.5) - 1) * 4
        let sample = ((1 << (exponent + 1)) * (mantissa + 16) + (1 << exponent) - 1 - 0x84) * sign;

        // Apply sign and clamp to 16-bit range
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        out.writeInt16LE(sample, i * 2);
    }
    return out;
}

// Simple XML escape helper for attribute values
function xmlEscape(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// NOTE: linear16ToMuLaw is implemented later in the file using a robust
// algorithm; the earlier helper was removed to avoid duplicate definitions.

// Quick local tone generator (LINEAR16, 8kHz) to validate outbound audio without
// Send PCM16 buffer to Twilio as mu-law 160-byte chunks (20ms at 8kHz)
async function sendMedia(ws, pcmBuffer, opts = { chunkMs: 20 }) {
    if (!ws || !pcmBuffer || pcmBuffer.length === 0) return;
    let sentChunks = 0;
    const chunkMs = opts.chunkMs || 20;

    try {
        const muLaw = linear16ToMuLaw(pcmBuffer);
        const chunkSize = 160;

        // Get streamSid from session (required by Twilio)
        let streamSid = null;
        try {
            const sessionId = ws._sessionId;
            const sess = sessions.get(sessionId);
            if (sess) streamSid = sess.streamSid;
        } catch (e) { }

        const startTime = Date.now();

        for (let offset = 0; offset < muLaw.length; offset += chunkSize) {
            const slice = muLaw.slice(offset, offset + chunkSize);
            const base64 = slice.toString('base64');
            const message = streamSid
                ? JSON.stringify({ event: 'media', streamSid: streamSid, media: { payload: base64 } })
                : JSON.stringify({ event: 'media', media: { payload: base64 } });

            if (!ws || ws.readyState !== 1) break;

            try {
                ws.send(message, { binary: false }, (sendErr) => {
                    if (sendErr) console.error('[SEND-MEDIA] Error:', sendErr.message);
                });
                sentChunks++;
            } catch (err) {
                console.error('[SEND-MEDIA] Failed:', err.message);
                break;
            }

            const expectedElapsed = (sentChunks * chunkMs);
            const actualElapsed = Date.now() - startTime;
            const sleepTime = expectedElapsed - actualElapsed;

            if (sleepTime > 0) {
                await new Promise(r => setTimeout(r, sleepTime));
            }
        }
    } catch (err) {
        console.error('[SEND-MEDIA] Error:', err.message);
    }
}

// Helper: convert 16-bit PCM (signed little-endian) to 8-bit mu-law
// Using standard ITU-T G.711 mu-law algorithm
function linear16ToMuLaw(pcm16Buffer) {
    const muLawBuf = Buffer.alloc(pcm16Buffer.length / 2);
    const BIAS = 0x84;
    const CLIP = 32635;

    for (let i = 0; i < pcm16Buffer.length; i += 2) {
        let sample = pcm16Buffer.readInt16LE(i);

        // Get sign bit
        const sign = (sample < 0) ? 0x80 : 0x00;

        // Get magnitude and clip
        if (sample < 0) sample = -sample;
        if (sample > CLIP) sample = CLIP;

        // Add bias
        sample += BIAS;

        // Find exponent (segment)
        let exponent = 7;
        for (let exp = 0x4000; exp > 0 && (sample & exp) === 0; exp >>= 1, exponent--) { }

        // Get mantissa (4 bits from the segment)
        const mantissa = (sample >> (exponent + 3)) & 0x0F;

        // Combine and invert
        const muLaw = ~(sign | (exponent << 4) | mantissa);
        muLawBuf[i / 2] = muLaw & 0xFF;
    }
    return muLawBuf;
}

// Send PCM16 buffer to Twilio as mu-law 160-byte chunks (20ms at 8kHz)
async function sendMediaChunked(ws, pcm16Buffer, opts = { chunkMs: 20 }) {
    try {
        if (!pcm16Buffer || pcm16Buffer.length === 0) return;
        // Convert to mu-law
        const muLaw = linear16ToMuLaw(pcm16Buffer);
        const bytesPerChunk = 160; // Twilio sends 160-byte mu-law frames (20ms)

        // Get streamSid from session (required by Twilio)
        let streamSid = null;
        try {
            const sessionId = ws._sessionId;
            const sess = sessions.get(sessionId);
            if (sess) streamSid = sess.streamSid;
        } catch (e) { }

        for (let offset = 0; offset < muLaw.length; offset += bytesPerChunk) {
            const slice = muLaw.slice(offset, offset + bytesPerChunk);
            const base64 = slice.toString('base64');
            // CRITICAL: Include streamSid in every outbound media message or Twilio returns 31951
            const message = streamSid
                ? JSON.stringify({ event: 'media', streamSid: streamSid, media: { payload: base64 } })
                : JSON.stringify({ event: 'media', media: { payload: base64 } });
            try {
                // Validate and force text frame similar to sendMedia
                const utf8Buf = Buffer.from(message, 'utf8');
                const printable = /^[\x09\x0A\x0D\x20-\x7E]*$/.test(utf8Buf.toString('binary'));
                if (!printable) console.warn('[SEND-MEDIA-CHUNK] non-printable bytes in outgoing chunk hex-preview=', utf8Buf.slice(0, 128).toString('hex'));

                // Wait for send callback and abort early on errors/closure
                const sender = ws.send.bind(ws);
                const ok = await new Promise((resolve) => {
                    try {
                        sender(message, { binary: false }, (err) => {
                            if (err) {
                                console.error('[SEND-MEDIA-CHUNK] ws.send callback error for chunk offset', offset, err && err.message ? err.message : err);
                                return resolve(false);
                            }
                            return resolve(true);
                        });
                    } catch (e) {
                        console.error('[SEND-MEDIA-CHUNK] ws.send threw for chunk offset', offset, e && e.message ? e.message : e);
                        return resolve(false);
                    }
                });

                if (!ok) break;
                console.log('[SEND-MEDIA-CHUNK] sent chunk', offset, 'len=', slice.length);
            } catch (err) {
                console.error('[SEND-MEDIA-CHUNK] ws.send failed:', err && err.message ? err.message : err);
                break;
            }
            // wait chunkMs before sending next chunk to emulate realtime
            await new Promise(r => setTimeout(r, opts.chunkMs || 20));
        }
        console.log('[SEND-MEDIA-CHUNK] finished sending', muLaw.length, 'bytes as', Math.ceil(muLaw.length / 160), 'chunks');
    } catch (err) {
        console.error('[SEND-MEDIA-CHUNK] error', err && err.message ? err.message : err);
    }
}

// Handle WS upgrades to route /audio
server.on('upgrade', (request, socket, head) => {
    // Parse the request URL robustly (support absolute-form targets)
    let requestUrl = request.url || '';
    // Log raw head bytes (if any) so we can diagnose websocket handshake issues.
    // `head` contains any buffered data read from the socket before the upgrade
    // handler is invoked (may include the start of the HTTP/WebSocket frames).
    try {
        const headLen = head && head.length ? head.length : 0;
        console.log(`[WS-UPGRADE-RAW] head length=${headLen}`);
        if (headLen > 0) {
            // log a short hex preview and a utf8-safe preview (replace non-printables)
            const preview = head.slice(0, 512);
            console.log('[WS-UPGRADE-RAW] hex-preview ->', preview.toString('hex'));
            // utf8 preview: replace control chars to keep logs readable
            const utf = preview.toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '.');
            console.log('[WS-UPGRADE-RAW] utf8-preview ->', utf);
        }
    } catch (err) {
        console.log('[WS-UPGRADE-RAW] failed to log head preview', err && err.message ? err.message : err);
    }
    try {
        const base = `http://${request.headers.host || 'localhost'}`;
        const parsed = new URL(requestUrl, base);
        requestUrl = parsed.pathname + (parsed.search || '');
    } catch (err) {
        // leave as-is if parsing fails
    }

    // More verbose logging to diagnose tunnel / proxy behavior
    try {
        console.log(`[WS-UPGRADE] ${request.method} ${requestUrl} - remote=${request.socket && request.socket.remoteAddress}`);
        console.log('[WS-UPGRADE-HEADERS]', JSON.stringify(request.headers, null, 2));
    } catch (err) {
        console.log('[WS-UPGRADE] (failed to stringify headers)', err && err.message ? err.message : err);
    }

    if (requestUrl && requestUrl.startsWith('/audio')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[WS-HANDLED] upgrade accepted for ${requestUrl}`);
            wss.emit('connection', ws, request);
        });
    } else {
        // Log unexpected upgrade attempts and close socket
        console.log(`[WS-UPGRADE] rejecting upgrade for ${requestUrl}`);
        try {
            socket.end();
        } catch (err) {
            socket.destroy();
        }
    }
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    console.log('[WS-CONNECT] req.url:', req.url);
    const params = new URLSearchParams(req.url.replace('/audio?', ''));
    const leadName = params.get('leadName') || 'valued customer';
    const leadPhone = params.get('leadPhone') || '';
    const sessionId = uuidv4();

    console.log(`[WS-CONNECT] New media stream for leadName="${leadName}" phone="${leadPhone}", session ${sessionId}`);

    // Wrap ws.send to log outgoing frames for debugging Twilio protocol errors
    try {
        if (!ws._origSend) {
            ws._origSend = ws.send.bind(ws);
            // Wrap ws.send so we always call the original send with an explicit
            // text-frame option (binary: false). This prevents accidentally
            // sending binary frames (opcode 2) which Twilio will reject with
            // 31951 "Invalid JSON Message" if it tries to parse them as JSON.
            ws.send = function (...args) {
                try {
                    const data = args[0];
                    let options;
                    let cb;
                    if (args.length === 1) {
                        options = { binary: false };
                        cb = undefined;
                    } else if (args.length === 2) {
                        if (typeof args[1] === 'function') {
                            options = { binary: false };
                            cb = args[1];
                        } else {
                            options = args[1] || {};
                            cb = undefined;
                        }
                    } else {
                        options = args[1] || {};
                        cb = args[2];
                    }
                    // enforce text frame
                    options.binary = false;

                    // Ensure we always send a proper UTF-8 string so ws emits a
                    let sendData;
                    if (typeof data === 'string') {
                        sendData = data;
                    } else if (Buffer.isBuffer(data)) {
                        sendData = data.toString('utf8');
                    } else {
                        sendData = String(data);
                    }
                    return ws._origSend.call(ws, sendData, options, cb);
                } catch (e) {
                    try { return ws._origSend.apply(ws, args); } catch (ee) { return; }
                }
            };
        }
    } catch (e) {
        console.error('[WS-OUT] failed to wrap ws.send', e && e.message ? e.message : e);
    }

    ws.on('error', (err) => {
        console.error(`WebSocket error on session ${sessionId}:`, err && err.message ? err.message : err);
    });

    // Create an STT streaming recognize instance (Google)
    const requestConfig = {
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 8000,
            languageCode: 'en-US',
        },
        interimResults: true,
    };

    let recognizeStream = null;
    if (speechClient) {
        console.log('[STT] Creating Google Speech-to-Text stream...');
        recognizeStream = speechClient.streamingRecognize(requestConfig)
            .on('error', (err) => {
                console.error('[STT] Stream error:', err);
                console.error('[STT] Error details:', err.code, err.details);
            })
            .on('data', async (data) => {
                console.log('[STT] Received data event from Google STT');

                // When Google STT returns results
                if (data.results && data.results[0]) {
                    const result = data.results[0];
                    const transcript = result.alternatives[0].transcript;
                    const isFinal = result.isFinal;
                    console.log(`[STT] ${isFinal ? 'Final' : 'Interim'}: "${transcript}" (length: ${transcript ? transcript.length : 0})`);
                    // record final transcripts for this session so we can detect silence
                    try {
                        const sess = sessions.get(sessionId);
                        if (sess) sess.transcripts = sess.transcripts || [];
                        if (isFinal && transcript && transcript.trim()) {
                            sess.transcripts.push(transcript.trim());
                            console.log('[STT] Stored transcript:', transcript.trim());
                        }

                        // Only process final results if we're not already playing audio
                        if (isFinal) {
                            console.log('[STT] Processing final result - isPlaying:', sess?.isPlaying, 'transcript:', transcript ? `"${transcript}"` : 'null/empty');

                            // Check if audio is already playing
                            if (sess && sess.isPlaying) {
                                console.log('[STT] audio already playing, skipping this final result');
                                return;
                            }

                            // If we get a final result WITH actual transcript, send to AI
                            if (transcript && transcript.trim()) {
                                console.log('[STT] final transcript received — sending to AI');
                                try {
                                    if (sess) sess.isPlaying = true;
                                    console.log('[AI-PIPELINE] Getting AI response...');
                                    const aiResult = await getAIResponse(transcript, leadName, leadPhone);
                                    console.log('[AI-PIPELINE] AI response received, synthesizing speech...');

                                    // Store outcome if detected
                                    if (aiResult.outcome && aiResult.outcome.type && sess) {
                                        sess.outcome = aiResult.outcome;
                                        console.log('[AI-PIPELINE] Outcome detected:', aiResult.outcome);

                                        // Update the call entry in the calls Map
                                        if (sess.callSid && calls.has(sess.callSid)) {
                                            const callEntry = calls.get(sess.callSid);
                                            callEntry.outcome = aiResult.outcome;
                                            console.log('[AI-PIPELINE] Updated call outcome for', sess.callSid);
                                        }
                                    }

                                    // Synthesize audio
                                    const audioBuffer = await synthesizeSpeech(aiResult.text);
                                    console.log('[AI-PIPELINE] Speech synthesized, sending to Twilio...');
                                    // Send back to Twilio
                                    await sendMedia(ws, audioBuffer);
                                    console.log('[AI-PIPELINE] Complete - audio sent');
                                } catch (err) {
                                    console.error('[AI-PIPELINE] Error:', err);
                                    console.error('[AI-PIPELINE] Error stack:', err.stack);
                                } finally {
                                    if (sess) sess.isPlaying = false;
                                }
                            }
                            // If empty final result, just log it - don't send fallback
                            // (Google STT sends empty finals on silence/timeout, but that's normal)
                            else {
                                console.log('[STT] Empty final result - ignoring (silence/timeout)');
                            }
                        }
                    } catch (e) { }
                }
            });

    }

    // Track closed state and first-media acceptance so long-running sends can
    // stop early if the socket closes and avoid sending large TTS until the
    // first small media frame is accepted by Twilio.
    // Also track isPlaying to prevent overlapping audio streams
    // Also track callSid to update call outcome in the calls Map
    sessions.set(sessionId, { ws, recognizeStream, transcripts: [], closed: false, acceptedFirstMedia: false, streamSid: null, callSid: null, isPlaying: false, outcome: null });
    // make session id available on ws so helpers can update acceptance state
    try { ws._sessionId = sessionId; } catch (e) { }

    ws.on('message', async (msg) => {
        // Twilio sends JSON messages (start, media, stop)
        let payload;
        try {
            payload = JSON.parse(msg.toString());
        } catch (err) {
            console.warn('Received non-JSON ws message');
            return;
        }

        if (payload.event === 'start') {
            console.log('Stream started (start payload) ->', JSON.stringify(payload));
            // CRITICAL: Capture the streamSid from Twilio's start event.
            // ALL outbound media messages MUST include this streamSid or Twilio
            // will reject them with error 31951.
            const twilioStreamSid = payload.streamSid || (payload.start && payload.start.streamSid);
            const twilioCallSid = payload.callSid || (payload.start && payload.start.callSid);
            const sess = sessions.get(sessionId);
            if (sess && twilioStreamSid) {
                sess.streamSid = twilioStreamSid;
                console.log('[STREAM-SID] captured from Twilio:', twilioStreamSid);
            } else {
                console.warn('[STREAM-SID] WARNING: Could not capture streamSid from start event!');
            }
            if (sess && twilioCallSid) {
                sess.callSid = twilioCallSid;
                console.log('[CALL-SID] captured from Twilio:', twilioCallSid);
            }

            // Send initial greeting
            (async () => {
                try {
                    const sess = sessions.get(sessionId);
                    if (sess) {
                        sess.acceptedFirstMedia = true;
                        sess.isPlaying = true;
                        console.log('[GREETING] Synthesizing initial greeting for', leadName);
                        const greeting = `Hi ${leadName}, this is Alex calling from Alti. We help companies automate their outbound calling and booking processes. I'd love to schedule a quick 15-minute call with one of our senior account managers to show you how we can help. Does later this week work for you?`;
                        const audioBuffer = await synthesizeSpeech(greeting);
                        await sendMedia(ws, audioBuffer);
                        console.log('[GREETING] Greeting sent');
                        sess.isPlaying = false;
                    }
                } catch (err) {
                    console.error('[GREETING] Error:', err.message);
                    const sess = sessions.get(sessionId);
                    if (sess) sess.isPlaying = false;
                }
            })();
        } else if (payload.event === 'media') {
            try {
                const b64 = payload.media && payload.media.payload;
                if (!b64) return;
                const muLawBuffer = Buffer.from(b64, 'base64');
                const pcm16 = muLawTo16BitPCM(muLawBuffer);
                const sess = sessions.get(sessionId);

                // forward to STT stream
                try {
                    if (recognizeStream) {
                        recognizeStream.write(pcm16);
                    } else {
                        console.warn('[STT] No recognizeStream available; dropping audio frame');
                    }
                } catch (err) {
                    console.error('[STT] Error writing to recognizeStream:', err);
                }
            } catch (err) {
                console.error('Error handling media event:', err && err.message ? err.message : err);
            }
        } else if (payload.event === 'stop') {
            console.log('Stream stopped (stop payload) ->', JSON.stringify(payload));
            const s = sessions.get(sessionId);
            if (s) {
                // if no transcripts were recorded, play a short fallback prompt so the caller hears something
                const hadTranscripts = s.transcripts && s.transcripts.length > 0;
                if (!hadTranscripts) {
                    // If the WebSocket is already closed, skip heavy work (TTS)
                    // and avoid attempting to send media frames to Twilio after
                    // the stream has stopped. This prevents late/malformed sends
                    // which can trigger Twilio 31951 errors.
                    if (!ws || ws.readyState !== 1) {
                        console.log('WS not open at stop event; skipping fallback TTS/send');
                    } else {
                        try {
                            const fallback = "I'm sorry, I didn't hear you. Can you repeat that?";
                            console.log('No transcripts found for session, synthesizing fallback TTS...');
                            const audioBuffer = await synthesizeSpeech(fallback);
                            console.log('Fallback TTS synthesized, bytes=', audioBuffer.length);
                            try {
                                await sendMedia(ws, audioBuffer);
                                console.log('Fallback media sent to Twilio stream');
                            } catch (err) {
                                console.error('Error sending fallback media to ws:', err && err.message ? err.message : err);
                            }
                        } catch (err) {
                            console.error('Fallback TTS error', err && err.message ? err.message : err);
                        }
                    }
                }
                try { if (s.recognizeStream) s.recognizeStream.end(); } catch (e) { }
                sessions.delete(sessionId);
            }
        }
    });

    ws.on('close', (code, reason) => {
        try {
            const reasonStr = (reason && reason.length) ? reason.toString('utf8') : '';
            console.log(`WS closed for session ${sessionId} - code=${code} reason=${reasonStr}`);
        } catch (e) {
            console.log(`WS closed for session ${sessionId} - code=${code} (failed to decode reason)`);
        }
        const s = sessions.get(sessionId);
        if (s) {
            try { if (s.recognizeStream) s.recognizeStream.end(); } catch (e) { }
            // mark closed so any concurrent tasks can detect and abort quickly
            try { s.closed = true; } catch (e) { }
            // keep acceptedFirstMedia value in logs for debugging
            try { console.log('[SESSION] acceptedFirstMedia=', !!s.acceptedFirstMedia); } catch (e) { }
            sessions.delete(sessionId);
        }
    });
});

// --- Helper: send transcript to Gemini (Generative API) ---
// Returns: { text: string, outcome: { type: 'scheduled'|'hangup'|'irrelevant'|null, details: string } }
async function getAIResponse(transcript, leadName, leadPhone) {
    // Gemini expects roles of 'user' or 'model'. Older code sent 'system' which
    // the API rejected (INVALID_ARGUMENT). To preserve the system instruction
    // include it at the top of the user prompt instead.
    const systemInstruction = `You are "Alex," a professional AI sales agent for AutomateInc. Your ONLY goal is to schedule a 15-minute demo meeting with a senior account manager. 

Key points about AutomateInc:
- We automate outbound calling and meeting booking for sales teams
- We help companies scale their outreach without hiring more staff
- Our system books qualified meetings directly into account managers' calendars

Your conversation style:
- Keep responses SHORT (1-2 sentences max)
- Be friendly but professional
- Handle objections gracefully (offer different times, ask what would work better)
- If they say they're busy, ask for a better time to call back
- If they're interested, ask for their preferred day/time this week or next
- If they explicitly decline or get hostile, politely end: "No problem, have a great day" then respond with HANGUP
- When you successfully get a time commitment, confirm it and respond with HANGUP

Remember: Your goal is to GET A SPECIFIC TIME for the meeting, not to pitch the product.`;

    const userPrompt = `${systemInstruction}\n\nLead: ${leadName} (${leadPhone})\nThey said: "${transcript}"\n\nRespond (keep it SHORT, 1-2 sentences):`;

    console.log('[AI] Sending to Gemini - transcript:', transcript);

    const apiKey = config.GEMINI_API_KEY || '';
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body = {
        // Use only allowed roles: 'user' for the prompt. Gemini will return
        // candidates with content.parts[].text as before.
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }]
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Gemini API error: ${resp.status} ${text}`);
    }

    const json = await resp.json();
    const candidate = json.candidates?.[0]?.content;
    if (!candidate) {
        console.error('[AI] No content from Gemini. Response:', JSON.stringify(json, null, 2));
        throw new Error('No content from Gemini');
    }
    const aiText = candidate.parts[0].text;
    console.log('[AI] Gemini response:', aiText);

    // Analyze the conversation for outcome detection
    const outcome = analyzeOutcome(transcript, aiText);
    console.log('[AI] Detected outcome:', outcome);

    return { text: aiText, outcome };
}

// --- Helper: Analyze conversation for automatic outcome detection ---
function analyzeOutcome(userTranscript, aiResponse) {
    const userLower = userTranscript.toLowerCase();
    const aiLower = aiResponse.toLowerCase();

    // Check if AI is ending the call with HANGUP
    if (aiLower.includes('hangup')) {
        // Determine if it's a scheduled meeting or rejection/irrelevant

        // Look for scheduling phrases in AI response or recent user transcript
        const schedulePatterns = [
            /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
            /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i,
            /\b(morning|afternoon|evening)\b/i,
            /scheduled|booked|confirmed|set up|looking forward/i
        ];

        let schedulingDetails = null;
        for (const pattern of schedulePatterns) {
            const match = aiResponse.match(pattern) || userTranscript.match(pattern);
            if (match) {
                // Extract scheduling details from the conversation
                schedulingDetails = extractSchedulingDetails(userTranscript, aiResponse);
                break;
            }
        }

        if (schedulingDetails) {
            return { type: 'scheduled', details: schedulingDetails };
        }

        // Check for rejection/not interested phrases
        const rejectionPatterns = [
            /not interested|no thanks|don't call|remove me|not a good time|busy/i,
            /never call|stop calling|leave me alone/i
        ];

        for (const pattern of rejectionPatterns) {
            if (userLower.match(pattern)) {
                return { type: 'irrelevant', details: 'Lead declined' };
            }
        }

        // Default to hangup if ending call without clear scheduling
        return { type: 'hangup', details: 'Call ended' };
    }

    // If no HANGUP detected, return null (call still in progress)
    return { type: null, details: null };
}

// --- Helper: Extract scheduling details from conversation ---
function extractSchedulingDetails(userTranscript, aiResponse) {
    // Combine both to find scheduling information
    const combined = `${userTranscript} ${aiResponse}`;

    // Try to find day and time
    const dayMatch = combined.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const timeMatch = combined.match(/\b(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)\b/i);

    if (dayMatch && timeMatch) {
        const day = dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();
        const time = timeMatch[1] + ' ' + timeMatch[2].toUpperCase().replace(/\./g, '');
        return `${day} ${time}`;
    } else if (dayMatch) {
        const day = dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();
        return day;
    } else if (timeMatch) {
        const time = timeMatch[1] + ' ' + timeMatch[2].toUpperCase().replace(/\./g, '');
        return time;
    }

    // Fallback
    return 'Meeting scheduled';
}

// --- Helper: synthesize using Google TTS ---
async function synthesizeSpeech(text) {
    if (!ttsClient) {
        throw new Error('TTS client not configured. Set TTS_PROVIDER and provider credentials (e.g., GOOGLE_APPLICATION_CREDENTIALS) in .env');
    }

    const request = {
        input: { text },
        voice: { languageCode: 'en-US', ssmlGender: 'MALE' },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 }
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const audioBuffer = Buffer.from(response.audioContent, 'base64');
    return audioBuffer;
}

server.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    console.log(`PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
});
