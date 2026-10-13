package com.wika.wicaby.core.livetv

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Live TV preferences store (spec §5.4, §7.1): the DisplayPreferences document `wicaby-livetv` per
// user per server, with a DataStore mirror for offline display. Changes apply at once in [prefs],
// queue, and are written 2 s after the last one through one serialized read-modify-write (GET, merge
// only lt.* keys, POST the whole DTO). Nothing is written while the document failed to load: the
// queue waits for a successful read, so a failed read never becomes an empty overwrite.

/** Its own DataStore file: the Live TV mirror and device-only Live TV settings. */
val Context.liveTvStore: DataStore<Preferences> by preferencesDataStore("wicaby_livetv")

const val PREFS_DEBOUNCE_MS = 2_000L

class LivePrefs(
    /** GET of the document. */
    private val read: suspend () -> JsonObject,
    /** POST of the whole document. */
    private val write: suspend (JsonObject) -> Unit,
    private val scope: CoroutineScope,
    /** Offline copy of CustomPrefs; null: none. */
    private val mirror: DataStore<Preferences>? = null,
    /** One mirror entry per server and user. */
    mirrorKey: String = "prefs",
    private val debounceMs: Long = PREFS_DEBOUNCE_MS,
) {
    private val key = stringPreferencesKey("livetv.custom.$mirrorKey")
    private val lock = Any()
    private var sync = syncInit()
    private val writeMutex = Mutex()
    private var writeJob: Job? = null

    private val _prefs = MutableStateFlow(defaultPrefs())
    val prefs: StateFlow<LiveTvPrefs> = _prefs.asStateFlow()

    private val _load = MutableStateFlow(PrefsLoad.PENDING)
    val load: StateFlow<PrefsLoad> = _load.asStateFlow()

    /** The last write or read-before-write failed ("Réglages des chaînes non synchronisés"). */
    private val _syncFailed = MutableStateFlow(false)
    val syncFailed: StateFlow<Boolean> = _syncFailed.asStateFlow()

    private fun withQueued(p: LiveTvPrefs): LiveTvPrefs = sync.queued.fields.fold(p) { acc, f -> acc.withField(f, sync.queued.values) }

    /** Loads the document (on each Live TV open). Until it answers, the mirror is shown. */
    suspend fun load() {
        if (_load.value != PrefsLoad.OK) {
            readMirror()?.let { m -> synchronized(lock) { _prefs.value = withQueued(decodePrefs(m)) } }
        }
        val doc = try {
            read()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        synchronized(lock) {
            sync = loaded(sync, doc != null)
            if (doc != null) _prefs.value = withQueued(decodePrefs(customPrefsOf(doc)))
            _load.value = sync.load
        }
        if (doc != null) {
            writeMirror(customPrefsOf(doc))
            if (synchronized(lock) { !sync.queued.isEmpty() }) scheduleWrite()
        }
    }

    /** Applies [patch] now and queues it for the server (last writer wins per field). */
    fun update(patch: PrefsPatch) {
        if (patch.isEmpty()) return
        synchronized(lock) {
            sync = queueChange(sync, patch)
            _prefs.value = patch.fields.fold(_prefs.value) { acc, f -> acc.withField(f, patch.values) }
        }
        scheduleWrite()
    }

    fun update(field: PrefField, values: LiveTvPrefs) = update(PrefsPatch.of(values, field))

    /** Favourite toggles and order edits are refused while favourites or prefs failed to load (§6.5). */
    fun canEditFavorites(favoritesLoaded: Boolean): Boolean = synchronized(lock) { canEditFavorites(sync, favoritesLoaded) }

    private fun scheduleWrite() {
        synchronized(lock) {
            writeJob?.cancel()
            writeJob = scope.launch {
                delay(debounceMs)
                flush()
            }
        }
    }

    /** Writes the queue now: GET, merge, POST. Refused (queue kept) unless the document loaded. */
    suspend fun flush() = writeMutex.withLock {
        if (synchronized(lock) { sync.load != PrefsLoad.OK || sync.queued.isEmpty() }) return@withLock
        val fresh = try {
            read()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _syncFailed.value = true
            return@withLock
        }
        val (plan, sent) = synchronized(lock) {
            val sent = sync.queued
            val w = planWrite(sync, fresh) ?: return@withLock
            sync = w.next
            w to sent
        }
        try {
            write(plan.body)
            _syncFailed.value = false
            writeMirror(customPrefsOf(plan.body))
        } catch (e: CancellationException) {
            synchronized(lock) { sync = sync.copy(queued = sent + sync.queued) }
            throw e
        } catch (e: Exception) {
            // Back in the queue, under anything changed since; the next change or open retries.
            synchronized(lock) { sync = sync.copy(queued = sent + sync.queued) }
            _syncFailed.value = true
        }
    }

    private suspend fun readMirror(): Map<String, String>? {
        val m = mirror ?: return null
        return runCatching {
            val text = m.data.first()[key] ?: return null
            customPrefsOf(JsonObject(mapOf("CustomPrefs" to LiveJson.parseToJsonElement(text))))
        }.getOrNull()
    }

    private suspend fun writeMirror(custom: Map<String, String>) {
        val m = mirror ?: return
        runCatching { m.edit { it[key] = JsonObject(custom.mapValues { e -> JsonPrimitive(e.value) }).toString() } }
    }
}
