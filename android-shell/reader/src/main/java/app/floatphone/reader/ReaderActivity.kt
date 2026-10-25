package app.floatphone.reader

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * 浮读：独立阅读器 App（不依赖小手机壳）。
 *
 * 它不联网也能用——书和批注都存在本机 IndexedDB 里。
 * 只有两件事会出网：
 *   1) 批注用的模型接口（用户自己填地址/Key）；
 *   2) 听书用的 GPT-SoVITS（跑在用户电脑上，通常是 192.168.x.x:9880）。
 *
 * 页面通过 WebViewAssetLoader 以 https://appassets.androidplatform.net/reader/ 提供，
 * 而不是 file://：file:// 源在 Chromium 里拿不到 IndexedDB，书就存不住。
 */
class ReaderActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/reader/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#f3f3f3"))
        setContentView(
            webView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            // 逐段朗读要能自己接着播下一段，不能被「用户手势」卡住
            mediaPlaybackRequiresUserGesture = false
            // 页面是 https://appassets...，语音服务是局域网 http://192.168...
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? {
                request?.let { return assetLoader.shouldInterceptRequest(it.url) }
                return null
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val url = request?.url ?: return false
                if (url.scheme == "https" && url.host == "appassets.androidplatform.net") return false
                // 其他链接（比如书里引用的网页）交给系统浏览器，别把阅读器顶掉
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: Exception) {
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/plain", "application/epub+zip", "text/html", "text/markdown"))
                    }
                    startActivityForResult(intent, REQ_PICK_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    // 先让页面自己处理：关弹层 → 回书架；它说没处理再退出
                    webView.evaluateJavascript("window.__readerBack ? window.__readerBack() : false") { result ->
                        if (result != "true") finish()
                    }
                }
            },
        )

        webView.loadUrl("https://appassets.androidplatform.net/reader/index.html")
    }

    @Deprecated("WebView 的文件选择回调还是这个老口子")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_PICK_FILE) {
            val cb = fileCallback
            fileCallback = null
            cb?.onReceiveValue(
                if (resultCode == RESULT_OK && data != null) {
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                } else {
                    null
                },
            )
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        try {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (e: Exception) {
            // 忽略：退出时销毁失败不影响下次进入
        }
        super.onDestroy()
    }

    private companion object {
        const val REQ_PICK_FILE = 4711
    }
}

