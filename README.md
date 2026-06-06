# WaveCast MVP

A first Wi-Fi casting prototype: one browser captures the screen with `getDisplayMedia()`, sends it over WebRTC, and another browser/device receives it. A small Node server provides the web UI and WebSocket signaling.

## What works in this MVP

- Sender page: `/sender`
- Receiver page: `/receiver`
- WebRTC video stream on the same Wi-Fi/LAN
- Room-code pairing
- WebSocket signaling relay
- Works best between Chrome/Edge browsers on PCs. TV browsers vary.

## Run

```bash
npm install
npm start
```

Open:

- Sender: `http://YOUR_PC_LAN_IP:8080/sender`
- Receiver: `http://YOUR_PC_LAN_IP:8080/receiver`

Open the sender page first to see a QR code. Scan/open the receiver URL on the target device; it auto-joins the room. Then click **Start screen cast** on the sender.

## Notes

This is not yet Chromecast/AirPlay/Miracast. It is a custom web receiver MVP. For ultra-low latency later, add a native receiver app and hardware encoding path.
