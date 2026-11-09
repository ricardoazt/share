package com.ricardo.pulseshare

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Dono da WebView do app (uma por processo), como o WhatsApp: a tela (MainActivity)
 * só "empresta" a WebView enquanto está aberta. Com "Rodar em segundo plano" ligado,
 * fechar o app (voltar, tirar dos recentes) só desanexa a WebView, que continua
 * conectada aos brokers dentro do PulseShareService, recebendo e notificando.
 * Se o sistema matar o processo, o serviço (START_STICKY / boot) recria a WebView
 * sem tela. O contexto é um MutableContextWrapper: aponta para a Activity quando há
 * tela (diálogos, seletor de arquivos) e para o Application quando não há.
 */
object WebViewHost {
    private const val TAG = "PulseShareHost"
    const val APP_URL = "file:///android_asset/www/index.html"

    private var webView: WebView? = null
    private var wrapper: MutableContextWrapper? = null
    private var bridge: PulseShareBridge? = null
    private var activityRef: WeakReference<MainActivity>? = null
    private val main = Handler(Looper.getMainLooper())

    var pageLoaded = false
        private set

    /** Arquivos/links compartilhados com o app esperando a página carregar. */
    val pendingSharedFiles = mutableListOf<JSONObject>()

    /** Conversa a abrir (toque numa notificação). */
    var pendingOpenChat: String = ""

    val activity: MainActivity?
        get() = activityRef?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

    fun exists(): Boolean = webView != null

    fun isHeadless(): Boolean = webView != null && activity == null

    /** Cria a WebView (se ainda não existe) e carrega o app. Sempre na thread principal. */
    @SuppressLint("SetJavaScriptEnabled")
    fun obtain(context: Context): WebView {
        webView?.let { return it }
        val app = context.applicationContext
        val ctx = MutableContextWrapper(app)
        WebView.setWebContentsDebuggingEnabled(true)
        val wv = WebView(ctx).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(0xFF020617.toInt()) // slate-950
        }
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        @Suppress("DEPRECATION")
        s.databaseEnabled = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.setGeolocationEnabled(true)
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        // O processo do renderizador continua "importante" mesmo sem tela (não é morto/congelado)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                val req = request ?: return
                main.post {
                    val a = activity
                    if (a != null) a.handleWebPermission(req) else req.deny()
                }
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                if (callback == null) return
                main.post {
                    val a = activity
                    if (a != null) a.handleGeolocationPrompt(origin, callback) else callback.invoke(origin, false, false)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                val a = activity ?: return false
                a.openFileChooser(filePathCallback)
                return true
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d("PulseShareWeb", "[${consoleMessage?.messageLevel()}] ${consoleMessage?.message()} (${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()})")
                return true
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                pageLoaded = false
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageLoaded = true
                deliverPendingSharedFiles()
            }
        }

        val b = PulseShareBridge(app)
        wv.addJavascriptInterface(b, "PulseShareNative")
        bridge = b
        wrapper = ctx
        webView = wv
        pageLoaded = false
        wv.loadUrl(APP_URL)
        Log.i(TAG, "WebView criada (${if (activity == null) "sem tela" else "com tela"})")
        return wv
    }

    /** A tela abriu: passa a usar o contexto dela e coloca a WebView no layout. */
    fun attach(a: MainActivity, parent: ViewGroup): WebView {
        activityRef = WeakReference(a)
        val wv = obtain(a)
        wrapper?.baseContext = a
        (wv.parent as? ViewGroup)?.removeView(wv)
        parent.addView(wv)
        wv.onResume()
        wv.resumeTimers()
        if (pageLoaded) {
            deliverPendingSharedFiles()
            evaluateJs("window.PulseShareNativeCallback && window.PulseShareNativeCallback.onUiAttached && window.PulseShareNativeCallback.onUiAttached()")
        }
        return wv
    }

    /** A tela fechou mas o app continua em segundo plano: tira a WebView do layout sem destruí-la. */
    fun detach(a: MainActivity) {
        if (activityRef?.get() !== a) return
        activityRef = null
        val wv = webView ?: return
        (wv.parent as? ViewGroup)?.removeView(wv)
        wrapper?.baseContext = a.applicationContext
        Log.i(TAG, "Tela fechada: WebView continua rodando em segundo plano")
    }

    /** Fecha tudo (segundo plano desligado e a tela fechou). */
    fun destroy() {
        val wv = webView ?: return
        webView = null
        activityRef = null
        pageLoaded = false
        try { bridge?.shutdown() } catch (ignored: Exception) {}
        bridge = null
        try {
            (wv.parent as? ViewGroup)?.removeView(wv)
            wv.stopLoading()
            wv.destroy()
        } catch (ignored: Exception) {}
        wrapper = null
        Log.i(TAG, "WebView destruída")
    }

    fun evaluateJs(js: String) {
        main.post { webView?.evaluateJavascript(js, null) }
    }

    fun evaluateJs(js: String, callback: (String?) -> Unit) {
        main.post {
            val wv = webView
            if (wv == null) callback(null) else wv.evaluateJavascript(js) { callback(it) }
        }
    }

    fun canGoBack(): Boolean = webView?.canGoBack() == true
    fun goBack() { webView?.goBack() }

    fun getSharedFilesJson(): String {
        val array = JSONArray()
        synchronized(pendingSharedFiles) { pendingSharedFiles.forEach { array.put(it) } }
        return array.toString()
    }

    fun clearSharedFiles() {
        synchronized(pendingSharedFiles) { pendingSharedFiles.clear() }
    }

    fun deliverPendingSharedFiles() {
        main.post {
            if (!pageLoaded) return@post
            val empty = synchronized(pendingSharedFiles) { pendingSharedFiles.isEmpty() }
            if (empty) return@post
            val jsonStr = getSharedFilesJson()
            clearSharedFiles()
            webView?.evaluateJavascript("if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onSharedFilesReceived) { window.PulseShareNativeCallback.onSharedFilesReceived($jsonStr); }", null)
        }
    }
}
