package com.ricardo.pulseshare

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

data class FileInfo(
    val name: String,
    val size: Long,
    val mimeType: String,
    val uriString: String
)

object FileHelper {

    private val activeStreams = ConcurrentHashMap<String, FileOutputStream>()
    private val activeFiles = ConcurrentHashMap<String, File>()

    fun setCustomDownloadFolder(context: Context, folderName: String?) {
        val prefs = context.getSharedPreferences("pulseshare_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("download_folder", folderName?.trim() ?: "PulseShare").apply()
    }

    fun getDownloadDir(context: Context? = null): File {
        val folder = if (context != null) {
            val prefs = context.getSharedPreferences("pulseshare_prefs", Context.MODE_PRIVATE)
            prefs.getString("download_folder", "PulseShare")?.trim() ?: "PulseShare"
        } else {
            "PulseShare"
        }
        val publicDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val pulseDir = if (folder.isEmpty() || folder == "." ||
            folder.equals("Downloads", ignoreCase = true) ||
            folder.equals("Download", ignoreCase = true) ||
            folder.equals("Transferências", ignoreCase = true) ||
            folder.equals("Transferencias", ignoreCase = true)
        ) {
            publicDownloads
        } else {
            File(publicDownloads, folder)
        }
        if (!pulseDir.exists()) {
            pulseDir.mkdirs()
        }
        return pulseDir
    }

    fun openDownloadFolder(context: Context) {
        val dir = getDownloadDir(context)
        try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                dir
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "*/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            try {
                val fallback = Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(fallback)
            } catch (ignored: Exception) {}
        }
    }

    fun getMimeType(fileName: String): String {
        val ext = fileName.substringAfterLast('.', "").lowercase()
        if (ext.isNotEmpty()) {
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            if (mime != null) return mime
        }
        return "application/octet-stream"
    }

    /**
     * Salva um arquivo completo a partir de bytes em Downloads/PulseShare/ ou pasta configurada
     */
    fun saveFileBytes(context: Context, fileName: String, bytes: ByteArray, mimeType: String?): File {
        val destDir = getDownloadDir(context)
        var targetFile = File(destDir, fileName)

        // Se já existir, gera nome único: ex: arquivo (1).ext
        if (targetFile.exists()) {
            val nameWithoutExt = fileName.substringBeforeLast('.')
            val ext = if (fileName.contains('.')) ".${fileName.substringAfterLast('.')}" else ""
            var counter = 1
            while (targetFile.exists()) {
                targetFile = File(destDir, "$nameWithoutExt ($counter)$ext")
                counter++
            }
        }

        FileOutputStream(targetFile).use { fos ->
            fos.write(bytes)
            fos.flush()
        }

        // Notifica o MediaScanner do Android para que o arquivo apareça na galeria e downloads
        MediaScannerConnection.scanFile(
            context,
            arrayOf(targetFile.absolutePath),
            arrayOf(mimeType ?: getMimeType(targetFile.name)),
            null
        )

        return targetFile
    }

    /**
     * Escreve chunks de streaming em tempo real diretamente para o disco
     */
    @Synchronized
    fun writeChunk(
        context: Context,
        transferId: String,
        fileName: String,
        chunkBytes: ByteArray,
        isFirst: Boolean,
        isLast: Boolean,
        mimeType: String?
    ): File? {
        val destDir = getDownloadDir(context)

        if (isFirst) {
            // Fecha stream anterior se houver
            activeStreams[transferId]?.close()
            activeStreams.remove(transferId)

            var targetFile = File(destDir, fileName)
            if (targetFile.exists()) {
                val nameWithoutExt = fileName.substringBeforeLast('.')
                val ext = if (fileName.contains('.')) ".${fileName.substringAfterLast('.')}" else ""
                var counter = 1
                while (targetFile.exists()) {
                    targetFile = File(destDir, "$nameWithoutExt ($counter)$ext")
                    counter++
                }
            }

            activeFiles[transferId] = targetFile
            activeStreams[transferId] = FileOutputStream(targetFile, false)
        }

        val fos = activeStreams[transferId] ?: run {
            val file = File(destDir, fileName)
            activeFiles[transferId] = file
            val newStream = FileOutputStream(file, true)
            activeStreams[transferId] = newStream
            newStream
        }

        if (chunkBytes.isNotEmpty()) {
            fos.write(chunkBytes)
        }

        if (isLast) {
            fos.flush()
            fos.close()
            activeStreams.remove(transferId)

            val finalFile = activeFiles.remove(transferId) ?: File(destDir, fileName)
            MediaScannerConnection.scanFile(
                context,
                arrayOf(finalFile.absolutePath),
                arrayOf(mimeType ?: getMimeType(finalFile.name)),
                null
            )
            return finalFile
        }

        return null
    }

    /**
     * Cancela uma transferência ativa em streaming e remove arquivo parcial
     */
    @Synchronized
    fun cancelTransfer(transferId: String) {
        try {
            activeStreams.remove(transferId)?.close()
            val file = activeFiles.remove(transferId)
            if (file != null && file.exists()) {
                file.delete()
            }
        } catch (ignored: Exception) {}
    }

    /**
     * Abre um arquivo com o app padrão do sistema
     */
    fun openFile(context: Context, file: File, customMime: String? = null) {
        try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )
            val mime = customMime ?: getMimeType(file.name)

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            // Tenta como */* genérico
            try {
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "*/*")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (ignored: Exception) {}
        }
    }

    /**
     * Compartilha o arquivo com WhatsApp, Telegram, etc.
     */
    fun shareFile(context: Context, file: File, customMime: String? = null) {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val mime = customMime ?: getMimeType(file.name)

        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, "Compartilhar arquivo PulseShare").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }

    /**
     * Obtém metadados de uma URI selecionada via SAF ou Intent
     */
    fun getUriDetails(context: Context, uri: Uri): FileInfo {
        var name = "arquivo_pulseshare"
        var size = 0L
        val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"

        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex != -1) name = cursor.getString(nameIndex) ?: name
                if (sizeIndex != -1) size = cursor.getLong(sizeIndex)
            }
        }

        return FileInfo(name, size, mimeType, uri.toString())
    }

    /**
     * Lê uma URI em Base64
     */
    fun readUriToBase64(context: Context, uri: Uri): String {
        val stream: InputStream? = context.contentResolver.openInputStream(uri)
        return stream?.use {
            val bytes = it.readBytes()
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } ?: ""
    }

    /**
     * Lê um chunk de uma URI com offset e comprimento para streaming seguro sem OutOfMemoryError
     */
    fun readUriChunkBase64(context: Context, uri: Uri, offset: Long, length: Int): String {
        return try {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
                java.io.FileInputStream(pfd.fileDescriptor).channel.use { channel ->
                    channel.position(offset)
                    val buffer = java.nio.ByteBuffer.allocate(length)
                    val bytesRead = channel.read(buffer)
                    if (bytesRead > 0) {
                        buffer.flip()
                        val bytes = ByteArray(bytesRead)
                        buffer.get(bytes)
                        android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    } else {
                        ""
                    }
                }
            } ?: ""
        } catch (e: Exception) {
            try {
                context.contentResolver.openInputStream(uri)?.use { stream ->
                    var remaining = offset
                    while (remaining > 0) {
                        val s = stream.skip(remaining)
                        if (s <= 0) break
                        remaining -= s
                    }
                    val buffer = ByteArray(length)
                    var read = 0
                    while (read < length) {
                        val r = stream.read(buffer, read, length - read)
                        if (r <= 0) break
                        read += r
                    }
                    if (read > 0) {
                        android.util.Base64.encodeToString(buffer, 0, read, android.util.Base64.NO_WRAP)
                    } else ""
                } ?: ""
            } catch (ex: Exception) {
                ""
            }
        }
    }
}
