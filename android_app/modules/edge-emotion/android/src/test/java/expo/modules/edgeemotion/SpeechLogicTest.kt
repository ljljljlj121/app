package expo.modules.edgeemotion

import org.junit.Assert.*
import org.junit.Test

class SpeechLogicTest {
  @Test fun silenceNeverStarts() {
    val gate = SpeechGate()
    for (time in 0L..60000L step 20) assertNull(gate.feed(time, false))
  }
  @Test fun shortPauseContinuesAndOneSecondEnds() {
    val gate = SpeechGate()
    assertEquals("start", gate.feed(500, true))
    gate.started = 0
    for (time in 520L..1200L step 20) assertNull(gate.feed(time, false))
    assertNull(gate.feed(1220, true))
    assertNull(gate.feed(2200, false))
    assertEquals("natural_end", gate.feed(2220, false))
  }
  @Test fun limitIncludesPreRollAndRequiresQuietBeforeRetrigger() {
    val gate = SpeechGate()
    gate.started = 0
    for (time in 500L..14980L step 20) assertNull(gate.feed(time, true))
    assertEquals("duration_limit", gate.feed(15000, true))
    for (time in 15020L..30000L step 20) assertNull(gate.feed(time, true))
    for (time in 30020L..31020L step 20) assertNull(gate.feed(time, false))
    assertEquals("start", gate.feed(31040, true))
  }
  @Test fun unavailableModalitiesRemainIndependent() {
    val visual = doubleArrayOf(.8, .1, .1)
    val text = doubleArrayOf(.1, .8, .1)
    assertNull(SpeechMath.fuse(null, null, .75))
    assertArrayEquals(visual, SpeechMath.fuse(visual, null, .75), 1e-12)
    assertArrayEquals(text, SpeechMath.fuse(null, text, .75), 1e-12)
    assertArrayEquals(doubleArrayOf(.275, .625, .1), SpeechMath.fuse(visual, text, .75), 1e-12)
    assertEquals("negative", SpeechMath.label(SpeechMath.fuse(visual, text, .75)))
    assertEquals(listOf("positive", "negative", "neutral"), EmotionMath.labels)
  }
  @Test fun chunkingRetainsEveryContentToken() {
    val tokens = BertTokens(listOf("a"))
    val input = List(200) { "a" }.joinToString(" ")
    val chunks = tokens.chunks(input)
    assertEquals(listOf(62, 62, 62, 14), chunks.map { it.size })
    assertEquals(200, chunks.flatten().size)
    assertTrue(tokens.chunks(" \n ").isEmpty())
  }
}
