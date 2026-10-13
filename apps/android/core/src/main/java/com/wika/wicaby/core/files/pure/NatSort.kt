package com.wika.wicaby.core.files.pure

import java.text.Normalizer

// File sources §4.1: the natural order of names, the same on both platforms (desktop shared/files/natsort.ts; vectors:
// tools/checks/fixtures/files/natsort.json). Not a Collator, whose order depends on the ICU build. Digit runs by value
// then the longer spelling first ("01" before "1"); other runs case- and accent-folded by UTF-16 code unit; a digit run
// before a letter run at the same place; fewer runs first; then the raw names.
object NatSort : Comparator<String> {
    private val MARKS = Regex("\\p{M}+")

    private fun runs(s: String): List<String> {
        val out = ArrayList<String>()
        var i = 0
        while (i < s.length) {
            val digit = s[i] in '0'..'9'
            var j = i + 1
            while (j < s.length && (s[j] in '0'..'9') == digit) j++
            out += s.substring(i, j)
            i = j
        }
        return out
    }

    private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(MARKS, "").lowercase()

    private fun digits(a: String, b: String): Int {
        val x = a.trimStart('0')
        val y = b.trimStart('0')
        if (x.length != y.length) return x.length - y.length
        val c = x.compareTo(y)
        return if (c != 0) c else b.length - a.length
    }

    override fun compare(a: String, b: String): Int {
        val ra = runs(Normalizer.normalize(a, Normalizer.Form.NFC))
        val rb = runs(Normalizer.normalize(b, Normalizer.Form.NFC))
        for (i in 0 until minOf(ra.size, rb.size)) {
            val da = ra[i][0] in '0'..'9'
            val db = rb[i][0] in '0'..'9'
            if (da != db) return if (da) -1 else 1
            val c = if (da) digits(ra[i], rb[i]) else fold(ra[i]).compareTo(fold(rb[i]))
            if (c != 0) return c
        }
        if (ra.size != rb.size) return ra.size - rb.size
        return a.compareTo(b)
    }
}
