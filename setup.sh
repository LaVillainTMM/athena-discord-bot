#!/bin/bash
# Athena Discord Bot — VPS Setup Script
# Run once on a fresh Ubuntu 22.04 / 24.04 droplet:
#   curl -fsSL https://raw.githubusercontent.com/LaVillainTMM/athena-discord-bot/main/setup.sh | bash

set -e

echo ""
echo "========================================"
echo "  Athena Discord Bot — VPS Setup"
echo "========================================"
echo ""

# ── 1. System packages ──────────────────────
echo "[1/6] Updating system and installing dependencies..."
apt-get update -y && apt-get upgrade -y
apt-get install -y git curl ffmpeg build-essential python3

# ── 2. Node.js 20 LTS ──────────────────────
echo "[2/6] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

# ── 3. PM2 process manager ─────────────────
echo "[3/6] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root

# ── 4. Clone the repository ─────────────────
echo "[4/6] Cloning Athena bot repository..."
if [ -d "/root/athena-discord-bot" ]; then
  echo "  Repo already exists — pulling latest..."
  cd /root/athena-discord-bot && git pull
else
  git clone https://github.com/LaVillainTMM/athena-discord-bot.git /root/athena-discord-bot
  cd /root/athena-discord-bot
fi

# ── 5. Install npm dependencies ─────────────
echo "[5/6] Installing npm packages..."
cd /root/athena-discord-bot
npm install --omit=dev

# ── 6. Create logs directory ────────────────
mkdir -p /root/athena-discord-bot/logs

echo ""
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "  1. Copy your environment variables:"
echo "     cp /root/athena-discord-bot/.env.example /root/athena-discord-bot/.env"
echo "     nano /root/athena-discord-bot/.env"
echo ""
echo "  2. Fill in all values in .env, then start the bot:"
echo "     cd /root/athena-discord-bot"
echo "     pm2 start ecosystem.config.cjs"
echo "     pm2 save"
echo ""
echo "  3. View live logs:"
echo "     pm2 logs athena-discord-bot"
echo ""
echo "  4. To update the bot in the future:"
echo "     cd /root/athena-discord-bot && git pull && npm install --omit=dev && pm2 restart athena-discord-bot"
echo ""
