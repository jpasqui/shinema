package io.shinema.tv

import java.io.IOException
import java.io.FilterInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicReference
import okhttp3.Call
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/** No persisted native grant: JS must restore the confirmed per-server choice first. */
internal class LocalHttpPolicy(private val resolver: Dns = Dns.SYSTEM) {
  data class State(val generation: Long, val origin: HttpUrl?)
  data class Update(val generation: Long, val origin: HttpUrl?)
  data class Ticket(val generation: Long, val origin: HttpUrl, val allowed: Boolean)
  private val state = AtomicReference(State(0, null))

  // Called on the bridge invocation thread, before any asynchronous DNS work.
  // A later revoke/replacement never waits for an earlier resolver to finish.
  @Synchronized fun begin(value: String?): Update {
    val generation = state.get().generation + 1
    state.set(State(generation, null))
    return Update(generation, value?.let(::parseOrigin))
  }

  fun complete(update: Update) {
    update.origin?.let { resolvePrivate(it.host) }
    while (true) {
      val current = state.get()
      if (current.generation != update.generation) throw IOException("Local HTTP choice was superseded")
      if (state.compareAndSet(current, State(update.generation, update.origin))) return
    }
  }

  fun capture(url: HttpUrl): Ticket? {
    if (url.scheme != "http") return null
    val current = state.get()
    return Ticket(current.generation, url, current.origin?.let { sameOrigin(it, url) } == true)
  }

  fun requireCurrent(ticket: Ticket, url: HttpUrl = ticket.origin) {
    val current = state.get()
    if (!ticket.allowed || current.generation != ticket.generation || current.origin == null ||
        !sameOrigin(current.origin, url) || !sameOrigin(ticket.origin, url)) {
      throw IOException("HTTP requires the selected local server permission")
    }
    if (url.username.isNotEmpty() || url.password.isNotEmpty()) throw IOException("URL credentials are not allowed")
  }

  fun resolvePrivate(host: String): List<InetAddress> {
    val addresses = resolver.lookup(host)
    if (addresses.isEmpty() || addresses.any { !isLocalAddress(it.address) }) {
      throw UnknownHostException("Local HTTP requires exclusively private network addresses")
    }
    return addresses
  }

  companion object {
    fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
        a.scheme == b.scheme && a.host == b.host && a.port == b.port

    fun parseOrigin(value: String): HttpUrl {
      if (value.any { it <= ' ' || it == '\\' || it == '@' }) throw IOException("Use a canonical server origin")
      val url = value.toHttpUrlOrNull() ?: throw IOException("Invalid local HTTP server origin")
      if (url.scheme != "http" || url.username.isNotEmpty() || url.password.isNotEmpty() ||
          url.encodedPath != "/" || url.query != null || url.fragment != null) {
        throw IOException("Use a local HTTP origin without credentials or a path")
      }
      val canonical = url.toString().removeSuffix("/")
      if (value != canonical && value != "$canonical/") throw IOException("Use a canonical server origin")
      return url
    }

    fun isLocalAddress(address: ByteArray): Boolean {
      fun octet(index: Int) = address[index].toInt() and 255
      if (address.size == 4) return octet(0) == 10 || octet(0) == 127 ||
          (octet(0) == 172 && octet(1) in 16..31) ||
          (octet(0) == 192 && octet(1) == 168) ||
          (octet(0) == 169 && octet(1) == 254)
      if (address.size != 16) return false
      // Java normally returns mapped IPv4 as Inet4Address, but check raw forms too.
      if ((0..9).all { octet(it) == 0 } && octet(10) == 255 && octet(11) == 255) {
        return isLocalAddress(address.copyOfRange(12, 16))
      }
      return ((0..14).all { octet(it) == 0 } && octet(15) == 1) ||
          ((octet(0) and 254) == 252) || (octet(0) == 254 && (octet(1) and 192) == 128)
    }
  }
}

