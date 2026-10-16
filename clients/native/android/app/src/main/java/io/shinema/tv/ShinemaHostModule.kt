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
  // Only the confirmed file is read on startup. A canceled/failed candidate
  // may remain in its separate private slot but cannot replace confirmed data.
  @ReactMethod fun stageState(value:String,promise:Promise){writeCache("candidate-state.json",value,promise)}
  @ReactMethod fun writeState(value:String,promise:Promise){writeCache("client-state.json",value,promise)}
  // Appearance never shares a file or queue with library/resume state.
  @ReactMethod fun readPreferences(promise:Promise){
    try{
      val file=AtomicFile(File(context.filesDir,"appearance-v1.json"))
      val backup=File(context.filesDir,"appearance-v1.json.bak")
      if(!file.baseFile.exists() && !backup.exists()){promise.resolve("");return}
      val bytes=file.readFully()
      if(bytes.size>16384){promise.reject("PREFERENCES_TOO_LARGE","Saved appearance exceeds limit");return}
      promise.resolve(bytes.toString(Charsets.UTF_8))
    }catch(error:Exception){promise.reject("PREFERENCES_READ_FAILED","Could not read appearance")}
  }
  @ReactMethod fun writePreferences(value:String,promise:Promise){
    val bytes=value.toByteArray(Charsets.UTF_8)
    if(bytes.size>16384){promise.reject("PREFERENCES_TOO_LARGE","Appearance exceeds limit");return}
    val file=AtomicFile(File(context.filesDir,"appearance-v1.json"));var output:java.io.FileOutputStream?=null
    try{output=file.startWrite();output.write(bytes);output.fd.sync();file.finishWrite(output);promise.resolve(null)}
    catch(error:Exception){if(output!=null)file.failWrite(output);promise.reject("PREFERENCES_WRITE_FAILED","Could not save appearance")}
  }
  private fun writeCache(name:String,value:String,promise:Promise){
    val bytes=value.toByteArray(Charsets.UTF_8)
    if(bytes.size>1048576){promise.reject("STATE_TOO_LARGE","Client state exceeds limit");return}
    val file=AtomicFile(File(context.filesDir,name));var output:java.io.FileOutputStream?=null
    try{output=file.startWrite();output.write(bytes);output.fd.sync();file.finishWrite(output);promise.resolve(null)}
    catch(error:Exception){if(output!=null)file.failWrite(output);promise.reject("STATE_WRITE_FAILED","Could not save client state")}
  }
  @ReactMethod fun finish(){context.currentActivity?.runOnUiThread{context.currentActivity?.finish()}}
}
class ShinemaHostPackage:ReactPackage{
  override fun createNativeModules(context:ReactApplicationContext):List<NativeModule> = listOf(ShinemaHostModule(context))
  override fun createViewManagers(context:ReactApplicationContext):List<ViewManager<*,*>> = emptyList()
}
