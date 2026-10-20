package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.MediaStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

// X-05: the golden vectors of CK/fixtures/track/track-fixtures.json (copied here by
// tools/checks/sync-track-fixtures.mjs), shared with tools/checks/track-check.mjs.
class TrackMemoryTest {
    private val fx = Json.parseToJsonElement(javaClass.classLoader!!.getResourceAsStream("track-fixtures.json")!!.bufferedReader(Charsets.UTF_8).readText()).jsonObject

    private fun stream(e: JsonElement): MediaStream {
        val o = e.jsonObject
        fun s(k: String) = o[k]?.jsonPrimitive?.content
        return MediaStream(
            index = o.getValue("Index").jsonPrimitive.intOrNull!!, type = s("Type")!!, codec = s("Codec"), language = s("Language"),
            title = s("Title"), displayTitle = s("DisplayTitle"), isForced = o["IsForced"]?.jsonPrimitive?.booleanOrNull == true,
            channels = o["Channels"]?.jsonPrimitive?.intOrNull,
            isDefault = o["IsDefault"]?.jsonPrimitive?.booleanOrNull == true,
        )
    }

    private fun streams(e: JsonElement?) = e!!.jsonArray.map(::stream)
    private fun expect(o: JsonObject): Int? = (o["expect"] as? JsonPrimitive)?.intOrNull

    // The shared contract: the index the memory picks, -1 = subtitles off, null = no match.
    private fun viaMemory(kind: String, c: TrackMemory.Choice?, s: List<MediaStream>): Int? =
        TrackMemory.pick(c, s).let { if (kind == "audio") it.first else it.second }

    @Test
    fun matching() {
        for (m in fx.getValue("matching").jsonArray.map { it.jsonObject }) {
            val name = m.getValue("name").jsonPrimitive.content
            val kind = m.getValue("kind").jsonPrimitive.content
            val ep1 = streams(m["episode1"])
            val pickedIndex = (m["picked"] as? JsonPrimitive)?.intOrNull
            val picked = pickedIndex?.let { i -> ep1.first { it.index == i } }
            val choice = TrackMemory.remember(null, kind, picked, ep1, 1)
            assertEquals(name, expect(m), viaMemory(kind, choice, streams(m["episode2"])))
            // Round trip through the stored JSON.
            assertEquals("$name (reloaded)", expect(m), viaMemory(kind, TrackMemory.parse(Json.parseToJsonElement(TrackMemory.encode(choice!!).toString())), streams(m["episode2"])))
        }
    }

    @Test
    fun legacyDesktopFormat() {
        for (l in fx.getValue("legacy").jsonArray.map { it.jsonObject }) {
            val kind = l.getValue("kind").jsonPrimitive.content
            assertEquals(l.getValue("name").jsonPrimitive.content, expect(l), viaMemory(kind, TrackMemory.parse(l["choice"]), streams(l["streams"])))
        }
    }

    @Test
    fun scopes() {
        for (sc in fx.getValue("scopes").jsonArray.map { it.jsonObject }) {
            var doc = JsonObject(emptyMap())
            sc.getValue("steps").jsonArray.forEachIndexed { i, st ->
                val o = st.jsonObject
                val prop = o.getValue("prop").jsonPrimitive.content
                val scope = ScopedPrefs.Scope.entries.first { it.name.lowercase() == o.getValue("scope").jsonPrimitive.content }
                val c = o.getValue("ctx").jsonObject
                val ctx = ScopedPrefs.Ctx(c["title"]?.jsonPrimitive?.content, c["library"]?.jsonPrimitive?.content, c["global"]?.jsonPrimitive?.booleanOrNull == true)
                if (o.getValue("op").jsonPrimitive.content == "set") {
                    doc = ScopedPrefs.write(doc, prop, scope, ctx, o.getValue("value"), i.toLong())
                } else {
                    val want = o["expect"].takeIf { it !is JsonNull }?.jsonPrimitive?.content
                    assertEquals("${sc.getValue("name").jsonPrimitive.content}, step $i", want, ScopedPrefs.read(doc, prop, scope, ctx)?.jsonPrimitive?.content)
                }
            }
        }
    }

    @Test
    fun scopeCap() {
        var doc = JsonObject(emptyMap())
        for (i in 0 until 305) doc = ScopedPrefs.write(doc, "speed", ScopedPrefs.Scope.Title, ScopedPrefs.Ctx("t$i"), JsonPrimitive(1.5), i.toLong())
        val titles = doc.getValue("speed").jsonObject.getValue("title").jsonObject
        assertEquals(300, titles.size)
        assertEquals(false, "t0" in titles)
    }

    // Accessibility: a server default of the wrong class gives way to its twin in the same language.
    @Test
    fun accessibleTwins() {
        val a = { i: Int, lang: String, title: String? -> MediaStream(index = i, type = "Audio", language = lang, title = title) }
        val s = { i: Int, lang: String, sdh: Boolean -> MediaStream(index = i, type = "Subtitle", language = lang, isHearingImpaired = sdh) }
        val streams = listOf(
            MediaStream(index = 0, type = "Video"), a(1, "eng", "English AD"), a(2, "eng", null), a(3, "fre", "Audiodescription"), a(4, "fre", null),
            MediaStream(index = 5, type = "Audio", language = "ger", isVisualImpaired = true), s(6, "fre", false), s(7, "fre", true), s(8, "eng", false),
        )
        assertEquals(2, TrackMemory.accessible(streams, 1, false, "avoid"))
        assertEquals(4, TrackMemory.accessible(streams, 4, false, "avoid"))
        assertEquals(5, TrackMemory.accessible(streams, 5, false, "avoid")) // no plain twin
        assertEquals(3, TrackMemory.accessible(streams, 4, false, "prefer"))
        assertEquals(1, TrackMemory.accessible(streams, 1, false, "any"))
        assertEquals(6, TrackMemory.accessible(streams, 6, false, "avoid"))
        assertEquals(7, TrackMemory.accessible(streams, 6, true, "avoid"))
        assertEquals(8, TrackMemory.accessible(streams, 8, true, "avoid")) // no SDH twin
        assertEquals("AD", TrackMemory.badge(streams[1]))
        assertEquals("SDH", TrackMemory.badge(streams[7]))
        assertEquals(null, TrackMemory.badge(MediaStream(index = 9, type = "Audio", title = "Bad Audio")))
    }
}
