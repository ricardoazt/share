package com.ricardo.pulseshare

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.*
import java.util.concurrent.ConcurrentHashMap

/**
 * PulseShare Bluetooth Low Energy (BLE) Mesh & Direct Communication Helper
 * Permite descoberta automática e troca de mensagens P2P offline entre smartphones próximos.
 */
class BluetoothMeshHelper(private val context: Context) {

    companion object {
        private const val TAG = "PulseShareBLE"
        val SERVICE_UUID: UUID = UUID.fromString("0000fe55-0000-1000-8000-00805f9b34fb")
        val CHARACTERISTIC_MSG_UUID: UUID = UUID.fromString("0000fe56-0000-1000-8000-00805f9b34fb")
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter

    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanner: BluetoothLeScanner? = null
    private var gattServer: BluetoothGattServer? = null

    private var myUserTag: String = ""
    private var isAdvertising = false
    private var isScanning = false

    // Peers descobertos via BLE: tag -> BlePeerInfo
    data class BlePeer(
        val tag: String,
        val device: BluetoothDevice,
        var rssi: Int,
        var lastSeen: Long = System.currentTimeMillis()
    )

    private val discoveredPeers = ConcurrentHashMap<String, BlePeer>()
    private val deviceToTag = ConcurrentHashMap<String, String>()

    // Callbacks para o frontend
    var onMessageReceived: ((fromTag: String, messageJson: String) -> Unit)? = null
    var onPeersUpdated: ((peersJson: String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    fun isBleSupported(): Boolean {
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) &&
                bluetoothAdapter != null
    }

    fun isBluetoothEnabled(): Boolean {
        return bluetoothAdapter?.isEnabled == true
    }

    private fun hasBlePermissions(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val scan = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            val adv = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
            val conn = context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            return scan && adv && conn
        }
        return true
    }

    /**
     * Inicia a malha BLE: inicia GATT Server, Advertising com a Tag do usuário e Escaneamento contínuo
     */
    @SuppressLint("MissingPermission")
    fun startBleMesh(tag: String) {
        if (!isBleSupported() || !isBluetoothEnabled() || !hasBlePermissions()) {
            Log.w(TAG, "BLE indisponível ou sem permissão necessária")
            return
        }

        myUserTag = tag.trim()
        advertiser = bluetoothAdapter?.bluetoothLeAdvertiser
        scanner = bluetoothAdapter?.bluetoothLeScanner

        startGattServer()
        startAdvertising()
        startScanning()
    }

    @SuppressLint("MissingPermission")
    fun stopBleMesh() {
        stopAdvertising()
        stopScanning()
        try {
            gattServer?.close()
            gattServer = null
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao fechar GATT server", e)
        }
    }

    // =========================================================================
    // 1. GATT SERVER (Recebe mensagens de outros nós)
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startGattServer() {
        if (gattServer != null) return
        try {
            val serverCallback = object : BluetoothGattServerCallback() {
                override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
                    super.onConnectionStateChange(device, status, newState)
                    Log.d(TAG, "GATT Server connection state change: device=${device?.address}, state=$newState")
                }

                override fun onCharacteristicWriteRequest(
                    device: BluetoothDevice?,
                    requestId: Int,
                    characteristic: BluetoothGattCharacteristic?,
                    preparedWrite: Boolean,
                    responseNeeded: Boolean,
                    offset: Int,
                    value: ByteArray?
                ) {
                    super.onCharacteristicWriteRequest(device, requestId, characteristic, preparedWrite, responseNeeded, offset, value)

                    if (characteristic?.uuid == CHARACTERISTIC_MSG_UUID && value != null) {
                        val addr = device?.address ?: "?"
                        if (preparedWrite) {
                            // Escrita longa (sem MTU negociado): acumula até o executeWrite
                            val buf = preparedBuffers.getOrPut(addr) { java.io.ByteArrayOutputStream() }
                            buf.write(value)
                        } else {
                            handleIncomingBytes(addr, value)
                        }
                    }

                    if (responseNeeded && device != null) {
                        try {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                        } catch (e: Exception) {
                            Log.e(TAG, "Erro ao enviar resposta GATT", e)
                        }
                    }
                }

                override fun onExecuteWrite(device: BluetoothDevice?, requestId: Int, execute: Boolean) {
                    super.onExecuteWrite(device, requestId, execute)
                    val addr = device?.address ?: "?"
                    val buf = preparedBuffers.remove(addr)
                    if (execute && buf != null) handleIncomingBytes(addr, buf.toByteArray())
                    try {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                    } catch (e: Exception) {
                        Log.e(TAG, "Erro ao responder executeWrite", e)
                    }
                }
            }

            gattServer = bluetoothManager?.openGattServer(context, serverCallback)
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

            val charMsg = BluetoothGattCharacteristic(
                CHARACTERISTIC_MSG_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or
                        BluetoothGattCharacteristic.PROPERTY_WRITE or
                        BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            service.addCharacteristic(charMsg)
            gattServer?.addService(service)
            Log.i(TAG, "GATT Server inicializado com sucesso para PulseShare")
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao iniciar GATT Server", e)
        }
    }

    // Remontagem de fragmentos "PSF|<id>|<i>|<n>|<dados>" (UTF-8 cortado em bytes)
    private val preparedBuffers = ConcurrentHashMap<String, java.io.ByteArrayOutputStream>()
    private data class Reassembly(val parts: Array<ByteArray?>, var received: Int = 0, val createdAt: Long = System.currentTimeMillis())
    private val reassemblies = ConcurrentHashMap<String, Reassembly>()

    private fun handleIncomingBytes(addr: String, value: ByteArray) {
        val fromTag = deviceToTag[addr] ?: "desconhecido"
        val headerEnd = fragmentHeaderEnd(value)
        if (headerEnd < 0) {
            deliver(fromTag, String(value, StandardCharsets.UTF_8))
            return
        }
        val header = String(value, 0, headerEnd, StandardCharsets.US_ASCII).split("|")
        // header = [PSF, id, i, n]
        val id = header.getOrNull(1) ?: return
        val idx = header.getOrNull(2)?.toIntOrNull() ?: return
        val total = header.getOrNull(3)?.toIntOrNull() ?: return
        if (total <= 0 || total > 64 || idx !in 0 until total) return
        val key = "$addr|$id"
        val now = System.currentTimeMillis()
        reassemblies.entries.removeIf { now - it.value.createdAt > 60000 }
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
        if (value.size < 8 || value[0] != 'P'.code.toByte() || value[1] != 'S'.code.toByte() ||
            value[2] != 'F'.code.toByte() || value[3] != '|'.code.toByte()) return -1
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
        Log.i(TAG, "Mensagem BLE recebida de $fromTag (${message.length} chars)")
        mainHandler.post { onMessageReceived?.invoke(fromTag, message) }
    }

    // =========================================================================
    // 2. ADVERTISING (Anuncia presença do nó com a Tag)
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startAdvertising() {
        if (isAdvertising || advertiser == null || myUserTag.isEmpty()) return

        try {
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build()

            // Anúncio legado = 31 bytes: flags (3) + service data (4 de cabeçalho) → sobram 24
            // bytes para a tag. Sem a lista de UUIDs (o service data já identifica o serviço),
            // cabem tags maiores; se ainda passar, o app resolve pelo prefixo.
            val tagBytes = myUserTag.toByteArray(StandardCharsets.UTF_8)
            val cleanBytes = if (tagBytes.size > 24) tagBytes.copyOf(24) else tagBytes

            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceData(ParcelUuid(SERVICE_UUID), cleanBytes)
                .build()

            advertiser?.startAdvertising(settings, data, advertiseCallback)
            isAdvertising = true
            Log.i(TAG, "Iniciado anúncio BLE para tag: $myUserTag")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao iniciar BLE advertising", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopAdvertising() {
        if (!isAdvertising) return
        try {
            advertiser?.stopAdvertising(advertiseCallback)
            isAdvertising = false
            Log.i(TAG, "BLE advertising parado")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao parar BLE advertising", e)
        }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            super.onStartSuccess(settingsInEffect)
            Log.d(TAG, "BLE Advertising iniciado com sucesso")
        }

        override fun onStartFailure(errorCode: Int) {
            super.onStartFailure(errorCode)
            Log.e(TAG, "BLE Advertising falhou com código: $errorCode")
            isAdvertising = false
        }
    }

    // =========================================================================
    // 3. SCANNING (Descobre nós próximos)
    // =========================================================================
    @SuppressLint("MissingPermission")
    private fun startScanning() {
        if (isScanning || scanner == null) return

        try {
            // Casa qualquer anúncio com service data do PulseShare (novo e antigo)
            val filter = ScanFilter.Builder()
                .setServiceData(ParcelUuid(SERVICE_UUID), ByteArray(0))
                .build()

            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()

            scanner?.startScan(listOf(filter), settings, scanCallback)
            isScanning = true
            Log.i(TAG, "Escaneamento BLE iniciado")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao iniciar BLE scan", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopScanning() {
        if (!isScanning) return
        try {
            scanner?.stopScan(scanCallback)
            isScanning = false
            Log.i(TAG, "Escaneamento BLE finalizado")
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao parar BLE scan", e)
        }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult?) {
            super.onScanResult(callbackType, result)
            result ?: return

            val serviceData = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID))
            if (serviceData != null && serviceData.isNotEmpty()) {
                val peerTag = String(serviceData, StandardCharsets.UTF_8).trim()
                if (peerTag.isNotEmpty() && peerTag != myUserTag) {
                    val device = result.device
                    deviceToTag[device.address] = peerTag

                    val existing = discoveredPeers[peerTag]
                    if (existing != null) {
                        existing.rssi = result.rssi
                        existing.lastSeen = System.currentTimeMillis()
                    } else {
                        discoveredPeers[peerTag] = BlePeer(peerTag, device, result.rssi)
                        Log.i(TAG, "Novo peer BLE detectado: $peerTag (RSSI: ${result.rssi})")
                    }

                    emitPeersJson()
                }
            }
        }

