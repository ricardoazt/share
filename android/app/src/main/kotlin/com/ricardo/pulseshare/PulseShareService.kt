package com.ricardo.pulseshare

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Serviço em primeiro plano.
 * - "Rodar em segundo plano" ligado: fica sempre ativo (notificação fixa) e mantém a
 *   WebView do app viva mesmo com o app fechado (WebViewHost). Se o sistema matar o
 *   processo, START_STICKY o recria e a WebView é aberta de novo sem tela; depois de
 *   reiniciar o aparelho ou atualizar o app, o BootReceiver o liga de novo.
 * - Desligado: só sobe durante transferências (WakeLock de 1 h).
 */
class PulseShareService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    companion object {
        private const val TAG = "PulseShareService"
        const val ACTION_START = "com.ricardo.pulseshare.START_SERVICE"
        const val ACTION_STOP = "com.ricardo.pulseshare.STOP_SERVICE"
        const val EXTRA_STATUS = "extra_status"
        private const val PREFS = "pulseshare_prefs"
        private const val KEY_BACKGROUND = "background_mode"
        private const val NOTIF_ID = 1
        const val BACKGROUND_STATUS = "Recebendo mensagens em segundo plano"

        @Volatile
        var isRunning = false
            private set

        fun isBackgroundMode(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_BACKGROUND, false)

        // Liga/desliga o modo "rodar em segundo plano" (notificação fixa + app vivo fechado)
        fun setBackgroundMode(context: Context, enabled: Boolean) {
            val was = isBackgroundMode(context)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_BACKGROUND, enabled).apply()
            if (enabled) {
                if (!isRunning || !was) start(context, BACKGROUND_STATUS, force = true)
            } else if (isRunning) {
                stop(context)
            }
        }

        fun start(context: Context, status: String = "Malha P2P ativa", force: Boolean = false) {
            if (isRunning && !force) {
                // Já está rodando: só atualiza o texto (evita startForegroundService com o app
                // em segundo plano, que o Android 12+ pode recusar)
                try {
                    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIF_ID, NotificationHelper.buildServiceNotification(context, status))
                } catch (ignored: Exception) {}
                return
            }
            val intent = Intent(context, PulseShareService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS, status)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Não foi possível iniciar o serviço: ${e.message}")
            }
        }

        fun stop(context: Context) {
            if (isBackgroundMode(context)) {
                // Transferência acabou, mas o modo segundo plano segue ligado: volta ao texto padrão
                if (isRunning) start(context, BACKGROUND_STATUS)
                return
            }
            context.stopService(Intent(context, PulseShareService::class.java))
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
        @Suppress("DEPRECATION")
        wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PulseShare::TransferWifiLock")
        wifiLock?.setReferenceCounted(false)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }

        val background = isBackgroundMode(this)
        // intent == null: o sistema recriou o serviço depois de matar o processo
        if (intent == null && !background) {
            shutdown()
            return START_NOT_STICKY
        }

        val status = intent?.getStringExtra(EXTRA_STATUS) ?: BACKGROUND_STATUS
        val notification = NotificationHelper.buildServiceNotification(this, status)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // remoteMessaging: sem o limite de 6 h/dia do dataSync e permitido a partir do boot.
                // dataSync só para transferência com o segundo plano desligado.
                val type = if (background) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                startForeground(NOTIF_ID, notification, type)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Exception) {
            Log.w(TAG, "startForeground recusado: ${e.message}")
            shutdown()
            return START_NOT_STICKY
        }
        isRunning = true
        acquireLocks(background)

        // App fechado (sem tela): mantém/recria a WebView com o app rodando
        if (background && !WebViewHost.exists()) {
            try {
                WebViewHost.obtain(this)
            } catch (e: Exception) {
                Log.w(TAG, "Falha ao criar a WebView sem tela: ${e.message}")
            }
        }
        return if (background) START_STICKY else START_NOT_STICKY
    }

    // App tirado dos recentes: a Activity some, mas o serviço (e a WebView) continuam
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (!isBackgroundMode(this)) {
            WebViewHost.destroy()
            shutdown()
        }
    }

    // Android 15: o tipo dataSync tem limite de tempo; ao esgotar, é preciso parar
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Tempo do serviço esgotado (tipo $fgsType)")
        if (!isBackgroundMode(this)) shutdown()
    }

    private fun shutdown() {
        releaseLocks()
        isRunning = false
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (ignored: Exception) {}
        stopSelf()
    }

    private fun acquireLocks(background: Boolean) {
        try {
            // Segundo plano: CPU acordada sem prazo (o usuário escolheu); transferência: 1 h
            if (wakeLock?.isHeld == false) {
                if (background) wakeLock?.acquire() else wakeLock?.acquire(60 * 60 * 1000L)
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
        isRunning = false
        releaseLocks()
        // Sem tela e sem serviço não há quem mantenha a WebView
        if (WebViewHost.isHeadless()) WebViewHost.destroy()
        super.onDestroy()
    }
}
