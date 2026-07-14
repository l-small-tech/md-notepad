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
import java.io.File

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

    // Extract the bundled `docs` asset folder to a real filesystem path.
    // The APK ships the user guide as compressed assets (a `resolveResource`
    // path would be an `asset://` URI), but the app's read/list/stat commands
    // all use std::fs, which can't touch assets. So copy the tree into internal
    // storage (`filesDir/docs`) once per launch — overwriting, so an app update
    // refreshes the guide — and hand back that POSIX path. Resolves { path }.
    @Command
    fun extractDocs(invoke: Invoke) {
        try {
            val dest = File(activity.filesDir, "docs")
            copyAsset("docs", dest)
            val ret = JSObject()
            ret.put("path", dest.absolutePath)
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "extract failed")
        }
    }

    // Recursively copy an APK asset path to `dest`, overwriting files.
    // AssetManager.list() returns a directory's children, or an empty array for
    // a file — our docs tree has no empty directories, so empty means "leaf".
    private fun copyAsset(assetPath: String, dest: File) {
        val children = activity.assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            activity.assets.open(assetPath).use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            return
        }
        dest.mkdirs()
        for (child in children) {
            copyAsset("$assetPath/$child", File(dest, child))
        }
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
