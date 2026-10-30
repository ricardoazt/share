package com.ricardo.pulseshare

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONObject
import java.io.File

class PulseShareBridge(
    private val activity: MainActivity,
    private val onPickFilesRequested: () -> Unit
) {
    private val mainHandler = Handler(Looper.getMainLooper())

    private val bleHelper = BluetoothMeshHelper(activity).apply {
        onMessageReceived = { fromTag, messageJson ->
            val safeJson = JSONObject.quote(messageJson)
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBleMessageReceived) { window.PulseShareNativeCallback.onBleMessageReceived('$fromTag', $safeJson); }"
            activity.evaluateJs(js)
        }
        onPeersUpdated = { peersJson ->
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBlePeersUpdated) { window.PulseShareNativeCallback.onBlePeersUpdated($peersJson); }"
            activity.evaluateJs(js)
        }
    }

    @JavascriptInterface
    fun isNativeAndroid(): Boolean = true

    @JavascriptInterface
    fun pickFiles() {
        mainHandler.post {
            onPickFilesRequested()
        }
    }

    @JavascriptInterface
    fun getPendingSharedFiles(): String {
        return activity.getSharedFilesJson()
    }

    @JavascriptInterface
    fun clearPendingSharedFiles() {
        activity.clearSharedFiles()
    }

    @JavascriptInterface
    fun readFileBase64(uriString: String): String {
        return try {
            val uri = Uri.parse(uriString)
            FileHelper.readUriToBase64(activity, uri)
        } catch (e: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun readUriChunkBase64(uriString: String, offset: Long, length: Int): String {
        return try {
            val uri = Uri.parse(uriString)
            FileHelper.readUriChunkBase64(activity, uri, offset, length)
        } catch (e: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun cancelTransfer(transferId: String) {
        FileHelper.cancelTransfer(transferId)
    }

    @JavascriptInterface
    fun getDownloadDirectory(): String {
        return FileHelper.getDownloadDir(activity).absolutePath
    }

    @JavascriptInterface
    fun setDownloadDirectory(folderName: String): String {
        FileHelper.setCustomDownloadFolder(activity, folderName)
        return FileHelper.getDownloadDir(activity).absolutePath
    }

    @JavascriptInterface
    fun openDownloadFolder() {
        mainHandler.post {
            try {
                FileHelper.openDownloadFolder(activity)
            } catch (e: Exception) {
                Toast.makeText(activity, "Não foi possível abrir o diretório", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun saveFile(fileName: String, base64Data: String, mimeType: String): String {
        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val file = FileHelper.saveFileBytes(activity, fileName, bytes, mimeType)
            NotificationHelper.showFileReceived(activity, fileName, file)
            file.absolutePath
        } catch (e: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun saveChunk(
        transferId: String,
        fileName: String,
        chunkBase64: String,
        isFirst: Boolean,
        isLast: Boolean,
        mimeType: String
    ): String {
        return try {
            val bytes = Base64.decode(chunkBase64, Base64.DEFAULT)
            val completedFile = FileHelper.writeChunk(
                activity,
                transferId,
                fileName,
                bytes,
                isFirst,
                isLast,
                mimeType
            )
            if (completedFile != null) {
                NotificationHelper.showFileReceived(activity, fileName, completedFile)
                completedFile.absolutePath
            } else {
                "CHUNK_WRITTEN"
            }
        } catch (e: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun openDownloadedFile(filePath: String) {
        mainHandler.post {
            try {
                val file = File(filePath)
                if (file.exists()) {
                    FileHelper.openFile(activity, file)
                } else {
                    Toast.makeText(activity, "Arquivo não encontrado: $filePath", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(activity, "Erro ao abrir arquivo: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun shareDownloadedFile(filePath: String, mimeType: String) {
        mainHandler.post {
            try {
                val file = File(filePath)
                if (file.exists()) {
                    FileHelper.shareFile(activity, file, mimeType)
                }
            } catch (e: Exception) {
                Toast.makeText(activity, "Erro ao compartilhar arquivo", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun shareText(title: String, text: String) {
        mainHandler.post {
            try {
                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, title)
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                val chooser = Intent.createChooser(sendIntent, title).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(chooser)
            } catch (ignored: Exception) {}
        }
    }

    @JavascriptInterface
    fun copyToClipboard(text: String) {
        mainHandler.post {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("PulseShare", text)
            clipboard.setPrimaryClip(clip)
            Toast.makeText(activity, "Copiado para a área de transferência!", Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun showToast(message: String) {
        mainHandler.post {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun showNotification(title: String, message: String, filePath: String?) {
        mainHandler.post {
            if (filePath != null && filePath.isNotEmpty()) {
                val file = File(filePath)
                if (file.exists()) {
                    NotificationHelper.showFileReceived(activity, file.name, file)
                    return@post
                }
            }
            NotificationHelper.showTransferNotification(activity, title, message)
        }
    }

    @JavascriptInterface
    fun startKeepAlive(status: String) {
        PulseShareService.start(activity, status)
    }

    @JavascriptInterface
    fun stopKeepAlive() {
        PulseShareService.stop(activity)
    }

    // =========================================================================
    // BLUETOOTH BLE MESH P2P
    // =========================================================================
    @JavascriptInterface
    fun isBleAvailable(): Boolean = bleHelper.isBleSupported() && bleHelper.isBluetoothEnabled()

    @JavascriptInterface
    fun startBleMesh(tag: String) {
        mainHandler.post {
            bleHelper.startBleMesh(tag)
        }
    }

    @JavascriptInterface
    fun stopBleMesh() {
        mainHandler.post {
            bleHelper.stopBleMesh()
        }
    }

    @JavascriptInterface
    fun getNearbyBlePeers(): String {
        return bleHelper.getDiscoveredPeersJson()
    }

    @JavascriptInterface
    fun sendBleMessage(targetTag: String, messageJson: String): Boolean {
        return bleHelper.sendBleMessage(targetTag, messageJson)
    }
}
