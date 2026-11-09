package com.ricardo.pulseshare

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Depois de ligar o aparelho ou atualizar o app: se "Rodar em segundo plano" estiver
 * ligado, sobe o serviço, que abre o app sem tela e volta a receber mensagens.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON" -> {
                if (PulseShareService.isBackgroundMode(context)) {
                    PulseShareService.start(context, PulseShareService.BACKGROUND_STATUS)
                }
            }
        }
    }
}
