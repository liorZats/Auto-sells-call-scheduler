# Auto-Sells Call Scheduler

An AI-powered automated outbound calling system that schedules sales meetings with leads. The system uses Twilio for phone calls, Google Cloud for speech-to-text/text-to-speech, and Google Gemini AI for intelligent conversation handling.
Live demonstrations

https://github.com/user-attachments/assets/46a9d013-561e-4436-bd48-b7c0789f5793

https://github.com/user-attachments/assets/ad3214e7-b45f-4015-9ad8-31465404b25d
## 🎯 Overview

This application automates the process of calling leads and scheduling demo meetings. It features:

- **Automated Outbound Calling**: Calls leads from a CSV list automatically
- **AI-Powered Conversations**: Uses Google Gemini to handle natural conversations
- **Smart Outcome Detection**: Automatically detects if meetings are scheduled, leads hung up, or are not interested
- **Real-time Call Status**: Live updates on call progress and outcomes
- **Auto-Advance**: Automatically moves to the next lead when current call completes

### How It Works

1. Upload a CSV list of leads (name, company, title, phone number)
2. Click "Start Dialing" to begin automated calls
3. AI agent (Alex) calls each lead and attempts to schedule a 15-minute demo
4. System automatically detects outcomes:
   - ✅ **Scheduled** - Meeting booked with date/time
   - ❌ **Hung Up** - Lead declined or hung up
   - 🚫 **Irrelevant** - Lead not interested
5. Automatically advances to next lead after each call

---

## 🏗️ Architecture

```
┌─────────────────┐
│  React Frontend │ (Port 3000)
│  - Lead Manager │
│  - Call Logger  │
└────────┬────────┘
         │ HTTP/WebSocket
         │
┌────────▼────────┐
│  Express Server │ (Port 3000)
│  - Call Control │
│  - WebSocket    │
└────────┬────────┘
         │
    ┌────┴─────┬──────────┬─────────────┐
    │          │          │             │
┌───▼───┐  ┌──▼──┐  ┌────▼─────┐  ┌───▼────┐
│Twilio │  │Google│  │  Google  │  │ Gemini │
│ Voice │  │ STT  │  │   TTS    │  │   AI   │
└───────┘  └──────┘  └──────────┘  └────────┘
```

### Technology Stack

**Frontend:**
- React 18
- WebSocket for real-time updates
- Polling for call status updates

**Backend:**
- Node.js + Express
- WebSocket (ws) for Twilio Media Streams
- Twilio SDK for call management
- Google Cloud Speech-to-Text
- Google Cloud Text-to-Speech
- Google Gemini AI API

**Audio Processing:**
- G.711 μ-law encoding/decoding
- 8kHz mono audio
- 20ms frame chunking

---

## 📋 Prerequisites

Before you begin, ensure you have:

1. **Node.js** (v16 or higher)
2. **npm** (comes with Node.js)
3. **Twilio Account** with:
   - Account SID
   - Auth Token
   - Phone number capable of making calls
4. **Google Cloud Project** with:
   - Speech-to-Text API enabled
   - Text-to-Speech API enabled
   - Service account credentials (JSON file)
5. **Google Gemini API Key**
6. **ngrok Account** (free tier works)

---

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/liorZats/Auto-sells-call-scheduler.git
cd Auto-sells-call-scheduler
```

### 2. Install Dependencies

```bash
npm install
```

This installs dependencies for both the root workspace, server, and frontend.

### 3. Set Up Google Cloud Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable APIs:
   - Cloud Speech-to-Text API
   - Cloud Text-to-Speech API
4. Create a service account:
   - Go to **IAM & Admin > Service Accounts**
   - Click **Create Service Account**
   - Grant roles: "Cloud Speech Client" and "Cloud Text-to-Speech Client"
   - Create and download JSON key
5. Save the JSON file in the project root (e.g., `credentials.json`)
6. Add to `.gitignore` to prevent committing sensitive data

### 4. Get Gemini API Key

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create an API key
3. Copy the key for your `.env` file

### 5. Set Up Twilio

1. Sign up at [Twilio](https://www.twilio.com/)
2. Get a phone number (Voice capable)
3. Find your Account SID and Auth Token in the console

### 6. Configure Environment Variables

Create a `.env` file in the `server` directory:

```bash
cd server
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Twilio Configuration
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_CALLER_NUMBER=+1234567890

# Google Cloud Configuration
GOOGLE_APPLICATION_CREDENTIALS=../your-credentials-file.json

# Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash

# Server Configuration
PORT=3000
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app

