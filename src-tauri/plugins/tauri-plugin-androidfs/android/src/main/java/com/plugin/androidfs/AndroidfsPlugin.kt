package com.plugin.androidfs

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ReadUriArgs {
    var uri: String? = null
}

@TauriPlugin
class AndroidfsPlugin(private val activity: Activity) : Plugin(activity) {
    // Incoming "Open with"/"Share" intents (VIEW/SEND/SEND_MULTIPLE) leave their
    // content:// URIs here. The frontend drains them via takeIncomingUris() at
    // boot (cold start) and on window focus (warm start — a new intent resumes
    // the singleTask activity, refocusing the webview). No event channel needed.
    private val pendingUris = mutableListOf<String>()

    override fun load(webView: WebView) {
        super.load(webView)
        pendingUris.addAll(collectUris(activity.intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingUris.addAll(collectUris(intent))
    }

    // Pull markdown-file URIs out of a VIEW (open) or SEND/SEND_MULTIPLE (share)
    // intent. Returns an empty list for the plain LAUNCHER intent.
    private fun collectUris(intent: Intent?): List<String> {
        if (intent == null) return emptyList()
        val out = mutableListOf<String>()
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let { out.add(it.toString()) }
            Intent.ACTION_SEND ->
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { out.add(it.toString()) }
            Intent.ACTION_SEND_MULTIPLE ->
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach {
                    out.add(it.toString())
                }
        }
        return out
    }

    @Command
    fun takeIncomingUris(invoke: Invoke) {
        val arr = JSArray()
        for (u in pendingUris) {
            arr.put(u)
        }
        pendingUris.clear()
        val ret = JSObject()
        ret.put("uris", arr)
        invoke.resolve(ret)
    }
    // The app-specific EXTERNAL files dir. Kotlin has the Activity/Context, so
    // this is a direct call — no permission needed for app-specific external storage.
    // Resolves { path: "<abs path>" }, or { } (path absent) when unavailable.
    @Command
    fun getExternalFilesDir(invoke: Invoke) {
        val dir = activity.getExternalFilesDir(null)
        val ret = JSObject()
        if (dir != null) {
            ret.put("path", dir.absolutePath)
        }
        invoke.resolve(ret)
    }

    // Read a content:// (or file://) URI's bytes once, for copy-into-app open.
    // The URI comes from the system file picker or an "Open with" intent; a
    // ContentResolver read works without any storage permission (the picker/intent
    // grants transient access). Resolves { base64, displayName? }.
    @Command
    fun readContentUri(invoke: Invoke) {
        val args = invoke.parseArgs(ReadUriArgs::class.java)
        val uriStr = args.uri
        if (uriStr == null) {
            invoke.reject("missing uri")
            return
        }
        try {
            val uri = Uri.parse(uriStr)
            val resolver = activity.contentResolver
            val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes == null) {
                invoke.reject("cannot open uri")
                return
            }
            var name: String? = null
            resolver
                .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) {
                            name = cursor.getString(idx)
                        }
                    }
                }
            val ret = JSObject()
            ret.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            if (name != null) {
                ret.put("displayName", name)
            }
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "read failed")
        }
    }
}
