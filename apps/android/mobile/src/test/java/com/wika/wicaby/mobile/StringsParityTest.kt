package com.wika.wicaby.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

// values (French, the default) and values-en must offer the same strings with the same
// format arguments, for :mobile (and its gplay flavour, CA-10) and the :mesh-ui panel and :livetv-ui grid it embeds.
class StringsParityTest {
    private val modules = listOf(File("src/main/res"), File("src/gplay/res"), File("../mesh-ui/src/main/res"), File("../livetv-ui/src/main/res"))

    // name -> sorted format arguments ("%1$s", "%2$d", ...), per quantity for plurals.
    private fun load(file: File): Map<String, List<String>> {
        assertTrue("missing $file", file.exists())
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val out = sortedMapOf<String, List<String>>()
        val root = doc.documentElement
        for (i in 0 until root.childNodes.length) {
            val e = root.childNodes.item(i) as? Element ?: continue
            if (e.getAttribute("translatable") == "false") continue
            val name = e.getAttribute("name")
            when (e.tagName) {
                "string" -> out[name] = args(e.textContent)
                "plurals" -> {
                    // Quantities differ between languages (French has "many"); the arguments must not.
                    val items = e.getElementsByTagName("item")
                    val sets = (0 until items.length).map { args(items.item(it).textContent) }.toSet()
                    assertEquals("$file: <plurals $name> items disagree on arguments", 1, sets.size)
                    out["plurals/$name"] = sets.first()
                }
                "string-array" -> out["array/$name"] = listOf(e.getElementsByTagName("item").length.toString())
            }
        }
        return out
    }

    private val formatArg = Regex("""%(\d+\$)?[-#+ 0,(]*\d*(\.\d+)?[sdfxXc]""")

    private fun args(text: String): List<String> =
        formatArg.findAll(text.replace("%%", "")).map { it.value.replace(Regex("""[-#+ 0,(]*\d*(\.\d+)?(?=[sdfxXc]$)"""), "") }.toList().sorted()

    @Test
    fun englishMatchesFrench() {
        for (res in modules) {
            val fr = load(File(res, "values/strings.xml"))
            val en = load(File(res, "values-en/strings.xml"))
            assertEquals("$res: keys only in French", emptySet<String>(), fr.keys - en.keys)
            assertEquals("$res: keys only in English", emptySet<String>(), en.keys - fr.keys)
            for ((k, v) in fr) assertEquals("$res: format arguments of $k", v, en[k])
        }
    }

    @Test
    fun untranslatableStringsAreNotTranslated() {
        for (res in modules) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "values/strings.xml"))
            val fixed = (0 until doc.documentElement.childNodes.length).mapNotNull { doc.documentElement.childNodes.item(it) as? Element }
                .filter { it.getAttribute("translatable") == "false" }.map { it.getAttribute("name") }.toSet()
            val en = File(res, "values-en/strings.xml").readText()
            for (k in fixed) assertTrue("$res: $k is translatable=\"false\" but has an English copy", "name=\"$k\"" !in en)
        }
    }
}
