package io.shinema.tv

import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Dns
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Test

class LocalHttpTransportTest {
  private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
  private val publicAddress = InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8))
  private fun dns(resolve: (String) -> List<InetAddress>): Dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> = resolve(hostname)
  }
  private val localDns = dns { listOf(loopback) }
  private fun policyFailure(operation: () -> Unit) {
    try { operation(); fail("Expected local HTTP policy rejection") } catch (_: IOException) { }
  }
  private fun grant(transport: LocalHttpTransport, origin: String) {
    transport.policy.complete(transport.beginUpdate(origin))
  }
  private fun request(url: String) = Request.Builder().url(url).build()

  @Test fun localAddressBoundariesAndMappedPublicAddresses() {
    listOf("127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1",
        "::1", "fc00::1", "fd12::1", "fe80::1", "febf::1", "::ffff:192.168.1.1").forEach {
      assertTrue(it, LocalHttpPolicy.isLocalAddress(InetAddress.getByName(it).address))
    }
    listOf("0.0.0.0", "8.8.8.8", "100.64.0.1", "172.15.255.255", "172.32.0.1", "192.169.1.1", "224.0.0.1",
        "::", "2001:4860:4860::8888", "fec0::1", "ff02::1", "::ffff:8.8.8.8", "::192.168.1.1").forEach {
      assertFalse(it, LocalHttpPolicy.isLocalAddress(InetAddress.getByName(it).address))
    }
    val mapped = ByteArray(16).apply { this[10] = -1; this[11] = -1; this[12] = 8; this[13] = 8; this[14] = 8; this[15] = 8 }
    assertFalse(LocalHttpPolicy.isLocalAddress(mapped))
  }

  @Test fun onlyCanonicalHttpOriginsCanBeGranted() {
    assertEquals("lan.test", LocalHttpPolicy.parseOrigin("http://lan.test:8787").host)
    assertEquals("::1", LocalHttpPolicy.parseOrigin("http://[::1]:8787").host)
    listOf("https://lan.test", "http://user:pass@lan.test", "http://@lan.test", "http://lan.test/api", "http://lan.test?x=1",
        "http://lan.test#x", "http://LAN.test", "http://lan.test:80", "http://lan.test\\x", " http://lan.test").forEach {
      policyFailure { LocalHttpPolicy.parseOrigin(it) }
    }
  }

  @Test fun defaultDeniedAndOnlyExactOriginGranted() {
    val policy = LocalHttpPolicy(localDns)
    val url = "http://lan.test:8787/api/catalog".toHttpUrl()
    policyFailure { policy.requireCurrent(policy.capture(url)!!) }
    policy.complete(policy.begin("http://lan.test:8787"))
    policy.requireCurrent(policy.capture(url)!!)
    listOf("http://other.test:8787/api", "http://lan.test:8788/api").forEach {
      policyFailure { policy.requireCurrent(policy.capture(it.toHttpUrl())!!) }
    }
    assertNull(policy.capture("https://example.com/api".toHttpUrl()))
  }

  @Test fun allDnsAnswersMustBePrivateIncludingMixedAndEmptyResults() {
    listOf(emptyList(), listOf(publicAddress), listOf(loopback, publicAddress)).forEach { answers ->
      val policy = LocalHttpPolicy(dns { answers })
      policyFailure { policy.complete(policy.begin("http://lan.test:8787")) }
      policyFailure { policy.requireCurrent(policy.capture("http://lan.test:8787/".toHttpUrl())!!) }
    }
  }

  @Test fun revokeBeforePendingDnsCompletionAndSameOriginAbaNeverRevivesTicket() {
    val policy = LocalHttpPolicy(localDns)
    policy.complete(policy.begin("http://lan.test:8787"))
    val oldTicket = policy.capture("http://lan.test:8787/api".toHttpUrl())!!
    val pending = policy.begin("http://other.test:8787")
    policyFailure { policy.requireCurrent(oldTicket) }
    policy.complete(policy.begin(null))
    policyFailure { policy.complete(pending) }
    policy.complete(policy.begin("http://lan.test:8787"))
    policyFailure { policy.requireCurrent(oldTicket) }
    policy.requireCurrent(policy.capture("http://lan.test:8787/api".toHttpUrl())!!)
  }

  @Test fun invalidReplacementAlsoRevokesPreviousPermission() {
    val policy = LocalHttpPolicy(localDns)
    policy.complete(policy.begin("http://lan.test:8787"))
    val oldTicket = policy.capture("http://lan.test:8787/api".toHttpUrl())!!
    policyFailure { policy.begin("http://credentials@lan.test") }
    policyFailure { policy.requireCurrent(oldTicket) }
  }

  @Test fun actualClientRequiresGrantAndRetainsSameOriginRedirects() {
    FixtureServer().use { server ->
      val transport = LocalHttpTransport(OkHttpClient.Builder(), localDns)
      policyFailure { transport.client.newCall(request(server.url("/blocked"))).execute().close() }
      assertEquals(0, server.accepted.get())
      grant(transport, server.origin)
      server.enqueue("302 Found", "Location: /allowed\r\n")
      server.enqueue("200 OK", body = "catalogue")
      transport.client.newCall(request(server.url("/start"))).execute().use {
        assertEquals("catalogue", it.body!!.string())
      }
      assertEquals(2, server.accepted.get())
    }
  }

  @Test fun redirectsCannotChangeHostPortSchemeOrCarryCredentials() {
    listOf("http://other.test:8787/api", "http://lan.test:1/api", "https://lan.test:8787/api", "http://user:pass@lan.test:8787/api").forEach { location ->
      FixtureServer().use { server ->
        val transport = LocalHttpTransport(OkHttpClient.Builder(), localDns)
        grant(transport, server.origin)
        server.enqueue("302 Found", "Location: $location\r\n")
        policyFailure { transport.client.newCall(request(server.url("/start"))).execute().close() }
        assertEquals(1, server.accepted.get())
      }
    }
    val transport = LocalHttpTransport(OkHttpClient.Builder(), localDns)
    assertFalse(transport.client.followRedirects)
    assertFalse(transport.client.followSslRedirects)
    assertEquals(OkHttpClient().proxySelector, transport.client.proxySelector)
  }

  @Test fun httpProxyReceivesNoRequestBytesAndHttpsProxyConfigurationIsPreserved() {
    ServerSocket(0, 1, loopback).use { proxySocket ->
      val firstByte = CompletableFuture<Int>()
      val serverThread = Thread {
        proxySocket.accept().use { connection ->
          connection.soTimeout = 2000
          firstByte.complete(connection.getInputStream().read())
        }
      }.apply { isDaemon = true; start() }
      val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress(loopback, proxySocket.localPort))
      val transport = LocalHttpTransport(OkHttpClient.Builder().proxy(proxy), localDns)
      grant(transport, "http://lan.test:8787")
      val privateRequest = request("http://lan.test:8787/api/private").newBuilder()
          .header("Authorization", "Bearer generated-unit-test")
          .post("generated-fixture-body".toRequestBody()).build()
      policyFailure { transport.client.newCall(privateRequest).execute().close() }
      assertEquals(-1, firstByte.get(3, TimeUnit.SECONDS).toInt())
      assertEquals(proxy, transport.client.proxy)
      serverThread.join(2500)
    }
  }

  @Test fun actualConnectionDnsCannotRebindToMixedOrPublicAnswers() {
    listOf(listOf(publicAddress), listOf(loopback, publicAddress)).forEach { rebound ->
      FixtureServer().use { server ->
        val lookups = AtomicInteger()
        val transport = LocalHttpTransport(OkHttpClient.Builder(), dns {
          if (lookups.incrementAndGet() < 3) listOf(loopback) else rebound
        })
        grant(transport, server.origin)
        policyFailure { transport.client.newCall(request(server.url("/api"))).execute().close() }
        assertTrue(lookups.get() >= 3)
        assertEquals(0, server.accepted.get())
      }
    }
  }

  @Test fun queuedCallsAndBufferedVideoArtworkSubtitleReadsCannotReuseRegrant() {
    FixtureServer().use { server ->
      val transport = LocalHttpTransport(OkHttpClient.Builder(), localDns)
      val beforeGrant = transport.client.newCall(request(server.url("/queued")))
      grant(transport, server.origin)
      policyFailure { beforeGrant.execute().close() }
      server.enqueue("200 OK", body = "artwork-and-video")
      val response = transport.client.newCall(request(server.url("/stream"))).execute()
      val stream = response.body!!.byteStream()
      assertEquals('a'.code, stream.read()) // primes the buffer too
      val queued = transport.client.newCall(request(server.url("/queued-old-generation")))
      transport.policy.complete(transport.beginUpdate(null))
      grant(transport, server.origin)
      policyFailure { stream.read() }
      policyFailure { response.body!!.string() }
      policyFailure { queued.execute().close() }
      response.close()
      assertEquals(1, server.accepted.get())
    }
  }

  @Test fun deniedNewCallIsSafeAndLaterGrantCannotAuthorizeExecuteOrEnqueue() {
    FixtureServer().use { server ->
      val transport = LocalHttpTransport(OkHttpClient.Builder(), localDns)
      // Construction itself must not throw into RN NetworkingModule/Fresco.
      val executeDenied = transport.client.newCall(request(server.url("/catalogue")))
      val enqueueDenied = transport.client.newCall(request(server.url("/artwork")))
      grant(transport, server.origin)
      policyFailure { executeDenied.execute().close() }
      transport.beginUpdate(null)
      grant(transport, server.origin)
      val result = CompletableFuture<IOException?>()
      try {
        enqueueDenied.enqueue(object : Callback {
          override fun onFailure(call: Call, error: IOException) { result.complete(error) }
          override fun onResponse(call: Call, response: Response) { response.close(); result.complete(null) }
        })
        assertNotNull(result.get(3, TimeUnit.SECONDS))
        // Credentials also fail through execution, never request construction.
        val credentialUrl = server.origin.replace("http://", "http://generated:fixture@") + "/private"
        val credentialDenied = transport.client.newCall(request(credentialUrl))
        policyFailure { credentialDenied.execute().close() }
        assertEquals(0, server.accepted.get())
      } finally {
        transport.client.dispatcher.cancelAll()
        transport.client.dispatcher.executorService.shutdownNow()
      }
    }
  }

  /** Ephemeral host loopback only. No Android/device, external DNS or media. */
  private class FixtureServer : Closeable {
    private val socket = ServerSocket(0, 8, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
    private val replies = LinkedBlockingQueue<String>()
    val accepted = AtomicInteger()
    val origin = "http://lan.test:${socket.localPort}"
    fun url(path: String) = origin + path
    private val worker = Thread {
      try {
        while (!socket.isClosed) {
          socket.accept().use { connection ->
            accepted.incrementAndGet()
            connection.soTimeout = 2000
            val input = connection.getInputStream().bufferedReader()
            while (!input.readLine().isNullOrEmpty()) { }
            val reply = replies.poll(2, TimeUnit.SECONDS) ?: return@Thread
            connection.getOutputStream().write(reply.toByteArray(Charsets.UTF_8))
          }
        }
      } catch (_: IOException) { }
    }.apply { isDaemon = true; start() }
    fun enqueue(status: String, headers: String = "", body: String = "") {
      replies.add("HTTP/1.1 $status\r\n${headers}Content-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body")
    }
    override fun close() { socket.close(); worker.join(2500) }
  }
}