# Optional: TTS Provider (default: google)
TTS_PROVIDER=google
```

---

## 🌐 Setting Up ngrok

ngrok creates a secure tunnel from the public internet to your local server, which is necessary for Twilio to send webhooks to your application.

### Why ngrok?

Twilio needs to:
1. Send call status updates to your server
2. Stream audio via WebSocket
3. Access your `/twiml` endpoint

Since your development server runs locally, ngrok exposes it to the internet.

### Installation

**Option 1: Download Binary**
```bash
# Visit https://ngrok.com/download
# Download for your platform and add to PATH
```

**Option 2: Using npm**
```bash
npm install -g ngrok
```

### Authentication

```bash
ngrok config add-authtoken YOUR_NGROK_AUTH_TOKEN
```

Get your auth token from [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).

### Starting ngrok

In a separate terminal:

```bash
ngrok http 3000
```

You'll see output like:

```
Session Status                online
Account                       Your Name (Plan: Free)
Version                       3.x.x
Region                        United States (us)
Latency                       -
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://abc123.ngrok-free.app -> http://localhost:3000
```

**Important:** Copy the `https://abc123.ngrok-free.app` URL.

### Update PUBLIC_BASE_URL

Edit `server/.env`:

```env
PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

**Note:** Every time you restart ngrok, you get a new URL (unless you have a paid plan with reserved domains). You must update `PUBLIC_BASE_URL` each time.

### ngrok Web Interface

Access `http://127.0.0.1:4040` in your browser to:
- Inspect HTTP requests/responses
- Debug webhooks from Twilio
- View WebSocket connections

---

## 🏃 Running the Application

### 1. Start ngrok (in terminal 1)

```bash
ngrok http 3000
```

Copy the HTTPS URL and update `server/.env` with `PUBLIC_BASE_URL`.

### 2. Start the Server (in terminal 2)

```bash
cd server
node index.js
```

You should see:

```
Server listening on 3000
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.app
```

### 3. Access the Frontend

Open your browser to:
- **Local:** `http://localhost:3000`
- **Public:** `https://your-ngrok-url.ngrok-free.app`

---

## 📝 Usage Guide

### 1. Load Leads

In the textarea, enter leads in CSV format:

```
John Doe,Acme Inc,VP of Engineering,+1234567890
Jane Smith,Beta Corp,CTO,+0987654321
Bob Johnson,Gamma LLC,Director of Sales,+1122334455
```

Format: `Name,Company,Title,Phone`

Click **"Load Leads"** to parse the list.

### 2. Start Dialing

Click **"Start Dialing"** to begin automated calls.

The system will:
1. Call the first pending lead
2. Play an AI-generated greeting
3. Handle the conversation using Gemini AI
4. Detect the outcome (scheduled/hung up/irrelevant)
5. Automatically move to the next lead

### 3. Monitor Progress

**Lead List:**
- 🟢 Green background = Meeting scheduled
- 🔴 Red background = Hung up/declined
- ⚫ Gray background = Not relevant

**Call Log:**
- Shows each call as it's placed
- Example: "Calling John Doe at +1234567890"

**Status Indicator:**
- Green dot = Call active
- Gray dot = No active call

### 4. Stop Dialing

Click **"Stop Dialing"** to halt the auto-dialer after the current call completes.

### 5. End Current Call

Click **"End Current Call"** to manually terminate an active call.

---

## 🔧 Configuration

### AI Conversation Behavior

Edit the system prompt in `server/index.js` (around line 845):

```javascript
const systemInstruction = `You are "Alex," a professional AI sales agent...`;
```

Customize:
- Agent name
- Company name (currently "Alti")
- Call objective (currently scheduling 15-min demos)
- Conversation style

### Greeting Message

Edit the greeting in `server/index.js` (around line 753):

```javascript
const greeting = `Hi ${leadName}, this is Alex calling from Alti...`;
```

### Outcome Detection

The system detects outcomes based on:

**Scheduled Meeting:**
- AI response contains day names (Monday, Tuesday, etc.)
- AI response contains time (10 AM, 2 PM, etc.)
- AI says "HANGUP" after confirming time

**Hung Up:**
- AI says "HANGUP" without scheduling phrases

**Irrelevant:**
- User says "not interested", "don't call", "remove me", etc.

Edit detection logic in `analyzeOutcome()` function (around line 887).

### Audio Settings

In `sendMedia()` function:
- `chunkMs`: Frame duration (default 20ms)
- `chunkSize`: μ-law bytes per frame (default 160)

---

## 🐛 Troubleshooting

### Calls Not Working

**Check ngrok:**
```bash
curl https://your-ngrok-url.ngrok-free.app/
```

Should return the React frontend.

**Check Twilio logs:**
- Go to Twilio Console > Monitor > Logs > Calls
- Look for errors

**Check server logs:**
- Look for `[START-CALL]`, `[GREETING]`, `[STT]`, `[AI]` logs
- Check for errors

### No Audio on Calls

**Verify:**
1. Google Cloud credentials are correct
2. TTS API is enabled
3. Service account has proper permissions
4. Check server logs for `[GREETING]` and `[SEND-MEDIA]` messages

**Test TTS:**
```bash
# Check if Google TTS is working
node -e "require('@google-cloud/text-to-speech')"
```

### STT Not Detecting Speech

**Verify:**
1. Incoming audio is being received (look for `[MEDIA]` logs)
2. STT API is enabled
3. Audio conversion is working (check for decoder errors)

