package com.wika.wicaby.core.ratings

import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// External ratings, as tools/checks/ratings-check.mjs: the route from the provider ids, the parser on the same saved
// MDBList answer, and the client against a loopback stand-in (never the real service): no key means no request, a
// week-long cache that keeps "not found" but never an error.
class RatingsTest {
    private lateinit var srv: MockWebServer
    private var key: String? = null
    private var now = 1_000_000L
    private val cache = mutableMapOf<String, String>()

    private val sample = checkNotNull(javaClass.getResourceAsStream("/ratings/mdblist-movie.json")) { "missing fixture" }.readBytes().decodeToString()
    private val movie = Item("m1", type = "Movie", providerIds = mapOf("Imdb" to "tt0111161", "Tmdb" to "278"))

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun ratings() = Ratings({ OkHttpClient() }, srv.url("/mdb").toString().trimEnd('/'), { key }, cache, {}, { now })

    private fun reply(code: Int, body: String) = srv.enqueue(MockResponse.Builder().code(code).body(body).build())

    @Test
    fun parsesTheSavedAnswer() {
        assertEquals(
            listOf(
                ExternalRating("imdb", 9.3), ExternalRating("tomatoes", 89.0), ExternalRating("popcorn", 98.0),
                ExternalRating("metacritic", 82.0), ExternalRating("letterboxd", 4.6), ExternalRating("tmdb", 87.0),
            ),
            Ratings.parse(sample),
        )
        assertEquals(emptyList<ExternalRating>(), Ratings.parse("""{"ratings":[{"source":"imdb","value":null},{"source":"tomatoes","value":"N/A"},{"source":"letterboxd","value":42}]}"""))
        assertEquals(emptyList<ExternalRating>(), Ratings.parse("""{"error":"Invalid API key!"}"""))
        assertEquals(emptyList<ExternalRating>(), Ratings.parse("not json"))
    }

    @Test
    fun routes() {
        assertEquals("imdb/movie/tt0111161", Ratings.path(movie))
        assertEquals("tmdb/show/1396", Ratings.path(Item("s", type = "Series", providerIds = mapOf("tmdb" to "1396"))))
        assertNull(Ratings.path(Item("e", type = "Episode", providerIds = mapOf("Imdb" to "tt0959621"))))
        assertNull(Ratings.path(Item("s", type = "Series", providerIds = mapOf("Imdb" to "nm1", "Tvdb" to "81189"))))
        assertTrue(Ratings.isKey(" abcdEFGH1234 "))
        assertTrue(!Ratings.isKey("abc def 123"))
    }

    @Test
    fun fetchesOnlyWithAKeyAndCachesAWeek() = runBlocking {
        assertEquals(emptyList<ExternalRating>(), ratings().get(movie))
        assertEquals(0, srv.requestCount)

        key = "abcd1234"
        reply(200, sample)
        assertEquals(6, ratings().get(movie).size)
        val req = srv.takeRequest()
        assertEquals("/mdb/imdb/movie/tt0111161", req.url.encodedPath)
        assertEquals("abcd1234", req.url.queryParameter("apikey"))
        // Cached: no second request, same values.
        assertEquals(Ratings.parse(sample), ratings().get(movie))
        assertEquals(1, srv.requestCount)

        // A rate limit is not kept; a week later it asks again.
        now += Ratings.TTL_MS
        reply(429, "")
        assertTrue(runCatching { ratings().get(movie) }.isFailure)
        reply(404, "")
        assertEquals(emptyList<ExternalRating>(), ratings().get(movie))
        assertEquals(emptyList<ExternalRating>(), ratings().get(movie))
        assertEquals(3, srv.requestCount)
    }
}
