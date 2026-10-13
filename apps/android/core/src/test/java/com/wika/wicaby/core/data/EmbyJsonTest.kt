package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

class EmbyJsonTest {
    // Real Emby 4.x item pages send Studios[].Id as a number; a strict decoder failed the whole detail page.
    @Test
    fun numericStudioIdsDecode() {
        val item = json.decodeFromString(
            Item.serializer(),
            """{"Id":"42","Name":"Final Hours","Type":"Movie","Studios":[{"Name":"Screen Australia","Id":171717}],"People":[{"Id":"9","Name":"Nathan Phillips","Type":"Actor"}]}""",
        )
        assertEquals("171717", item.studios.single().id)
        assertEquals("Nathan Phillips", item.people.single().name)
    }
}
