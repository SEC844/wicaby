package com.wika.wicaby.core.i18n

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

// French is the default locale (res/values), English the translation (res/values-en).
// Both must carry the same string, plurals and string-array keys, with the same format
// arguments, in :core, the TV app (:tv), the phone app (:mobile) and the guide grid (:livetv-ui). Lint's MissingTranslation backs this up.
class TranslationsTest {
    // Unit tests run from the module directory (apps/android/core).
    private val modules = listOf(File("src/main/res"), File("../tv/src/main/res"), File("../mobile/src/main/res"), File("../livetv-ui/src/main/res"))

    private class Entry(val args: Set<String>, val size: Int = 1)

    private val formatArg = Regex("""%(?:(\d+)\$)?[-#+ 0,(]*\d*(?:\.\d+)?([a-zA-Z%])""")

    private fun args(text: String): List<String> =
        formatArg.findAll(text).filter { it.groupValues[2] != "%" }.map { m ->
            "${m.groupValues[1].ifEmpty { "?" }}$${m.groupValues[2].lowercase()}"
        }.toList()

    private fun load(dir: File): Map<String, Entry> {
        val out = mutableMapOf<String, Entry>()
        val factory = DocumentBuilderFactory.newInstance()
        dir.listFiles { f -> f.extension == "xml" }.orEmpty().sortedBy { it.name }.forEach { file ->
            val root = factory.newDocumentBuilder().parse(file).documentElement
            val children = root.childNodes
            for (i in 0 until children.length) {
                val e = children.item(i) as? Element ?: continue
                if (e.getAttribute("translatable") == "false") continue
                val name = e.getAttribute("name")
                val texts = when (e.tagName) {
                    "string" -> listOf(e.textContent)
                    "plurals", "string-array" -> e.getElementsByTagName("item").let { items -> (0 until items.length).map { items.item(it).textContent } }
                    else -> continue
                }
                val key = "${e.tagName}/$name"
                assertTrue("$file: $key is defined twice", key !in out)
                val all = texts.flatMap(::args)
                // Several arguments must be positional (%1$s, %2$d) so translations can reorder them.
                if (all.toSet().size > 1) assertTrue("$file: $key mixes non-positional arguments", all.none { it.startsWith("?") })
                out[key] = Entry(all.toSet(), if (e.tagName == "string-array") texts.size else 1)
            }
        }
        return out
    }

    @Test
    fun englishMatchesFrench() {
        modules.forEach { res ->
            assertTrue("missing $res", res.isDirectory)
            // Only <string>, <plurals> and <string-array> count; colors and styles are skipped.
            val fr = load(File(res, "values"))
            val en = load(File(res, "values-en"))
            assertEquals("$res: keys differ between values and values-en", fr.keys.sorted(), en.keys.sorted())
            fr.forEach { (key, f) ->
                val e = en.getValue(key)
                assertEquals("$res: format arguments of $key", f.args, e.args)
                assertEquals("$res: item count of $key", f.size, e.size)
            }
        }
    }

    @Test
    fun formatArgumentsParse() {
        assertEquals(listOf("1\$s", "2\$d"), args("%1\$s · %2\$02d"))
        assertEquals(emptyList<String>(), args("100 %% sûr"))
    }
}
