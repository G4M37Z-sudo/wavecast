package com.g4m37z.wavecast

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Talks to the WaveCast signaling server using the same WebSocket
 * protocol as the web sender (see src/protocol.js in the server repo).
 *
 * Two WebSocket connections are used, matching the web sender:
 *   1. /ws/presence — announces our presence, sees other senders/receivers
 *   2. /ws (after pairing) — relays SDP offer/answer and ICE candidates
 *
 * The base URL is configurable in [serverUrl] so the same APK can be
 * pointed at localhost (emulator), a LAN IP, or the deployed Render
 * instance. The web sender uses wss:// on Render; this client does the same.
 */
class SignalingClient(
    private val serverUrl: String,
    private val onEvent: (Event) -> Unit
) {
    sealed class Event {
        data class PresenceSnapshot(val peers: List<Peer>) : Event()
        data class PeerJoined(val peer: Peer) : Event()
        data class PeerLeft(val peerId: String) : Event()
        data class PairInvite(val fromPeerId: String, val fromName: String, val room: String) : Event()
        data class PairOffer(val room: String, val sdp: String) : Event()
        data class IceCandidate(val candidate: JSONObject) : Event()
        data class Error(val message: String) : Event()
        data class Connected(val isPresenceSocket: Boolean) : Event()
        data class Disconnected(val isPresenceSocket: Boolean) : Event()
    }

    data class Peer(
        val peerId: String,
        val name: String,
        val role: String,
        val ip: String? = null,
        val subnet: String? = null
    )

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // no read timeout for WebSocket
        .build()

    private var presenceSocket: WebSocket? = null
    private var roomSocket: WebSocket? = null

    fun connectPresence(peerId: String, name: String) {
        val wsUrl = "$serverUrl/ws/presence?peerId=$peerId&role=sender&name=${name.encode()}"
        val request = Request.Builder().url(wsUrl).build()
        presenceSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onEvent(Event.Connected(isPresenceSocket = true))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (e: Exception) { return }
                when (msg.optString("type")) {
                    "presence-snapshot" -> {
                        val peers = msg.optJSONArray("peers")
                        val list = if (peers != null) (0 until peers.length()).map { i ->
                            val p = peers.getJSONObject(i)
                            Peer(
                                peerId = p.optString("peerId"),
                                name = p.optString("name"),
                                role = p.optString("role"),
                                ip = p.optString("ip").ifEmpty { null },
                                subnet = p.optString("subnet").ifEmpty { null }
                            )
                        } else emptyList()
                        onEvent(Event.PresenceSnapshot(list))
                    }
                    "peer-joined" -> {
                        val p = msg.optJSONObject("peer") ?: return
                        onEvent(Event.PeerJoined(Peer(
                            peerId = p.optString("peerId"),
                            name = p.optString("name"),
                            role = p.optString("role"),
                            ip = p.optString("ip").ifEmpty { null },
                            subnet = p.optString("subnet").ifEmpty { null }
                        )))
                    }
                    "peer-left" -> onEvent(Event.PeerLeft(msg.optString("peerId")))
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onEvent(Event.Error("presence: ${t.message}"))
                onEvent(Event.Disconnected(isPresenceSocket = true))
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
        })
    }

    fun joinRoom(room: String, peerId: String, name: String) {
        val wsUrl = "$serverUrl/ws?room=${room.encode()}&role=sender&peerId=$peerId&name=${name.encode()}"
        val request = Request.Builder().url(wsUrl).build()
        roomSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                onEvent(Event.Connected(isPresenceSocket = false))
                // The server expects a join message after the WS opens
                webSocket.send(JSONObject().apply {
                    put("type", "join")
                    put("role", "sender")
                    put("room", room)
                    put("peerId", peerId)
                    put("name", name)
                }.toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (e: Exception) { return }
                when (msg.optString("type")) {
                    "peer-ready" -> {
                        // The receiver is in the room. We can start the
                        // WebRTC offer. The signaling layer doesn't tell
                        // us the SDP — we generate it ourselves in
                        // WebRtcManager when we get this signal.
                    }
                    "answer" -> {
                        onEvent(Event.PairOffer(
                            room = msg.optString("room", room),
                            sdp = msg.optString("sdp")
                        ))
                    }
                    "ice-candidate" -> {
                        val c = msg.optJSONObject("candidate") ?: return
                        onEvent(Event.IceCandidate(c))
                    }
                    "peer-left" -> onEvent(Event.PeerLeft(msg.optString("peerId")))
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onEvent(Event.Error("room: ${t.message}"))
                onEvent(Event.Disconnected(isPresenceSocket = false))
            }
        })
    }

    fun sendOffer(room: String, sdp: String) {
        roomSocket?.send(JSONObject().apply {
            put("type", "offer")
            put("room", room)
            put("sdp", sdp)
        }.toString())
    }

    fun sendIceCandidate(candidate: JSONObject) {
        roomSocket?.send(JSONObject().apply {
            put("type", "ice-candidate")
            put("candidate", candidate)
        }.toString())
    }

    fun reserveRoom(peerId: String, name: String, callback: (Result) -> Unit) {
        // POST /api/pairing/reserve — returns a room code we can share
        val httpUrl = "$serverUrl/api/pairing/reserve"
        val body = JSONObject().apply {
            put("senderId", peerId)
            put("senderName", name)
        }.toString().toRequestBody("application/json".toMediaType())

        val request = Request.Builder().url(httpUrl).post(body).build()
        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                callback(Result.failure(e))
            }
            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use { r ->
                    if (!r.isSuccessful) {
                        callback(Result.failure(Exception("HTTP ${r.code}")))
                        return
                    }
                    val body = r.body?.string() ?: ""
                    val json = try { JSONObject(body) } catch (e: Exception) {
                        callback(Result.failure(e)); return
                    }
                    callback(Result.success(ReserveResponse(
                        room = json.optString("room"),
                        requestId = json.optString("requestId")
                    )))
                }
            }
        })
    }

    data class ReserveResponse(val room: String, val requestId: String)

    fun disconnect() {
        presenceSocket?.close(1000, "bye")
        roomSocket?.close(1000, "bye")
        presenceSocket = null
        roomSocket = null
    }

    private fun String.encode(): String =
        java.net.URLEncoder.encode(this, "UTF-8")
}

/* --- OkHttp request body helpers (kept here to avoid an extra file) --- */

private fun String.toRequestBody(contentType: okhttp3.MediaType?) =
    okhttp3.RequestBody.create(contentType, this)

private fun String.toMediaType() = okhttp3.MediaType.parse(this)
