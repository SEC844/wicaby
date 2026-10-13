package com.wika.wicaby.meshui

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.brand.WicabyMark
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min

// Loading state drawn with the Wicaby mark, "en mode pinceau" (desktop twin:
// components/LogoLoader.svelte). A brush runs along the W's centreline from the
// top-left to the right arm and leaves ink, the blue play stamps in (0.6 to 1,
// spring), holds, then the ink lifts (fade, slight rise) and the loop restarts:
// 2.4 s per cycle. Geometry: :core WicabyMark (brand/scripts/make-brand.mjs).
//
// Shared by the TV and mobile apps, each passing its label colour and "loading" text.
// Low-end TV budget: no layer, blur or shader, one path segment per stroke and a
// scale. Round-capped strokes on the centreline at the W's width match its
// outline exactly along the first three arms; the right arm (tapered, cut by the
// gap) is revealed from the W's own path behind a clip edge that follows the
// brush. A narrower tip runs slightly ahead so the leading edge tapers.
// Animator duration scale 0: the finished mark, breathing (or still, if the
// clock is frozen too). delayMs: fade in only after this long, so a wait that
// ends quickly shows nothing.
@Composable
fun LogoLoader(color: Color, label: String, modifier: Modifier = Modifier, size: Dp = 64.dp, delayMs: Int = 0) {
    val geo = remember(size <= 28.dp) { LoaderGeometry(if (size <= 28.dp) WicabyMark.small else WicabyMark.regular) }
    val context = LocalContext.current
    val still = remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    var due by remember { mutableStateOf(delayMs <= 0) }
    if (!due) LaunchedEffect(Unit) { delay(delayMs.toLong()); due = true }
    val shown by animateFloatAsState(if (due) 1f else 0f, tween(320), label = "appear")
    val clock = rememberInfiniteTransition(label = "logoLoader")
        .animateFloat(0f, 1f, infiniteRepeatable(tween(LoaderGeometry.CYCLE_MS, easing = LinearEasing)), label = "cycle")
    Canvas(
        // The one-off appear fade goes through the layer, so overlapping strokes do not show seams.
        modifier.size(size).graphicsLayer { alpha = shown }.semantics {
            contentDescription = label
            progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate
        },
    ) { if (shown > 0f) geo.draw(this, clock.value, color, still) }
}

private class LoaderGeometry(private val cut: WicabyMark.Cut) {
    private val w = PathParser().parsePathString(cut.w).toPath()
    private val play = PathParser().parsePathString(cut.play).toPath()
    private val measure = PathMeasure()
    private val length: Float
    private val armStart: Float // distance to P4, where the right arm starts
    private val p4: Offset
    private val armAngle: Float
    private val body = Path()
    private val tip = Path()
    private val bodyStroke = Stroke(width = cut.stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)
    private val tipStroke = Stroke(width = cut.stroke * 0.5f, cap = StrokeCap.Round, join = StrokeJoin.Round)
    private val pivot = Offset(cut.playX, cut.playY)

    init {
        val p = cut.line
        val line = Path().apply {
            moveTo(p[0], p[1])
            for (i in 2 until p.size step 2) lineTo(p[i], p[i + 1])
        }
        measure.setPath(line, false)
        length = measure.length
        var d = 0f
        for (i in 2..6 step 2) d += hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
        armStart = d
        p4 = Offset(p[6], p[7])
        armAngle = (atan2(p[9] - p[7], p[8] - p[6]) * 180 / PI).toFloat()
    }

    fun draw(scope: DrawScope, f: Float, color: Color, still: Boolean) = with(scope) {
        val k = size.minDimension / WicabyMark.VIEW_SIZE
        if (still) {
            val a = 0.75f + 0.25f * cos(2 * PI * f).toFloat()
            withTransform({
                scale(k, k, Offset.Zero)
                translate(-WicabyMark.VIEW_X, -WicabyMark.VIEW_Y)
            }) {
                drawPath(w, color, alpha = a)
                drawPath(play, BRAND_BLUE, alpha = a)
            }
            return@with
        }
        // The ink lifts: in over the first 3 %, out with a slight rise from 78 % to 95 %.
        val out = EASE_LIFT.transform(((f - 0.78f) / 0.17f).coerceIn(0f, 1f))
        val alpha = min((f / 0.03f).coerceAtMost(1f), 1f - out)
        if (alpha <= 0f) return@with
        withTransform({
            scale(k, k, Offset.Zero)
            translate(-WicabyMark.VIEW_X, -WicabyMark.VIEW_Y - 34f * out)
        }) {
            // Fast then slow: the body is done at 44 % (1.06 s), the tip leads it.
            val bodyAt = EASE_PAINT.transform((f / 0.44f).coerceAtMost(1f)) * length
            val tipAt = min(EASE_PAINT.transform((f / 0.41f).coerceAtMost(1f)) * length, cut.lineEnd * length - cut.stroke * 0.25f)
            if (bodyAt >= length) {
                drawPath(w, color, alpha = alpha)
            } else {
                body.reset()
                if (measure.getSegment(0f, min(bodyAt, armStart), body, true)) drawPath(body, color, alpha = alpha, style = bodyStroke)
                if (bodyAt > armStart) {
                    // Right arm: the W itself up to a line across the arm at the brush. Everything
                    // before P4 is already inked (alpha is 1 by then), so the clip only needs that edge.
                    withTransform({
                        rotate(armAngle, p4)
                        clipRect(p4.x - 2000f, p4.y - 2000f, p4.x + (bodyAt - armStart), p4.y + 2000f)
                        rotate(-armAngle, p4)
                    }) { drawPath(w, color, alpha = alpha) }
                }
                if (tipAt > bodyAt && alpha >= 1f) { // only once opaque: overlapping caps would show at partial alpha
                    tip.reset()
                    if (measure.getSegment(bodyAt, tipAt, tip, true)) drawPath(tip, color, alpha = alpha, style = tipStroke)
                }
            }
            // The play stamps in once the brush reaches the arm: 0.6 to 1 with a spring overshoot.
            val pa = ((f - 0.35f) / 0.03f).coerceIn(0f, 1f)
            if (pa > 0f) {
                val s = stampScale(f)
                withTransform({ scale(s, s, pivot) }) { drawPath(play, BRAND_BLUE, alpha = pa * alpha) }
            }
        }
    }

    private fun stampScale(f: Float): Float = when {
        f < 0.35f -> 0.6f
        f < 0.42f -> lerp(0.6f, 1.09f, EASE_STAMP.transform((f - 0.35f) / 0.07f))
        f < 0.47f -> lerp(1.09f, 0.97f, EASE_IN_OUT.transform((f - 0.42f) / 0.05f))
        f < 0.53f -> lerp(0.97f, 1f, EASE_IN_OUT.transform((f - 0.47f) / 0.06f))
        else -> 1f
    }

    companion object {
        const val CYCLE_MS = 2400
        private val BRAND_BLUE = Color(0xFF0A84FF) // brand blue, independent of the accent
        private val EASE_PAINT = CubicBezierEasing(0.42f, 0.15f, 0.35f, 1f)
        private val EASE_STAMP = CubicBezierEasing(0.2f, 0.9f, 0.3f, 1f)
        private val EASE_IN_OUT = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
        private val EASE_LIFT = CubicBezierEasing(0.4f, 0f, 0.6f, 1f)
        private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t
    }
}
