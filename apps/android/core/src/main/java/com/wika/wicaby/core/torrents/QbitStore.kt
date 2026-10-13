package com.wika.wicaby.core.torrents

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.wika.wicaby.core.data.Vault
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

// Where qBittorrent is and how to sign in. The password is sealed by the Keystore Vault.
data class QbitConfig(val url: String, val username: String, val password: String) {
    override fun toString() = "QbitConfig(url=$url, username=$username)"
}

// Its own DataStore file so the Emby Prefs schema stays untouched.
private val Context.qbitStore by preferencesDataStore("wicaby_torrents")

class QbitStore(private val context: Context) {
    private val urlKey = stringPreferencesKey("url")
    private val userKey = stringPreferencesKey("username")
    private val passKey = stringPreferencesKey("password")

    val config: Flow<QbitConfig?> = context.qbitStore.data.map { p ->
        val url = p[urlKey]?.takeIf { it.isNotBlank() } ?: return@map null
        QbitConfig(url, p[userKey].orEmpty(), p[passKey]?.let(Vault::decrypt).orEmpty())
    }.distinctUntilChanged()

    suspend fun current(): QbitConfig? = config.first()

    suspend fun save(c: QbitConfig) {
        context.qbitStore.edit {
            it[urlKey] = c.url
            it[userKey] = c.username
            if (c.password.isEmpty()) it.remove(passKey) else it[passKey] = Vault.encrypt(c.password)
        }
    }

    suspend fun clear() {
        context.qbitStore.edit { it.clear() }
    }
}
