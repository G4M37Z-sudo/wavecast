package com.g4m37z.wavecast

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.g4m37z.wavecast.databinding.ItemReceiverBinding

/**
 * Renders the list of receivers discovered on the same network.
 * Tapping Connect calls back to MainActivity, which triggers a
 * tap-to-pair flow.
 */
class ReceiverAdapter(
    private val onConnect: (SignalingClient.Peer) -> Unit
) : ListAdapter<SignalingClient.Peer, ReceiverAdapter.VH>(Diff) {

    object Diff : DiffUtil.ItemCallback<SignalingClient.Peer>() {
        override fun areItemsTheSame(a: SignalingClient.Peer, b: SignalingClient.Peer) = a.peerId == b.peerId
        override fun areContentsTheSame(a: SignalingClient.Peer, b: SignalingClient.Peer) = a == b
    }

    fun submit(peers: List<SignalingClient.Peer>) = submitList(peers.toList())

    class VH(val binding: ItemReceiverBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val inflater = LayoutInflater.from(parent.context)
        return VH(ItemReceiverBinding.inflate(inflater, parent, false))
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val peer = getItem(position)
        holder.binding.receiverName.text = peer.name.ifBlank { "Receiver" }
        holder.binding.receiverSub.text = buildString {
            append("ID: ${peer.peerId}")
            peer.ip?.let { append(" · $it") }
        }
        holder.binding.connectBtn.setOnClickListener { onConnect(peer) }
    }
}
