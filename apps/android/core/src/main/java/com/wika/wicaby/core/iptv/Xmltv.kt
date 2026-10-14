package com.wika.wicaby.core.iptv

import com.wika.wicaby.core.livetv.Civil
import com.wika.wicaby.core.livetv.jsTrim
import java.math.BigInteger
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

// XMLTV guides parsed as a stream, the twin of D/shared/iptv/xmltv.ts: push() takes text chunks of any size (gunzipped
// by the caller), only complete <channel> and <programme> elements are parsed, and only the programmes of kept channels
// inside [from, to) are handed out, so a guide of hundreds of MB never sits in memory (vectors: tools/checks/fixtures/iptv).

data class XmltvChannel(val id: String, val names: List<String>, val icon: String? = null)

data class XmltvProgramme(
    val channel: String,
    val start: Long,
    val stop: Long,
    val title: String,
    val subTitle: String? = null,
    val desc: String? = null,
    val categories: List<String>? = null,
    val episode: String? = null,
)

interface XmltvSink {
    val from: Long
    val to: Long

    /** Called for each <programme> channel id: false drops it before its children are parsed. */
    fun keep(channel: String): Boolean
    fun channel(c: XmltvChannel) {}
    fun programme(p: XmltvProgramme)
}

/** One element bigger than this is malformed (an unclosed tag): it is skipped, never buffered further. */
const val MAX_ELEMENT = 256 * 1024
private const val MAX_DESC = 1000
private const val MAX_TEXT = 300
private const val MINUTE = 60_000L

private val DATE = Regex("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})?[$WS]*(?:([+-])(\\d{2}):?(\\d{2})|Z|UTC|GMT)?", RegexOption.IGNORE_CASE)

/** "20261014213000 +0200" (XMLTV): no zone means UTC. null when malformed (NaN in xmltv.ts). */
fun parseXmltvDate(s: String?): Long? {
    if (s.isNullOrEmpty()) return null
    val g = DATE.find(jsTrim(s))?.groupValues ?: return null
    val mo = g[2].toLong()
    val d = g[3].toLong()
    val h = g[4].toLong()
    val mi = g[5].toLong()
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
    val utc = Civil.utc(g[1].toLong(), mo - 1, d, h, mi, if (g[6].isNotEmpty()) g[6].toLong() else 0L, 0L)
    val off = if (g[7].isNotEmpty()) (if (g[7] == "-") -1 else 1) * (g[8].toLong() * 60 + g[9].toLong()) * MINUTE else 0L
    return utc - off
}

private val ENT = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'")
private val CDATA = Regex("<!\\[CDATA\\[([\\s\\S]*?)]]>")
private val ENTITY = Regex("&(#x[0-9a-f]{1,6}|#\\d{1,7}|[a-z]+);", RegexOption.IGNORE_CASE)
private val SPACES = Regex("[$WS]+")

fun decodeXml(s: String): String {
    var t = if (s.contains("<![CDATA[")) CDATA.replace(s) { it.groupValues[1].replace("&", "&#38;") } else s
    if ('&' in t) {
        t = ENTITY.replace(t) { m ->
            val e = m.groupValues[1]
            if (e[0] != '#') return@replace ENT[e.lowercase(Locale.ROOT)] ?: m.value
            val n = if (e[1] == 'x' || e[1] == 'X') e.substring(2).toInt(16) else e.substring(1).toInt()
            if (n in 1..0x10ffff) String(Character.toChars(n)) else ""
        }
    }
    return jsTrim(SPACES.replace(t, " "))
}

private val ATTRS = Regex("([\\w:-]+)[$WS]*=[$WS]*(?:\"([^\"]*)\"|'([^']*)')")

private fun attrs(s: String): Map<String, String> {
    val out = HashMap<String, String>()
    for (m in ATTRS.findAll(s)) out[m.groupValues[1].lowercase(Locale.ROOT)] = decodeXml(m.groups[2]?.value ?: m.groups[3]?.value ?: "")
    return out
}

private class Child(val a: Map<String, String>, val text: String)

private val childRes = ConcurrentHashMap<String, Regex>()

// Children <name ...>text</name> of an element body, in order.
private fun children(body: String, name: String): List<Child> {
    if (!body.contains("<$name")) return emptyList()
    val re = childRes.getOrPut(name) { Regex("<$name([$WS][^>]*)?(?:/>|>([\\s\\S]*?)</$name[$WS]*>)") }
    return re.findAll(body).map { Child(attrs(it.groups[1]?.value ?: ""), decodeXml(it.groups[2]?.value ?: "")) }.toList()
}

private val NAME = Regex("^<(channel|programme)[$WS>/]")

class XmltvParser(private val sink: XmltvSink) {
    private var buf = ""
    private var pos = 0
    var channels = 0
        private set

    /** <programme> elements seen. */
    var programmes = 0
        private set
    var kept = 0
        private set
    var skipped = 0
        private set

    fun push(chunk: String) {
        buf = if (pos > 0) buf.substring(pos) + chunk else buf + chunk
        pos = 0
        drain(false)
    }

    fun end() {
        drain(true)
        buf = ""
        pos = 0
    }

