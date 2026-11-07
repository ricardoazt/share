package com.ricardo.pulseshare

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class PulseShareService : Service {

    constructor() : super()

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    companion object {
        const val ACTION_START = "com.ricardo.pulseshare.START_SERVICE"
        const val ACTION_STOP = "com.ricardo.pulseshare.STOP_SERVICE"
        const val EXTRA_STATUS = "extra_status"
        private const val PREFS = "pulseshare_prefs"
        private const val KEY_BACKGROUND = "background_mode"

        fun isBackgroundMode(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_BACKGROUND, false)

        // Liga/desliga o modo "rodar em segundo plano" (notificação fixa + CPU acordada)
        fun setBackgroundMode(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_BACKGROUND, enabled).apply()
            if (enabled) start(context, "Recebendo mensagens em segundo plano")
            else stop(context)
        }

        fun start(context: Context, status: String = "Malha P2P ativa") {
            val intent = Intent(context, PulseShareService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS, status)
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, PulseShareService::class.java).apply {
                action = ACTION_STOP
            }
            context.stopService(intent)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotificationHelper.createChannels(this)

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PulseShare::TransferWakeLock")
        wakeLock?.setReferenceCounted(false)

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PulseShare::TransferWifiLock")
        wifiLock?.setReferenceCounted(false)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseLocks()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val status = intent?.getStringExtra(EXTRA_STATUS) ?: "Malha P2P ativa em segundo plano"
        val notification = NotificationHelper.buildServiceNotification(this, status)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // remoteMessaging: sem o limite de 6 h/dia do tipo dataSync no Android 15
            startForeground(1, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
        acquireLocks()

        return START_STICKY
    }

    private fun acquireLocks() {
        try {
            // Segundo plano: CPU acordada sem prazo (o usuário escolheu); transferência: 1 h
            if (wakeLock?.isHeld == false) {
                if (isBackgroundMode(this)) wakeLock?.acquire() else wakeLock?.acquire(60 * 60 * 1000L)
            }
            if (wifiLock?.isHeld == false) wifiLock?.acquire()
        } catch (ignored: Exception) {}
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (ignored: Exception) {}
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }
}
