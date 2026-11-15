package com.ricardo.pulseshare

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.*
import java.util.concurrent.ConcurrentHashMap

/**
 * PulseShare — malha Bluetooth Low Energy (BLE) entre celulares próximos.
 *
 * Transporte (reescrito em 2026-11-14, ideias do bitchat):
 *  - Cada aparelho anuncia (service data = tag, até 24 bytes), varre e tem um servidor GATT.
 *  - A conexão com um vizinho FICA ABERTA e é usada nos dois sentidos:
 *      cliente → servidor: escrita sem resposta na característica;
 *      servidor → cliente: notificação (o cliente assina o CCCD).
 *    Antes era uma conexão nova a cada lote (conectar/MTU/serviços/escrever/desconectar),
 *    e os dois celulares conectavam um no outro ao mesmo tempo durante um anexo.
 *  - Desempate: quem tem a tag anunciada "menor" conecta; o outro espera até 2,5 s a
 *    conexão chegar e só então conecta também (versões antigas nunca conectam de volta).
 *  - Ao assinar, o cliente se apresenta ("PSH|<tag completa>"): o servidor sabe quem está
 *    do outro lado (o endereço da conexão difere do endereço do anúncio no Android).
 *  - Mensagens grandes vão em fragmentos "PSF|<id>|<i>|<n>|<bytes>" do tamanho do MTU
 *    (formato antigo, que as versões anteriores entendem). Uma operação por vez por conexão.
 *  - Toda a lógica roda numa thread própria (bleHandler); os callbacks do Android só repassam.
 */
class BluetoothMeshHelper(private val context: Context) {

