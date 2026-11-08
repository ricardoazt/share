package com.ricardo.pulseshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import java.io.File

object NotificationHelper {
    // Ícone pequeno = raio do PulseShare (res/drawable/ic_stat_pulseshare.xml, gerado por icons/gen_icons.py)
    private const val BRAND_COLOR = 0xFF4F46E5.toInt()


    const val CHANNEL_TRANSFERS = "pulseshare_transfers"
    const val CHANNEL_SERVICE = "pulseshare_service"

    private var notificationIdCounter = 1000

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val transfersChannel = NotificationChannel(
                CHANNEL_TRANSFERS,
                "Transferências PulseShare",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notificações de arquivos recebidos e transferências da malha P2P"
                enableVibration(true)
            }

            val serviceChannel = NotificationChannel(
                CHANNEL_SERVICE,
                "Malha P2P PulseShare",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Manutenção ativa da malha P2P durante streaming de arquivos"
            }

            manager.createNotificationChannel(transfersChannel)
            manager.createNotificationChannel(serviceChannel)
        }
    }

    fun showFileReceived(context: Context, fileName: String, file: File) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifId = notificationIdCounter++

        // Intent para abrir o arquivo
        val openIntent = try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, FileHelper.getMimeType(file.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        } catch (e: Exception) {
            Intent(context, MainActivity::class.java)
        }

        val pendingOpen = PendingIntent.getActivity(
            context,
            notifId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_pulseshare)
            .setColor(BRAND_COLOR)
            .setContentTitle("Download Concluído — PulseShare")
            .setContentText(fileName)
            .setStyle(NotificationCompat.BigTextStyle().bigText("O arquivo \"$fileName\" foi recebido e salvo na pasta Downloads/PulseShare."))
            .setContentIntent(pendingOpen)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        manager.notify(notifId, notification)
    }

    fun showTransferNotification(context: Context, title: String, text: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notifId = notificationIdCounter++

        val mainIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingMain = PendingIntent.getActivity(
            context,
            notifId,
            mainIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_TRANSFERS)
            .setSmallIcon(R.drawable.ic_stat_pulseshare)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pendingMain)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        manager.notify(notifId, notification)
    }

    fun buildServiceNotification(context: Context, text: String): Notification {
        val mainIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingMain = PendingIntent.getActivity(
            context,
            1,
            mainIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_pulseshare)
            .setColor(BRAND_COLOR)
            .setContentTitle("PulseShare ativo")
            .setContentText(text)
            .setContentIntent(pendingMain)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    // =========================================================================
    // MENSAGENS: som e vibração escolhidos nas Configurações do app.
    // No Android 8+ o som/vibração pertencem ao CANAL e não mudam depois de
    // criado; por isso cada combinação vira um canal "ps_msg_<som>_<vibração>"
    // e os canais antigos de mensagem são apagados ao trocar.
    // =========================================================================
    const val EXTRA_OPEN_CHAT = "com.ricardo.pulseshare.OPEN_CHAT"
    private val SOUNDS = setOf("pulso", "sino", "bipe", "marimba", "alerta", "sistema", "nenhum")

    fun vibrationPattern(id: String): LongArray? = when (id) {
        "curta" -> longArrayOf(0, 200)
        "longa" -> longArrayOf(0, 700)
        "tripla" -> longArrayOf(0, 150, 100, 150, 100, 150)
        "batida" -> longArrayOf(0, 100, 90, 300)
        "nenhuma" -> null
        else -> longArrayOf(0, 220, 130, 220) // dupla (padrão)
    }

    fun soundUri(context: Context, id: String): Uri? = when (id) {
        "nenhum" -> null
        "sistema" -> RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        else -> {
            val resId = context.resources.getIdentifier("ps_$id", "raw", context.packageName)
            if (resId != 0) Uri.parse("android.resource://${context.packageName}/$resId")
            else RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        }
    }

    private fun messageChannelId(context: Context, sound: String, vib: String): String {
        val s = if (sound in SOUNDS) sound else "pulso"
        val v = if (vibrationPattern(vib) == null && vib != "nenhuma") "dupla" else vib
        val id = "ps_msg_${s}_$v"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(id) == null) {
                manager.notificationChannels
                    .filter { it.id.startsWith("ps_msg_") && it.id != id }
                    .forEach { manager.deleteNotificationChannel(it.id) }
                val ch = NotificationChannel(id, "Mensagens PulseShare", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Mensagens e arquivos recebidos (som: $s, vibração: $v)"
                    val uri = soundUri(context, s)
                    if (uri != null) {
                        setSound(uri, AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    } else {
                        setSound(null, null)
                    }
                    val pattern = vibrationPattern(v)
                    enableVibration(pattern != null)
                    if (pattern != null) vibrationPattern = pattern
                    enableLights(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                }
                manager.createNotificationChannel(ch)
            }
        }
        return id
    }

    fun showMessage(context: Context, title: String, body: String, peerTag: String, sound: String, vib: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channelId = messageChannelId(context, sound, vib)
        // Um aviso por contato (o novo substitui o anterior da mesma conversa)
        val notifId = if (peerTag.isNotEmpty()) 5000 + (peerTag.hashCode() and 0x3fff) else notificationIdCounter++
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (peerTag.isNotEmpty()) putExtra(EXTRA_OPEN_CHAT, peerTag)
        }
        val pending = PendingIntent.getActivity(context, notifId, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_pulseshare)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(0)
        // Android < 8: som e vibração vão na própria notificação
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            soundUri(context, sound)?.let { builder.setSound(it) }
            vibrationPattern(vib)?.let { builder.setVibrate(it) }
        }
        manager.notify(notifId, builder.build())
    }

    // Botão "Testar" das Configurações: toca o som e vibra na hora
    private var previewPlayer: MediaPlayer? = null
    fun preview(context: Context, sound: String, vib: String) {
        try {
            previewPlayer?.release()
            previewPlayer = null
            soundUri(context, sound)?.let { uri ->
                previewPlayer = MediaPlayer().apply {
                    setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    setDataSource(context, uri)
                    setOnCompletionListener { it.release(); if (previewPlayer === it) previewPlayer = null }
                    prepare()
                    start()
                }
            }
        } catch (ignored: Exception) {}
        val pattern = vibrationPattern(vib) ?: return
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        } catch (ignored: Exception) {}
    }
}
