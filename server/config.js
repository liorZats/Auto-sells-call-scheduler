const path = require('path');
// Load the .env file that lives next to this config file (server/.env)
require('dotenv').config({ path: path.join(__dirname, '.env') });

const requiredTwilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_CALLER_NUMBER'];
const missingTwilio = requiredTwilio.filter(k => !process.env[k]);
if (missingTwilio.length) {
    console.warn(`Warning: Missing Twilio environment variables: ${missingTwilio.join(', ')}. /start-call will fail until they are set.`);
}

const config = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

    // Twilio
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
    TWILIO_CALLER_NUMBER: process.env.TWILIO_CALLER_NUMBER || '',

    // Gemini / LLM
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-09-2025',

    // Google credentials (optional if using Google STT/TTS)
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',

    // Feature toggles
    STT_PROVIDER: process.env.STT_PROVIDER || 'google',
    TTS_PROVIDER: process.env.TTS_PROVIDER || 'google'
};

module.exports = config;
