package com.g4m37z.wavecast

import android.content.Context
import android.media.projection.MediaProjection
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.Executors

/**
 * Sets up the WebRTC pipeline: PeerConnectionFactory, the
 * MediaProjection-backed screen capturer, and a single PeerConnection.
 *
 * On [startCapture], the capturer attaches to the MediaProjection's
 * virtual display, frames flow into the PeerConnection, and we send an
 * SDP offer through the [SignalingClient].
 *
 * Mirrors the web sender's `addTransceiver(track, { direction: 'sendonly' })`
 * pattern — we explicitly mark tracks as sendonly so the receiver SDP is
 * deterministic.
 */
class WebRtcManager(
    private val context: Context,
    private val signaling: SignalingClient,
    private val onStateChange: (State) -> Unit
) {
    enum class State { Idle, Initializing, Connecting, Connected, Failed, Closed }

    private val eglBase: EglBase = EglBase.create()
    private val executor = Executors.newSingleThreadExecutor()

    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var screenCapturer: VideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null

    /**
     * Callback invoked when we have a local SDP offer ready to send to
     * the receiver via signaling. The owner of this manager (CastService)
     * wires this up so it knows when to call signaling.sendOffer.
     */
    var onLocalSdp: ((SessionDescription) -> Unit)? = null

    fun initialize() {
        executor.execute {
            onStateChange(State.Initializing)
            val initOptions = PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
            PeerConnectionFactory.initialize(initOptions)

            val encoderFactory = DefaultVideoEncoderFactory(
                eglBase.eglContext,
                /* enableIntelVp8Encoder */ true,
                /* enableH264HighProfile */ true
            )
            val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglContext)

            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .setOptions(PeerConnectionFactory.Options())
                .createPeerConnectionFactory()
            onStateChange(State.Idle)
        }
    }

    /**
     * Begin screen capture. [mediaProjection] is the result of
     * startActivityForResult(MediaProjectionManager.createScreenCaptureIntent(), ...).
     * [includeAudio] toggles system audio capture (Android 10+).
     */
    fun startCapture(mediaProjection: MediaProjection, includeAudio: Boolean) {
        executor.execute {
            onStateChange(State.Connecting)
            val metrics = displayMetrics()
            val width = metrics.widthPixels
            val height = metrics.heightPixels
            val fps = 30

            val capturer = ScreenCapturerAndroid(mediaProjection, object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.w(TAG, "MediaProjection.onStop")
                    stop()
                }
            })
            screenCapturer = capturer

            surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase.eglContext)

            videoSource = factory?.createVideoSource(/* isScreencast */ true)
            capturer.initialize(surfaceTextureHelper, context, videoSource!!.capturerObserver)
            capturer.startCapture(width, height, fps)

            videoTrack = factory?.createVideoTrack("VIDEO_TRACK", videoSource)
            videoTrack?.setEnabled(true)

            if (includeAudio) {
                val audioConstraints = MediaConstraints()
                audioSource = factory?.createAudioSource(audioConstraints)
                audioTrack = factory?.createAudioTrack("AUDIO_TRACK", audioSource)
                audioTrack?.setEnabled(true)
            }

            buildPeerConnection()
        }
    }

    private fun buildPeerConnection() {
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
        )
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
        }
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                Log.d(TAG, "ICE state: $state")
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> onStateChange(State.Connected)
                    PeerConnection.IceConnectionState.FAILED -> onStateChange(State.Failed)
                    PeerConnection.IceConnectionState.CLOSED -> onStateChange(State.Closed)
                    else -> {}
                }
            }
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                signaling.sendIceCandidate(JSONObject().apply {
                    put("candidate", candidate.sdp)
                    put("sdpMid", candidate.sdpMid)
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                })
            }
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
            override fun onRenegotiationNeeded() {
                Log.d(TAG, "renegotiation needed")
            }
            override fun onAddTrack(p0: org.webrtc.RtpReceiver?, p1: Array<out MediaStream>?) {}
        }

        peerConnection = factory?.createPeerConnection(rtcConfig, observer)
            ?: run {
                Log.e(TAG, "Failed to create peer connection")
                onStateChange(State.Failed)
                return
            }

        // Explicit sendonly transceivers — same approach as the web sender.
        // Each track gets its own transceiver so the SDP is unambiguous.
        videoTrack?.let { track ->
            val transceiver = peerConnection!!.addTransceiver(track, MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO)
            transceiver.direction = RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
        }
        audioTrack?.let { track ->
            val transceiver = peerConnection!!.addTransceiver(track, MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO)
            transceiver.direction = RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
        }

        createOffer()
    }

    private fun createOffer() {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }
        peerConnection?.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                sdp ?: return
                peerConnection?.setLocalDescription(SimpleSdpObserver(), sdp)
                // CastService picks this up and forwards to the receiver.
                onLocalSdp?.invoke(sdp)
            }
        }, constraints)
    }

    fun applyRemoteAnswer(sdp: String) {
        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        peerConnection?.setRemoteDescription(SimpleSdpObserver(), answer)
    }

    fun applyRemoteIceCandidate(candidate: JSONObject) {
        val ice = IceCandidate(
            candidate.optString("sdpMid"),
            candidate.optInt("sdpMLineIndex"),
            candidate.optString("candidate")
        )
        peerConnection?.addIceCandidate(ice)
    }

    fun stop() {
        executor.execute {
            try { videoTrack?.setEnabled(false) } catch (_: Throwable) {}
            try { audioTrack?.setEnabled(false) } catch (_: Throwable) {}
            try { screenCapturer?.stopCapture() } catch (_: Throwable) {}
            try { videoSource?.dispose() } catch (_: Throwable) {}
            try { audioSource?.dispose() } catch (_: Throwable) {}
            try { surfaceTextureHelper?.dispose() } catch (_: Throwable) {}
            try { peerConnection?.close() } catch (_: Throwable) {}
            try { factory?.dispose() } catch (_: Throwable) {}
            try { eglBase.release() } catch (_: Throwable) {}

            videoTrack = null
            audioTrack = null
            videoSource = null
            audioSource = null
            surfaceTextureHelper = null
            screenCapturer = null
            peerConnection = null
            factory = null
            onStateChange(State.Closed)
        }
    }

    private fun displayMetrics(): DisplayMetrics {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(p0: String?) { Log.e(TAG, "SDP create failure: $p0") }
        override fun onSetFailure(p0: String?) { Log.e(TAG, "SDP set failure: $p0") }
    }

    companion object {
        private const val TAG = "WebRtcManager"
    }
}
