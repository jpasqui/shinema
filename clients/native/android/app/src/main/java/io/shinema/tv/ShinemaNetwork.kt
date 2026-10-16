package io.shinema.tv

import com.facebook.react.bridge.Promise
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.util.concurrent.Executors

internal object ShinemaNetwork {
  private val worker = Executors.newFixedThreadPool(2)
  private val transport by lazy { LocalHttpTransport(OkHttpClientProvider.createClientBuilder()) }

  fun install() {
    // Must precede loadReactNative/Fresco initialization. Preserve RN's
    // ReactCookieJarContainer: Fresco and RNVideo both expect that container.
    OkHttpClientProvider.setOkHttpClientFactory(OkHttpClientFactory { transport.client })
  }

  fun setLocalHttpOrigin(value: String?, promise: Promise) {
    val update = try { transport.beginUpdate(value) } catch (error: Exception) {
      promise.reject("LOCAL_HTTP_INVALID", "Use an explicitly selected private HTTP server origin")
      return
    }
    if (value == null) {
      // beginUpdate already revoked. Do not let concurrent invalidate/revoke
      // turn this safe null request into an uncaught bridge exception.
      promise.resolve(null)
      return
    }
    worker.execute {
      try {
        transport.policy.complete(update)
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("LOCAL_HTTP_UNAVAILABLE", "Local HTTP requires private network addresses and a current selection")
      }
    }
  }

  fun revoke() { transport.beginUpdate(null) }
}
