package com.plugin.androidfs

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
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

/** Args for the SAF ops that address a document by tree URI + relative path. */
@InvokeArg
class SafPathArgs {
    var treeUri: String? = null
    var relPath: String? = null
}

@InvokeArg
class SafWriteArgs {
    var treeUri: String? = null
    var relPath: String? = null
    var base64: String? = null
}

@InvokeArg
class SafRenameArgs {
    var treeUri: String? = null
    var relPath: String? = null
    var newName: String? = null
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
    ],
)
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

    /* ---- Storage Access Framework (synced-folder workspaces) ------------- */
    //
    // A "synced folder" is any SAF DocumentsProvider tree (Google Drive,
    // OneDrive, an SD card, …) the user picked via ACTION_OPEN_DOCUMENT_TREE.
    // Files are addressed by (treeUri, relPath); every op resolves the relPath
    // to a document id under the tree. `findFile`-style resolution lists a whole
    // directory per level, and providers like Drive are network-backed, so a
    // process-lived docId cache (populated as directories are listed, evicted on
    // mutation) keeps the common flat-folder case at ~one network list per dir.
    // The cache survives across @Command calls, like pendingUris above.

    // treeUri -> (relPath -> documentId). relPath "" is the tree root.
    private val docIdCache = HashMap<String, HashMap<String, String>>()

    private fun cacheFor(treeUri: String): HashMap<String, String> =
        docIdCache.getOrPut(treeUri) { HashMap() }

    private fun docUri(tree: Uri, docId: String): Uri =
        DocumentsContract.buildDocumentUriUsingTree(tree, docId)

    private data class Child(
        val name: String,
        val docId: String,
        val isDir: Boolean,
        val size: Long,
        val mtime: Long,
    )

    // Enumerate one directory level, caching every child's docId under its
    // relPath. `parentRel` is "" for the tree root.
    private fun listChildren(treeUri: String, parentId: String, parentRel: String): List<Child> {
        val tree = Uri.parse(treeUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val cache = cacheFor(treeUri)
        val out = ArrayList<Child>()
        activity.contentResolver.query(
            childrenUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            ),
            null,
            null,
            null,
        )?.use { c ->
            val idI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val sizeI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
            val modI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            while (c.moveToNext()) {
                val id = c.getString(idI) ?: continue
                val name = c.getString(nameI) ?: continue
                val isDir = c.getString(mimeI) == DocumentsContract.Document.MIME_TYPE_DIR
                val size = if (c.isNull(sizeI)) 0L else c.getLong(sizeI)
                val mtime = if (c.isNull(modI)) 0L else c.getLong(modI)
                val rel = if (parentRel.isEmpty()) name else "$parentRel/$name"
                cache[rel] = id
                out.add(Child(name, id, isDir, size, mtime))
            }
        }
        return out
    }

    // Resolve a relPath to its document id, or null if any segment is missing.
    private fun resolveDocId(treeUri: String, relPath: String): String? {
        val tree = Uri.parse(treeUri)
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rel = relPath.trim('/')
        if (rel.isEmpty()) return rootId
        val cache = cacheFor(treeUri)
        cache[rel]?.let { return it }
        var parentId = rootId
        var parentRel = ""
        for (seg in rel.split('/')) {
            val curRel = if (parentRel.isEmpty()) seg else "$parentRel/$seg"
            val id = cache[curRel]
                ?: listChildren(treeUri, parentId, parentRel).firstOrNull { it.name == seg }?.docId
                ?: return null
            parentId = id
            parentRel = curRel
        }
        return parentId
    }

    // Resolve `relDir`, creating any missing segments (mkdir -p). Returns the
    // directory's document id, or null on failure.
    private fun ensureDir(treeUri: String, relDir: String): String? {
        val tree = Uri.parse(treeUri)
        val rel = relDir.trim('/')
        if (rel.isEmpty()) return DocumentsContract.getTreeDocumentId(tree)
        resolveDocId(treeUri, rel)?.let { return it }
        val cache = cacheFor(treeUri)
        var parentId = DocumentsContract.getTreeDocumentId(tree)
        var parentRel = ""
        for (seg in rel.split('/')) {
            val curRel = if (parentRel.isEmpty()) seg else "$parentRel/$seg"
            var id = cache[curRel]
                ?: listChildren(treeUri, parentId, parentRel).firstOrNull { it.name == seg }?.docId
            if (id == null) {
                val created = DocumentsContract.createDocument(
                    activity.contentResolver,
                    docUri(tree, parentId),
                    DocumentsContract.Document.MIME_TYPE_DIR,
                    seg,
                ) ?: return null
                id = DocumentsContract.getDocumentId(created)
                cache[curRel] = id
            }
            parentId = id
            parentRel = curRel
        }
        return parentId
    }

    // Drop `rel` and everything under it from the cache (after a mutation).
    private fun evictSubtree(treeUri: String, rel: String) {
        val cache = docIdCache[treeUri] ?: return
        val prefix = "$rel/"
        cache.keys.toList().forEach { k ->
            if (k == rel || k.startsWith(prefix)) cache.remove(k)
        }
    }

    private fun mimeForName(name: String): String =
        when (name.substringAfterLast('.', "").lowercase()) {
            "md", "markdown" -> "text/markdown"
            "txt" -> "text/plain"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "bmp" -> "image/bmp"
            "avif" -> "image/avif"
            else -> "application/octet-stream"
        }

    private fun queryTreeDisplayName(tree: Uri): String? {
        val docId = DocumentsContract.getTreeDocumentId(tree)
        activity.contentResolver.query(
            docUri(tree, docId),
            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { c -> if (c.moveToFirst()) return c.getString(0) }
        return null
    }

    // Launch the system folder picker. The persistable read/write grant is
    // taken in the activity-result callback below, then { treeUri, displayName }
    // resolves. A cancel rejects.
    @Command
    fun pickSyncedTree(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            )
            // Park the picker inside Documents. It's a selectable (non-blocklisted)
            // location, so the system's "USE THIS FOLDER" button is enabled on
            // arrival instead of greyed out with "To protect your privacy, choose
            // another folder" — which is what the user hits at storage/Download
            // roots. Honoured from API 26; older versions just ignore the extra.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val initial = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents",
                    "primary:Documents",
                )
                putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial)
            }
        }
        startActivityForResult(invoke, intent, "onTreePicked")
    }

    @ActivityCallback
    fun onTreePicked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.reject("cancelled")
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            invoke.reject("no tree selected")
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            invoke.reject(e.message ?: "could not persist folder permission")
            return
        }
        val name = queryTreeDisplayName(uri) ?: DocumentsContract.getTreeDocumentId(uri)
        val ret = JSObject()
        ret.put("treeUri", uri.toString())
        ret.put("displayName", name)
        invoke.resolve(ret)
    }

    // List one directory level: { entries: [{ name, isDir, size, mtimeMs }] }.
    // Filtering (.md/images, dot-files) is done on the TS side, mirroring list_dir.
    @Command
    fun safList(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: ""
        try {
            val dirId = resolveDocId(treeUri, relPath)
                ?: return invoke.reject("NOT_FOUND: $relPath")
            val children = listChildren(treeUri, dirId, relPath.trim('/'))
            val arr = JSArray()
            for (ch in children) {
                val o = JSObject()
                o.put("name", ch.name)
                o.put("isDir", ch.isDir)
                o.put("size", ch.size)
                o.put("mtimeMs", ch.mtime)
                arr.put(o)
            }
            val ret = JSObject()
            ret.put("entries", arr)
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "list failed")
        }
    }

    // Read a document's bytes as base64. mtime is deliberately not returned —
    // SAF/Drive last-modified is unreliable, so the app treats synced files as
    // having no mtime baseline (see src/ipc/provider.ts).
    @Command
    fun safRead(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: ""
        try {
            val docId = resolveDocId(treeUri, relPath)
                ?: return invoke.reject("NOT_FOUND: $relPath")
            val uri = docUri(Uri.parse(treeUri), docId)
            val bytes = activity.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: return invoke.reject("NOT_FOUND: $relPath")
            val ret = JSObject()
            ret.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "read failed")
        }
    }

    // Create-or-truncate write. Missing parent directories are created (mkdir -p).
    // Not atomic (SAF has no temp+rename); Drive keeps version history, so a torn
    // write is recoverable but not prevented.
    @Command
    fun safWrite(invoke: Invoke) {
        val args = invoke.parseArgs(SafWriteArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: return invoke.reject("missing relPath")
        val base64 = args.base64 ?: return invoke.reject("missing base64")
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val tree = Uri.parse(treeUri)
            val rel = relPath.trim('/')
            val parentRel = rel.substringBeforeLast('/', "")
            val name = rel.substringAfterLast('/')
            val parentId = ensureDir(treeUri, parentRel)
                ?: return invoke.reject("IO: could not create parent folder")
            val existing = resolveDocId(treeUri, rel)
            val uri = if (existing != null) {
                docUri(tree, existing)
            } else {
                val created = DocumentsContract.createDocument(
                    activity.contentResolver,
                    docUri(tree, parentId),
                    mimeForName(name),
                    name,
                ) ?: return invoke.reject("IO: could not create file")
                cacheFor(treeUri)[rel] = DocumentsContract.getDocumentId(created)
                created
            }
            activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                ?: return invoke.reject("IO: could not open file for writing")
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "write failed")
        }
    }

    // Create a directory (mkdir -p on the parents); EXISTS if the leaf is taken.
    @Command
    fun safCreateDir(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: return invoke.reject("missing relPath")
        try {
            if (resolveDocId(treeUri, relPath) != null) {
                return invoke.reject("EXISTS: $relPath")
            }
            ensureDir(treeUri, relPath) ?: return invoke.reject("IO: could not create folder")
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "mkdir failed")
        }
    }

    // Same-parent display rename. Cross-directory moves are done as copy+delete
    // on the TS side, so this only ever changes a document's display name.
    @Command
    fun safRename(invoke: Invoke) {
        val args = invoke.parseArgs(SafRenameArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: return invoke.reject("missing relPath")
        val newName = args.newName ?: return invoke.reject("missing newName")
        try {
            val docId = resolveDocId(treeUri, relPath)
                ?: return invoke.reject("NOT_FOUND: $relPath")
            DocumentsContract.renameDocument(
                activity.contentResolver,
                docUri(Uri.parse(treeUri), docId),
                newName,
            ) ?: return invoke.reject("IO: rename failed")
            evictSubtree(treeUri, relPath.trim('/'))
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "rename failed")
        }
    }

    // Delete a document (idempotent — a missing target is success, matching
    // delete_path, so the flusher can retry a plan whose delete already ran).
    @Command
    fun safDelete(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: return invoke.reject("missing relPath")
        try {
            val docId = resolveDocId(treeUri, relPath)
                ?: return invoke.resolve(JSObject())
            DocumentsContract.deleteDocument(
                activity.contentResolver,
                docUri(Uri.parse(treeUri), docId),
            )
            evictSubtree(treeUri, relPath.trim('/'))
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "delete failed")
        }
    }

    // Existence + type/size/mtime, without reading content.
    @Command
    fun safStat(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        val relPath = args.relPath ?: ""
        try {
            val docId = resolveDocId(treeUri, relPath)
            val ret = JSObject()
            if (docId == null) {
                ret.put("exists", false)
                invoke.resolve(ret)
                return
            }
            var isDir = false
            var size = 0L
            var mtime = 0L
            activity.contentResolver.query(
                docUri(Uri.parse(treeUri), docId),
                arrayOf(
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                ),
                null,
                null,
                null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    val mimeI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val sizeI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
                    val modI = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    isDir = c.getString(mimeI) == DocumentsContract.Document.MIME_TYPE_DIR
                    size = if (c.isNull(sizeI)) 0L else c.getLong(sizeI)
                    mtime = if (c.isNull(modI)) 0L else c.getLong(modI)
                }
            }
            ret.put("exists", true)
            ret.put("isDir", isDir)
            ret.put("size", size)
            ret.put("mtimeMs", mtime)
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "stat failed")
        }
    }

    // Release a persisted folder permission (workspace removal). Best-effort —
    // a missing/already-released grant is not an error.
    @Command
    fun releaseSyncedTree(invoke: Invoke) {
        val args = invoke.parseArgs(SafPathArgs::class.java)
        val treeUri = args.treeUri ?: return invoke.reject("missing treeUri")
        try {
            activity.contentResolver.releasePersistableUriPermission(
                Uri.parse(treeUri),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            // Best effort; the settings entry is dropped regardless.
        }
        docIdCache.remove(treeUri)
        invoke.resolve(JSObject())
    }

    /* ---- On-device speech-to-text (voice comments) ----------------------- */
    //
    // Android's SpeechRecognizer with EXTRA_PREFER_OFFLINE keeps dictation on the
    // device (no cloud, no UI overlay) — the app owns the mic via tap-and-hold.
    // The recognizer MUST be created and driven on the main thread, and its
    // results arrive asynchronously through a RecognitionListener, so we hold the
    // startSpeech Invoke and resolve it from onResults / onError. v1 returns only
    // the final transcript (partials are ignored) to keep this a clean
    // request/response, mirroring every other command here.

    private var recognizer: SpeechRecognizer? = null
    private var speechInvoke: Invoke? = null

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    // Whether on-device recognition is available at all on this device.
    @Command
    fun sttAvailable(invoke: Invoke) {
        val ret = JSObject()
        ret.put("available", SpeechRecognizer.isRecognitionAvailable(activity))
        invoke.resolve(ret)
    }

    // Current RECORD_AUDIO grant, without prompting: { granted }.
    @Command
    fun sttPermission(invoke: Invoke) {
        val ret = JSObject()
        ret.put("granted", hasMicPermission())
        invoke.resolve(ret)
    }

    // Prompt for RECORD_AUDIO if needed; resolves { granted } after the user
    // answers (or immediately if already granted).
    @Command
    fun sttRequestPermission(invoke: Invoke) {
        if (hasMicPermission()) {
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
            return
        }
        requestPermissionForAlias("microphone", invoke, "sttPermissionCallback")
    }

    @PermissionCallback
    fun sttPermissionCallback(invoke: Invoke) {
        val ret = JSObject()
        ret.put("granted", hasMicPermission())
        invoke.resolve(ret)
    }

    // Start listening; resolves { text } with the final transcript, or rejects
    // ("PERMISSION_DENIED" / "STT_BUSY" / "STT_UNAVAILABLE" / "STT_ERROR:<n>").
    @Command
    fun startSpeech(invoke: Invoke) {
        if (!hasMicPermission()) {
            invoke.reject("PERMISSION_DENIED")
            return
        }
        activity.runOnUiThread {
            if (speechInvoke != null) {
                invoke.reject("STT_BUSY")
                return@runOnUiThread
            }
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                invoke.reject("STT_UNAVAILABLE")
                return@runOnUiThread
            }
            speechInvoke = invoke
            val rec = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = rec
            rec.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
                override fun onError(error: Int) {
                    resolveSpeech(null, error)
                }
                override fun onResults(results: Bundle?) {
                    resolveSpeech(firstResult(results) ?: "", null)
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
            }
            try {
                rec.startListening(intent)
            } catch (e: Exception) {
                resolveSpeech(null, -1)
            }
        }
    }

    // Stop listening; the final transcript still arrives via onResults, resolving
    // the pending startSpeech. This call itself just acknowledges.
    @Command
    fun stopSpeech(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                recognizer?.stopListening()
            } catch (e: Exception) {
                // Ignore — a torn-down recognizer needs no stop.
            }
        }
        invoke.resolve(JSObject())
    }

    // Resolve/reject the held startSpeech invoke and destroy the recognizer.
    // Runs on the main thread (called from listener callbacks or startSpeech).
    private fun resolveSpeech(text: String?, error: Int?) {
        val invoke = speechInvoke
        speechInvoke = null
        if (invoke != null) {
            if (text != null) {
                val ret = JSObject()
                ret.put("text", text)
                invoke.resolve(ret)
            } else {
                invoke.reject("STT_ERROR:${error ?: -1}")
            }
        }
        recognizer?.let {
            try {
                it.destroy()
            } catch (e: Exception) {
                // Best effort.
            }
        }
        recognizer = null
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
}
