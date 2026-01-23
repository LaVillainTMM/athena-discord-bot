# Athena Discord Bot — Canonical Deployment

Athena is the authoritative Discord-based AI interface for the Athena AI system.
She acts as the **identity gatekeeper**, **memory interface**, and **assessment authority**
for users across Discord, Mobile, and Desktop platforms.

This repository contains the **Discord control plane** for Athena.

---

## 🧠 Core Responsibilities

Athena (Discord):

- Identifies users across platforms
- Maintains a unified identity per human (not per account)
- Stores message history in Firebase
- Conducts assessments (quiz-based role assignment)
- Assigns SleeperZ roles on Discord
- Interfaces with Google Gemini for reasoning
- Runs 24/7 via Railway

---

## 🏗️ Tech Stack

- **Node.js** 18+
- **discord.js** v14
- **Firebase Admin SDK**
  - Firestore (canonical memory)
  - Realtime DB (optional presence)
- **Google Gemini API**
- **Railway** (hosting & secrets)
- **GitHub** (source control)

---

## 📁 Project Structure


> User data is **never** stored in this repository.
> All user state lives in Firebase.

---

## 🔐 Required Environment Variables (Railway)

Set **only** the following in Railway:



Each **human** has one `athenaUserId`, regardless of:
- Number of Discord accounts
- Devices
- Platforms

---

## 🚀 Deployment (Railway)

1. Push this repo to GitHub
2. Create a Railway project → Deploy from GitHub
3. Add environment variables
4. Deploy

Athena will come online automatically.

---

## 🛡️ Security Notes

- Secrets are **never** committed
- Firebase Admin SDK is server-only
- API keys must be rotated if exposed
- User voice recordings are NOT stored (features only)

---

## 📌 Status

This repository currently supports:
- Discord messaging
- Gemini-based responses
- Firebase memory
- Identity creation (foundation)

Next phases add:
- Full quiz flow
- Role gating
- Cross-platform session sync

---

## 🧭 Philosophy

Athena is not a chatbot.
She is a **system authority**.

Structure first. Intelligence second.
