# WaveCast MVP

A first Wi-Fi casting prototype: one browser captures the screen with `getDisplayMedia()`, sends it over WebRTC, and another browser/device receives it. A small Node server provides the web UI and WebSocket signaling.

## What works in this MVP

- Sender page: `/sender`
- Receiver page: `/receiver`
- WebRTC video stream on the same Wi-Fi/LAN
- Room-code pairing
- WebSocket signaling relay
- Network awareness: device subnet detection via WebRTC ICE
- Sender discovery list (no typing codes needed when on the same LAN)
- Receiver-initiated invite flow with sender-side confirm modal
- Works best between Chrome/Edge browsers on PCs. TV browsers vary.

## Deploy

The fastest path is **Render.com** (free tier, 5 min). See [DEPLOY.md](./DEPLOY.md) for full instructions and alternatives.

Quick version: connect your `G4M37Z-sudo/wavecast` repo to https://render.com → New → Blueprint → Apply. You'll get a public URL like `https://wavecast.onrender.com` in ~2 minutes.

> **Vercel and other serverless hosts don't work** — WaveCast needs persistent WebSocket connections and in-memory state for pairing.

## Run locally

```bash
npm install
npm start
```

Open:

- Sender: `http://YOUR_PC_LAN_IP:8080/sender`
- Receiver: `http://YOUR_PC_LAN_IP:8080/receiver`

Open the sender page first to see a QR code. Scan/open the receiver URL on the target device; it auto-joins the room. Then click **Start screen cast** on the sender.

## Test

```bash
npm test
```

80 unit tests covering protocol, pairing, presence, network detection, and server endpoints.

## Notes

This is not yet Chromecast/AirPlay/Miracast. It is a custom web receiver MVP. For ultra-low latency later, add a native receiver app and hardware encoding path.
