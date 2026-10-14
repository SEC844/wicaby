package com.wika.wicaby.core.iptv

import com.wika.wicaby.core.livetv.jsTrim
import kotlinx.serialization.Serializable
import java.text.Normalizer

// Which playlist channels an XMLTV channel feeds, the twin of D/shared/iptv/guide.ts: tvg-id first (case-insensitive,
// duplicates share the guide), then, for playlist channels without a tvg-id only, a <display-name> equal to the tvg-name
// or the name (case and accents folded).

private val MARKS = Regex("\\p{M}")
private val SPACES = Regex("[$WS]+")

fun fold(s: String): String = jsTrim(SPACES.replace(MARKS.replace(Normalizer.normalize(s, Normalizer.Form.NFD), "").lowercase(), " "))

class GuideMatcher(channels: List<IptvChannel>) {
    private val byTvg = HashMap<String, MutableList<String>>()
    private val byName = HashMap<String, MutableList<String>>()
    private val named = HashMap<String, List<String>>()

    init {
        fun add(m: HashMap<String, MutableList<String>>, k: String, id: String) {
            if (k.isEmpty()) return
            val l = m.getOrPut(k) { ArrayList(1) }
            if (id !in l) l += id
        }
        for (c in channels) {
            if (c.tvgId != null) add(byTvg, c.tvgId.lowercase(), c.id)
            else {
                add(byName, fold(c.name), c.id)
                if (c.tvgName != null) add(byName, fold(c.tvgName), c.id)
            }
        }
    }

    /** A <channel> element: its display names may feed playlist channels without a tvg-id. */
    fun channel(c: XmltvChannel) {
        val ids = ArrayList<String>()
        for (n in c.names) for (id in byName[fold(n)].orEmpty()) if (id !in ids) ids += id
        if (ids.isNotEmpty()) named[c.id.lowercase()] = ids
    }

    fun targets(xmltvId: String): List<String> {
        val k = xmltvId.lowercase()
        val a = byTvg[k]
        val b = named[k]
        return if (a != null && b != null) a + b.filter { it !in a } else a ?: b ?: emptyList()
    }
}

/**
 * Past this many programmes the rest of the guide is dropped (about 100 MB of JSON): a guide this big is a whole
 * country's provider guide, far beyond what the playlist's channels need.
 */
const val MAX_PROGRAMMES = 400_000

@Serializable
data class GuideProgramme(
    val start: Long,
    val stop: Long,
    val title: String,
    val subTitle: String? = null,
    val desc: String? = null,
    val categories: List<String>? = null,
    val episode: String? = null,
)

/** A parser feeding the playlist's channels; finish() ends it and gives, per playlist channel id, its programmes. */
class GuideCollector internal constructor(val parser: XmltvParser, private val out: HashMap<String, MutableList<GuideProgramme>>, private val n: () -> Int) {
    fun count(): Int = n()

    /** Sorted by start, an overlap clipped off the later one (a duplicate goes). */
    fun finish(): Map<String, List<GuideProgramme>> {
        parser.end()
        val res = HashMap<String, List<GuideProgramme>>(out.size * 2)
        for ((id, l) in out) {
            l.sortWith(compareBy<GuideProgramme> { it.start }.thenBy { it.stop })
            val kept = ArrayList<GuideProgramme>(l.size)
            for (p in l) {
                val last = kept.lastOrNull()
                if (last == null || p.start >= last.stop) kept += p
                else if (p.stop > last.stop) kept += p.copy(start = last.stop)
            }
            res[id] = kept
        }
        return res
    }
}

/** Programmes of [channels] in [from, to). */
fun collectGuide(channels: List<IptvChannel>, from: Long, to: Long, max: Int = MAX_PROGRAMMES): GuideCollector {
    val match = GuideMatcher(channels)
    val out = HashMap<String, MutableList<GuideProgramme>>()
    val cache = HashMap<String, List<String>>()
    var n = 0
    fun targets(id: String): List<String> = cache.getOrPut(id) { match.targets(id) }
    val parser = XmltvParser(object : XmltvSink {
        override val from = from
        override val to = to
        override fun keep(channel: String) = n < max && targets(channel).isNotEmpty()
        override fun channel(c: XmltvChannel) {
            match.channel(c)
            cache.remove(c.id)
        }
        override fun programme(p: XmltvProgramme) {
            val g = GuideProgramme(p.start, p.stop, p.title, p.subTitle, p.desc, p.categories, p.episode)
            for (id in targets(p.channel)) {
                out.getOrPut(id) { ArrayList() } += g
                n++
            }
        }
    })
    return GuideCollector(parser, out) { n }
}
