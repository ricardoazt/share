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

/**
 * Ponte JS → Android. Vive junto com a WebView (WebViewHost), que pode estar sem
 * tela (app fechado, rodando em segundo plano): o que precisa de tela (seletor de
 * arquivos, telas do sistema) usa a Activity quando ela existe; o resto usa o
 * contexto do aplicativo.
 */
class PulseShareBridge(private val appContext: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Activity se a tela estiver aberta, senão o Application (para Toast, arquivos, notificações). */
    private val activity: Context
        get() = WebViewHost.activity ?: appContext

    private val bleHelper = BluetoothMeshHelper(appContext).apply {
        onMessageReceived = { fromTag, messageJson ->
            val safeJson = JSONObject.quote(messageJson)
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBleMessageReceived) { window.PulseShareNativeCallback.onBleMessageReceived(${JSONObject.quote(fromTag)}, $safeJson); }"
            WebViewHost.evaluateJs(js)
        }
        onPeersUpdated = { peersJson ->
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBlePeersUpdated) { window.PulseShareNativeCallback.onBlePeersUpdated($peersJson); }"
            WebViewHost.evaluateJs(js)
        }
    }

    fun shutdown() {
        try { bleHelper.stopBleMesh() } catch (ignored: Exception) {}
    }

    @JavascriptInterface
    fun isNativeAndroid(): Boolean = true

    @JavascriptInterface
    fun pickFiles() {
        mainHandler.post {
            WebViewHost.activity?.launchFilePicker(arrayOf("*/*"))
        }
    }

    // accept no formato do <input type=file>: "image/*,video/*", "audio/*"
    @JavascriptInterface
    fun pickFilesOfType(accept: String) {
        val types = accept.split(',').map { it.trim() }.filter { it.matches(Regex("^[a-z*]+/[a-z0-9.+*-]+$")) }
        mainHandler.post {
            WebViewHost.activity?.launchFilePicker(types.toTypedArray())
        }
    }

    @JavascriptInterface
    fun getPendingSharedFiles(): String {
        return WebViewHost.getSharedFilesJson()
    }

    @JavascriptInterface
    fun clearPendingSharedFiles() {
        WebViewHost.clearSharedFiles()
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

    // Arquivo baixado ainda existe? (se foi apagado, o chat baixa de novo de quem enviou)
    @JavascriptInterface
    fun fileExists(filePath: String): Boolean {
        return try { File(filePath).let { it.exists() && it.length() > 0 } } catch (e: Exception) { true }
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

    /** Abre um link (ex.: portal de download de um link PulseShare) no navegador do sistema. */
    @JavascriptInterface
    fun openUrl(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        mainHandler.post {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(intent)
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

    // Notificação de mensagem/arquivo com o som e a vibração escolhidos
    @JavascriptInterface
    fun notifyMessage(title: String, body: String, peerTag: String, sound: String, vibration: String) {
        mainHandler.post { NotificationHelper.showMessage(activity, title, body, peerTag, sound, vibration) }
    }

    @JavascriptInterface
    fun previewNotification(sound: String, vibration: String) {
        mainHandler.post { NotificationHelper.preview(activity, sound, vibration) }
    }

    @JavascriptInterface
    fun setBackgroundMode(enabled: Boolean) {
        mainHandler.post { PulseShareService.setBackgroundMode(appContext, enabled) }
    }

    // Abre a tela do sistema para tirar o app da otimização de bateria (Samsung mata apps em segundo plano)
    @JavascriptInterface
    fun requestBatteryExemption() {
        mainHandler.post {
            try {
                val pm = activity.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                val intent = if (!pm.isIgnoringBatteryOptimizations(activity.packageName)) {
                    Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
                } else {
                    Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(activity, "Abra Configurações → Bateria → PulseShare → Sem restrições", Toast.LENGTH_LONG).show()
            }
        }
    }

    // Conversa a abrir quando o app foi aberto pelo toque numa notificação
    @JavascriptInterface
    fun consumePendingOpenChat(): String {
        val t = WebViewHost.pendingOpenChat
        WebViewHost.pendingOpenChat = ""
        return t
    }

    // A tela do app está aberta? (com o app fechado a WebView roda sem tela)
    @JavascriptInterface
    fun isUiVisible(): Boolean = WebViewHost.activity?.isUiVisible() == true

    @JavascriptInterface
    fun startKeepAlive(status: String) {
        mainHandler.post { PulseShareService.start(appContext, status) }
    }

    @JavascriptInterface
    fun stopKeepAlive() {
        mainHandler.post { PulseShareService.stop(appContext) }
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
