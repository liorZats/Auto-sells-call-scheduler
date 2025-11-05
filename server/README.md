Node.js Express server for Auto-sells-call-scheduler

This server provides:
- POST /start-call - initiate an outbound Twilio call
- GET /twiml - TwiML response used by Twilio to open a WebSocket media stream
- WebSocket /audio - handle bi-directional audio between Twilio and backend STT / AI / TTS pipeline

Setup
1. Copy `.env.example` to `.env` and fill values.
2. Install dependencies:

   npm install

3. Start the server:

   npm start

Notes & Integration
- This code expects either Google Cloud credentials (for streaming Speech-to-Text and Text-to-Speech) and/or a Gemini API key for inference.
- Do NOT store production API keys in client-side code. Use environment variables.
