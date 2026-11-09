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
import android.webkit.GeolocationPermissions
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

    // A WebView pertence ao WebViewHost (continua viva com o app fechado, em segundo plano)
    private lateinit var webView: WebView
    private lateinit var rootLayout: FrameLayout
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var resumed = false

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
            WebViewHost.evaluateJs(js)

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

    // Câmera (leitor de QR) e microfone (mensagem de voz) pedidos na hora em que a
    // página chama getUserMedia; só concede à página o que o Android liberou.
    private var pendingWebPermission: PermissionRequest? = null
    private val mediaPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val req = pendingWebPermission
        pendingWebPermission = null
        if (req != null) grantAllowedResources(req)
    }

    private fun androidPermissionFor(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        else -> null
    }

    private fun grantAllowedResources(request: PermissionRequest) {
        val allowed = request.resources.filter { res ->
            val perm = androidPermissionFor(res)
            perm == null || ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED
        }
        if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
    }

    fun handleWebPermission(request: PermissionRequest) {
        val missing = request.resources.mapNotNull { androidPermissionFor(it) }
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            pendingWebPermission?.deny()
            pendingWebPermission = request
            mediaPermissionLauncher.launch(missing.distinct().toTypedArray())
        } else {
            grantAllowedResources(request)
        }
    }

    // Localização para a página (enviar localização no chat)
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null
    private val geoPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val granted = results.values.any { it }
        pendingGeoCallback?.invoke(pendingGeoOrigin, granted, false)
        pendingGeoCallback = null
        pendingGeoOrigin = null
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun handleGeolocationPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
        if (hasLocationPermission()) {
            callback.invoke(origin, true, false)
        } else {
            pendingGeoCallback?.invoke(pendingGeoOrigin, false, false)
            pendingGeoOrigin = origin
            pendingGeoCallback = callback
            geoPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
    }

    // <input type=file> da página
    fun openFileChooser(callback: ValueCallback<Array<Uri>>?) {
        fileUploadCallback?.onReceiveValue(null)
        fileUploadCallback = callback
        filePickerLauncher.launch(arrayOf("*/*"))
    }

    fun isUiVisible(): Boolean = resumed

    // Seletor de arquivos com filtro de tipo ("image/*,video/*", "audio/*")
    fun launchFilePicker(mimeTypes: Array<String>) {
        filePickerLauncher.launch(if (mimeTypes.isEmpty()) arrayOf("*/*") else mimeTypes)
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
        // A câmera não é pedida aqui: só quando o leitor de QR abre (handleWebPermission)
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

    fun evaluateJs(js: String) = WebViewHost.evaluateJs(js)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        NotificationHelper.createChannels(this)
        requestNotificationPermission()
        requestAppPermissions()

        // Container raiz que aplica insets da barra de status e navegação do Android
        rootLayout = FrameLayout(this).apply {
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
            // Edge-to-edge (target 35+) ignora adjustResize: desconta o teclado manualmente
            // para a WebView encolher e a barra de digitação / busca não ficarem cobertas.
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, maxOf(systemBars.bottom, ime.bottom))
            windowInsets
        }

        setContentView(rootLayout)

        // Processa Intents recebidos (ex: compartilhar arquivo de outros apps)
        handleIntent(intent)

        // Usa a WebView que já está rodando em segundo plano (ou cria e carrega o app)
        webView = WebViewHost.attach(this, rootLayout)

        // Botão Voltar do Android
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val js = "if (window.PulseShareNativeCallback && window.PulseShareNativeCallback.onBackPressed) { window.PulseShareNativeCallback.onBackPressed(); } else { 'HANDLED'; }"
                WebViewHost.evaluateJs(js) { res ->
                    if (res == null || res == "null" || res == "\"EXIT\"") {
                        if (WebViewHost.canGoBack()) {
                            WebViewHost.goBack()
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
        WebViewHost.deliverPendingSharedFiles()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        evaluateJs("window.PulseShareNativeCallback && window.PulseShareNativeCallback.onUiVisibility && window.PulseShareNativeCallback.onUiVisibility(true)")
    }

    override fun onPause() {
        resumed = false
        evaluateJs("window.PulseShareNativeCallback && window.PulseShareNativeCallback.onUiVisibility && window.PulseShareNativeCallback.onUiVisibility(false)")
        super.onPause()
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        intent.getStringExtra(NotificationHelper.EXTRA_OPEN_CHAT)?.let { tag ->
            intent.removeExtra(NotificationHelper.EXTRA_OPEN_CHAT)
            val safe = tag.replace(Regex("[^a-z0-9_@]"), "")
            if (safe.isNotEmpty()) {
                WebViewHost.pendingOpenChat = safe
                // App já carregado: avisa o JS direto
                evaluateJs("window.PulseShareNativeCallback && window.PulseShareNativeCallback.onOpenChat && window.PulseShareNativeCallback.onOpenChat('$safe')")
            }
        }
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
                    synchronized(WebViewHost.pendingSharedFiles) { WebViewHost.pendingSharedFiles.add(obj) }
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
                synchronized(WebViewHost.pendingSharedFiles) { WebViewHost.pendingSharedFiles.add(obj) }
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
        synchronized(WebViewHost.pendingSharedFiles) { WebViewHost.pendingSharedFiles.add(obj) }
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
        fileUploadCallback?.onReceiveValue(null)
        fileUploadCallback = null
        pendingWebPermission?.deny()
        pendingWebPermission = null
        if (PulseShareService.isBackgroundMode(this)) {
            // Como o WhatsApp: fechar o app não desliga. A WebView sai da tela e continua
            // conectada dentro do serviço em primeiro plano, recebendo e notificando.
            WebViewHost.detach(this)
            PulseShareService.start(this, PulseShareService.BACKGROUND_STATUS)
        } else {
            WebViewHost.destroy()
        }
        super.onDestroy()
    }
}
