package com.g4m37z.wavecast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service that owns the WebRtcManager and the MediaProjection
 * for the duration of a cast. Android will kill any app that holds a
 * MediaProjection but isn't a foreground service, so this is required.
 */
class CastService : Service() {
    companion object {
        const val ACTION_START = "com.g4m37z.wavecast.START"
        const val ACTION_STOP = "com.g4m37z.wavecast.STOP"
        const val EXTRA_PROJECTION_DATA = "projectionData"
        const val EXTRA_ROOM = "room"
        const val EXTRA_INCLUDE_AUDIO = "includeAudio"
        const val EXTRA_SERVER_URL = "serverUrl"
        const val EXTRA_PEER_ID = "peerId"
        const val EXTRA_PEER_NAME = "peerName"
        private const val NOTIF_ID = 42
        private const val CHANNEL_ID = "cast"
        private const val TAG = "CastService"
    }

    private var webrtc: WebRtcManager? = null
    private var signaling: SignalingClient? = null
    private var projection: MediaProjection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCast()
                stopSelf()
            }
            ACTION_START -> startCast(intent)
        }
        return START_NOT_STICKY
    }

    private fun startCast(intent: Intent) {
        val data = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(EXTRA_PROJECTION_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_PROJECTION_DATA)
        } ?: run { Log.e(TAG, "Missing projection data"); stopSelf(); return }

        val room = intent.getStringExtra(EXTRA_ROOM) ?: run {
            Log.e(TAG, "Missing room"); stopSelf(); return
        }
        val includeAudio = intent.getBooleanExtra(EXTRA_INCLUDE_AUDIO, false)
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: "wss://g4m37z-wifi-cast.onrender.com"
        val peerId = intent.getStringExtra(EXTRA_PEER_ID) ?: return
        val peerName = intent.getStringExtra(EXTRA_PEER_NAME) ?: "Android"

        startForegroundCompat()

        val sig = SignalingClient(serverUrl) { event ->
            when (event) {
                is SignalingClient.Event.Connected -> Log.d(TAG, "signaling connected: presence=${event.isPresenceSocket}")
                is SignalingClient.Event.Disconnected -> Log.d(TAG, "signaling disconnected")
                is SignalingClient.Event.Error -> Log.e(TAG, "signaling error: ${event.message}")
                is SignalingClient.Event.IceCandidate -> webrtc?.applyRemoteIceCandidate(event.candidate)
                is SignalingClient.Event.PairOffer -> {
                    // The signaling server gives us the receiver's SDP answer
                    // (it arrives as a "PairOffer" event in our local naming).
                    webrtc?.applyRemoteAnswer(event.sdp)
                }
                else -> {}
            }
        }
        signaling = sig
        sig.joinRoom(room, peerId, peerName)

        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = mgr.getMediaProjection(MediaProjectionManager.TYPE_SCREEN_CAPTURE, data)

        webrtc = WebRtcManager(this, sig) { state ->
            Log.d(TAG, "webrtc state: $state")
        }.also { mgr ->
            mgr.onLocalSdp = { sdp ->
                sig.sendOffer(room, sdp.description)
            }
            mgr.initialize()
            mgr.startCapture(projection!!, includeAudio)
        }
    }

    private fun stopCast() {
        try { webrtc?.stop() } catch (_: Throwable) {}
        try { projection?.stop() } catch (_: Throwable) {}
        try { signaling?.disconnect() } catch (_: Throwable) {}
        webrtc = null
        projection = null
        signaling = null
    }

    override fun onDestroy() {
        stopCast()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, CastService::class.java).apply { action = ACTION_STOP }
        val stopPi = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WaveCast is casting")
            .setContentText("Tap to return to the app, or use Stop to end the cast.")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(CHANNEL_ID, "Casting", NotificationManager.IMPORTANCE_LOW)
                ch.description = "Shown while WaveCast is sharing your screen"
                nm.createNotificationChannel(ch)
            }
        }
    }
}