### Outcome Not Detected

**Check:**
1. AI is responding with "HANGUP" keyword
2. `analyzeOutcome()` function is being called
3. Backend logs show `[AI] Detected outcome:`

**Debug:**
Add more logging in `analyzeOutcome()` function.

### ngrok Session Expired

**Free tier limitation:** Sessions expire after 2 hours.

**Solution:**
- Restart ngrok
- Update `PUBLIC_BASE_URL` in `.env`
- Restart server

**Alternative:** Upgrade to ngrok paid plan for persistent URLs.

---

## 📂 Project Structure

```
Auto-sells-call-scheduler/
├── server/                      # Backend Node.js server
│   ├── index.js                # Main server file
│   ├── .env                    # Environment variables (gitignored)
│   ├── .env.example            # Example env file
│   └── package.json            # Server dependencies
├── frontend/                    # React frontend
│   ├── src/
│   │   └── SingleFileComponent.jsx  # Main React component
│   ├── public/
│   ├── package.json            # Frontend dependencies
│   └── vite.config.js          # Vite configuration
├── build/                       # Production build (generated)
├── package.json                 # Root workspace config
├── .gitignore                   # Git ignore rules
└── README.md                    # This file
```

---

## 🔐 Security Best Practices

1. **Never commit sensitive data:**
   - `.env` files
   - Google Cloud credentials
   - API keys

2. **Use environment variables:**
   - All sensitive config should be in `.env`
   - Never hardcode credentials

3. **Validate phone numbers:**
   - Add phone validation before calling
   - Prevent abuse/spam

4. **Rate limiting:**
   - Consider adding rate limits to prevent API abuse

5. **HTTPS only:**
   - Always use HTTPS in production (ngrok provides this)

---

## 🚀 Deployment to Production

### Option 1: Deploy to a VPS (Recommended)

1. **Set up a server** (DigitalOcean, AWS EC2, etc.)
2. **Get a domain** and point it to your server
3. **Install SSL certificate** (Let's Encrypt)
4. **Use PM2** to run the server:

```bash
npm install -g pm2
pm2 start server/index.js --name auto-sells
pm2 save
pm2 startup
```

5. **Update .env:**
```env
PUBLIC_BASE_URL=https://yourdomain.com
```

### Option 2: Deploy to Heroku

1. Create Heroku app
2. Set environment variables in Heroku dashboard
3. Deploy via Git:

```bash
heroku git:remote -a your-app-name
git push heroku main
```

### Option 3: Deploy to Cloud Run (Google Cloud)

1. Containerize the application
2. Push to Container Registry
3. Deploy to Cloud Run
4. Set environment variables

---

## 📊 API Endpoints

### Public Endpoints

- `GET /` - Serves React frontend
- `POST /start-call` - Initiates a new call
  - Body: `{ name, phone, leadId }`
  - Response: `{ success, callSid }`

- `GET /calls-status` - Returns current call statuses
  - Response: `[{ sid, status, to, leadId, outcome }]`

- `POST /call-status` - Twilio status webhook
  - Receives call status updates from Twilio

- `GET /twiml` - TwiML endpoint for call handling
  - Query: `leadName`, `leadPhone`
  - Returns TwiML XML

### WebSocket Endpoint

- `WS /audio` - Twilio Media Stream WebSocket
  - Handles bidirectional audio streaming
  - Query: `leadName`, `leadPhone`

---

## 🧪 Testing

### Manual Testing

1. **Test with your own phone:**
   - Add your number to the leads list
   - Start dialing
   - Answer the call and interact with the AI

2. **Check outcome detection:**
   - Say "Tuesday at 10 AM" - should detect scheduled
   - Say "not interested" - should detect irrelevant
   - Hang up immediately - should detect hangup

### Debugging Tools

1. **ngrok Web Interface:** `http://127.0.0.1:4040`
   - View all HTTP requests
   - Inspect WebSocket connections
   - Replay requests

2. **Twilio Console:**
   - Monitor > Logs > Calls
   - View call recordings
   - Check error logs

3. **Server Logs:**
   - All operations are logged with prefixes:
     - `[START-CALL]` - Call initiation
     - `[GREETING]` - Initial greeting
     - `[STT]` - Speech-to-text
     - `[AI]` - AI responses
     - `[SEND-MEDIA]` - Audio transmission

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## 📜 License

This project is licensed under the MIT License.

---

## 📧 Support

For issues or questions:
- Open an issue on GitHub
- Check existing issues for solutions

---

## 🎓 Learn More

- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text)
- [Google Cloud Text-to-Speech](https://cloud.google.com/text-to-speech)
- [Google Gemini API](https://ai.google.dev/)
- [ngrok Documentation](https://ngrok.com/docs)

---

## 🙏 Acknowledgments

Built with:
- Twilio for telephony
- Google Cloud for speech processing
- Google Gemini for AI conversations
- React for the frontend
- Node.js for the backend

---

**Made with ❤️ for automated sales outreach**
