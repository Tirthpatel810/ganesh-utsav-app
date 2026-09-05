package com.shashwat.ganeshutsav

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.webkit.*
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature

/**
 * A thin shell around the hosted app.
 *
 * The web app already handles everything that matters -- offline queueing,
 * sync, the ledgers -- so this exists only to give the committee something
 * they can install and tap, rather than a URL to keep track of. What it does
 * add is the three things a browser tab cannot do well on a cheap Android:
 * DOM storage that survives, a working camera picker for photographing bills,
 * and a back button that moves inside the app instead of closing it.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var offline: TextView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    private val fileChooser = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        cb.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        )
    }

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        pendingPermission?.let {
            if (granted) it.grant(it.resources) else it.deny()
            pendingPermission = null
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        offline = findViewById(R.id.offline)

        web.settings.apply {
            javaScriptEnabled = true
            // The whole app keeps its roster, its queue and its session in
            // localStorage. Without this it would forget everything, including
            // work queued while out of signal.
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        WebView.setWebContentsDebuggingEnabled(false)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        // let the service worker serve the shell when there is no signal
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance()
                .setServiceWorkerClient(object : ServiceWorkerClientCompat() {
                    override fun shouldInterceptRequest(request: WebResourceRequest) = null
                })
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                v: WebView, req: WebResourceRequest
            ): Boolean {
                val url = req.url
                // keep our own pages inside the app, hand anything else to the phone
                if (url.host == Uri.parse(APP_URL).host) return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            override fun onReceivedError(
                v: WebView, req: WebResourceRequest, err: WebResourceError
            ) {
                if (req.isForMainFrame) showOffline()
            }

            override fun onPageFinished(v: WebView, url: String) {
                offline.visibility = View.GONE
                web.visibility = View.VISIBLE
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                v: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    // offer the camera alongside the gallery, since the Spend
                    // screen is normally used standing in front of a vendor
                    val chooser = params.createIntent()
                    val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    val pick = Intent(Intent.ACTION_CHOOSER).apply {
                        putExtra(Intent.EXTRA_INTENT, chooser)
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
                    }
                    fileChooser.launch(pick)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.CAMERA
                        ) == PackageManager.PERMISSION_GRANTED
                    ) request.grant(request.resources)
                    else {
                        pendingPermission = request
                        cameraPermission.launch(Manifest.permission.CAMERA)
                    }
                } else request.deny()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        if (savedInstanceState == null) web.loadUrl(APP_URL)
        else web.restoreState(savedInstanceState)
    }

    private fun showOffline() {
        // Anything already loaded keeps working from the service worker cache;
        // this only shows when the very first load has never happened.
        if (web.url == null) {
            web.visibility = View.GONE
            offline.visibility = View.VISIBLE
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    companion object {
        const val APP_URL = "https://tirthpatel810.github.io/ganesh-utsav-app/"
    }
}
