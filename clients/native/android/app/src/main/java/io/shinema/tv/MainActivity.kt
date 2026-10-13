package io.shinema.tv
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.widget.EditText
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
class MainActivity : ReactActivity() {
  override fun getMainComponentName() = "ShinemaTV"
  override fun createReactActivityDelegate(): ReactActivityDelegate = DefaultReactActivityDelegate(this,mainComponentName,fabricEnabled)
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
  }
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if(currentFocus is EditText)return super.dispatchKeyEvent(event)
    val handled=event.keyCode in setOf(KeyEvent.KEYCODE_DPAD_LEFT,KeyEvent.KEYCODE_DPAD_RIGHT,KeyEvent.KEYCODE_DPAD_UP,KeyEvent.KEYCODE_DPAD_DOWN,KeyEvent.KEYCODE_DPAD_CENTER,KeyEvent.KEYCODE_ENTER,KeyEvent.KEYCODE_BACK,KeyEvent.KEYCODE_ESCAPE,KeyEvent.KEYCODE_MENU,KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
    if(handled && ShinemaHostModule.sendKey(event.keyCode,event.action,event.repeatCount))return true
    return super.dispatchKeyEvent(event)
  }
}