    private fun drain(final: Boolean) {
        val b = buf
        while (true) {
            val lt = b.indexOf('<', pos)
            if (lt < 0) {
                pos = b.length
                return
            }
            pos = lt
            if (b.startsWith("<!--", lt)) {
                val end = b.indexOf("-->", lt + 4)
                if (end < 0) {
                    if (skipCut(final, lt)) continue else return
                }
                pos = end + 3
                continue
            }
            val name = NAME.find(b.substring(lt, minOf(lt + 12, b.length)))?.groupValues?.get(1)
            if (name == null) {
                // <?xml?>, <!DOCTYPE>, <tv>, </tv> and stray text: skip the tag.
                val gt = b.indexOf('>', lt + 1)
                if (gt < 0) {
                    if (skipCut(final, lt)) continue else return
                }
                pos = gt + 1
                continue
            }
            val openEnd = b.indexOf('>', lt + 1)
            if (openEnd < 0) {
                if (skipCut(final, lt)) continue else return
            }
            val selfClosing = b[openEnd - 1] == '/'
            val head = b.substring(lt + name.length + 1, if (selfClosing) openEnd - 1 else openEnd)
            var bodyEnd = openEnd + 1
            var next = openEnd + 1
            if (!selfClosing) {
                val close = b.indexOf("</$name>", openEnd + 1)
                if (close < 0) {
                    if (skipCut(final, lt)) continue else return
                }
                bodyEnd = close
                next = close + name.length + 3
            }
            if (next - lt > MAX_ELEMENT) skipped++
            else if (name == "channel") onChannel(head, b.substring(openEnd + 1, bodyEnd))
            else onProgramme(head, b.substring(openEnd + 1, bodyEnd))
            pos = next
        }
    }

    // An element cut by the chunk boundary waits for the next chunk (false), unless it is already too long (malformed)
    // or the stream ended: then it is skipped up to its first '>' and the drain goes on (true).
    private fun skipCut(final: Boolean, at: Int): Boolean {
        if (final || buf.length - at > MAX_ELEMENT) {
            skipped++
            val gt = buf.indexOf('>', at + 1)
            pos = if (gt < 0) buf.length else gt + 1
            return true
        }
        pos = at
        return false
    }

    private fun onChannel(head: String, body: String) {
        val id = attrs(head)["id"]
        if (id.isNullOrEmpty()) {
            skipped++
            return
        }
        channels++
        val names = children(body, "display-name").map { it.text.take(MAX_TEXT) }.filter { it.isNotEmpty() }
        val icon = children(body, "icon").firstOrNull()?.a?.get("src")?.ifEmpty { null }
        sink.channel(XmltvChannel(id, names, icon))
    }

    private fun onProgramme(head: String, body: String) {
        programmes++
        val a = attrs(head)
        val channel = a["channel"]
        if (channel.isNullOrEmpty()) {
            skipped++
            return
        }
        val start = parseXmltvDate(a["start"])
        // A programme without a stop runs 30 min (rare; the next one usually starts then).
        val stop = if (!a["stop"].isNullOrEmpty()) parseXmltvDate(a["stop"]) else start?.plus(30 * MINUTE)
        if (start == null || stop == null || stop <= start) {
            skipped++
            return
        }
        if (stop <= sink.from || start >= sink.to || !sink.keep(channel)) return
        val cats = children(body, "category").map { it.text.take(60) }.filter { it.isNotEmpty() }.take(6)
        val eps = children(body, "episode-num")
        val ep = eps.firstOrNull { it.a["system"] == "onscreen" }?.text ?: xmltvNs(eps.firstOrNull { it.a["system"] == "xmltv_ns" }?.text)
        kept++
        sink.programme(
            XmltvProgramme(
                channel = channel, start = start, stop = stop,
                title = (children(body, "title").firstOrNull()?.text ?: "").take(MAX_TEXT),
                subTitle = children(body, "sub-title").firstOrNull()?.text?.ifEmpty { null }?.take(MAX_TEXT),
                desc = children(body, "desc").firstOrNull()?.text?.ifEmpty { null }?.take(MAX_DESC),
                categories = cats.ifEmpty { null },
                episode = ep?.ifEmpty { null }?.take(40),
            ),
        )
    }
}

private val XMLTV_NS = Regex("^[$WS]*(\\d+)?[$WS]*(?:/[$WS]*\\d+)?[$WS]*\\.[$WS]*(\\d+)?")

// "1.4.0/1" (zero-based season.episode.part) → "S2E5".
private fun xmltvNs(s: String?): String? {
    val m = if (s.isNullOrEmpty()) null else XMLTV_NS.find(s)
    val season = m?.groups?.get(1)?.value
    val episode = m?.groups?.get(2)?.value
    if (season == null && episode == null) return null
    // shortcut: BigInteger keeps huge numbers exact where JavaScript would print 1e+21; nobody numbers seasons that far.
    fun plusOne(d: String) = (BigInteger(d) + BigInteger.ONE).toString()
    return (season?.let { "S${plusOne(it)}" } ?: "") + (episode?.let { "E${plusOne(it)}" } ?: "")
}
