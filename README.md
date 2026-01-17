# Athena Discord Bot - Standalone Deployment

This is the standalone Discord bot for the DBI Nation Z community. Deploy this on a hosting platform like **Railway**, **Render**, or **Fly.io** for reliable 24/7 uptime.

## Quick Deploy Options

### Option 1: Railway (Recommended - Free Tier Available)
1. Go to [railway.app](https://railway.app)
2. Sign up/login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Create a new GitHub repo with this folder's contents, or upload directly
5. Add environment variables (see below)
6. Deploy!

### Option 2: Render (Free Tier Available)
1. Go to [render.com](https://render.com)
2. Sign up/login
3. Click "New" → "Web Service"
4. Connect your GitHub repo or upload code
5. Set Build Command: `npm install`
6. Set Start Command: `npm start`
7. Add environment variables
8. Deploy!

### Option 3: Fly.io
1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. Run: `fly launch`
3. Set secrets: `fly secrets set DISCORD_BOT_TOKEN=your_token`
4. Deploy: `fly deploy`

## Required Environment Variables

Set these in your hosting platform's dashboard:

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token from the Developer Portal |
| `OPENAI_API_KEY` | Your OpenAI API key for AI responses |
| `FIREBASE_API_KEY` | Firebase API key for the athenaai-memory project |
| `FIREBASE_MESSAGING_ID` | Firebase messaging sender ID |
| `FIREBASE_APP_ID` | Firebase app ID |

## Files Included

- `bot.js` - Main bot code with all functionality
- `package.json` - Dependencies and start script

## Features

- Responds to @mentions, DMs, and "Athena" prefix messages
- AI-powered responses using GPT-4
- Syncs nation roles (SleeperZ, ESpireZ, BoroZ, PsycZ) to Firebase
- Cross-platform message history with the mobile app
- Knowledge base integration for verified facts
- Heartbeat logging every 60 seconds

## Testing Locally

```bash
cd discord-bot-standalone
npm install
export DISCORD_BOT_TOKEN="your_token_here"
export OPENAI_API_KEY="your_openai_key"
export FIREBASE_API_KEY="your_firebase_key"
export FIREBASE_MESSAGING_ID="your_messaging_id"
export FIREBASE_APP_ID="your_app_id"
npm start
```

## Support

The bot will show "Watching over DBI Nation Z" status when online and ready.
