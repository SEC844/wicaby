package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.DavListing
import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.core.files.pure.Names
import com.wika.wicaby.core.files.pure.NatSort
import com.wika.wicaby.core.files.pure.Nfo
import com.wika.wicaby.core.files.pure.ParsedSource
import com.wika.wicaby.core.files.pure.ProgressRecord
import com.wika.wicaby.core.files.pure.ProgressRules
import com.wika.wicaby.core.files.pure.Propfind
import com.wika.wicaby.core.files.pure.Shapes
import com.wika.wicaby.core.files.pure.SidecarRules
import com.wika.wicaby.core.files.pure.Sidecars
import com.wika.wicaby.core.files.pure.Urls
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// FS-01: the Kotlin pure core against the golden vectors the desktop checks too (tools/checks/fixtures/files, copied
// onto the test classpath by copyFilesFixtures; desktop: tools/checks/files-core-check.mjs). Same cases, same counts.
class FilesVectorsTest {
    private fun load(name: String): JsonElement =
        Json.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/files/$name")) { "missing /files/$name" }.readBytes().decodeToString())

    private var cases = 0

    private fun eq(expected: Any?, actual: Any?, msg: String) {
        assertEquals(msg, expected, actual)
        cases++
    }

    // A JSON object without its null members, as JSON.stringify writes an object with undefined fields.
    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.mapNotNull { (k, v) -> json(v)?.let { k to it } }.toMap())

    private fun json(v: Any?): JsonElement? = when (v) {
        null -> null
        is JsonElement -> v
        is String -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is List<*> -> JsonArray(v.map { json(it) ?: JsonNull })
        is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to (json(x) ?: JsonNull) })
        else -> error("no JSON for $v")
    }

    private val JsonElement.str get() = jsonPrimitive.content

    @Test
    fun paths() {
        val p = load("paths.json").jsonObject
        val hostile = p.getValue("hostile").jsonArray.map { it.str }
        assertTrue("at least 40 hostile paths (${hostile.size})", hostile.size >= 40)
        for (v in p.getValue("valid").jsonArray.map { it.jsonObject }) {
            eq(v.getValue("id").str, Ids.encode(v.getValue("rel").str), "encode ${v["rel"]}")
            eq(v.getValue("rel").str, Ids.decode(v.getValue("id").str), "decode ${v["id"]}")
        }
        for (r in hostile) eq(false, Ids.guard(r), "guard refuses ${r.take(60)}")
        for (r in hostile) eq(null, Ids.encode(r), "no id for ${r.take(60)}")
        for (i in p.getValue("hostileIds").jsonArray.map { it.str }) eq(null, Ids.decode(i), "decode refuses ${i.take(60)}")
        for (r in p.getValue("noId").jsonArray.map { it.str }) {
            assertTrue(Ids.guard(r))
            eq(null, Ids.encode(r), "too long for an id")
        }
        for (c in p.getValue("crumbs").jsonArray.map { it.jsonObject }) {
            eq(c.getValue("crumbs"), json(Ids.crumbs(c.getValue("rel").str).map { (id, name) -> mapOf("id" to id, "name" to name) }), "crumbs of ${c["rel"]}")
        }
        assertEquals("", Ids.decode("p."))
        for (a in listOf("..", "a/../b", "C:", "CON")) assertTrue("hand: $a", !Ids.guard(a))
    }

    @Test
    fun natsort() {
        val n = load("natsort.json").jsonObject
        for (p in n.getValue("pairs").jsonArray.map { it.jsonObject }) {
            val a = p.getValue("a").str
            val b = p.getValue("b").str
            val cmp = p.getValue("cmp").jsonPrimitive.int
            eq(cmp, Integer.signum(NatSort.compare(a, b)), "$a vs $b")
            eq(-cmp, Integer.signum(NatSort.compare(b, a)), "$b vs $a (antisymmetric)")
        }
        val sorted = n.getValue("sorted").jsonObject
        eq(sorted.getValue("output").jsonArray.map { it.str }, sorted.getValue("input").jsonArray.map { it.str }.sortedWith(NatSort), "sorted list")
        assertTrue(NatSort.compare("E2", "E10") < 0 && NatSort.compare("Season 2", "Season 10") < 0 && NatSort.compare("01", "1") < 0)
    }

    @Test
    fun names() {
        for (v in load("names.json").jsonArray.map { it.jsonObject }) {
            val input = v.getValue("input").str
            val got = Names.parse(input)
            val expect = JsonObject(v - "input" - "label")
            eq(expect, obj("title" to got.title, "year" to got.year, "season" to got.season, "episode" to got.episode, "episodeEnd" to got.episodeEnd, "date" to got.date), "name $input")
            eq(v.getValue("label").str, got.label, "label $input")
        }
        assertEquals(Names.parse("Example.Show.S01E02.720p.mkv").let { Triple(it.title, it.season, it.episode) }, Triple("Example Show", 1, 2))
        assertEquals(Names.parse("Example.Movie.2019.1080p.mkv").let { it.title to it.year }, "Example Movie" to 2019)
    }

    private fun sidecarJson(s: Sidecars, subtitles: Boolean) = obj(
        "poster" to s.poster, "backdrop" to s.backdrop, "nfo" to s.nfo,
        "subtitles" to if (!subtitles) null else s.subtitles.map {
            obj("name" to it.name, "forced" to it.forced, "hearingImpaired" to it.hearingImpaired, "codec" to it.codec, "language" to it.language)
        },
    )

    @Test
    fun sidecars() {
        val side = load("sidecars.json").jsonObject
        val videos = side.getValue("videos").jsonArray.map { it.jsonObject }
        for (c in videos) {
            val video = c.getValue("video").str
            eq(c.getValue("expect"), sidecarJson(SidecarRules.video(video, c.getValue("names").jsonArray.map { it.str }), true), "sidecars of $video")
        }
        for (c in side.getValue("folders").jsonArray.map { it.jsonObject }) {
            val names = c.getValue("names").jsonArray.map { it.str }
            eq(c.getValue("expect"), sidecarJson(SidecarRules.folder(names), false), "folder sidecars $names")
        }
        val movie = SidecarRules.video("Example.Movie.2019.1080p.mkv", videos[0].getValue("names").jsonArray.map { it.str })
        assertEquals("poster.jpg", movie.poster)
        assertEquals(listOf("en" to true, "fr" to false), movie.subtitles.map { it.language to it.forced })
    }

    @Test
    fun nfo() {
        for (c in load("nfo.json").jsonArray.map { it.jsonObject }) {
            val input = c.getValue("input").str
            val got = Nfo.parse(input)?.let {
                obj(
                    "kind" to it.kind, "genres" to it.genres, "providerIds" to it.providerIds, "title" to it.title, "year" to it.year, "plot" to it.plot,
                    "season" to it.season, "episode" to it.episode, "runtimeMin" to it.runtimeMin,
                )
            } ?: JsonNull
            eq(c.getValue("expect"), got, "nfo ${input.take(40)}")
        }
        assertEquals("Example Movie & Friends", Nfo.parse("<movie><title>Example Movie &amp; Friends</title></movie>")?.title)
        assertEquals("&x;", Nfo.parse("<!DOCTYPE m [<!ENTITY x \"boom\">]><movie><title>&x;</title></movie>")?.title)
    }

    private fun davJson(l: DavListing) = obj(
        "entries" to l.entries.map { obj("name" to it.name, "dir" to it.dir, "size" to it.size, "mtime" to it.mtime) },
        "dropped" to l.dropped,
        "self" to l.self?.let { obj("name" to it.name, "dir" to it.dir, "size" to it.size, "mtime" to it.mtime) },
    )

    @Test
    fun propfind() {
        val pf = load("propfind.json").jsonObject
        val base = pf.getValue("base").str
        val all = pf.getValue("cases").jsonArray.map { it.jsonObject }
        all.forEachIndexed { i, c -> eq(c.getValue("expect"), davJson(Propfind.parse(c.getValue("xml").str, base, c.getValue("rel").str)), "propfind ${c["rel"]} #$i") }
        val evil = Propfind.parse(all[2].getValue("xml").str, base, "")
        assertTrue("evil hrefs dropped", evil.dropped >= 6 && evil.entries.single().name == "ok.mkv")
    }

    private fun recordOf(o: JsonObject) = ProgressRecord(
        size = o.getValue("size").jsonPrimitive.long, mtimeSec = o.getValue("mtimeSec").jsonPrimitive.long,
        positionMs = o.getValue("positionMs").jsonPrimitive.long, durationMs = o.getValue("durationMs").jsonPrimitive.long,
        played = o.getValue("played").jsonPrimitive.boolean, hidden = o.getValue("hidden").jsonPrimitive.boolean,
        lastPlayedAt = o.getValue("lastPlayedAt").jsonPrimitive.long, title = o["title"]?.str,
    )

    private fun docOf(o: JsonObject) = o.getValue("records").jsonObject.mapValues { recordOf(it.value.jsonObject) }

    @Test
    fun progress() {
        val pr = load("progress.json").jsonObject
        for (k in pr.getValue("keys").jsonArray.map { it.jsonObject }) {
            eq(k.getValue("key").str, ProgressRules.key(k.getValue("rel").str, k.getValue("size").jsonPrimitive.long, k.getValue("mtimeMs").jsonPrimitive.long), "key ${k["rel"]}")
        }
        val file = pr.getValue("file").jsonObject
        val size = file.getValue("size").jsonPrimitive.long
        val mtime = file.getValue("mtimeMs").jsonPrimitive.long
        val now = pr.getValue("now").jsonPrimitive.long
        for (r in pr.getValue("reports").jsonArray.map { it.jsonObject }) {
            val prev = (r["prev"] as? JsonObject)?.let(::recordOf)
            val pos = r.getValue("pos").jsonPrimitive.long
            val dur = r.getValue("dur").jsonPrimitive.long
            eq(recordOf(r.getValue("expect").jsonObject), ProgressRules.report(prev, size, mtime, pos, dur, now), "report $pos/$dur")
        }
        val cont = pr.getValue("continue").jsonObject
        val doc = docOf(cont.getValue("doc").jsonObject)
        eq(cont.getValue("expect").jsonArray.map { it.str }, ProgressRules.continueList(doc, cont.getValue("limit").jsonPrimitive.int), "continue (limit)")
        eq(cont.getValue("all").jsonArray.map { it.str }, ProgressRules.continueList(doc), "continue (all)")
        val prune = pr.getValue("prune").jsonObject
        eq(prune.getValue("expect").jsonArray.map { it.str }, ProgressRules.prune(doc, prune.getValue("max").jsonPrimitive.int).keys.sorted(), "prune")
        assertEquals(0L, ProgressRules.report(null, 1, 10_000, 4, 100, 0).positionMs)
        assertEquals(50L, ProgressRules.report(null, 1, 10_000, 50, 100, 0).positionMs)
        assertTrue(ProgressRules.report(null, 1, 10_000, 90, 100, 0).played)
        assertTrue(!ProgressRules.sameFile(ProgressRules.report(null, 1, 10_000, 50, 100, 0), 1, 11_000))
    }

    private fun sourceJson(s: ParsedSource?) = s?.let { obj("protocol" to it.protocol, "url" to it.url, "user" to it.user, "pass" to it.pass) } ?: JsonNull

    @Test
    fun urls() {
        val u = load("urls.json").jsonObject
        for (c in u.getValue("parse").jsonArray.map { it.jsonObject }) eq(c.getValue("expect"), sourceJson(Urls.parse(c.getValue("input").str)), "parse ${c["input"]}")
        for (c in u.getValue("redact").jsonArray.map { it.jsonObject }) eq(c.getValue("expect").str, Urls.redact(c.getValue("input").str), "redact ${c["input"]}")
        for (c in u.getValue("unc").jsonArray.map { it.jsonObject }) {
            eq((c.getValue("expect") as? JsonPrimitive)?.takeIf { it.isString }?.content, Urls.unc(c.getValue("url").str, c.getValue("rel").str), "unc ${c["url"]} ${c["rel"]}")
        }
        for (c in u.getValue("display").jsonArray.map { it.jsonObject }) {
            eq(c.getValue("expect").str, Urls.display(c.getValue("input").str), "display ${c["input"]}")
            eq(c.getValue("name").str, Urls.defaultName(c.getValue("input").str), "name ${c["input"]}")
        }
        assertEquals("https://dav.example/media", Urls.parse("https://demo:secret@dav.example/media")?.url)
        assertNull(Urls.parse("smb://STORAGE:445/media"))
    }

    @Test
    fun shapes() {
        val sh = load("shapes.json").jsonObject
        for (v in sh.getValue("seasons").jsonArray.map { it.jsonArray }) {
            eq((v[1] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int, Shapes.seasonNumber(v[0].str), "season number of ${v[0]}")
        }
        for (c in sh.getValue("folders").jsonArray.map { it.jsonObject }) {
            val children = c.getValue("children").jsonArray.map { val n = it.str; n.removeSuffix("/") to n.endsWith("/") }
            val (shape, film) = Shapes.folder(c.getValue("name").str, children)
            eq(c.getValue("shape").str to (c["film"]?.str), shape to film, "shape of ${c["name"]} $children")
        }
        for (c in sh.getValue("episodeOrder").jsonArray.map { it.jsonObject }) {
            val names = c.getValue("names").jsonArray.map { it.str }
            eq(c.getValue("sorted").jsonArray.map { it.str }, names.sortedWith(Shapes.episodeOrder.then(NatSort)), "episode order ${names.first()}")
        }
    }

    // ≥ 200 vector cases in all (spec FS-01), as the desktop check counts them.
    @Test
    fun twoHundredCasesInAll() {
        val t = FilesVectorsTest()
        t.paths(); t.natsort(); t.names(); t.sidecars(); t.nfo(); t.propfind(); t.progress(); t.urls(); t.shapes()
        assertTrue("at least 200 vector cases (${t.cases})", t.cases >= 200)
    }
}
