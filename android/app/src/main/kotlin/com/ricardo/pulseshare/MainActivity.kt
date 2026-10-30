package com.ricardo.pulseshare

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private val pendingSharedFiles = mutableListOf<JSONObject>()

    // Launcher para seleção de múltiplos arquivos nativa do Android
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris != null && uris.isNotEmpty()) {
            val jsonArray = JSONArray()
            for (uri in uris) {
                try {
                    // Mantém permissão persistente de leitura
                    contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (ignored: Exception) {}

                val details = FileHelper.getUriDetails(this, uri)
                val obj = JSONObject().apply {
                    put("name", details.name)
                    put("size", details.size)
                    put("mimeType", details.mimeType)
                    put("uri", details.uriString)
                }
                jsonArray.put(obj)
            }

            // Notifica o frontend PulseShare
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onFilesPicked) { window.PulseShareNativeCallback.onFilesPicked(${jsonArray.toString()}); }"
            webView.evaluateJavascript(js, null)

            // Se for resposta ao input file padrão do HTML
            fileUploadCallback?.onReceiveValue(uris.toTypedArray())
            fileUploadCallback = null
        } else {
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = null
        }
    }

    // Solicitação de permissão de Notificação no Android 13+
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        Log.i("PulseShare", "Permissão de notificação concedida: $isGranted")
    }

    private val runtimePermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        permissions.entries.forEach { (permission, isGranted) ->
            Log.i("PulseShare", "Permissão $permission concedida: $isGranted")
        }
    }

    fun requestAppPermissions() {
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_ADVERTISE)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (needed.isNotEmpty()) {
            runtimePermissionsLauncher.launch(needed.toTypedArray())
        }
    }

    fun evaluateJs(js: String) {
        runOnUiThread {
            webView.evaluateJavascript(js, null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        NotificationHelper.createChannels(this)
        requestNotificationPermission()
        requestAppPermissions()

        WebView.setWebContentsDebuggingEnabled(true)

        // Configuração da WebView
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF020617.toInt()) // slate-950
        }

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true

        // Suporte WebRTC e Permissões
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.let {
                    // Concede permissões para WebRTC (DataChannel/Audio/Video)
                    it.grant(it.resources)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback = filePathCallback
                filePickerLauncher.launch(arrayOf("*/*"))
                return true
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d("PulseShareWeb", "[${consoleMessage?.messageLevel()}] ${consoleMessage?.message()} (${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()})")
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                deliverPendingSharedFiles()
            }
        }

        // Bridge Nativo PulseShare
        val bridge = PulseShareBridge(this) {
            filePickerLauncher.launch(arrayOf("*/*"))
        }
        webView.addJavascriptInterface(bridge, "PulseShareNative")

        // Container raiz que aplica insets da barra de status e navegação do Android
        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF020617.toInt())
        }

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, windowInsets ->
            val systemBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            windowInsets
        }

        rootLayout.addView(webView)
        setContentView(rootLayout)

        // Processa Intents recebidos (ex: compartilhar arquivo de outros apps)
        handleIntent(intent)

        // Carrega a aplicação PulseShare empacotada localmente
        webView.loadUrl("file:///android_asset/www/index.html")

        // Botão Voltar do Android
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBackPressed) { window.PulseShareNativeCallback.onBackPressed(); } else { 'HANDLED'; }"
                webView.evaluateJavascript(js) { res ->
                    if (res == null || res == "null" || res == "\"EXIT\"") {
                        if (webView.canGoBack()) {
                            webView.goBack()
                        } else {
                            moveTaskToBack(true)
                        }
                    }
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
        deliverPendingSharedFiles()
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        val type = intent.type

        if (Intent.ACTION_SEND == action && type != null) {
            val streamUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }

            if (streamUri != null) {
                addSharedUri(streamUri)
            } else {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                if (text != null && text.isNotEmpty()) {
                    val obj = JSONObject().apply {
                        put("type", "text")
                        put("content", text)
                    }
                    pendingSharedFiles.add(obj)
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE == action && type != null) {
            val streamUris = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            }
            streamUris?.forEach { uri ->
                addSharedUri(uri)
            }
        } else if (Intent.ACTION_VIEW == action) {
            val dataUri = intent.data
            if (dataUri != null) {
                val obj = JSONObject().apply {
                    put("type", "link")
                    put("content", dataUri.toString())
                }
                pendingSharedFiles.add(obj)
            }
        }
    }

    private fun addSharedUri(uri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (ignored: Exception) {}

        val details = FileHelper.getUriDetails(this, uri)
        val obj = JSONObject().apply {
            put("type", "file")
            put("name", details.name)
            put("size", details.size)
            put("mimeType", details.mimeType)
            put("uri", details.uriString)
        }
        pendingSharedFiles.add(obj)
    }

    fun getSharedFilesJson(): String {
        val array = JSONArray()
        pendingSharedFiles.forEach { array.put(it) }
        return array.toString()
    }

    fun clearSharedFiles() {
        pendingSharedFiles.clear()
    }

    private fun deliverPendingSharedFiles() {
        if (pendingSharedFiles.isNotEmpty()) {
            val jsonStr = getSharedFilesJson()
            val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onSharedFilesReceived) { window.PulseShareNativeCallback.onSharedFilesReceived($jsonStr); }"
            webView.evaluateJavascript(js, null)
            clearSharedFiles()
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
