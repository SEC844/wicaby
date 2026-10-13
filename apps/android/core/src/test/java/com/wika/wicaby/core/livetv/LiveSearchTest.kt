package com.wika.wicaby.core.livetv

import org.junit.Assert.assertEquals
import org.junit.Test

// TP-12: channel matching for the (voice) library search: accents, number words, "chaîne"/"channel" prefixes.
class LiveSearchTest {
    private fun row(id: String, number: String, name: String, i: Int) =
        ChannelRow(id, "srv", number, parseChannelNumber(number), name, null, false, emptyList(), false, i, null)

    private val lineup = listOf(
        row("tf1", "1", "TF1", 0),
        row("f2", "2", "France 2", 1),
        row("f5", "5", "France 5", 2),
        row("m6", "6", "M6", 3),
        row("arte", "7", "Arte", 4),
        row("c8", "8", "Chaîne Parlementaire", 5),
        row("f24", "52", "France 24", 6),
        row("canal", "4", "Canal+", 7),
    )

    private fun ids(q: String) = voiceChannels(lineup, q).map { it.id }

    @Test
    fun foldsCaseAccentsAndNumberWords() {
        assertEquals("5", voiceChannelQuery("Chaîne cinq"))
        assertEquals("5", voiceChannelQuery("la chaîne numéro 5"))
        assertEquals("5", voiceChannelQuery("channel number five"))
        assertEquals("france 2", voiceChannelQuery("France deux"))
        assertEquals("arte", voiceChannelQuery("ARTE"))
        assertEquals("", voiceChannelQuery("chaîne"))
    }

    @Test
    fun prefixedNumberPicksTheChannelFirst() {
        assertEquals("f5", ids("chaîne 5").first())
        assertEquals("f5", ids("Chaine cinq").first())
        assertEquals("f5", ids("channel 5").first())
        assertEquals("m6", ids("channel six").first())
        assertEquals("f24", ids("chaîne 52").first())
    }

    @Test
    fun namesWithAccentsSpokenNumbersAndSpaces() {
        assertEquals("f2", ids("France 2").first())
        assertEquals("f2", ids("france deux").first())
        assertEquals(listOf("c8"), ids("chaine parlementaire"))
        assertEquals(listOf("c8"), ids("CHAÎNE PARLEMENTAIRE"))
        assertEquals(listOf("tf1"), ids("TF 1"))
        assertEquals(listOf("m6"), ids("M six"))
        assertEquals(listOf("canal"), ids("canal"))
    }

    @Test
    fun typedQueriesStillMatchAsBefore() {
        assertEquals(searchChannels(lineup, "fra").map { it.id }, ids("fra"))
        assertEquals(emptyList<String>(), ids("zzz"))
        assertEquals(emptyList<String>(), ids("  "))
        assertEquals(2, voiceChannels(lineup, "france", limit = 2).size)
    }
}