/** Shared by RN fetch/subtitles, Fresco artwork and RNVideo's OkHttpDataSource. */
internal class LocalHttpTransport(
    builder: OkHttpClient.Builder,
    resolver: Dns = Dns.SYSTEM,
) {
  val policy = LocalHttpPolicy(resolver)
  private val tickets = Collections.synchronizedMap(WeakHashMap<Call, LocalHttpPolicy.Ticket>())
  private val resolving = ThreadLocal<LocalHttpPolicy.Ticket?>()

  val client: OkHttpClient = builder
      // Follow-ups are performed below only after checking the original origin.
      .followRedirects(false)
      .followSslRedirects(false)
      .dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
          val ticket = resolving.get()
          return if (ticket == null) resolver.lookup(hostname) else {
            policy.requireCurrent(ticket)
            if (hostname != ticket.origin.host) throw UnknownHostException("HTTP DNS origin changed")
            val addresses = policy.resolvePrivate(hostname)
            policy.requireCurrent(ticket)
            addresses
          }
        }
      })
      .eventListenerFactory { call ->
        // Factory runs at newCall(), before dispatcher queuing. A call created
        // before revoke/regrant cannot acquire the later permission (ABA).
        policy.capture(call.request().url)?.let { tickets[call] = it }
        object : EventListener() {
          override fun callEnd(call: Call) { tickets.remove(call) }
          override fun callFailed(call: Call, ioe: IOException) { tickets.remove(call) }
        }
      }
      .addInterceptor(Interceptor { chain -> execute(chain) })
      .addNetworkInterceptor(Interceptor { chain ->
        val ticket = tickets[chain.call()]
        if (chain.request().url.scheme == "http") {
          if (ticket == null) throw IOException("Missing local HTTP permission")
          policy.requireCurrent(ticket, chain.request().url)
          // Preserve ordinary HTTPS proxy behavior. An HTTP connection must be
          // direct; this runs before the exchange writes any request headers.
          if (chain.connection()?.route()?.proxy?.type() != Proxy.Type.DIRECT) {
            throw IOException("Local HTTP cannot use a proxy")
          }
          val address = chain.connection()?.socket()?.inetAddress?.address
          if (address == null || !LocalHttpPolicy.isLocalAddress(address)) {
            throw IOException("HTTP connection is not private")
          }
        }
        chain.proceed(chain.request())
      })
      .build()

  fun beginUpdate(value: String?): LocalHttpPolicy.Update {
    try {
      return policy.begin(value)
    } finally {
      // State is revoked before cancellation, including invalid replacement input.
      client.dispatcher.cancelAll()
      client.connectionPool.evictAll()
    }
  }

  private fun execute(chain: Interceptor.Chain): Response {
    val original = chain.request()
    val ticket = tickets[chain.call()]
    if (original.url.username.isNotEmpty() || original.url.password.isNotEmpty()) {
      throw IOException("URL credentials are not allowed")
    }
    if (original.url.scheme == "http") {
      if (ticket == null) throw IOException("Missing local HTTP permission")
      policy.requireCurrent(ticket, original.url)
      // Recheck even when a pooled socket/cache can avoid the connection DNS step.
      policy.resolvePrivate(original.url.host)
      policy.requireCurrent(ticket, original.url)
    }
    val previous = resolving.get()
    resolving.set(ticket)
    try {
      var request = original
      repeat(21) { redirect ->
        ticket?.let { policy.requireCurrent(it, request.url) }
        val response = chain.proceed(request)
        try {
          ticket?.let { policy.requireCurrent(it, request.url) }
          val location = response.header("Location")
          if (response.code !in setOf(300, 301, 302, 303, 307, 308) || location == null) {
            return if (ticket == null || response.body == null) response else
              response.newBuilder().body(guardBody(response.body!!, ticket)).build()
          }
          val next = request.url.resolve(location) ?: throw IOException("Invalid server redirect")
          if (next.username.isNotEmpty() || next.password.isNotEmpty() ||
              !LocalHttpPolicy.sameOrigin(original.url, next)) {
            throw IOException("Server redirects must retain the selected origin and transport")
          }
          if (redirect == 20) throw IOException("Too many server redirects")
          val nextRequest = request.newBuilder().url(next)
          if (response.code == 303 || ((response.code == 301 || response.code == 302) && request.method == "POST")) {
            if (request.method != "HEAD") nextRequest.method("GET", null)
            nextRequest.removeHeader("Content-Length").removeHeader("Content-Type").removeHeader("Transfer-Encoding")
          }
          request = nextRequest.build()
        } catch (error: Exception) {
          response.close()
          throw error
        }
        response.close()
      }
      throw IOException("Too many server redirects")
    } finally {
      resolving.set(previous)
    }
  }

  private fun guardBody(body: ResponseBody, ticket: LocalHttpPolicy.Ticket): ResponseBody =
      object : ResponseBody() {
        private fun <T> checked(read: () -> T): T {
          policy.requireCurrent(ticket)
          val result = read()
          policy.requireCurrent(ticket)
          return result
        }
        private val buffered = object : ForwardingSource(body.source()) {
          override fun read(sink: Buffer, byteCount: Long): Long {
            return checked { super.read(sink, byteCount) }
          }
        }.buffer()
        private val guarded: BufferedSource = object : BufferedSource by buffered {
          // RN text/JSON/subtitles use readString/readByteArray. Fresco and
          // ExoPlayer use byteStream. Check consumers too, not just upstream
          // fills: already buffered bytes must not revive an old grant.
          override fun read(sink: Buffer, byteCount: Long): Long = checked { buffered.read(sink, byteCount) }
          override fun read(sink: ByteArray): Int = checked { buffered.read(sink) }
          override fun read(sink: ByteArray, offset: Int, byteCount: Int): Int = checked { buffered.read(sink, offset, byteCount) }
          override fun read(sink: ByteBuffer): Int = checked { buffered.read(sink) }
          override fun readByteArray(): ByteArray = checked { buffered.readByteArray() }
          override fun readByteArray(byteCount: Long): ByteArray = checked { buffered.readByteArray(byteCount) }
          override fun readUtf8(): String = checked { buffered.readUtf8() }
          override fun readUtf8(byteCount: Long): String = checked { buffered.readUtf8(byteCount) }
          override fun readString(charset: Charset): String = checked { buffered.readString(charset) }
          override fun readString(byteCount: Long, charset: Charset): String = checked { buffered.readString(byteCount, charset) }
          override fun inputStream(): InputStream = object : FilterInputStream(buffered.inputStream()) {
            override fun read(): Int = checked { super.read() }
            override fun read(bytes: ByteArray, offset: Int, count: Int): Int = checked { super.read(bytes, offset, count) }
            override fun skip(count: Long): Long = checked { super.skip(count) }
          }
        }
        override fun contentType(): MediaType? = body.contentType()
        override fun contentLength(): Long = body.contentLength()
        override fun source(): BufferedSource { policy.requireCurrent(ticket); return guarded }
        // Cleanup must remain possible after revocation. ResponseBody's default
        // close calls source(), which correctly refuses revoked reads above.
        override fun close() { buffered.close() }
      }
}
