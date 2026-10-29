package com.ricardo.pulseshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import java.io.File

object NotificationHelper {

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
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
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
            .setSmallIcon(android.R.drawable.stat_notify_chat)
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
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("PulseShare Ativo")
            .setContentText(text)
            .setContentIntent(pendingMain)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