    companion object {
        private const val TAG = "PulseShareBLE"
        val SERVICE_UUID: UUID = UUID.fromString("0000fe55-0000-1000-8000-00805f9b34fb")
        val CHARACTERISTIC_MSG_UUID: UUID = UUID.fromString("0000fe56-0000-1000-8000-00805f9b34fb")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val HELLO_PREFIX = "PSH|"
        private const val MAX_CLIENT_LINKS = 6
        private const val CONNECT_TIMEOUT_MS = 12_000L
        private const val LINK_IDLE_MS = 5 * 60_000L
        private const val TIE_WAIT_MS = 2_500L
        private const val PENDING_MAX_MSGS = 400
        private const val PENDING_MAX_AGE_MS = 45_000L
        private const val OP_WATCHDOG_MS = 1_500L
        private const val PEER_FRESH_MS = 30_000L
        private const val FAIL_BACKOFF_MS = 5_000L
        private const val PROACTIVE_BACKOFF_MS = 30_000L
        private const val MAX_FRAGMENTS = 4096
        private const val ADV_TAG_BYTES = 24
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter

    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanner: BluetoothLeScanner? = null
    private var gattServer: BluetoothGattServer? = null
    private var serverChar: BluetoothGattCharacteristic? = null

    private var myUserTag: String = ""
    private var myAdvTag: String = ""
    private var isAdvertising = false
    private var isScanning = false

    data class BlePeer(
        val tag: String,
        var device: BluetoothDevice,
        var rssi: Int,
        var lastSeen: Long = System.currentTimeMillis()
    )

    // Vizinhos vistos na varredura: tag anunciada -> peer
    private val discoveredPeers = ConcurrentHashMap<String, BlePeer>()
    private val deviceToTag = ConcurrentHashMap<String, String>()

    var onMessageReceived: ((fromTag: String, messageJson: String) -> Unit)? = null
    var onPeersUpdated: ((peersJson: String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val bleThread = HandlerThread("PulseShareBLE").apply { start() }
    private val ble = Handler(bleThread.looper)

    // ---------------------------------------------------------------- conexões ----
    private enum class LinkState { CONNECTING, READY, CLOSED }

    /** Conexão em que EU sou o cliente (conectei no servidor GATT do vizinho). */
    private inner class ClientLink(val advTag: String, val device: BluetoothDevice) {
        var gatt: BluetoothGatt? = null
        var char: BluetoothGattCharacteristic? = null
        var state = LinkState.CONNECTING
        var payload = 20
        var busy = false
        var opSeq = 0
        var noResponse = true
        var subscribed = false
        val out = ArrayDeque<ByteArray>()
        var lastActivity = System.currentTimeMillis()
        val startedAt = System.currentTimeMillis()
    }

    /** Conexão em que o vizinho é o cliente (conectou no meu servidor GATT). */
    private inner class ServerLink(val device: BluetoothDevice) {
        var tag: String? = null
        var subscribed = false
        var payload = 20
        var busy = false
        var opSeq = 0
        val out = ArrayDeque<ByteArray>()
        var lastActivity = System.currentTimeMillis()
    }

    private data class Pending(val msg: String, val at: Long)

    // Estado da malha: só mexido na thread "ble"
    private val clientLinks = HashMap<String, ClientLink>()          // tag anunciada -> link
    private val serverLinks = HashMap<String, ServerLink>()          // endereço -> link
    private val pending = HashMap<String, ArrayDeque<Pending>>()      // tag anunciada -> fila
    private val tieWaitSince = HashMap<String, Long>()
    private val failedAt = HashMap<String, Long>()
    private var fragmentSeq = (System.currentTimeMillis() % 100000).toInt()

    fun isBleSupported(): Boolean {
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) &&
                bluetoothAdapter != null
    }

    fun isBluetoothEnabled(): Boolean = bluetoothAdapter?.isEnabled == true

    private fun hasBlePermissions(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val scan = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            val adv = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
            val conn = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            return scan && adv && conn
        }
        return true
    }

    // Bluetooth ligado/desligado pela pessoa: a malha volta sozinha quando o rádio liga
    private val btStateReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: android.content.Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> mainHandler.postDelayed({
                    if (myUserTag.isNotEmpty()) startBleMesh(myUserTag)
                }, 800)
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
                    isAdvertising = false
                    isScanning = false
                    ble.post { closeAllLinks() }
                    try { gattServer?.close() } catch (_: Exception) {}
                    gattServer = null
                    serverChar = null
                    discoveredPeers.clear()
                    notifyPeersUpdatedSafe()
                }
            }
        }
    }

    init {
        try {
            androidx.core.content.ContextCompat.registerReceiver(
                context, btStateReceiver,
                android.content.IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
                androidx.core.content.ContextCompat.RECEIVER_EXPORTED
            )
        } catch (e: Exception) {
            Log.w(TAG, "Sem receptor de estado do Bluetooth", e)
        }
        ble.postDelayed(object : Runnable {
            override fun run() {
                housekeeping()
                ble.postDelayed(this, 15_000L)
            }
        }, 15_000L)
    }

    private fun notifyPeersUpdatedSafe() {
        try { mainHandler.post { onPeersUpdated?.invoke(JSONArray().toString()) } } catch (_: Exception) {}
    }

    private fun advTagOf(tag: String): String {
        val b = tag.toByteArray(StandardCharsets.UTF_8)
        return if (b.size > ADV_TAG_BYTES) String(b.copyOf(ADV_TAG_BYTES), StandardCharsets.UTF_8).trimEnd('�') else tag
    }

    @SuppressLint("MissingPermission")
    fun startBleMesh(tag: String) {
        if (tag.isNotBlank()) {
            myUserTag = tag.trim()
            myAdvTag = advTagOf(myUserTag)
        }
        if (!isBleSupported() || !isBluetoothEnabled() || !hasBlePermissions()) {
            Log.w(TAG, "BLE indisponível ou sem permissão necessária")
            return
        }
        advertiser = bluetoothAdapter?.bluetoothLeAdvertiser
        scanner = bluetoothAdapter?.bluetoothLeScanner
        startGattServer()
        // Tag nova (troca de nome): reanuncia
        if (isAdvertising) stopAdvertising()
        startAdvertising()
        startScanning()
    }

    @SuppressLint("MissingPermission")
    fun stopBleMesh() {
        stopAdvertising()
        stopScanning()
        ble.post { closeAllLinks() }
        try {
            gattServer?.close()
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao fechar GATT server", e)
        }
        gattServer = null
        serverChar = null
    }

    // =========================================================================
    // 1. SERVIDOR GATT (recebe escritas; envia por notificação a quem assinou)
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startGattServer() {
        if (gattServer != null) return
        try {
            val serverCallback = object : BluetoothGattServerCallback() {
                override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
                    device ?: return
                    ble.post {
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            serverLinks.getOrPut(device.address) { ServerLink(device) }.lastActivity = System.currentTimeMillis()
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            val l = serverLinks.remove(device.address)
                            if (l != null) Log.i(TAG, "Vizinho desconectou do servidor: ${l.tag ?: device.address}")
                            reassemblies.keys.removeIf { it.startsWith(device.address + "|") }
                            emitPeersJson()
                        }
                    }
                }

                override fun onMtuChanged(device: BluetoothDevice?, mtu: Int) {
                    device ?: return
                    ble.post { serverLinks.getOrPut(device.address) { ServerLink(device) }.payload = (mtu - 3).coerceIn(20, 512) }
                }

                override fun onDescriptorWriteRequest(
                    device: BluetoothDevice?, requestId: Int, descriptor: BluetoothGattDescriptor?,
                    preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?
                ) {
                    if (device != null && descriptor?.uuid == CCCD_UUID) {
                        val on = value != null && value.isNotEmpty() && (value[0].toInt() and 0x01) != 0
                        ble.post {
                            val l = serverLinks.getOrPut(device.address) { ServerLink(device) }
                            l.subscribed = on
                            l.lastActivity = System.currentTimeMillis()
                            l.tag?.let { pump(it) }
                        }
                    }
                    if (responseNeeded && device != null) {
                        try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value) } catch (_: Exception) {}
                    }
                }

                override fun onCharacteristicWriteRequest(
                    device: BluetoothDevice?, requestId: Int, characteristic: BluetoothGattCharacteristic?,
                    preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?
                ) {
                    if (characteristic?.uuid == CHARACTERISTIC_MSG_UUID && value != null && device != null) {
                        val copy = value.copyOf()
                        ble.post {
                            val addr = device.address
                            val l = serverLinks.getOrPut(addr) { ServerLink(device) }
                            l.lastActivity = System.currentTimeMillis()
                            if (preparedWrite) {
                                // Escrita longa (cliente antigo sem MTU): acumula até o executeWrite
                                preparedBuffers.getOrPut(addr) { java.io.ByteArrayOutputStream() }.write(copy)
                            } else {
                                handleServerBytes(l, copy)
                            }
                        }
                    }
                    if (responseNeeded && device != null) {
                        try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value) } catch (e: Exception) {
                            Log.e(TAG, "Erro ao enviar resposta GATT", e)
                        }
                    }
                }

                override fun onExecuteWrite(device: BluetoothDevice?, requestId: Int, execute: Boolean) {
                    if (device != null) {
                        ble.post {
                            val buf = preparedBuffers.remove(device.address)
                            val l = serverLinks.getOrPut(device.address) { ServerLink(device) }
                            if (execute && buf != null) handleServerBytes(l, buf.toByteArray())
                        }
                    }
                    try { gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null) } catch (_: Exception) {}
                }

                override fun onNotificationSent(device: BluetoothDevice?, status: Int) {
                    device ?: return
                    ble.post {
                        val l = serverLinks[device.address] ?: return@post
                        l.busy = false
                        drainServer(l)
                    }
                }
            }

            gattServer = bluetoothManager?.openGattServer(context, serverCallback)
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val charMsg = BluetoothGattCharacteristic(
                CHARACTERISTIC_MSG_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or
                        BluetoothGattCharacteristic.PROPERTY_WRITE or
                        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE
            )
            charMsg.addDescriptor(
                BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE)
            )
            service.addCharacteristic(charMsg)
            gattServer?.addService(service)
            serverChar = charMsg
            Log.i(TAG, "Servidor GATT pronto (escrita + notificação)")
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao iniciar GATT Server", e)
        }
    }

    private fun handleServerBytes(l: ServerLink, value: ByteArray) {
        if (startsWithAscii(value, HELLO_PREFIX)) {
            val tag = String(value, HELLO_PREFIX.length, value.size - HELLO_PREFIX.length, StandardCharsets.UTF_8).trim()
            if (tag.isNotEmpty() && tag.length <= 64) {
                l.tag = tag
                deviceToTag[l.device.address] = tag
                Log.i(TAG, "Vizinho conectado e identificado: $tag")
                emitPeersJson()
                pump(advTagOf(tag))
            }
            return
        }
        handleIncomingBytes(l.device.address, value, l.tag ?: deviceToTag[l.device.address] ?: "desconhecido")
    }

    // ------------------------------------------------------- remontagem PSF ----
    private val preparedBuffers = HashMap<String, java.io.ByteArrayOutputStream>()
    private class Reassembly(val parts: Array<ByteArray?>, var received: Int = 0, val createdAt: Long = System.currentTimeMillis())
    private val reassemblies = HashMap<String, Reassembly>()

    private fun startsWithAscii(v: ByteArray, prefix: String): Boolean {
        if (v.size < prefix.length) return false
        for (i in prefix.indices) if (v[i] != prefix[i].code.toByte()) return false
        return true
    }

    private fun handleIncomingBytes(linkKey: String, value: ByteArray, fromTag: String) {
        val headerEnd = fragmentHeaderEnd(value)
        if (headerEnd < 0) {
            deliver(fromTag, String(value, StandardCharsets.UTF_8))
            return
        }
        val header = String(value, 0, headerEnd, StandardCharsets.US_ASCII).split("|")
        val id = header.getOrNull(1) ?: return
        val idx = header.getOrNull(2)?.toIntOrNull() ?: return
        val total = header.getOrNull(3)?.toIntOrNull() ?: return
        if (total <= 0 || total > MAX_FRAGMENTS || idx !in 0 until total) return
        val key = "$linkKey|$id"
        val r = reassemblies.getOrPut(key) { Reassembly(arrayOfNulls(total)) }
        if (r.parts.size != total || r.parts[idx] != null) return
        r.parts[idx] = value.copyOfRange(headerEnd + 1, value.size)
        r.received++
        if (r.received == total) {
            reassemblies.remove(key)
            val out = java.io.ByteArrayOutputStream()
            r.parts.forEach { out.write(it!!) }
            deliver(fromTag, String(out.toByteArray(), StandardCharsets.UTF_8))
        }
    }

    // Índice do 4º "|" se o valor começa com "PSF|", senão -1
    private fun fragmentHeaderEnd(value: ByteArray): Int {
        if (value.size < 8 || !startsWithAscii(value, "PSF|")) return -1
        var pipes = 0
        for (i in 0 until minOf(value.size, 64)) {
            if (value[i] == '|'.code.toByte()) {
                pipes++
                if (pipes == 4) return i
            }
        }
        return -1
    }

    private fun deliver(fromTag: String, message: String) {
        mainHandler.post { onMessageReceived?.invoke(fromTag, message) }
    }

    /** Divide a mensagem em fragmentos que cabem no MTU da conexão. */
    private fun fragment(msg: String, payload: Int): List<ByteArray> {
        val bytes = msg.toByteArray(StandardCharsets.UTF_8)
        if (bytes.size <= payload && !msg.startsWith("PSF|") && !msg.startsWith(HELLO_PREFIX)) return listOf(bytes)
        val id = (++fragmentSeq).toString(36)
        val headerMax = "PSF|$id|9999|9999|".length
        val chunk = maxOf(8, payload - headerMax)
        val total = (bytes.size + chunk - 1) / chunk
        val list = ArrayList<ByteArray>(total)
        for (i in 0 until total) {
            val head = "PSF|$id|$i|$total|".toByteArray(StandardCharsets.US_ASCII)
            list.add(head + bytes.copyOfRange(i * chunk, minOf(bytes.size, (i + 1) * chunk)))
        }
        return list
    }

    // =========================================================================
    // 2. ANÚNCIO
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startAdvertising() {
        if (isAdvertising || advertiser == null || myUserTag.isEmpty()) return
        try {
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .build()
            // Anúncio legado = 31 bytes: flags (3) + service data (4 de cabeçalho) → 24 bytes de tag
            val tagBytes = myUserTag.toByteArray(StandardCharsets.UTF_8)
            val cleanBytes = if (tagBytes.size > ADV_TAG_BYTES) tagBytes.copyOf(ADV_TAG_BYTES) else tagBytes
            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceData(ParcelUuid(SERVICE_UUID), cleanBytes)
                .build()
            advertiser?.startAdvertising(settings, data, advertiseCallback)
            isAdvertising = true
            Log.i(TAG, "Anúncio BLE iniciado para $myUserTag")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao iniciar BLE advertising", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopAdvertising() {
        if (!isAdvertising) return
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao parar BLE advertising", e)
        }
        isAdvertising = false
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "BLE Advertising falhou com código: $errorCode")
            isAdvertising = false
        }
    }

    // =========================================================================
    // 3. VARREDURA
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startScanning() {
        if (isScanning || scanner == null) return
        try {
            val filter = ScanFilter.Builder()
                .setServiceData(ParcelUuid(SERVICE_UUID), ByteArray(0))
                .build()
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            scanner?.startScan(listOf(filter), settings, scanCallback)
            isScanning = true
            Log.i(TAG, "Varredura BLE iniciada")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao iniciar BLE scan", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopScanning() {
        if (!isScanning) return
        try { scanner?.stopScan(scanCallback) } catch (e: Exception) { Log.e(TAG, "Erro ao parar BLE scan", e) }
        isScanning = false
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            result ?: return
            val serviceData = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
            if (serviceData.isEmpty()) return
            val peerTag = String(serviceData, StandardCharsets.UTF_8).trim()
            if (peerTag.isEmpty() || peerTag == myUserTag || peerTag == myAdvTag) return
            val device = result.device
            deviceToTag[device.address] = peerTag
            val existing = discoveredPeers[peerTag]
            if (existing != null) {
                existing.rssi = result.rssi
                existing.lastSeen = System.currentTimeMillis()
                existing.device = device
            } else {
                discoveredPeers[peerTag] = BlePeer(peerTag, device, result.rssi)
                Log.i(TAG, "Novo vizinho BLE: $peerTag (RSSI ${result.rssi})")
                ble.post { maybeProactiveConnect(peerTag) }
            }
            emitPeersJson()
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "BLE scan falhou com código: $errorCode")
            isScanning = false
        }
    }

    private fun peersJsonArray(): JSONArray {
        val jsonArr = JSONArray()
        val now = System.currentTimeMillis()
        val listed = HashSet<String>()
        discoveredPeers.values.forEach { peer ->
            val linked = clientLinks[peer.tag]?.state == LinkState.READY
            if (now - peer.lastSeen < PEER_FRESH_MS || linked) {
                jsonArr.put(JSONObject().put("tag", peer.tag).put("address", peer.device.address)
                    .put("rssi", peer.rssi).put("transport", "ble").put("linked", linked))
                listed.add(peer.tag)
            }
        }
        // Vizinho conectado em mim que não aparece na varredura (ex.: parou de anunciar)
        serverLinks.values.forEach { l ->
            val t = l.tag ?: return@forEach
            if (!l.subscribed || listed.contains(advTagOf(t)) || listed.contains(t)) return@forEach
            jsonArr.put(JSONObject().put("tag", t).put("address", l.device.address).put("rssi", -70)
                .put("transport", "ble").put("linked", true))
        }
        return jsonArr
    }

    private fun emitPeersJson() {
        ble.post {
            val json = peersJsonArray().toString()
            mainHandler.post { onPeersUpdated?.invoke(json) }
        }
    }

    fun getDiscoveredPeersJson(): String {
        // Chamado pela ponte JS: lê o estado na thread "ble"
        if (Looper.myLooper() == bleThread.looper) return peersJsonArray().toString()
        val lock = Object()
        var out = "[]"
        var done = false
        ble.post { synchronized(lock) { out = peersJsonArray().toString(); done = true; lock.notifyAll() } }
        synchronized(lock) { if (!done) lock.wait(500) }
        return out
    }

    // =========================================================================
    // 4. ENVIO
    // =========================================================================
    fun sendBleMessage(targetTag: String, messageJson: String): Boolean {
        val t = targetTag.trim()
        if (t.isEmpty()) return false
        val known = discoveredPeers.containsKey(t) || discoveredPeers.containsKey(advTagOf(t)) ||
                deviceToTag.values.any { it == t || it.startsWith(t) || t.startsWith(it) }
        if (!known) return false
        ble.post {
            val key = if (discoveredPeers.containsKey(t)) t else advTagOf(t)
            val q = pending.getOrPut(key) { ArrayDeque() }
            if (q.size >= PENDING_MAX_MSGS) {
                q.removeFirst()
                Log.w(TAG, "Fila BLE cheia para $key: descartei a mensagem mais antiga")
            }
            q.addLast(Pending(messageJson, System.currentTimeMillis()))
            pump(key)
        }
        return true
    }

    private fun serverLinkFor(advTag: String): ServerLink? = serverLinks.values.firstOrNull { l ->
        val t = l.tag
        l.subscribed && t != null && (t == advTag || advTagOf(t) == advTag || t.startsWith(advTag))
    }

    /** Quem conecta: a tag anunciada menor. O outro espera a conexão chegar. */
    private fun shouldInitiate(advTag: String): Boolean = myAdvTag.isEmpty() || myAdvTag < advTag

    /** Leva o que está na fila do vizinho para a melhor conexão disponível. */
    private fun pump(advTag: String) {
        val q = pending[advTag] ?: return
        val now = System.currentTimeMillis()
        while (q.isNotEmpty() && now - q.first().at > PENDING_MAX_AGE_MS) q.removeFirst()
        if (q.isEmpty()) { tieWaitSince.remove(advTag); return }

        val cl = clientLinks[advTag]
        if (cl != null && cl.state == LinkState.READY) {
            while (q.isNotEmpty()) fragment(q.removeFirst().msg, cl.payload).forEach { cl.out.addLast(it) }
            tieWaitSince.remove(advTag)
            drainClient(cl)
            return
        }
        val sl = serverLinkFor(advTag)
        if (sl != null) {
            while (q.isNotEmpty()) fragment(q.removeFirst().msg, sl.payload).forEach { sl.out.addLast(it) }
            tieWaitSince.remove(advTag)
            drainServer(sl)
            return
        }
        if (cl != null) return // conectando: segue quando ficar pronta

        val peer = discoveredPeers[advTag] ?: return
        val lastFail = failedAt[advTag] ?: 0L
        if (now - lastFail < FAIL_BACKOFF_MS) {
            ble.postDelayed({ pump(advTag) }, FAIL_BACKOFF_MS - (now - lastFail) + 50)
            return
        }
        if (shouldInitiate(advTag)) {
            connect(peer)
            return
        }
        // Desempate: espera o vizinho conectar; se não vier (versão antiga), conecta eu
        val since = tieWaitSince.getOrPut(advTag) { now }
        if (now - since >= TIE_WAIT_MS) {
            connect(peer)
        } else {
            ble.postDelayed({ pump(advTag) }, TIE_WAIT_MS - (now - since) + 50)
        }
    }

    /** Vizinho novo: quem tem a tag menor já abre a conexão (o outro lado responde por ela). */
    private fun maybeProactiveConnect(advTag: String) {
        if (!shouldInitiate(advTag) || clientLinks.containsKey(advTag)) return
        if (clientLinks.size >= MAX_CLIENT_LINKS) return
        if (System.currentTimeMillis() - (failedAt[advTag] ?: 0L) < PROACTIVE_BACKOFF_MS) return
        val peer = discoveredPeers[advTag] ?: return
        connect(peer)
    }

    @SuppressLint("MissingPermission")
    private fun connect(peer: BlePeer) {
        if (clientLinks.containsKey(peer.tag)) return
        if (!hasBlePermissions() || !isBluetoothEnabled()) return
        if (clientLinks.size >= MAX_CLIENT_LINKS) {
            // Libera a conexão parada há mais tempo
            clientLinks.values.filter { pending[it.advTag].isNullOrEmpty() && it.out.isEmpty() }
                .minByOrNull { it.lastActivity }?.let { closeClient(it, "limite de conexões") }
            if (clientLinks.size >= MAX_CLIENT_LINKS) return
        }
        val link = ClientLink(peer.tag, peer.device)
        clientLinks[peer.tag] = link
        Log.i(TAG, "Conectando em ${peer.tag}")
        try {
            link.gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                peer.device.connectGatt(context, false, clientCallback(link), BluetoothDevice.TRANSPORT_LE)
            } else {
                peer.device.connectGatt(context, false, clientCallback(link))
            }
            if (link.gatt == null) { failClient(link, "connectGatt nulo"); return }
        } catch (e: Exception) {
            failClient(link, "exceção ao conectar: ${e.message}")
            return
        }
        ble.postDelayed({
            if (link.state == LinkState.CONNECTING && clientLinks[link.advTag] === link) failClient(link, "tempo esgotado")
        }, CONNECT_TIMEOUT_MS)
    }

    @SuppressLint("MissingPermission")
    private fun clientCallback(link: ClientLink) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            ble.post {
                if (link.state == LinkState.CLOSED) { try { gatt.close() } catch (_: Exception) {}; return@post }
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    link.gatt = gatt
                    if (!gatt.requestMtu(517)) gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    if (link.state == LinkState.READY) closeClient(link, "desconectou (status $status)")
                    else failClient(link, "falha ao conectar (status $status)")
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            ble.post {
                if (status == BluetoothGatt.GATT_SUCCESS) link.payload = (mtu - 3).coerceIn(20, 512)
                if (link.state == LinkState.CONNECTING) gatt.discoverServices()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            ble.post {
                if (link.state != LinkState.CONNECTING) return@post
                val c = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHARACTERISTIC_MSG_UUID)
                if (status != BluetoothGatt.GATT_SUCCESS || c == null) { failClient(link, "serviço não encontrado"); return@post }
                link.char = c
                link.noResponse = (c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                try { gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) } catch (_: Exception) {}
                val cccd = c.getDescriptor(CCCD_UUID)
                if (cccd != null && (c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
                    // Versão nova: assina as notificações (o vizinho responde por esta conexão)
                    gatt.setCharacteristicNotification(c, true)
                    val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                    } else {
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(cccd)
                    }
                    if (!ok) linkReady(link, false)
                } else {
                    linkReady(link, false) // versão antiga: só escrita
                }
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            ble.post {
                if (link.state == LinkState.CONNECTING && descriptor.uuid == CCCD_UUID) {
                    linkReady(link, status == BluetoothGatt.GATT_SUCCESS)
                }
            }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            ble.post {
                link.busy = false
                link.lastActivity = System.currentTimeMillis()
                if (status != BluetoothGatt.GATT_SUCCESS) Log.w(TAG, "Escrita BLE para ${link.advTag} falhou (status $status)")
                drainClient(link)
            }
        }

        @Deprecated("API < 33")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val v = characteristic.value?.copyOf() ?: return
            ble.post { onClientNotification(link, v) }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            val v = value.copyOf()
            ble.post { onClientNotification(link, v) }
        }
    }

    private fun onClientNotification(link: ClientLink, value: ByteArray) {
        link.lastActivity = System.currentTimeMillis()
        discoveredPeers[link.advTag]?.lastSeen = System.currentTimeMillis()
        handleIncomingBytes("c:" + link.advTag, value, link.advTag)
    }

    private fun linkReady(link: ClientLink, subscribed: Boolean) {
        if (link.state != LinkState.CONNECTING) return
        link.state = LinkState.READY
        link.subscribed = subscribed
        link.lastActivity = System.currentTimeMillis()
        failedAt.remove(link.advTag)
        Log.i(TAG, "Conexão pronta com ${link.advTag} (MTU ${link.payload + 3}, ${if (subscribed) "dois sentidos" else "só escrita"})")
        // Apresenta-se primeiro: o servidor do vizinho passa a saber quem sou
        if (subscribed && myUserTag.isNotEmpty()) link.out.addFirst((HELLO_PREFIX + myUserTag).toByteArray(StandardCharsets.UTF_8))
        emitPeersJson()
        pump(link.advTag)
        drainClient(link)
    }

    @SuppressLint("MissingPermission")
    private fun drainClient(link: ClientLink) {
        if (link.busy || link.state != LinkState.READY) return
        val gatt = link.gatt ?: return
        val c = link.char ?: return
        val frag = link.out.pollFirst() ?: return
        val type = if (link.noResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(c, frag, type) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                c.writeType = type
                @Suppress("DEPRECATION")
                c.value = frag
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(c)
            }
        } catch (e: Exception) { false }
        if (!ok) {
            // Pilha ocupada: tenta de novo daqui a pouco
            link.out.addFirst(frag)
            ble.postDelayed({ drainClient(link) }, 15)
            return
        }
        link.busy = true
        link.lastActivity = System.currentTimeMillis()
        val seq = ++link.opSeq
        // Alguns aparelhos não avisam o fim da escrita sem resposta: segue mesmo assim
        ble.postDelayed({ if (link.busy && link.opSeq == seq) { link.busy = false; drainClient(link) } }, OP_WATCHDOG_MS)
    }

    @SuppressLint("MissingPermission")
    private fun drainServer(l: ServerLink) {
        if (l.busy || !l.subscribed) return
        val server = gattServer ?: return
        val c = serverChar ?: return
        val frag = l.out.pollFirst() ?: return
        val ok = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                server.notifyCharacteristicChanged(l.device, c, false, frag) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                c.value = frag
                @Suppress("DEPRECATION")
                server.notifyCharacteristicChanged(l.device, c, false)
            }
        } catch (e: Exception) { false }
        if (!ok) {
            l.out.addFirst(frag)
            ble.postDelayed({ drainServer(l) }, 15)
            return
        }
        l.busy = true
        l.lastActivity = System.currentTimeMillis()
        val seq = ++l.opSeq
        ble.postDelayed({ if (l.busy && l.opSeq == seq) { l.busy = false; drainServer(l) } }, OP_WATCHDOG_MS)
    }

    @SuppressLint("MissingPermission")
    private fun failClient(link: ClientLink, why: String) {
        Log.w(TAG, "Conexão com ${link.advTag} falhou: $why")
        failedAt[link.advTag] = System.currentTimeMillis()
        closeClient(link, why)
    }

    @SuppressLint("MissingPermission")
    private fun closeClient(link: ClientLink, why: String) {
        if (link.state == LinkState.CLOSED) return
        val wasReady = link.state == LinkState.READY
        link.state = LinkState.CLOSED
        if (clientLinks[link.advTag] === link) clientLinks.remove(link.advTag)
        reassemblies.keys.removeIf { it.startsWith("c:" + link.advTag + "|") }
        // Fragmentos já cortados não servem para outra conexão (outro MTU): o que estava na
        // fila de mensagens continua em "pending" e vai pela próxima conexão
        link.out.clear()
        val g = link.gatt
        try { g?.disconnect() } catch (_: Exception) {}
        ble.postDelayed({ try { g?.close() } catch (_: Exception) {} }, 300)
        if (wasReady) Log.i(TAG, "Conexão com ${link.advTag} encerrada: $why")
        emitPeersJson()
        if (!pending[link.advTag].isNullOrEmpty()) ble.postDelayed({ pump(link.advTag) }, 300)
    }

    @SuppressLint("MissingPermission")
    private fun closeAllLinks() {
        clientLinks.values.toList().forEach { closeClient(it, "malha parada") }
        clientLinks.clear()
        serverLinks.clear()
        pending.clear()
        tieWaitSince.clear()
        reassemblies.clear()
        preparedBuffers.clear()
    }

    /** A cada 15 s: fecha conexões paradas, limpa fragmentos velhos e filas vencidas. */
    private fun housekeeping() {
        val now = System.currentTimeMillis()
        clientLinks.values.toList().forEach { l ->
            val peerGone = now - (discoveredPeers[l.advTag]?.lastSeen ?: 0L) > 2 * PEER_FRESH_MS
            if (l.state == LinkState.READY && l.out.isEmpty() && pending[l.advTag].isNullOrEmpty() &&
                (now - l.lastActivity > LINK_IDLE_MS || (peerGone && now - l.lastActivity > PEER_FRESH_MS))) {
                closeClient(l, "sem uso")
            }
        }
        reassemblies.entries.removeIf { now - it.value.createdAt > 60_000L }
        pending.keys.toList().forEach { k ->
            val q = pending[k] ?: return@forEach
            while (q.isNotEmpty() && now - q.first().at > PENDING_MAX_AGE_MS) q.removeFirst()
            if (q.isEmpty()) pending.remove(k)
        }
        discoveredPeers.entries.removeIf { now - it.value.lastSeen > 10 * 60_000L && !clientLinks.containsKey(it.key) }
        // Vizinhos novos que ainda não têm conexão (ex.: depois de uma falha)
        discoveredPeers.keys.forEach { if (now - (discoveredPeers[it]?.lastSeen ?: 0L) < PEER_FRESH_MS) maybeProactiveConnect(it) }
    }
}