        override fun onScanFailed(errorCode: Int) {
            super.onScanFailed(errorCode)
            Log.e(TAG, "BLE scan falhou com código: $errorCode")
            isScanning = false
        }
    }

    private fun emitPeersJson() {
        mainHandler.post {
            val jsonArr = JSONArray()
            val now = System.currentTimeMillis()

            // Filtra peers vistos nos últimos 30 segundos
            discoveredPeers.values.forEach { peer ->
                if (now - peer.lastSeen < 30000) {
                    val obj = JSONObject()
                    obj.put("tag", peer.tag)
                    obj.put("address", peer.device.address)
                    obj.put("rssi", peer.rssi)
                    obj.put("transport", "ble")
                    jsonArr.put(obj)
                }
            }

            onPeersUpdated?.invoke(jsonArr.toString())
        }
    }

    fun getDiscoveredPeersJson(): String {
        val jsonArr = JSONArray()
        val now = System.currentTimeMillis()
        discoveredPeers.values.forEach { peer ->
            if (now - peer.lastSeen < 30000) {
                val obj = JSONObject()
                obj.put("tag", peer.tag)
                obj.put("address", peer.device.address)
                obj.put("rssi", peer.rssi)
                obj.put("transport", "ble")
                jsonArr.put(obj)
            }
        }
        return jsonArr.toString()
    }

    // =========================================================================
    // 4. CLIENT GATT (Envia mensagem direta para um peer via BLE)
    // =========================================================================
    // Fila por destino: uma conexão GATT por vez, MTU negociado (até 517) e
    // fragmentos escritos em sequência; o servidor remonta pelo cabeçalho PSF.
    private val sendQueues = ConcurrentHashMap<String, java.util.concurrent.ConcurrentLinkedQueue<String>>()
    private val sending = ConcurrentHashMap<String, Boolean>()
    private var fragmentSeq = 0

    fun sendBleMessage(targetTag: String, messageJson: String): Boolean {
        if (discoveredPeers[targetTag] == null) return false
        val q = sendQueues.getOrPut(targetTag) { java.util.concurrent.ConcurrentLinkedQueue() }
        if (q.size > 50) q.poll() // evita crescer sem limite com o peer fora de alcance
        q.add(messageJson)
        mainHandler.post { drainQueue(targetTag) }
        return true
    }

    @SuppressLint("MissingPermission")
    private fun drainQueue(targetTag: String) {
        if (sending[targetTag] == true) return
        val q = sendQueues[targetTag] ?: return
        val peer = discoveredPeers[targetTag]
        if (peer == null) { q.clear(); return }
        if (q.isEmpty()) return
        sending[targetTag] = true

        val fragments = java.util.ArrayDeque<ByteArray>()
        var mtuPayload = 20
        var finished = false

        fun finish(gatt: BluetoothGatt?) {
            if (finished) return
            finished = true
            try { gatt?.disconnect(); gatt?.close() } catch (ignored: Exception) {}
            sending[targetTag] = false
            if (!q.isEmpty()) mainHandler.postDelayed({ drainQueue(targetTag) }, 150)
        }

        fun buildFragments() {
            fragments.clear()
            val batch = mutableListOf<String>()
            while (batch.size < 8) batch.add(q.poll() ?: break)
            batch.forEach { msg ->
                val bytes = msg.toByteArray(StandardCharsets.UTF_8)
                val id = (++fragmentSeq).toString(36)
                val headerMax = "PSF|$id|99|99|".length
                val chunk = maxOf(8, mtuPayload - headerMax)
                val total = (bytes.size + chunk - 1) / chunk
                if (total == 1 && bytes.size <= mtuPayload && !msg.startsWith("PSF|")) {
                    fragments.add(bytes)
                } else {
                    for (i in 0 until total) {
                        val head = "PSF|$id|$i|$total|".toByteArray(StandardCharsets.US_ASCII)
                        val part = bytes.copyOfRange(i * chunk, minOf(bytes.size, (i + 1) * chunk))
                        fragments.add(head + part)
                    }
                }
            }
        }

        fun writeNext(gatt: BluetoothGatt) {
            val charMsg = gatt.getService(SERVICE_UUID)?.getCharacteristic(CHARACTERISTIC_MSG_UUID)
            val next = fragments.poll()
            if (charMsg == null || next == null) { finish(gatt); return }
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(charMsg, next, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                charMsg.value = next
                charMsg.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(charMsg)
            }
            if (!ok) finish(gatt)
        }

        try {
            val gattCallback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
                    super.onConnectionStateChange(gatt, status, newState)
                    if (newState == BluetoothProfile.STATE_CONNECTED && gatt != null) {
                        if (!gatt.requestMtu(517)) gatt.discoverServices()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        mainHandler.post { finish(gatt) }
                    }
                }

                override fun onMtuChanged(gatt: BluetoothGatt?, mtu: Int, status: Int) {
                    super.onMtuChanged(gatt, mtu, status)
                    if (status == BluetoothGatt.GATT_SUCCESS) mtuPayload = minOf(mtu - 3, 512)
                    gatt?.discoverServices()
                }

                override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
                    super.onServicesDiscovered(gatt, status)
                    if (status == BluetoothGatt.GATT_SUCCESS && gatt != null) {
                        buildFragments()
                        writeNext(gatt)
                    } else {
                        mainHandler.post { finish(gatt) }
                    }
                }

                override fun onCharacteristicWrite(
                    gatt: BluetoothGatt?,
                    characteristic: BluetoothGattCharacteristic?,
                    status: Int
                ) {
                    super.onCharacteristicWrite(gatt, characteristic, status)
                    if (gatt == null) return
                    if (status != BluetoothGatt.GATT_SUCCESS) { mainHandler.post { finish(gatt) }; return }
                    if (fragments.isEmpty() && !q.isEmpty()) buildFragments()
                    if (fragments.isEmpty()) {
                        Log.i(TAG, "Mensagens BLE entregues para ${peer.tag}")
                        mainHandler.post { finish(gatt) }
                    } else {
                        writeNext(gatt)
                    }
                }
            }

            val g = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                peer.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                peer.device.connectGatt(context, false, gattCallback)
            }
            // Trava de segurança (fora de alcance / conexão presa): libera a fila em 20 s
            mainHandler.postDelayed({ if (!finished) finish(g) }, 20000)
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao enviar mensagem BLE para $targetTag", e)
            sending[targetTag] = false
        }
    }
}
