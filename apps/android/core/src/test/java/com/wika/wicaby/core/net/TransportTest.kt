package com.wika.wicaby.core.net

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportTest {
    @Test
    fun rewritesOntoForwarderWithPathToken() {
        val u = "http://100.64.0.5:8096/emby/Items/abc/Images/Primary?tag=x&maxHeight=300".toHttpUrl()
        assertEquals(
            "http://127.0.0.1:41234/tok/emby/Items/abc/Images/Primary?tag=x&maxHeight=300",
            rewrite(u, "http://127.0.0.1:41234/tok/").toString(),
        )
    }

    @Test
    fun keepsEncodingAndHandlesBareBase() {
        val u = "https://nas.lan:8920/Videos/1/stream?api_key=a%2Bb".toHttpUrl()
        assertEquals("http://127.0.0.1:9000/Videos/1/stream?api_key=a%2Bb", rewrite(u, "http://127.0.0.1:9000").toString())
    }

    @Test
    fun originIncludesDefaultPort() {
        assertEquals("https://example.org:443", origin("https://example.org/emby".toHttpUrl()))
        assertEquals("http://10.0.2.2:8230", origin("http://10.0.2.2:8230/emby/System/Info".toHttpUrl()))
    }
}
