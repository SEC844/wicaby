package com.wika.wicaby.core.livetv

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.math.BigDecimal
import java.util.Random
import java.util.TimeZone

// C-1: replays every golden vector of tools/checks/fixtures/livetv/ (the files livetv-check.mjs
// replays against D/shared/livetv/*.ts) through the Kotlin twins in core/livetv, and checks them the
// same way: values compare as JSON, an absent field equals null (TypeScript's undefined vanishes),
// numbers compare by value. Also: the binary search against a brute-force filter, and the minSdk 23
// grep gate (no java-time, no android-icu, no Collator under core/livetv).
class LiveTvParityTest {
    // ---- Fixtures ----

    private val root: File by lazy {
        generateSequence(File("").absoluteFile) { it.parentFile }
            .firstOrNull { File(it, FIXTURES_DIR).isDirectory }
            ?: error("$FIXTURES_DIR not found above ${File("").absolutePath}")
    }

    private fun cases(name: String): List<JsonObject> {
        val file = File(root, "$FIXTURES_DIR/$name.json")
        assertTrue("missing ${file.path}", file.isFile)
        return Json.parseToJsonElement(file.readText()).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    }

    private fun replay(name: String, eval: (fn: String, a: JsonArray, case: JsonObject) -> JsonElement?) {
        val all = cases(name)
        assertTrue("$name.json has no case", all.isNotEmpty())
        val failures = ArrayList<String>()
        for (c in all) {
            val where = "$name.json \"${c.txt("name")}\""
            val expected = c["out"] ?: run { failures += "$where: no \"out\""; null } ?: continue
            try {
                val got = eval(c.txt("fn")!!, c["args"]?.jsonArray ?: JsonArray(emptyList()), c) ?: JsonNull
                diff(expected, got, "out")?.let { failures += "$where: $it\n    expected ${expected.short()}\n    got      ${got.short()}" }
            } catch (e: Throwable) {
                failures += "$where: ${e::class.simpleName}: ${e.message}"
            }
        }
        if (failures.isNotEmpty()) fail("${failures.size} of ${all.size} vector(s) failed in $name.json:\n  " + failures.joinToString("\n  "))
    }

    // ---- Comparison: JSON values, absent == null, numbers by value ----

    private fun diff(e: JsonElement, g: JsonElement, path: String): String? {
        val en = e is JsonNull
        val gn = g is JsonNull
        if (en || gn) return if (en && gn) null else "$path: ${e.short()} != ${g.short()}"
        return when (e) {
            is JsonObject -> {
                if (g !is JsonObject) return "$path: object expected"
                for (k in e.keys + g.keys) diff(e[k] ?: JsonNull, g[k] ?: JsonNull, "$path.$k")?.let { return it }
                null
            }
            is JsonArray -> {
                if (g !is JsonArray) return "$path: array expected"
                if (e.size != g.size) return "$path: ${e.size} item(s) expected, got ${g.size}"
                e.indices.firstNotNullOfOrNull { diff(e[it], g[it], "$path[$it]") }
            }
            is JsonPrimitive -> {
                if (g !is JsonPrimitive) return "$path: value expected"
                val same = when {
                    e.isString || g.isString -> e.isString == g.isString && e.content == g.content
                    e.booleanOrNull != null || g.booleanOrNull != null -> e.booleanOrNull == g.booleanOrNull
                    else -> BigDecimal(e.content).compareTo(BigDecimal(g.content)) == 0
                }
                if (same) null else "$path: ${e.short()} != ${g.short()}"
            }
        }
    }

    private fun JsonElement.short(): String = toString().let { if (it.length > 400) it.take(400) + "…" else it }

    // ---- Argument helpers ----

