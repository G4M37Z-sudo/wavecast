package com.g4m37z.wavecast

import android.content.Intent
import android.content.SharedPreferences
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.g4m37z.wavecast.databinding.ActivityMainBinding
import java.util.UUID

/**
 * Single-screen UI for the Android sender.
 *
 *   - Top: device name input + server URL (configured once, saved to prefs)
 *   - Middle: list of receivers discovered on the network (via /ws/presence)
 *   - Bottom: code input for typed pairing + Start casting button
 *
 *   The Start button requests MediaProjection permission (Android's
 *   system dialog), and on approval hands the projection to CastService.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: SharedPreferences
    private lateinit var receiverAdapter: ReceiverAdapter

    private var signaling: SignalingClient? = null
    private var peerId: String = ""
    private val discoveredReceivers = mutableListOf<SignalingClient.Peer>()

    private val projectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK) {
            toast("Screen capture permission denied")
            return@registerForActivityResult
        }
        val data = result.data ?: return@registerForActivityResult
        startCastService(data)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = getSharedPreferences("wavecast", MODE_PRIVATE)
        peerId = prefs.getString("peerId", null) ?: generatePeerId().also {
            prefs.edit().putString("peerId", it).apply()
        }

        binding.deviceNameInput.setText(prefs.getString("deviceName", defaultName()))
        binding.serverUrlInput.setText(prefs.getString("serverUrl", DEFAULT_SERVER_URL))

        receiverAdapter = ReceiverAdapter { peer ->
            // User tapped Connect on a discovered receiver — start a
            // tap-to-pair flow: reserve a room, then start the cast.
            startCastForPeer(peer)
        }
        binding.receiversList.apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = receiverAdapter
        }

        binding.deviceNameInput.addTextChangedListener(simpleTextWatcher {
            prefs.edit().putString("deviceName", it).apply()
            connectPresence()
        })
        binding.serverUrlInput.addTextChangedListener(simpleTextWatcher {
            prefs.edit().putString("serverUrl", it).apply()
        })

        binding.codeInput.addTextChangedListener(simpleTextWatcher { code ->
            binding.joinCodeBtn.isEnabled = code.isNotBlank()
        })
        binding.joinCodeBtn.setOnClickListener { joinWithCode() }
        binding.startCastBtn.setOnClickListener { requestProjection() }

        connectPresence()
    }

    override fun onResume() {
        super.onResume()
        // Re-announce ourselves in case the server restarted.
        connectPresence()
    }

    override fun onDestroy() {
        super.onDestroy()
        signaling?.disconnect()
    }

    private fun connectPresence() {
        signaling?.disconnect()
        val name = binding.deviceNameInput.text.toString().ifBlank { defaultName() }
        val url = binding.serverUrlInput.text.toString().ifBlank { DEFAULT_SERVER_URL }
        val client = SignalingClient(toWsUrl(url)) { event ->
            when (event) {
                is SignalingClient.Event.Connected -> {}
                is SignalingClient.Event.PresenceSnapshot -> {
                    // Show only receivers, not other senders
                    val receivers = event.peers.filter { it.role == "receiver" }
                    runOnUiThread {
                        discoveredReceivers.clear()
                        discoveredReceivers.addAll(receivers)
                        receiverAdapter.submit(receivers)
                        binding.emptyState.visibility =
                            if (receivers.isEmpty()) View.VISIBLE else View.GONE
                    }
                }
                is SignalingClient.Event.PeerJoined -> {
                    if (event.peer.role == "receiver") runOnUiThread {
                        discoveredReceivers.add(event.peer)
                        receiverAdapter.submit(discoveredReceivers.toList())
                        binding.emptyState.visibility = View.GONE
                    }
                }
                is SignalingClient.Event.PeerLeft -> runOnUiThread {
                    discoveredReceivers.removeAll { it.peerId == event.peerId }
                    receiverAdapter.submit(discoveredReceivers.toList())
                    if (discoveredReceivers.isEmpty()) {
                        binding.emptyState.visibility = View.VISIBLE
                    }
                }
                is SignalingClient.Event.Error -> runOnUiThread {
                    toast("Signaling: ${event.message}")
                }
                else -> {}
            }
        }
        client.connectPresence(peerId, name)
        signaling = client
    }

    private fun startCastForPeer(peer: SignalingClient.Peer) {
        val url = binding.serverUrlInput.text.toString().ifBlank { DEFAULT_SERVER_URL }
        val name = binding.deviceNameInput.text.toString().ifBlank { defaultName() }
        val client = SignalingClient(toWsUrl(url)) { /* events handled in service */ }
        client.reserveRoom(peerId, name) { result ->
            result.fold(
                onSuccess = { resp ->
                    runOnUiThread {
                        castRoomCode = resp.room
                        binding.codeInput.setText(resp.room)
                        // Now ask for MediaProjection
                        requestProjection()
                    }
                },
                onFailure = { e -> runOnUiThread { toast("Failed to reserve: ${e.message}") } }
            )
        }
    }

    private var castRoomCode: String? = null

    private fun joinWithCode() {
        val code = binding.codeInput.text.toString().trim().uppercase()
        if (code.isEmpty()) return
        castRoomCode = code
        requestProjection()
    }

    private fun requestProjection() {
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(mgr.createScreenCaptureIntent())
    }

    private fun startCastService(data: Intent) {
        val room = castRoomCode ?: binding.codeInput.text.toString().trim().uppercase().ifEmpty {
            toast("No room code"); return
        }
        val intent = Intent(this, CastService::class.java).apply {
            action = CastService.ACTION_START
            putExtra(CastService.EXTRA_PROJECTION_DATA, data)
            putExtra(CastService.EXTRA_ROOM, room)
            putExtra(CastService.EXTRA_INCLUDE_AUDIO, false)
            putExtra(CastService.EXTRA_SERVER_URL, binding.serverUrlInput.text.toString().ifBlank { DEFAULT_SERVER_URL })
            putExtra(CastService.EXTRA_PEER_ID, peerId)
            putExtra(CastService.EXTRA_PEER_NAME, binding.deviceNameInput.text.toString().ifBlank { defaultName() })
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        toast("Casting to $room")
    }

    private fun defaultName() = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    private fun generatePeerId(): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return (1..6).map { alphabet.random() }.joinToString("")
    }

    private fun toWsUrl(httpUrl: String): String =
        httpUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
            .trimEnd('/')

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun simpleTextWatcher(after: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) { after(s?.toString() ?: "") }
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://g4m37z-wifi-cast.onrender.com"
    }
}
