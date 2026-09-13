package org.aegisub.web

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.util.UUID

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val handles = mutableMapOf<String, Uri>()
    private var pendingOpenId: Int? = null
    private var pendingSave: Triple<Int, String, ByteArray>? = null

    private val openDocument = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val id = pendingOpenId ?: return@registerForActivityResult
        pendingOpenId = null
        if (uri == null) return@registerForActivityResult respond(id, JSONObject.NULL)
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val token = UUID.randomUUID().toString().replace("-", "")
        handles[token] = uri
        val result = JSONObject().put("token", token).put("name", displayName(uri)).put("mime", contentResolver.getType(uri) ?: "application/octet-stream")
        respond(id, result)
    }

    private val createDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val save = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri != null) contentResolver.openOutputStream(uri)?.use { it.write(save.third) }
        respond(save.first, JSONObject().put("saved", uri != null))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/media/", WebViewAssetLoader.PathHandler { path ->
                val uri = handles[path.substringBefore('/')] ?: return@PathHandler null
                WebResourceResponse(contentResolver.getType(uri) ?: "application/octet-stream", null, contentResolver.openInputStream(uri))
            })
            .build()
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowContentAccess = true
            addJavascriptInterface(HostBridge(), "AegisubHost")
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = assets.shouldInterceptRequest(request.url)
            }
            loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
        }
        setContentView(webView)
    }

    private inner class HostBridge {
        @JavascriptInterface fun postMessage(message: String) = runOnUiThread { handleMessage(JSONObject(message)) }
    }

    private fun handleMessage(request: JSONObject) {
        val id = request.getInt("id")
        val method = request.getString("method")
        val params = request.getJSONObject("params")
        try {
            when (method) {
                "openFile" -> { pendingOpenId = id; openDocument.launch(arrayOf("*/*")) }
                "readFile" -> {
                    val bytes = contentResolver.openInputStream(resolve(params.getString("token")))!!.use { it.readBytes() }
                    respond(id, JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                }
                "saveFile" -> {
                    pendingSave = Triple(id, params.getString("name"), Base64.decode(params.getString("base64"), Base64.DEFAULT))
                    createDocument.launch(params.getString("name"))
                }
                "openMedia" -> {
                    val token = params.getString("token")
                    resolve(token)
                    respond(id, JSONObject().put("url", "https://appassets.androidplatform.net/media/$token"))
                }
                else -> throw IllegalArgumentException("Unknown host method: $method")
            }
        } catch (error: Exception) { respondError(id, error.message ?: "Host operation failed") }
    }

    private fun resolve(token: String) = handles[token] ?: throw IllegalArgumentException("The selected file handle has expired")

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) return cursor.getString(0)
        }
        return "selected-file"
    }

    private fun respond(id: Int, result: Any) = dispatch(JSONObject().put("id", id).put("result", result))
    private fun respondError(id: Int, error: String) = dispatch(JSONObject().put("id", id).put("error", error))
    private fun dispatch(payload: JSONObject) {
        val script = "window.dispatchEvent(new CustomEvent('aegisub-host-message',{detail:${payload}}))"
        webView.evaluateJavascript(script, null)
    }
}
