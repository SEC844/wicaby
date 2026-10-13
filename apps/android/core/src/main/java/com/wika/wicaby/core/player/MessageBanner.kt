package com.wika.wicaby.core.player

import android.app.Activity
import android.app.Application
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.wika.wicaby.core.Core
import java.lang.ref.WeakReference

// A server message (DisplayMessage) on screen: a banner over the activity in front, browsing or playing
// (a Toast can go unseen on Google TV and under a full-screen player), else a Toast while the app is in the
// background. Plain views on the activity's content frame, so both apps' Compose screens need no wiring.
// Main thread only; Core.init registers it.
object MessageBanner : Application.ActivityLifecycleCallbacks {
    private const val SHOWN_MS = 8_000L
    private var front: WeakReference<Activity>? = null
    private var shown: View? = null

    fun show(title: String, text: String) {
        val a = front?.get()?.takeUnless { it.isFinishing }
        val root = a?.findViewById<ViewGroup>(android.R.id.content)
        if (a == null || root == null) {
            Toast.makeText(Core.app, "$title\n$text", Toast.LENGTH_LONG).show()
            return
        }
        dismiss()
        val d = a.resources.displayMetrics.density
        fun line(s: String, sp: Float, color: Int, bold: Boolean) = TextView(a).apply {
            this.text = s
            textSize = sp
            setTextColor(color)
            if (bold) typeface = Typeface.DEFAULT_BOLD
            maxWidth = (520 * d).toInt()
            maxLines = 6
            ellipsize = TextUtils.TruncateAt.END
        }
        val banner = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * d).toInt(), (12 * d).toInt(), (20 * d).toInt(), (14 * d).toInt())
            background = GradientDrawable().apply {
                cornerRadius = 18 * d
                setColor(0xF21C1C1E.toInt())
            }
            elevation = 12 * d
            // Read out by TalkBack; never takes the D-pad focus from the screen below.
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            isFocusable = false
            addView(line(title, 16f, 0xFFFFFFFF.toInt(), true))
            addView(line(text, 15f, 0xEBEBEBF5.toInt(), false))
            alpha = 0f
        }
        root.addView(
            banner,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
                .apply { setMargins((16 * d).toInt(), (24 * d).toInt(), (16 * d).toInt(), 0) },
        )
        banner.animate().alpha(1f).setDuration(200).start()
        shown = banner
        banner.postDelayed({ if (shown === banner) dismiss() }, SHOWN_MS)
    }

    private fun dismiss() {
        val v = shown ?: return
        shown = null
        (v.parent as? ViewGroup)?.removeView(v)
    }

    override fun onActivityResumed(activity: Activity) {
        front = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (front?.get() === activity) front = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}
