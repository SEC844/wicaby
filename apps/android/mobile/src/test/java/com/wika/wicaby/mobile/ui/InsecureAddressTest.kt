package com.wika.wicaby.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The sign-in screen warns before a password goes in clear: plain HTTP off the LAN, loopback and mesh only.
class InsecureAddressTest {
    @Test
    fun onlyPlainHttpOffTheLanWarns() {
        assertTrue(insecureAddress("http://media.example.com:8096"))
        assertTrue(insecureAddress("http://203.0.113.7:8096"))
        for (a in listOf("https://media.example.com", "http://192.168.1.20:8096", "http://100.101.102.103:8096", "http://localhost:8096", "http://nas.local:8096", "http://nas:8096")) {
            assertFalse(a, insecureAddress(a))
        }
    }
}
