package de.powerizzle.drivehunt

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import de.powerizzle.drivehunt.ui.theme.DrivehuntTheme

/**
 * Shell around the Drückjagd web app (BuildConfig.BASE_URL).
 *
 * The map, drives, simulation and editing all live in the web app, so updates
 * reach the app without a new release. Native parts: location permission for
 * "Mein Standort", the back button (closes tools/views in the web app first),
 * an offline screen, and links to other sites opening in the browser.
 */
class MainActivity : ComponentActivity() {

    private var webView: WebView? = null

    // Screen state observed by Compose.
    private var loadProgress by mutableIntStateOf(0)
    private var offline by mutableStateOf(false)

    // A geolocation request from the page waits here while Android asks the user.
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val granted = result.values.any { it }
            pendingGeo?.let { (origin, callback) -> callback.invoke(origin, granted, false) }
            pendingGeo = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView ?: return finish()
                // Let the web app close drawing tools, dialogs and sub-views first.
                view.evaluateJavascript("window.drivehuntBack ? window.drivehuntBack() : false") { handled ->
                    if (handled != "true") {
                        if (view.canGoBack()) view.goBack() else moveTaskToBack(true)
                    }
                }
            }
        })

        setContent {
            DrivehuntTheme {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .systemBarsPadding()
                ) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { context -> createWebView(context, savedInstanceState) },
                    )
                    if (loadProgress in 1..99) {
                        LinearProgressIndicator(
                            progress = { loadProgress / 100f },
                            modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter),
                        )
                    }
                    if (offline) {
                        OfflineScreen(onRetry = {
                            offline = false
                            webView?.reload()
                        })
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: android.content.Context, savedInstanceState: Bundle?): WebView =
        WebView(context).apply {
            // Without explicit MATCH_PARENT the page sees a 0 px high viewport (CSS height: 100% = 0).
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            // chrome://inspect for debug builds
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setGeolocationEnabled(true)
            settings.userAgentString = "${settings.userAgentString} DrivehuntApp/${BuildConfig.VERSION_NAME}"
            CookieManager.getInstance().setAcceptCookie(true)

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.host == Uri.parse(BuildConfig.BASE_URL).host) return false
                    // Attribution links etc. open in the browser.
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    return true
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    this@MainActivity.offline = false
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) this@MainActivity.offline = true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) {
                    loadProgress = newProgress
                }

                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    pendingGeo = origin to callback
                    locationPermission.launch(
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                    )
                }
            }

            if (savedInstanceState != null) restoreState(savedInstanceState) else loadUrl(BuildConfig.BASE_URL)
            this@MainActivity.webView = this
        }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush() // keep the login
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}

@Composable
private fun OfflineScreen(onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Keine Verbindung", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Text(
            "Die Jagdkarte konnte nicht geladen werden. Bitte Internetverbindung prüfen.",
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onRetry) { Text("Erneut versuchen") }
    }
}
