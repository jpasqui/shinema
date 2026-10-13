package io.shinema.tv
import android.util.AtomicFile
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.io.File
class ShinemaHostModule(private val context:ReactApplicationContext):ReactContextBaseJavaModule(context){
  companion object{
    private var instance:ShinemaHostModule?=null
    fun sendKey(code:Int,action:Int,repeat:Int):Boolean{
      val module=instance?:return false
      if(!module.context.hasActiveReactInstance())return false
      val payload=Arguments.createMap().apply{putInt("code",code);putInt("action",action);putInt("repeat",repeat)}
      module.context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("ShinemaKey",payload)
      return true
    }
  }
  override fun getName()="ShinemaHost"
  override fun initialize(){super.initialize();instance=this}
  override fun invalidate(){if(instance===this)instance=null;super.invalidate()}
  @ReactMethod fun addListener(eventName:String){}
  @ReactMethod fun removeListeners(count:Int){}
  @ReactMethod fun readState(promise:Promise){
    try{val file=AtomicFile(File(context.filesDir,"client-state.json"));promise.resolve(if(file.baseFile.exists())file.readFully().toString(Charsets.UTF_8)else "")}
    catch(error:Exception){promise.resolve("")}
  }
  @ReactMethod fun writeState(value:String,promise:Promise){
    val bytes=value.toByteArray(Charsets.UTF_8)
    if(bytes.size>1048576){promise.reject("STATE_TOO_LARGE","Client state exceeds limit");return}
    val file=AtomicFile(File(context.filesDir,"client-state.json"));var output:java.io.FileOutputStream?=null
    try{output=file.startWrite();output.write(bytes);file.finishWrite(output);promise.resolve(null)}
    catch(error:Exception){if(output!=null)file.failWrite(output);promise.reject("STATE_WRITE_FAILED","Could not save client state")}
  }
  @ReactMethod fun finish(){context.currentActivity?.runOnUiThread{context.currentActivity?.finish()}}
}
class ShinemaHostPackage:ReactPackage{
  override fun createNativeModules(context:ReactApplicationContext):List<NativeModule> = listOf(ShinemaHostModule(context))
  override fun createViewManagers(context:ReactApplicationContext):List<ViewManager<*,*>> = emptyList()
}
