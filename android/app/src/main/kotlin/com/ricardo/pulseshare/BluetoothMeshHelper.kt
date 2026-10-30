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
                        val messageStr = String(value, StandardCharsets.UTF_8)
                        val fromTag = device?.address?.let { deviceToTag[it] } ?: "desconhecido"

                        Log.i(TAG, "Mensagem BLE recebida via GATT de $fromTag: $messageStr")

                        mainHandler.post {
                            onMessageReceived?.invoke(fromTag, messageStr)
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

            // Tag condensada para caber no pacote de anúncio BLE (máx 24 bytes de payload)
            val tagBytes = myUserTag.toByteArray(StandardCharsets.UTF_8)
            val cleanBytes = if (tagBytes.size > 20) tagBytes.copyOf(20) else tagBytes

            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
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
            val filter = ScanFilter.Builder()
                .setServiceUuid(ParcelUuid(SERVICE_UUID))
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
    @SuppressLint("MissingPermission")
    fun sendBleMessage(targetTag: String, messageJson: String): Boolean {
        val peer = discoveredPeers[targetTag] ?: return false
        val device = peer.device

        try {
            val gattCallback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt?, status: Int, newState: Int) {
                    super.onConnectionStateChange(gatt, status, newState)
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Log.d(TAG, "Conectado ao peer BLE ${peer.tag}, descobrindo serviços...")
                        gatt?.discoverServices()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        try { gatt?.close() } catch (ignored: Exception) {}
                    }
                }

                override fun onServicesDiscovered(gatt: BluetoothGatt?, status: Int) {
                    super.onServicesDiscovered(gatt, status)
                    if (status == BluetoothGatt.GATT_SUCCESS && gatt != null) {
                        val service = gatt.getService(SERVICE_UUID)
                        val charMsg = service?.getCharacteristic(CHARACTERISTIC_MSG_UUID)
                        if (charMsg != null) {
                            val bytes = messageJson.toByteArray(StandardCharsets.UTF_8)
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                gatt.writeCharacteristic(charMsg, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                            } else {
                                @Suppress("DEPRECATION")
                                charMsg.value = bytes
                                @Suppress("DEPRECATION")
                                gatt.writeCharacteristic(charMsg)
                            }
                        }
                    }
                }

                override fun onCharacteristicWrite(
                    gatt: BluetoothGatt?,
                    characteristic: BluetoothGattCharacteristic?,
                    status: Int
                ) {
                    super.onCharacteristicWrite(gatt, characteristic, status)
                    Log.i(TAG, "Mensagem BLE enviada com sucesso para ${peer.tag} (status: $status)")
                    try {
                        gatt?.disconnect()
                        gatt?.close()
                    } catch (ignored: Exception) {}
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(context, false, gattCallback)
            }
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Erro ao enviar mensagem BLE para $targetTag", e)
            return false
        }
    }
}