    private fun JsonObject.txt(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.contentOrNull?.toBigDecimalOrNull()?.toLong()
    private fun JsonObject.int(k: String): Int? = long(k)?.toInt()
    private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.strs(k: String): List<String>? = (this[k] as? JsonArray)?.map { it.jsonPrimitive.content }

    private fun JsonArray.at(i: Int): JsonElement? = getOrNull(i)?.takeUnless { it is JsonNull }
    private fun JsonArray.s(i: Int): String = getValue(i).jsonPrimitive.content
    private fun JsonArray.sOrNull(i: Int): String? = at(i)?.jsonPrimitive?.content
    private fun JsonArray.l(i: Int): Long = BigDecimal(getValue(i).jsonPrimitive.content).toLong()
    private fun JsonArray.n(i: Int): Int = l(i).toInt()
    private fun JsonArray.b(i: Int): Boolean = getValue(i).jsonPrimitive.booleanOrNull!!
    private fun JsonArray.o(i: Int): JsonObject = getValue(i).jsonObject
    private fun JsonArray.arr(i: Int): JsonArray = getValue(i).jsonArray
    private fun JsonArray.strs(i: Int): List<String> = arr(i).map { it.jsonPrimitive.content }
    private fun JsonArray.objs(i: Int): List<JsonObject> = arr(i).map { it.jsonObject }
    private fun JsonArray.getValue(i: Int): JsonElement = getOrNull(i) ?: error("missing argument $i")

    private fun kindOf(s: String): ServerKind = J.decodeFromJsonElement(JsonPrimitive(s))
    private fun categoryOf(s: String?): Category? = s?.let { Category.fromId(it) ?: error("unknown category $it") }
    private fun triOf(e: JsonElement?): Tri = when ((e as? JsonPrimitive)?.contentOrNull) {
        "true" -> Tri.TRUE
        "false" -> Tri.FALSE
        else -> Tri.UNKNOWN
    }
    private fun stringMap(o: JsonObject): Map<String, String> = o.mapValues { it.value.jsonPrimitive.content }

    private inline fun <reified T> enc(v: T): JsonElement = J.encodeToJsonElement(v)
    private fun ids(rows: List<ChannelRow>): JsonElement = enc(rows.map { it.id })
    private fun pids(rows: List<ProgramLite>): JsonElement = enc(rows.map { it.id })

    /** Fixture rows: serverId "s", tags [], radio false, favorite false, serverIndex = position, then the case's fields. */
    private fun channel(c: JsonObject, i: Int): ChannelRow {
        val number = c.txt("number") ?: ""
        return ChannelRow(
            id = c.txt("id")!!,
            serverId = c.txt("serverId") ?: "s",
            number = number,
            numKey = parseChannelNumber(number),
            name = c.txt("name") ?: "",
            logoTag = c.txt("logoTag"),
            favorite = c.bool("favorite") ?: false,
            tags = c.strs("tags") ?: emptyList(),
            radio = c.bool("radio") ?: false,
            serverIndex = c.int("serverIndex") ?: i,
            lastPlayed = c.long("lastPlayed"),
        )
    }

    private fun channels(a: JsonArray): List<ChannelRow> = a.mapIndexed { i, e -> channel(e.jsonObject, i) }

    /** Fixture programmes: [id, channelId, start, end, flags?] (title = id) or full objects. */
    private fun prog(e: JsonElement): ProgramLite {
        if (e is JsonArray) {
            return ProgramLite(
                id = e[0].jsonPrimitive.content,
                channelId = e[1].jsonPrimitive.content,
                start = BigDecimal(e[2].jsonPrimitive.content).toLong(),
                end = BigDecimal(e[3].jsonPrimitive.content).toLong(),
                title = e[0].jsonPrimitive.content,
                flags = e.getOrNull(4)?.let { BigDecimal(it.jsonPrimitive.content).toInt() } ?: 0,
            )
        }
        val o = e.jsonObject
        return ProgramLite(
            id = o.txt("id")!!, channelId = o.txt("channelId")!!, start = o.long("start")!!, end = o.long("end")!!,
            title = o.txt("title") ?: "", flags = o.int("flags") ?: 0,
            timerId = o.txt("timerId"), seriesTimerId = o.txt("seriesTimerId"),
        )
    }

    private fun progs(a: JsonArray): List<ProgramLite> = a.map(::prog)

    private fun iso(s: String): Long = parseServerDate(s) ?: error("bad time $s")
    private fun iso(e: JsonElement): Long = iso(e.jsonPrimitive.content)

    /** Local ISO with offset in [tz], as livetv-check.mjs prints anchor times. */
    private fun isoOut(t: Long?, tz: TimeZone): JsonElement {
        if (t == null) return JsonNull
        val off = tz.getOffset(t)
        val wall = t + off
        val (y, m, d) = Civil.civilFromDays(Math.floorDiv(wall, Civil.DAY_MS))
        val ms = Math.floorMod(wall, Civil.DAY_MS)
        val offMin = off / 60_000
        val p = { n: Long -> n.toString().padStart(2, '0') }
        val a = kotlin.math.abs(offMin).toLong()
        return JsonPrimitive("$y-${p(m.toLong())}-${p(d.toLong())}T${p(ms / 3_600_000)}:${p(ms / 60_000 % 60)}:${p(ms / 1_000 % 60)}${if (offMin >= 0) "+" else "-"}${p(a / 60)}:${p(a % 60)}")
    }

    private fun tuningOf(name: String): PlatformTuning = (DeviceClass.fromId(name) ?: error("unknown device class $name")).tuning

    private fun tuningJson(t: PlatformTuning): JsonObject = JsonObject(
        linkedMapOf(
            "channelPage" to JsonPrimitive(t.channelPage), "channelPagesInFlight" to JsonPrimitive(t.channelPagesInFlight),
            "tileChannels" to JsonPrimitive(t.tileChannels), "tileMaxSlabs" to JsonPrimitive(t.tileMaxSlabs),
            "concurrency" to JsonPrimitive(t.concurrency), "rowOverscan" to JsonPrimitive(t.rowOverscan),
            "timeOverscanMin" to JsonPrimitive(t.timeOverscanMin), "maxCells" to JsonPrimitive(t.maxCells),
            "lruPrograms" to JsonPrimitive(t.lruPrograms), "persistMb" to JsonPrimitive(t.persistMb),
            "idleFavoritesOnly" to JsonPrimitive(t.idleFavoritesOnly), "idleMax" to JsonPrimitive(t.idleMax),
            "artDelayMs" to JsonPrimitive(t.artDelayMs),
        ),
    )

    private fun viewport(o: JsonObject) = Viewport(
        rows = o.strs("rows")!!, firstRow = o.int("firstRow")!!, lastRow = o.int("lastRow")!!,
        from = o.long("from")!!, to = o.long("to")!!, tuning = tuningOf(o.txt("tuning")!!),
    )

    /** Partial<LivePrefs> from JSON: the given fields over the defaults. */
    private fun patch(changes: JsonObject): PrefsPatch {
        val merged = JsonObject(J.encodeToJsonElement(LiveTvPrefs()).jsonObject + changes)
        return PrefsPatch(J.decodeFromJsonElement(merged), changes.keys.map { PrefField.fromKey(it) ?: error("unknown pref field $it") }.toSet())
    }

    private fun obj(vararg pairs: Pair<String, JsonElement?>): JsonObject = JsonObject(linkedMapOf(*pairs).mapValues { it.value ?: JsonNull })

    // ---- normalize.json ----

    @Test
    fun normalize() = replay("normalize") { fn, a, _ ->
        when (fn) {
            "parseServerDate" -> enc(parseServerDate(a.getValue(0)))
            "normalizeChannel" -> enc(normalizeChannel(a.o(0), a.s(1), a.n(2)))
            "normalizeProgram" -> {
                val opts = a.at(1) as? JsonObject
                enc(normalizeProgram(a.o(0), opts?.txt("kind")?.let(::kindOf), opts?.txt("categorySource")?.let { J.decodeFromJsonElement<CategorySource>(JsonPrimitive(it)) }))
            }
            "flagsOf" -> enc(flagsOf(a.o(0), a.sOrNull(1)?.let(::kindOf)))
            "hdProbe" -> enc(hdProbe(a.objs(0)))
            "onNowProbe" -> enc(onNowProbe(a.objs(0), a.l(1)))
            "defaultCaps" -> enc(defaultCaps(kindOf(a.s(0))))
            "skewSequence" -> {
                var s = SkewState()
                enc(a.arr(0).map { pair -> nextSkew(s, BigDecimal(pair.jsonArray[0].jsonPrimitive.content).toLong(), BigDecimal(pair.jsonArray[1].jsonPrimitive.content).toLong()).also { s = it } })
            }
            "pf" -> enc(PF.byName)
            else -> error("unknown fn $fn")
        }
    }

    // ---- dialect.json ----

    @Test
    fun dialect() = replay("dialect") { fn, a, _ ->
        val k = kindOf(a.s(0))
        val x = a.at(1) as? JsonObject ?: JsonObject(emptyMap())
        val u by lazy { x.txt("userId")!! }
        fun report(f: (ServerKind, String, String, String, String?, Dialect.PlayMethod, Boolean) -> Req) =
            f(k, x.txt("itemId")!!, x.txt("mediaSourceId")!!, x.txt("playSessionId")!!, x.txt("liveStreamId"), Dialect.PlayMethod.valueOf(x.txt("playMethod")!!), x.bool("isPaused") ?: false)
        val r: Req? = when (fn) {
            "info" -> Dialect.info(k)
            "guideInfo" -> Dialect.guideInfo(k)
            "channelsPage" -> Dialect.channelsPage(k, u, x.int("startIndex")!!, x.int("limit")!!)
            "channelCategorySet" -> Dialect.channelCategorySet(k, u, categoryOf(x.txt("category"))!!)
            "channelTags" -> Dialect.channelTags(k, u)
            "programsTile" -> Dialect.programsTile(k, u, x.strs("channelIds")!!, x.long("from")!!, x.long("to")!!, x.bool("genres") ?: false)
            "programNowNext" -> Dialect.programNowNext(k, u, x.txt("channelId")!!, x.long("now")!!)
            "programDetail" -> Dialect.programDetail(k, u, x.txt("id")!!)
            "onNow" -> Dialect.onNow(k, u, x.long("now")!!, categoryOf(x.txt("category")), x.txt("source")?.let { J.decodeFromJsonElement<OnNowSource>(JsonPrimitive(it)) })
            "onLater" -> Dialect.onLater(k, u, x.long("now")!!, categoryOf(x.txt("category"))!!)
            "searchPrograms" -> Dialect.searchPrograms(k, u, x.txt("query")!!, x.long("now")!!, x.long("guideEnd")!!)
            "otherAirings" -> Dialect.otherAirings(k, u, x.txt("name")!!, x.long("now")!!, x.txt("seriesTimerId"), x.txt("librarySeriesId"))
            "timers" -> Dialect.timers(k)
            "timersOfRule" -> Dialect.timersOfRule(k, x.txt("id")!!)
            "seriesTimers" -> Dialect.seriesTimers(k)
            "seriesTimer" -> Dialect.seriesTimer(k, x.txt("id")!!)
            "timerDefaults" -> Dialect.timerDefaults(k, x.txt("programId")!!)
            "recordingOptions" -> Dialect.recordingOptions(k, u)
            "recordings" -> Dialect.recordings(k, u, x.int("startIndex") ?: 0, x.int("limit") ?: 500, x.bool("inProgress") ?: false)
            "displayPrefs" -> Dialect.displayPrefs(k, u)
            "setFavorite" -> Dialect.setFavorite(k, u, x.txt("id")!!, x.bool("favorite")!!)
            "createTimer" -> Dialect.createTimer(k, x.getValue("body"))
            "updateTimer" -> Dialect.updateTimer(k, x.txt("id")!!, x.getValue("body"))
            "cancelTimer" -> Dialect.cancelTimer(k, x.txt("id")!!)
            "createSeriesTimer" -> Dialect.createSeriesTimer(k, x.getValue("body"))
            "updateSeriesTimer" -> Dialect.updateSeriesTimer(k, x.txt("id")!!, x.getValue("body"))
            "deleteSeriesTimer" -> Dialect.deleteSeriesTimer(k, x.txt("id")!!)
            "deleteRecording" -> Dialect.deleteRecording(k, x.txt("id")!!)
            "deleteItem" -> Dialect.deleteItem(k, x.txt("id")!!)
            "saveDisplayPrefs" -> Dialect.saveDisplayPrefs(k, u, x.getValue("body").jsonObject)
            "tune" -> Dialect.tune(k, u, x.txt("channelId")!!, x.long("maxBitrate")!!, x.int("rung")!!, x["deviceProfile"], x.bool("autoOpen") ?: true)
            "open" -> Dialect.open(k, u, x.txt("itemId")!!, x.txt("playSessionId")!!, x.long("maxBitrate")!!, x.txt("openToken")!!, x["deviceProfile"])
            "close" -> Dialect.close(k, x.txt("liveStreamId")!!, x.txt("playSessionId")!!)
            "killEncodes" -> Dialect.killEncodes(k, x.txt("deviceId")!!, x.txt("playSessionId")!!)
            "staticStream" -> Dialect.staticStream(k, x.txt("itemId")!!, x.txt("container")!!, x.txt("mediaSourceId")!!, x.txt("liveStreamId"), x.txt("deviceId")!!, x.txt("playSessionId")!!)
            "reportPlaying" -> report(Dialect::reportPlaying)
            "reportProgress" -> report(Dialect::reportProgress)
            "reportStopped" -> report(Dialect::reportStopped)
            else -> error("unknown op $fn")
        }
        enc(r)
    }

    @Test
    fun dialectUrls() {
        val r = Dialect.programDetail(ServerKind.EMBY, "u 1", "p/1é")
        assertEquals("/LiveTv/Programs/p%2F1%C3%A9?UserId=u%201", r.toUrl())
        assertEquals("a-_.!~*'()%20%26%3D%2B", encodeUriComponent("a-_.!~*'() &=+"))
        assertEquals("/LiveTv/Info", Dialect.info(ServerKind.JELLYFIN).toUrl())
    }

    // ---- channel-order.json ----

    @Test
    fun channelOrder() = replay("channel-order") { fn, a, _ ->
        when (fn) {
            "parseChannelNumber" -> enc(parseChannelNumber(a.sOrNull(0)))
            "nameKey" -> enc(nameKey(a.sOrNull(0)))
            "sortNames" -> enc(a.strs(0).sortedWith(::compareNames))
            "compareNames" -> enc(Integer.signum(compareNames(a.s(0), a.s(1))))
            "sortChannels" -> {
                val opts = a.at(2) as? JsonObject
                ids(sortChannels(channels(a.arr(0)), SortMode.fromId(a.s(1))!!, opts?.strs("mru") ?: emptyList(), opts?.bool("favFirst") ?: false))
            }
            "duplicateNumbers" -> enc(duplicateNumbers(channels(a.arr(0))))
            else -> error("unknown fn $fn")
        }
    }

    // ---- lens.json ----

    @Test
    fun lens() = replay("lens") { fn, a, _ ->
        when (fn) {
            "reconcileFavorites" -> ids(reconcileFavorites(channels(a.arr(0)), a.strs(1)))
            "recentIds" -> enc(recentIds(channels(a.arr(0)), a.strs(1), a.at(2)?.let { a.n(2) } ?: RECENTS_MAX))
            "pushRecent" -> enc(pushRecent(a.strs(0), a.s(1), a.at(2)?.let { a.n(2) } ?: RECENTS_MAX))
            "applyLens" -> {
                val o = a.o(1)
                val p = o.getValue("prefs").jsonObject
                val prefs = LensPrefs(
                    favOrder = p.strs("favOrder") ?: emptyList(),
                    hidden = p.strs("hidden") ?: emptyList(),
                    groups = p["groups"]?.let { J.decodeFromJsonElement<List<ClientGroup>>(it) } ?: emptyList(),
                    recents = p.strs("recents") ?: emptyList(),
                )
                ids(applyLens(LensInput(channels(a.arr(0)), J.decodeFromJsonElement(o.getValue("lens")), prefs, SortMode.fromId(o.txt("sort"))!!, o.bool("favFirst") ?: false)))
            }
            "availableLenses" -> enc(availableLenses(channels(a.arr(0)), J.decodeFromJsonElement(a.arr(1)), a.at(2)?.let { a.b(2) } ?: true))
            "stepLens" -> enc(stepLens(J.decodeFromJsonElement(a.arr(0)), J.decodeFromJsonElement(a.o(1)), a.n(2)))
            "lensToParam" -> enc(lensToParam(J.decodeFromJsonElement(a.o(0))))
            "lensFromParam" -> enc(lensFromParam(a.sOrNull(0)))
            "categoryRows" -> ids(categoryRows(channels(a.arr(0)), categoryOf(a.sOrNull(1)), (a.at(2) as? JsonArray)?.map { it.jsonPrimitive.content }, triOf(a.at(3))))
            "categoryRowsProbe" -> enc(categoryRowsProbe(a.n(0), a.n(1)))
            "dimmed" -> enc(dimmed(a.n(0), categoryOf(a.sOrNull(1))))
            "categorySourceFromTiles" -> enc(categorySourceFromTiles(a.arr(0).map { BigDecimal(it.jsonPrimitive.content).toInt() }, a.n(1)))
            "categorySourceFromGenres" -> enc(categorySourceFromGenres(a.arr(0).map { g -> g.jsonArray.map { it.jsonPrimitive.content } }))
            "genreFlags" -> enc(genreFlags(a.strs(0)))
            "genreTokens" -> enc(genreTokens(a.s(0)))
            "searchChannels" -> ids(searchChannels(channels(a.arr(0)), a.s(1), a.at(2)?.let { a.n(2) } ?: 8))
            else -> error("unknown fn $fn")
        }
    }

    // ---- zap.json ----

    @Test
    fun zap() = replay("zap") { fn, a, _ ->
        when (fn) {
            "zapTarget" -> enc(zapTarget(J.decodeFromJsonElement(a.arr(0)), a.s(1), a.n(2), a.sOrNull(3), (a.at(4) as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()))
            "zapScenario" -> {
                val list: List<ZapEntry> = J.decodeFromJsonElement(a.arr(0))
                val hidden = (a.at(3) as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
                var s = zapInit(a.sOrNull(1))
                JsonArray(
                    a.arr(2).map { e ->
                        val r = zapReduce(s, J.decodeFromJsonElement<ZapEvent>(e), list, hidden)
                        s = r.state
                        obj("effects" to enc(r.effects), "pending" to enc(s.pending), "current" to enc(s.current), "last" to enc(s.last), "tuning" to enc(s.tuning))
                    },
                )
            }
            "digitScenario" -> {
                val ix = digitIndex(J.decodeFromJsonElement(a.arr(0)))
                val timeout = a.at(2)?.let { a.l(2) } ?: DIGIT_TIMEOUT_MS
                var st: DigitState? = null
                JsonArray(
                    a.arr(1).map { e ->
                        val r = digitReduce(ix, st, J.decodeFromJsonElement<DigitEvent>(e), timeout)
                        st = r.state
                        obj("buf" to enc(st?.buf), "preview" to enc(r.preview), "result" to enc(r.result))
                    },
                )
            }
            else -> error("unknown fn $fn")
        }
    }

    // ---- tiles.json (tuning and device class: DeviceClass.kt, C-5) ----

    @Test
    fun tiles() = replay("tiles") { fn, a, _ ->
        when (fn) {
            "tuning" -> JsonObject(DeviceClass.entries.associate { it.id to tuningJson(it.tuning) })
            "deviceClass" -> {
                val f = a.o(0)
                enc(
                    classifyDevice(
                        DeviceFacts(
                            platform = FormFactor.valueOf(f.txt("platform")!!.uppercase()),
                            is64Bit = f.bool("is64Bit"),
                            lowRam = f.bool("lowRam"),
                            totalMemBytes = f.long("totalMemBytes"),
                            memoryClassMb = f.int("memoryClassMb"),
                            override = f.txt("override")?.let { DeviceClass.fromId(it) ?: error("unknown class $it") },
                        ),
                    ).id,
                )
            }
            "slabOf" -> enc(slabOf(iso(a.getValue(0))))
            "slabStart" -> enc(isoUtc(slabStart(a.l(0))))
            "slabRange" -> enc(slabRange(iso(a.getValue(0)), iso(a.getValue(1))))
            "cleanPrograms" -> JsonArray(cleanPrograms(progs(a.arr(0))).map { JsonArray(listOf(JsonPrimitive(it.id), JsonPrimitive(it.start), JsonPrimitive(it.end))) })
            "mergePrograms" -> JsonArray(mergePrograms(progs(a.arr(0)), progs(a.arr(1))).map { JsonArray(listOf(JsonPrimitive(it.id), JsonPrimitive(it.start), JsonPrimitive(it.end), JsonPrimitive(it.title))) })
            "programsInWindow" -> pids(programsInWindow(cleanPrograms(progs(a.arr(0))), a.l(1), a.l(2)))
            "programAt" -> enc(programAt(cleanPrograms(progs(a.arr(0))), a.l(1))?.id)
            "planTiles" -> {
                val o = a.o(0)
                enc(planTiles(PlanInput(viewport(o), o.int("dir") ?: 0, o.strs("covered") ?: emptyList(), o.bool("idle") ?: false, o.long("now"), o.strs("idleIds") ?: emptyList())))
            }
            "dropStale" -> {
                val r = dropStale(J.decodeFromJsonElement(a.arr(0)), viewport(a.o(1)))
                val key = { q: TileRequest -> q.channelIds[0] + "@" + q.slabs[0] }
                obj("keep" to enc(r.keep.map(key)), "dropped" to enc(r.dropped.map(key)))
            }
            "idleSet" -> enc(idleSet(a.strs(0), a.strs(1), tuningOf(a.s(2))))
            "ingestTile" -> {
                val r = ingestTile(J.decodeFromJsonElement(a.o(0)), progs(a.arr(1)))
                obj("coverage" to enc(r.coverage), "byChannel" to JsonObject(r.byChannel.mapValues { pids(it.value) }))
            }
            else -> error("unknown fn $fn")
        }
    }

    // ---- timers.json ----

    @Test
    fun timers() = replay("timers") { fn, a, _ ->
        val overlayOf = { e: JsonElement? -> e?.let { buildOverlay(normalizeTimers(it.jsonArray.map { t -> t.jsonObject })) } }
        when (fn) {
            "mapTimerStatus" -> enc(mapTimerStatus(a.at(0)?.jsonPrimitive?.takeIf { it.isString }?.content))
            "normalizeTimers" -> enc(normalizeTimers(a.objs(0)))
            "buildOverlay" -> enc(overlayOf(a.getValue(0)))
            "markFor" -> {
                val p = a.o(0)
                enc(markFor(p.txt("id")!!, p.txt("timerId"), p.txt("seriesTimerId"), overlayOf(a.at(1))))
            }
            "conflictCount" -> enc(conflictCount(normalizeTimers(a.objs(0))))
            "visibleOptions" -> enc(visibleOptions(a.at(0) as? JsonObject, J.decodeFromJsonElement(a.getValue(1))))
            "applyOptions" -> applyOptions(a.o(0), a.o(1))
            "quickRecordBody" -> quickRecordBody(a.o(0), (a.at(1) as? JsonObject)?.let { DvrPadding(it.long("pre")!!.toDouble(), it.long("post")!!.toDouble()) })
            "mapDvrError" -> enc(mapDvrError(kindOf(a.s(0)), J.decodeFromJsonElement(a.getValue(1)), a.n(2), a.sOrNull(3) ?: ""))
            else -> error("unknown fn $fn")
        }
    }

    // ---- anchor.json (each case under its "tz", injected) ----

    @Test
    fun anchor() = replay("anchor") { fn, a, c ->
        val tzId = c.txt("tz") ?: error("anchor case without tz")
        val tz = TimeZone.getTimeZone(tzId)
        assertEquals("unknown zone $tzId", tzId, tz.id)
        val clock = GuideClock(tz)
        fun out(t: Long?) = isoOut(t, tz)
        when (fn) {
            "dayStart" -> out(clock.dayStart(iso(a.getValue(0))))
            "addDays" -> out(clock.addDays(iso(a.getValue(0)), a.n(1)))
            "dayKey" -> enc(clock.dayKey(iso(a.getValue(0))))
            "parseDayKey" -> out(clock.parseDayKey(a.sOrNull(0)))
            "parseAt" -> out(clock.parseAt(iso(a.getValue(0)), a.sOrNull(1)))
            "dayChips" -> JsonArray(
                clock.dayChips(iso(a.getValue(0)), a.at(1)?.let { iso(it) }).map {
                    obj("index" to enc(it.index), "key" to enc(it.key), "start" to out(it.start), "hours" to enc((it.end - it.start) / 3_600_000.0))
                },
            )
            "daypartTime" -> out(clock.daypartTime(iso(a.getValue(0)), Daypart.fromId(a.s(1))!!))
            "leftForNow" -> out(leftForNow(iso(a.getValue(0)), a.l(1)))
            "leftForDaypart" -> out(clock.leftForDaypart(iso(a.getValue(0)), Daypart.fromId(a.s(1))!!))
            "leftForDay" -> out(clock.leftForDay(iso(a.getValue(0)), iso(a.getValue(1)), a.b(2)))
            "shiftDay" -> out(clock.shiftDay(iso(a.getValue(0)), a.n(1)))
            "anchorScenario" -> {
                var s = anchorInit(iso(a.getValue(0)))
                JsonArray(
                    a.arr(1).map { e ->
                        val ev = JsonObject(e.jsonObject + ("at" to JsonPrimitive(iso(e.jsonObject.getValue("at")))))
                        val r = anchorReduce(s, J.decodeFromJsonElement<AnchorEvent>(ev))
                        s = r.state
                        obj("mode" to enc(s.mode), "recenter" to enc(r.recenter))
                    },
                )
            }
            else -> error("unknown fn $fn")
        }
    }

    @Test
    fun anchorDstGapAndOverlap() {
        val c = GuideClock(TimeZone.getTimeZone("Europe/Paris"))
        // Skipped hour (2026-03-29 02:00 → 03:00): 02:30 reads with the offset before, i.e. 03:30 CEST.
        assertEquals(iso("2026-03-29T03:30:00+02:00"), c.local(2026, 2, 29, 2, 30))
        // Repeated hour (2026-10-25 03:00 → 02:00): 02:30 is its first occurrence, CEST.
        assertEquals(iso("2026-10-25T02:30:00+02:00"), c.local(2026, 9, 25, 2, 30))
        // Overflowing fields roll over like Date's.
        assertEquals(c.local(2027, 0, 1), c.local(2026, 11, 32))
        assertEquals(null, c.parseDayKey("2026-02-30"))
        assertEquals(null, c.parseDayKey("2026-10-25\n"))
        assertEquals(null, c.parseAt(c.local(2026, 9, 25), "2460"))
    }

    // ---- prefs.json ----

    @Test
    fun prefs() = replay("prefs") { fn, a, _ ->
        when (fn) {
            "decodePrefs" -> enc(decodePrefs((a.at(0) as? JsonObject)?.let(::stringMap)))
            "encodeField" -> {
                val field = PrefField.fromKey(a.s(0)) ?: error("unknown field ${a.s(0)}")
                enc(encodeField(field, patch(obj(a.s(0) to a.getOrNull(1))).values))
            }
            "chunkStats" -> {
                val prefix = a.s(0)
                val items = (0 until a.n(1)).map { JsonPrimitive(a.s(2).replace("{i}", it.toString().padStart(12, '0'))) }
                val out = chunkArray(prefix, items)
                obj(
                    "keys" to enc(out.keys.toList()),
                    "bytes" to enc(out.values.map(::utf8Length)),
                    "roundTrip" to enc(jsStringify(JsonArray(readChunks(out, prefix))) == jsStringify(JsonArray(items))),
                )
            }
            "mergeCustomPrefs" -> enc(mergeCustomPrefs((a.at(0) as? JsonObject)?.let(::stringMap), patch(a.o(1))))
            "prefsBody" -> prefsBody(a.at(0) as? JsonObject, stringMap(a.o(1)))
            "syncScenario" -> {
                var s = syncInit()
                JsonArray(
                    a.arr(0).map { e ->
                        val step = e.jsonObject
                        when {
                            "queue" in step -> {
                                s = queueChange(s, patch(step.getValue("queue").jsonObject))
                                obj("load" to enc(s.load.id))
                            }
                            "loaded" in step -> {
                                s = loaded(s, step.bool("loaded")!!)
                                obj("load" to enc(s.load.id))
                            }
                            else -> {
                                val w = planWrite(s, step["write"] as? JsonObject)
                                if (w != null) s = w.next
                                obj("write" to (w?.body ?: JsonNull))
                            }
                        }
                    },
                )
            }
            else -> error("unknown fn $fn")
        }
    }

    // ---- guide-nav.json ----

    private fun navModel(m: JsonObject): NavModel {
        val programs = m.getValue("programs").jsonObject.mapValues { (_, v) -> if (v is JsonNull) null else cleanPrograms(progs(v.jsonArray)) }
        return NavModel(
            rows = m.strs("rows")!!,
            programs = { id -> programs[id] },
            rangeStart = m.long("rangeStart")!!,
            rangeEnd = m.long("rangeEnd")!!,
            left = m.long("left")!!,
            right = m.long("right")!!,
            now = m.long("now")!!,
        )
    }

    @Test
    fun guideNav() = replay("guide-nav") { fn, a, _ ->
        when (fn) {
            "rowCells" -> enc(rowCells(navModel(a.o(0)), a.s(1), a.l(2), a.l(3)))
            "navMoves" -> {
                var m = navModel(a.o(0))
                var f: GuideFocus = J.decodeFromJsonElement(a.o(1))
                val pageRows = a.at(3)?.let { a.n(3) } ?: 1
                JsonArray(
                    a.arr(2).map { mv ->
                        val r = navMove(m, f, J.decodeFromJsonElement(mv), pageRows)
                        r.scrollLeft?.let { m = m.copy(left = it, right = it + (m.right - m.left)) }
                        r.focus?.let { f = it }
                        enc(r)
                    },
                )
            }
            "restoreFocus" -> enc(restoreFocus(navModel(a.o(0)), J.decodeFromJsonElement(a.o(1)), a.n(2)))
            "resolveJump" -> enc(resolveJump(navModel(a.o(0)), J.decodeFromJsonElement(a.o(1)), a.b(2), a.strs(3)))
            "gateMoves" -> {
                var g = repeatGateInit()
                enc(
                    a.arr(0).map { e ->
                        val r = gateMove(g, BigDecimal(e.jsonArray[0].jsonPrimitive.content).toLong(), e.jsonArray[1].jsonPrimitive.booleanOrNull!!)
                        g = r.gate
                        r.accept
                    },
                )
            }
            else -> error("unknown fn $fn")
        }
    }

    // ---- Every fixture file is replayed (a new file must get an evaluator here) ----

    @Test
    fun everyFixtureFileIsReplayed() {
        val files = File(root, FIXTURES_DIR).listFiles { f -> f.name.endsWith(".json") }!!.map { it.name.removeSuffix(".json") }.toSet()
        assertEquals(REPLAYED, files)
    }

    // ---- Binary search against a brute-force filter on 10,000 random windows ----

    @Test
    fun binarySearchMatchesBruteForce() {
        val rnd = Random(0x5eed1e57)
        val min = 60_000L
        val base = 1_792_627_200_000L // 2026-10-22T00:00Z
        var mismatches = 0
        repeat(20) {
            // A messy EPG: random lengths, gaps, overlaps, zero lengths and duplicate ids.
            val raw = ArrayList<ProgramLite>()
            var t = base - rnd.nextInt(600) * min
            for (i in 0 until 400) {
                val len = rnd.nextInt(180) * min
                val r = rnd.nextDouble()
                t += if (r < 0.2) rnd.nextInt(120) * min else if (r < 0.28) -rnd.nextInt(10) * min else 0
                val id = if (rnd.nextDouble() < 0.02 && i > 0) "p${i - 1}" else "p$i"
                raw.add(ProgramLite(id = id, channelId = "c", start = t, end = t + len, title = "", flags = 0))
                t += len
            }
            val clean = cleanPrograms(raw)
            for (i in 1 until clean.size) if (clean[i].start < clean[i - 1].end || clean[i].end <= clean[i].start) mismatches++
            val lo = clean.firstOrNull()?.start ?: base
            val hi = clean.lastOrNull()?.end ?: base
            repeat(500) {
                val from = lo - 120 * min + rnd.nextInt(((hi - lo) / min + 240).toInt()) * min
                val to = from + rnd.nextInt(600) * min
                val fast = programsInWindow(clean, from, to).map { it.id }
                val slow = clean.filter { it.end > from && it.start < to }.map { it.id }
                if (fast != slow) mismatches++
                val at = from + rnd.nextInt(60) * min
                if (programAt(clean, at)?.id != clean.firstOrNull { it.start <= at && at < it.end }?.id) mismatches++
            }
        }
        assertEquals("mismatches against the brute-force filter over 10,000 windows", 0, mismatches)
    }

    // ---- minSdk 23 grep gate (§21.3): no java-time, no android-icu, no Collator under core/livetv ----

    private fun gateProblems(src: String): List<String> {
        val code = src
            .replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
            .replace(Regex("//.*$", RegexOption.MULTILINE), "")
            .replace(Regex("\"(?:[^\"\\\\\\n]|\\\\.)*\""), "\"\"")
        return listOf(
            Regex("\\bjava\\.time\\b") to "java.time (API 26; minSdk is 23, no desugaring)",
            Regex("\\bandroid\\.icu\\b") to "android.icu (API 24; minSdk is 23)",
            Regex("\\bCollator\\b") to "Collator (locale collation differs per device: use nameKey)",
        ).filter { (re, _) -> re.containsMatchIn(code) }.map { it.second }
    }

    @Test
    fun minSdkGrepGate() {
        // The gate checks itself first.
        assertEquals(listOf("java.time (API 26; minSdk is 23, no desugaring)"), gateProblems("import java.time.Instant"))
        assertEquals(listOf("android.icu (API 24; minSdk is 23)"), gateProblems("val c = android.icu.util.Calendar.getInstance()"))
        assertEquals(listOf("Collator (locale collation differs per device: use nameKey)"), gateProblems("import java.text.Collator"))
        assertEquals(emptyList<String>(), gateProblems("val s = \"java.time.Instant\" // android.icu.text.Collator\n/* java.time. */"))

        val dir = File(root, LIVETV_SRC)
        val files = dir.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("no Kotlin file under $LIVETV_SRC", files.size >= 10)
        val problems = files.flatMap { f -> gateProblems(f.readText()).map { "${f.name}: $it" } }
        assertEquals(emptyList<String>(), problems)
    }

    companion object {
        private const val FIXTURES_DIR = "tools/checks/fixtures/livetv"
        private const val LIVETV_SRC = "apps/android/core/src/main/java/com/wika/wicaby/core/livetv"
        private val REPLAYED = setOf("normalize", "dialect", "channel-order", "lens", "zap", "tiles", "timers", "anchor", "prefs", "guide-nav")

        private val J = Json {
            encodeDefaults = true
            explicitNulls = true
            ignoreUnknownKeys = true
        }
    }
}
