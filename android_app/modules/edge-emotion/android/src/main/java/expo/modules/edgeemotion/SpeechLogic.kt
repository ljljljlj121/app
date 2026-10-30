package expo.modules.edgeemotion

import java.text.Normalizer
import java.util.Locale
import kotlin.math.exp

/** All times include the aligned pre-roll, including the hard duration limit. */
class SpeechGate(val silenceMs: Long = 1000, val maximumMs: Long = 15000) {
  var started = -1L
  var lastVoice = -1L
  var waitingSilence = false
  private var quietSince = -1L
  fun feed(now: Long, voice: Boolean): String? {
    if (voice) { lastVoice = now; quietSince = -1 }
    else if (quietSince < 0) quietSince = now
    if (waitingSilence) {
      if (!voice && now - quietSince >= silenceMs) waitingSilence = false
      return null
    }
    if (started < 0) return if (voice) "start" else null
    if (now - started >= maximumMs) {
      started = -1; waitingSilence = true
      return "duration_limit"
    }
    if (!voice && now - lastVoice >= silenceMs) {
      started = -1
      return "natural_end"
    }
    return null
  }
}

class BertTokens(vocab: List<String>) {
  private val ids = vocab.withIndex().associate { it.value to it.index.toLong() }
  fun encode(text: String): List<Long> {
    val out = mutableListOf<Long>()
    var end = 0
    Regex("\\[(PAD|UNK|CLS|SEP|MASK)]").findAll(text).forEach { match ->
      out.addAll(encodePlain(text.substring(end, match.range.first)))
      out.add(ids.getValue(match.value))
      end = match.range.last + 1
    }
    out.addAll(encodePlain(text.substring(end)))
    return out
  }
  private fun encodePlain(text: String): List<Long> {
    val cleaned = buildString {
      text.codePoints().forEach { cp ->
        val type = Character.getType(cp)
        when {
          cp == 0 || cp == 0xfffd -> Unit
          Character.isWhitespace(cp) || type == Character.SPACE_SEPARATOR.toInt() -> append(' ')
          type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt() -> Unit
          cp in 0x4e00..0x9fff || cp in 0x3400..0x4dbf || cp in 0x20000..0x2a6df ||
            cp in 0x2a700..0x2b73f || cp in 0x2b740..0x2b81f || cp in 0x2b820..0x2ceaf ||
            cp in 0xf900..0xfaff || cp in 0x2f800..0x2fa1f -> {
            append(' '); appendCodePoint(cp); append(' ')
          }
          else -> appendCodePoint(cp)
        }
      }
    }
    val normalized = Normalizer.normalize(cleaned.lowercase(Locale.ROOT), Normalizer.Form.NFD)
      .replace(Regex("\\p{Mn}+"), "")
    val words = normalized.replace(Regex("([\\p{P}\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E])"), " $1 ")
      .trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return words.flatMap { word ->
      val cps = word.codePoints().toArray()
      if (cps.size > 100) listOf(100L) else {
        val pieces = mutableListOf<Long>()
        var start = 0
        while (start < cps.size) {
          var end = cps.size
          var found: Long? = null
          while (end > start) {
            found = ids[(if (start > 0) "##" else "") + String(cps, start, end - start)]
            if (found != null) break
            end--
          }
          if (found == null) { pieces.clear(); pieces.add(100L); break }
          pieces.add(found); start = end
        }
        pieces
      }
    }
  }
  fun chunks(text: String): List<List<Long>> = encode(text).chunked(62)
}

object SpeechMath {
  const val textTemperature = 2.0566793434560156
  fun softmax(logits: FloatArray): DoubleArray {
    require(logits.size == 3 && logits.all { it.isFinite() })
    val peak = logits.max().toDouble()
    val p = DoubleArray(3) { exp((logits[it] - peak) / textTemperature) }
    val sum = p.sum()
    return DoubleArray(3) { p[it] / sum }
  }
  // F3: arithmetic late fusion; A2: mean of valid visual frame probabilities.
  fun fuse(visual: DoubleArray?, text: DoubleArray?, weight: Double): DoubleArray? =
    if (visual == null) text else if (text == null) visual else
      DoubleArray(3) { visual[it] * (1 - weight) + text[it] * weight }
  fun label(p: DoubleArray?): String? = p?.let { EmotionMath.labels[it.indices.maxBy { i -> it[i] }] }
}
