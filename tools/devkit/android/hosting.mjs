// Android LAN hosting support. This is HTML5 WebView packaging only: no engine target, JSB or NDK.
// HostWebSocket is deliberately pure Java so its ServerSocket/RFC 6455 framing can run on a desktop JVM in tests.

export function hostRuntimeFiles(appId) {
    return [
        ['HostWebSocket.java', hostWebSocketJava(appId)],
        ['HostRuntime.java', hostRuntimeJava(appId)],
    ];
}

export function hostWebSocketJava(appId) {
    return String.raw`package ${appId};

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Real ServerSocket transport and RFC 6455 framing for the Android-hosted room backend. */
public final class HostWebSocket {
    public static final int MAX_FRAME = 64 * 1024;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int IDLE_CLOSE_MS = 60 * 1000;
    private static final int HEARTBEAT_SECONDS = 20;

    private HostWebSocket() {}

    public interface Events {
        boolean ready();
        void connect(Connection connection);
        void message(Connection connection, String type, String data, int bytes);
        void close(Connection connection);
        void error(String message);
    }

    public static final class Server {
        private final Map<String, Connection> connections = new ConcurrentHashMap<>();
        private final AtomicInteger nextId = new AtomicInteger();
        private volatile boolean closed = true;
        private ServerSocket listener;
        private Thread acceptThread;
        private ScheduledExecutorService heartbeat;
        private Events events;
        private String path = "/ws";
        private int port;

        public synchronized void start(int requestedPort, String bindAddress, String wsPath, Events callbacks) throws IOException {
            if (listener != null) throw new IllegalStateException("host server is already started");
            if (requestedPort < 0 || requestedPort > 65535) throw new IllegalArgumentException("port must be 0..65535");
            if (wsPath == null || !wsPath.startsWith("/") || wsPath.length() > 128
                    || wsPath.indexOf('?') >= 0 || wsPath.indexOf('#') >= 0 || wsPath.indexOf('\\') >= 0) {
                throw new IllegalArgumentException("path must be an absolute URL path");
            }
            events = callbacks;
            path = wsPath;
            closed = false;
            listener = new ServerSocket();
            listener.setReuseAddress(true);
            listener.bind(new InetSocketAddress(bindAddress, requestedPort), 50);
            port = listener.getLocalPort();
            acceptThread = new Thread(new Runnable() {
                @Override public void run() { acceptLoop(); }
            }, "cocos4-host-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            heartbeat = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
                @Override public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable, "cocos4-host-heartbeat");
                    thread.setDaemon(true);
                    return thread;
                }
            });
            heartbeat.scheduleAtFixedRate(new Runnable() {
                @Override public void run() { heartbeat(); }
            }, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
        }

        public int port() { return port; }

        public int connectionCount() { return connections.size(); }

        public synchronized void close() {
            if (closed && listener == null) return;
            closed = true;
            ServerSocket current = listener;
            listener = null;
            if (current != null) try { current.close(); } catch (IOException ignored) { }
            if (heartbeat != null) {
                heartbeat.shutdownNow();
                heartbeat = null;
            }
            for (Connection connection : new ArrayList<>(connections.values())) connection.close(1001, "shutdown");
            connections.clear();
        }

        public void sendText(String connectionId, String text) {
            Connection connection = connections.get(connectionId);
            if (connection != null) connection.sendText(text);
        }

        public void sendBinary(String connectionId, String base64) {
            Connection connection = connections.get(connectionId);
            if (connection != null) connection.sendBinary(base64);
        }

        public void close(String connectionId, int code, String reason) {
            Connection connection = connections.get(connectionId);
            if (connection != null) connection.close(code, reason);
        }

        /** Adapter-driven liveness probe: sends one real RFC 6455 ping on the connection. */
        public void ping(String connectionId) {
            Connection connection = connections.get(connectionId);
            if (connection != null) connection.ping();
        }

        private void acceptLoop() {
            while (!closed) {
                try {
                    Socket socket = listener.accept();
                    socket.setTcpNoDelay(true);
                    if (events == null || !events.ready()) {
                        reject(socket);
                        continue;
                    }
                    String id = "c_" + String.format(Locale.ROOT, "%08x", nextId.incrementAndGet());
                    Connection connection = new Connection(this, socket, id, path);
                    connections.put(id, connection);
                    Thread thread = new Thread(new Runnable() {
                        @Override public void run() { connection.run(); }
                    }, "cocos4-host-" + id);
                    thread.setDaemon(true);
                    thread.start();
                } catch (SocketException stopped) {
                    if (!closed && events != null) events.error("listener stopped: " + message(stopped));
                } catch (IOException failure) {
                    if (!closed && events != null) events.error("listener failed: " + message(failure));
                }
            }
        }

        private void heartbeat() {
            for (Connection connection : connections.values()) connection.heartbeat();
        }

        private void remove(Connection connection) {
            connections.remove(connection.id);
        }

        private static void reject(Socket socket) {
            try {
                byte[] body = "{\"error\":\"BACKEND_NOT_READY\"}".getBytes(StandardCharsets.UTF_8);
                String head = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: "
                        + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                OutputStream output = socket.getOutputStream();
                output.write(head.getBytes(StandardCharsets.ISO_8859_1));
                output.write(body);
                output.flush();
            } catch (IOException ignored) {
            } finally {
                try { socket.close(); } catch (IOException ignored) { }
            }
        }
    }

    public static final class Connection implements Closeable {
        private final Server server;
        private final Socket socket;
        private final InputStream input;
        private final OutputStream output;
        private final Object writeLock = new Object();
        public final String id;
        public final String path;
        public volatile String remoteAddress = "?";
        public volatile int remotePort;
        public volatile String origin = "";
        public volatile String host = "";
        public volatile String query = "";
        public volatile String userAgent = "";
        private volatile boolean open = true;
        private volatile long lastPong = System.currentTimeMillis();
        private final AtomicInteger pingSequence = new AtomicInteger();

        private Connection(Server server, Socket socket, String id, String path) throws IOException {
            this.server = server;
            this.socket = socket;
            this.id = id;
            this.path = path;
            this.input = socket.getInputStream();
            this.output = socket.getOutputStream();
            this.remoteAddress = socket.getInetAddress() == null ? "?" : socket.getInetAddress().getHostAddress();
            this.remotePort = socket.getPort();
        }

        private void run() {
            try {
                if (handshake()) {
                    server.events.connect(this);
                    frameLoop();
                }
            } catch (ProtocolException protocol) {
                close(protocol.code, protocol.getMessage(), true);
            } catch (IOException failure) {
                // A malformed or disconnected client is isolated to its own socket.
            } finally {
                closeQuietly();
                server.remove(this);
                if (server.events != null) server.events.close(this);
            }
        }

        private boolean handshake() throws IOException {
            Map<String, String> headers = new HashMap<>();
            String requestLine = readHttpRequest(headers);
            if (requestLine == null) return false;
            String[] request = requestLine.split(" ");
            if (request.length != 3) { respond(400, "Bad Request", "{\"error\":\"BAD_REQUEST\"}"); return false; }
            String method = request[0];
            String target = request[1];
            int queryAt = target.indexOf('?');
            String requestPath = queryAt < 0 ? target : target.substring(0, queryAt);
            query = queryAt < 0 ? "" : target.substring(queryAt + 1);
            host = header(headers, "host");
            origin = header(headers, "origin");
            userAgent = header(headers, "user-agent");
            if (!"GET".equals(method)) { respond(405, "Method Not Allowed", "{\"error\":\"METHOD_NOT_ALLOWED\"}"); return false; }
            if ("/healthz".equals(requestPath)) {
                respond(200, "OK", server.events == null ? "{\"ok\":false}" : "{\"ok\":true,\"cocos4AndroidHost\":true,\"connections\":" + server.connectionCount() + "}");
                return false;
            }
            if (!path.equals(requestPath)) { respond(404, "Not Found", "{\"error\":\"NOT_FOUND\"}"); return false; }
            if (server.events == null || !server.events.ready()) { respond(503, "Service Unavailable", "{\"error\":\"BACKEND_NOT_READY\"}"); return false; }
            String upgrade = header(headers, "upgrade");
            String connection = header(headers, "connection");
            String key = header(headers, "sec-websocket-key");
            String version = header(headers, "sec-websocket-version");
            if (upgrade == null || !"websocket".equalsIgnoreCase(upgrade) || connection == null || !containsToken(connection, "upgrade")
                    || key == null || !"13".equals(version) || !validKey(key)) {
                respond(400, "Bad Request", "{\"error\":\"WEBSOCKET_REQUIRED\"}");
                return false;
            }
            String accept;
            try { accept = accept(key); } catch (Exception failure) { throw new IOException("WebSocket accept failed", failure); }
            respondRaw("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                    + accept + "\r\n\r\n");
            return true;
        }

        private void frameLoop() throws IOException {
            int fragmentOpcode = -1;
            ByteArrayOutputStream fragment = null;
            while (open) {
                Frame frame = readFrame();
                if (frame == null) break;
                if (frame.opcode == 0x8) { handleClose(frame.payload); break; }
                if (frame.opcode == 0x9) { sendFrame(0xA, frame.payload); continue; }
                if (frame.opcode == 0xA) {
                    lastPong = System.currentTimeMillis();
                    // Forward the real pong to the adapter so its heartbeat/hello deadlines resolve on
                    // actual traffic; the shell never fabricates pongs or relaxes those deadlines.
                    deliverPong(frame.payload);
                    continue;
                }
                if (frame.opcode == 0x0) {
                    if (fragmentOpcode < 0 || fragment == null) throw new ProtocolException(1002, "unexpected continuation frame");
                    fragment.write(frame.payload);
                    if (fragment.size() > MAX_FRAME) throw new ProtocolException(1009, "fragmented message exceeds 64 KiB");
                    if (frame.fin) {
                        deliver(fragmentOpcode, fragment.toByteArray());
                        fragmentOpcode = -1;
                        fragment = null;
                    }
                    continue;
                }
                if (frame.opcode != 0x1 && frame.opcode != 0x2) throw new ProtocolException(1002, "invalid WebSocket opcode");
                if (fragmentOpcode >= 0) throw new ProtocolException(1002, "new data frame during fragmented message");
                if (frame.fin) deliver(frame.opcode, frame.payload);
                else {
                    fragmentOpcode = frame.opcode;
                    fragment = new ByteArrayOutputStream();
                    fragment.write(frame.payload);
                }
            }
        }

        private void handleClose(byte[] payload) throws ProtocolException {
            if (payload.length == 1) throw new ProtocolException(1002, "close frame with one-byte payload");
            if (payload.length == 0) { close(1000, ""); return; }
            int code = ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
            if (!validCloseCode(code)) throw new ProtocolException(1002, "invalid close code");
            String reason = payload.length > 2 ? strictUtf8(payload, 2, payload.length - 2) : "";
            close(code, reason);
        }

        private void deliver(int opcode, byte[] payload) throws ProtocolException {
            if (server.events == null) return;
            if (opcode == 0x1) server.events.message(this, "text", strictUtf8(payload, 0, payload.length), payload.length);
            else server.events.message(this, "binary", Base64.getEncoder().encodeToString(payload), payload.length);
        }

        private void deliverPong(byte[] payload) {
            if (server.events == null) return;
            server.events.message(this, "pong", Base64.getEncoder().encodeToString(payload), payload.length);
        }

        private Frame readFrame() throws IOException {
            int first = input.read();
            if (first < 0) return null;
            int second = readByte();
            if ((first & 0x70) != 0) throw new ProtocolException(1002, "reserved WebSocket bits set");
            boolean fin = (first & 0x80) != 0;
            int opcode = first & 0x0f;
            boolean masked = (second & 0x80) != 0;
            long length = second & 0x7f;
            if (!masked) throw new ProtocolException(1002, "client WebSocket frames must be masked");
            if (length == 126) {
                length = ((long) readByte() << 8) | readByte();
                if (length < 126) throw new ProtocolException(1002, "non-canonical WebSocket length");
            } else if (length == 127) {
                if ((readByte() & 0x80) != 0) throw new ProtocolException(1002, "invalid WebSocket length");
                length = 0;
                for (int index = 0; index < 7; index++) length = (length << 8) | readByte();
                if (length < 65536) throw new ProtocolException(1002, "non-canonical WebSocket length");
            }
            if (length > MAX_FRAME) throw new ProtocolException(1009, "WebSocket message exceeds 64 KiB");
            if (opcode >= 0x8 && (!fin || length > 125)) throw new ProtocolException(1002, "invalid WebSocket control frame");
            byte[] mask = new byte[4];
            readFully(mask, 0, mask.length);
            byte[] payload = new byte[(int) length];
            readFully(payload, 0, payload.length);
            for (int index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
            return new Frame(fin, opcode, payload);
        }

        public void sendText(String text) { sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8)); }

        public void sendBinary(String base64) {
            try { sendFrame(0x2, Base64.getDecoder().decode(base64)); }
            catch (IllegalArgumentException invalid) { /* Adapter data errors stay local to the backend. */ }
        }

        /**
         * Sends one real ping frame for the adapter's own heartbeat/hello deadline logic. The payload is
         * echoed back by the peer, so the forwarded pong is distinguishable from the shell's own
         * empty-payload idle probes. The shell never synthesizes a pong or disables adapter deadlines.
         */
        public void ping() {
            int sequence = pingSequence.incrementAndGet();
            sendFrame(0x9, ("cocos4-adapter-" + sequence).getBytes(StandardCharsets.US_ASCII));
        }

        private void heartbeat() {
            if (!open) return;
            long now = System.currentTimeMillis();
            if (now - lastPong > IDLE_CLOSE_MS) { close(1001, "idle"); return; }
            sendFrame(0x9, new byte[0]);
        }

        private void protocolError(int code) {
            close(code, code == 1009 ? "message too large" : "protocol error");
        }

        public void close(int code, String reason) { close(code, reason, false); }

        /**
         * Sends the close frame and, for protocol errors, briefly drains already-arriving peer
         * bytes before closing. Closing a socket with unread data can emit a TCP reset that hides
         * the close code from the peer, so this keeps RFC 6455 error codes observable while staying
         * bounded.
         */
        private void close(int code, String reason, boolean drain) {
            if (!open) return;
            open = false;
            try {
                byte[] text = reason == null ? new byte[0] : reason.getBytes(StandardCharsets.UTF_8);
                ByteArrayOutputStream payload = new ByteArrayOutputStream();
                payload.write((code >>> 8) & 0xFF);
                payload.write(code & 0xFF);
                payload.write(text);
                sendFrame(0x8, payload.toByteArray());
            } catch (IOException ignored) {
            } finally {
                if (drain) drainBounded();
                closeQuietly();
            }
        }

        private void drainBounded() {
            try {
                socket.setSoTimeout(250);
                byte[] buffer = new byte[8192];
                int total = 0;
                while (total < MAX_FRAME) {
                    int count = input.read(buffer);
                    if (count < 0) break;
                    total += count;
                }
            } catch (IOException ignored) {
            }
        }

        private void sendFrame(int opcode, byte[] payload) {
            synchronized (writeLock) {
                if (!open && opcode != 0x8) return;
                try {
                    output.write(0x80 | opcode);
                    int length = payload.length;
                    if (length <= 125) output.write(length);
                    else if (length <= 65535) {
                        output.write(126);
                        output.write((length >>> 8) & 0xFF);
                        output.write(length & 0xFF);
                    } else {
                        output.write(127);
                        for (int shift = 56; shift >= 0; shift -= 8) output.write((int) (((long) length >>> shift) & 0xFF));
                    }
                    output.write(payload);
                    output.flush();
                } catch (IOException failure) {
                    open = false;
                }
            }
        }

        private String readHttpRequest(Map<String, String> headers) throws IOException {
            ByteArrayOutputStream raw = new ByteArrayOutputStream();
            int matched = 0;
            while (raw.size() < 32768) {
                int value = input.read();
                if (value < 0) return null;
                raw.write(value);
                if ((matched == 0 && value == '\r') || (matched == 1 && value == '\n')
                        || (matched == 2 && value == '\r') || (matched == 3 && value == '\n')) matched++;
                else matched = value == '\r' ? 1 : 0;
                if (matched == 4) break;
            }
            if (matched != 4) throw new IOException("HTTP header block too large");
            String text = new String(raw.toByteArray(), StandardCharsets.ISO_8859_1);
            String[] lines = text.split("\r\n");
            if (lines.length == 0 || lines[0].trim().isEmpty()) return null;
            for (int index = 1; index < lines.length; index++) {
                int colon = lines[index].indexOf(':');
                if (colon <= 0) continue;
                headers.put(lines[index].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[index].substring(colon + 1).trim());
            }
            return lines[0];
        }

        private void respond(int status, String reason, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: application/json\r\nContent-Length: "
                    + bytes.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
            respondRaw(head);
            output.write(bytes);
            output.flush();
        }

        private void respondRaw(String value) throws IOException {
            output.write(value.getBytes(StandardCharsets.ISO_8859_1));
            output.flush();
        }

        private int readByte() throws IOException {
            int value = input.read();
            if (value < 0) throw new EOFException("truncated WebSocket frame");
            return value;
        }

        private void readFully(byte[] target, int offset, int length) throws IOException {
            int read = 0;
            while (read < length) {
                int count = input.read(target, offset + read, length - read);
                if (count < 0) throw new EOFException("truncated WebSocket frame");
                read += count;
            }
        }

        private void closeQuietly() {
            open = false;
            try { socket.close(); } catch (IOException ignored) { }
        }

        @Override public void close() { close(1000, ""); }
    }

    public static String accept(String key) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-1");
        return Base64.getEncoder().encodeToString(hash.digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
    }

    public static String message(Throwable failure) {
        String value = failure == null ? null : failure.getMessage();
        return value == null || value.isEmpty() ? failure == null ? "unknown error" : failure.getClass().getSimpleName() : value;
    }

    private static boolean validKey(String value) {
        try { return Base64.getDecoder().decode(value.trim()).length == 16; }
        catch (IllegalArgumentException invalid) { return false; }
    }

    private static boolean validCloseCode(int code) {
        if (code < 1000 || code >= 5000) return false;
        if (code == 1004 || code == 1005 || code == 1006 || code == 1015) return false;
        if (code >= 1016 && code <= 2999) return false;
        return true;
    }

    private static String strictUtf8(byte[] bytes, int offset, int length) throws ProtocolException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, offset, length)).toString();
        } catch (CharacterCodingException invalid) {
            throw new ProtocolException(1007, "invalid UTF-8");
        }
    }

    private static String header(Map<String, String> headers, String name) {
        return headers.get(name);
    }

    private static boolean containsToken(String value, String token) {
        for (String part : value.split(",")) if (token.equalsIgnoreCase(part.trim())) return true;
        return false;
    }

    private static final class ProtocolException extends IOException {
        final int code;
        ProtocolException(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class Frame {
        final boolean fin;
        final int opcode;
        final byte[] payload;
        Frame(boolean fin, int opcode, byte[] payload) {
            this.fin = fin;
            this.opcode = opcode;
            this.payload = payload;
        }
    }
}
`;
}

export function hostRuntimeJava(appId) {
    return String.raw`package ${appId};

import android.app.Activity;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Android glue for the isolated backend WebView and the local hosting control endpoints. */
public final class HostRuntime {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String ENTRY = ORIGIN + "/__cocos4_host/index.html";
    private static final String CONTROL = "/__cocos4/host/";
    private static final int READY_TIMEOUT_MS = 15000;

    private HostRuntime() { }

    public static final class Controller {
        private final Activity activity;
        private final AssetManager assets;
        private final ViewGroup parent;
        private final Handler main = new Handler(Looper.getMainLooper());
        private final Object lock = new Object();
        private WebView webView;
        private HostWebSocket.Server server;
        private String state = "stopped";
        private boolean backendReady;
        private String bind = "lan";
        private String path = "/ws";
        private int requestedPort = 3000;
        private int boundPort;
        private long startedAt;
        private String lastError;
        private volatile String adapterStatus;
        private boolean startDispatched;
        private boolean destroyed;
        private Runnable readyTimeout;

        public Controller(Activity activity, AssetManager assets, ViewGroup parent) {
            this.activity = activity;
            this.assets = assets;
            this.parent = parent;
        }

        public WebResourceResponse handleControl(WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isLocalOrigin(uri) || request.isForMainFrame()) return response(403, "Forbidden", "{\"error\":\"FORBIDDEN\"}", null);
            String method = request.getMethod();
            String localPath = uri.getPath();
            if ((CONTROL + "status").equals(localPath)) {
                if (!"GET".equalsIgnoreCase(method)) return response(405, "Method Not Allowed", statusJson(), "GET");
                return response(200, "OK", statusJson(), null);
            }
            if ((CONTROL + "start").equals(localPath)) {
                if (!"POST".equalsIgnoreCase(method)) return response(405, "Method Not Allowed", statusJson(), "POST");
                try {
                    int port = parsePort(uri.getQueryParameter("port"));
                    String requestedBind = uri.getQueryParameter("bind");
                    String requestedPath = uri.getQueryParameter("path");
                    if (requestedBind == null) requestedBind = "lan";
                    if (requestedPath == null) requestedPath = "/ws";
                    validateHosting(port, requestedBind, requestedPath);
                    int code = startInternal(port, requestedBind, requestedPath);
                    return response(code, code == 202 ? "Accepted" : code == 200 ? "OK" : code == 409 ? "Conflict" : "Internal Server Error", statusJson(), null);
                } catch (IllegalArgumentException invalid) {
                    setLastError(invalid.getMessage());
                    return response(400, "Bad Request", statusJson(), null);
                }
            }
            if ((CONTROL + "stop").equals(localPath)) {
                if (!"POST".equalsIgnoreCase(method)) return response(405, "Method Not Allowed", statusJson(), "POST");
                int code = stopInternal();
                return response(code, code == 202 ? "Accepted" : "OK", statusJson(), null);
            }
            return response(404, "Not Found", "{\"error\":\"NOT_FOUND\"}", null);
        }

        public void destroy() {
            HostWebSocket.Server current;
            synchronized (lock) {
                if (destroyed) return;
                destroyed = true;
                state = "stopped";
                backendReady = false;
                current = server;
                server = null;
                cancelReadyTimeout();
            }
            if (current != null) current.close();
            main.post(new Runnable() {
                @Override public void run() {
                    if (webView != null) callAdapter("onStop", stopRequestJson());
                    destroyWebView();
                }
            });
        }

        private boolean isReady() {
            synchronized (lock) { return !destroyed && backendReady && "running".equals(state) && server != null; }
        }

        private void dispatchConnect(HostWebSocket.Connection connection) {
            if (!isReady()) { connection.close(1013, "backend not ready"); return; }
            final String json = connectionJson(connection);
            main.post(new Runnable() {
                @Override public void run() { if (isReady()) callAdapter("onConnect", json); }
            });
        }

        private void dispatchMessage(HostWebSocket.Connection connection, String type, String data, int bytes) {
            final String json = messageJson(connection, type, data, bytes);
            main.post(new Runnable() {
                @Override public void run() { callAdapter("onMessage", json); }
            });
        }

        private void dispatchClose(HostWebSocket.Connection connection) {
            final String json = closeJson(connection);
            main.post(new Runnable() {
                @Override public void run() { callAdapter("onClose", json); }
            });
        }

        private void dispatchError(String message) {
            final String json = errorJson(message);
            main.post(new Runnable() {
                @Override public void run() { callAdapter("onError", json); }
            });
        }

        private int startInternal(int port, String bindValue, String pathValue) {
            synchronized (lock) {
                if (destroyed) return 500;
                if (("running".equals(state) || "starting".equals(state))) {
                    if (sameOptions(port, bindValue, pathValue)) return 200;
                    return 409;
                }
                bind = bindValue;
                requestedPort = port;
                path = pathValue;
                state = "starting";
                backendReady = false;
                boundPort = 0;
                startedAt = 0;
                lastError = null;
                startDispatched = false;
            }
            final HostWebSocket.Server created = new HostWebSocket.Server();
            try {
                created.start(port, bindAddress(bindValue), pathValue, new HostWebSocket.Events() {
                    @Override public boolean ready() { return isReady(); }
                    @Override public void connect(HostWebSocket.Connection connection) { dispatchConnect(connection); }
                    @Override public void message(HostWebSocket.Connection connection, String type, String data, int bytes) { dispatchMessage(connection, type, data, bytes); }
                    @Override public void close(HostWebSocket.Connection connection) { dispatchClose(connection); }
                    @Override public void error(String message) { fail(message); }
                });
            } catch (Exception failure) {
                synchronized (lock) {
                    state = "error";
                    backendReady = false;
                    lastError = trim(HostWebSocket.message(failure));
                    boundPort = 0;
                }
                created.close();
                return 500;
            }
            synchronized (lock) {
                server = created;
                boundPort = created.port();
            }
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        ensureWebView();
                        startDispatched = false;
                        webView.loadUrl(ENTRY);
                        scheduleReadyTimeout();
                    } catch (RuntimeException failure) {
                        fail("adapter WebView failed: " + HostWebSocket.message(failure));
                    }
                }
            });
            return 202;
        }

        private int stopInternal() {
            HostWebSocket.Server current;
            synchronized (lock) {
                if ("stopped".equals(state) || destroyed) return 200;
                state = "stopping";
                backendReady = false;
                current = server;
                server = null;
                cancelReadyTimeout();
            }
            if (current != null) current.close();
            main.post(new Runnable() {
                @Override public void run() {
                    if (webView != null) callAdapter("onStop", stopRequestJson());
                    destroyWebView();
                    synchronized (lock) {
                        state = "stopped";
                        backendReady = false;
                        boundPort = 0;
                        startedAt = 0;
                        lastError = null;
                    }
                }
            });
            return 202;
        }

        private void markReady(String status) {
            synchronized (lock) {
                if (!"starting".equals(state)) return;
                adapterStatus = trim(status);
                backendReady = true;
                state = "running";
                startedAt = System.currentTimeMillis();
                cancelReadyTimeout();
            }
        }

        private void scheduleReadyTimeout() {
            cancelReadyTimeout();
            readyTimeout = new Runnable() {
                @Override public void run() {
                    synchronized (lock) {
                        if (!"starting".equals(state)) return;
                    }
                    fail("backend adapter did not call Cocos4Host.ready within 15 seconds");
                }
            };
            main.postDelayed(readyTimeout, READY_TIMEOUT_MS);
        }

        private void cancelReadyTimeout() {
            if (readyTimeout != null) {
                main.removeCallbacks(readyTimeout);
                readyTimeout = null;
            }
        }

        private void fail(String message) {
            HostWebSocket.Server current;
            synchronized (lock) {
                if (destroyed) return;
                state = "error";
                backendReady = false;
                lastError = trim(message);
                current = server;
                server = null;
                cancelReadyTimeout();
            }
            if (current != null) current.close();
            main.post(new Runnable() {
                @Override public void run() {
                    callAdapter("onError", errorJson(lastError));
                    destroyWebView();
                }
            });
        }

        private void ensureWebView() {
            if (webView != null) return;
            WebView created = new WebView(activity);
            created.setBackgroundColor(Color.TRANSPARENT);
            created.setVisibility(View.INVISIBLE);
            WebSettings settings = created.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false);
            settings.setGeolocationEnabled(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(true);
            created.addJavascriptInterface(new Bridge(), "Cocos4Host");
            created.setWebViewClient(new HostWebViewClient());
            parent.addView(created, new ViewGroup.LayoutParams(1, 1));
            webView = created;
        }

        private void destroyWebView() {
            WebView current = webView;
            webView = null;
            if (current == null) return;
            try { current.stopLoading(); } catch (RuntimeException ignored) { }
            ViewGroup owner = (ViewGroup) current.getParent();
            if (owner != null) owner.removeView(current);
            current.destroy();
        }

        private void callAdapter(String method, String json) {
            final WebView current = webView;
            if (current == null) return;
            String missing = "missing __COCOS4_HOST_ADAPTER__." + method;
            String script = "(function(){try{if(!globalThis.__COCOS4_HOST_ADAPTER__||typeof globalThis.__COCOS4_HOST_ADAPTER__."
                    + method + "!=='function')throw new Error(" + jsString(missing) + ");return globalThis.__COCOS4_HOST_ADAPTER__."
                    + method + "(" + jsString(json) + ");}catch(e){try{Cocos4Host.__hostError(String(e&&e.stack||e));}catch(ignore){}}return null;})()";
            current.evaluateJavascript(script, null);
        }

        private String statusJson() {
            synchronized (lock) {
                List<String> lan = lanUrls();
                return "{"
                        + json("schemaVersion") + ":1,"
                        + json("kind") + ":" + json("cocos4-android-host-control") + ","
                        + json("mode") + ":" + json("lan-host") + ","
                        + json("state") + ":" + json(state) + ","
                        + json("running") + ":" + "running".equals(state) + ","
                        + json("backendReady") + ":" + backendReady + ","
                        + json("bind") + ":" + json(bind) + ","
                        + json("host") + ":" + json(bindAddress(bind)) + ","
                        + json("port") + ":" + boundPort + ","
                        + json("requestedPort") + ":" + requestedPort + ","
                        + json("path") + ":" + json(path) + ","
                        + json("localBackendUrl") + ":" + json(localBackendUrl()) + ","
                        + json("localWsUrl") + ":" + json(localWsUrl()) + ","
                        + json("lanUrls") + ":" + jsonStrings(lan) + ","
                        + json("wsUrls") + ":" + jsonStrings(wsUrls(lan)) + ","
                        + json("connections") + ":" + (server == null ? 0 : server.connectionCount()) + ","
                        + json("adapterStatus") + ":" + (adapterStatus == null ? "null" : json(adapterStatus)) + ","
                        + json("startedAt") + ":" + (startedAt == 0 ? "null" : String.valueOf(startedAt)) + ","
                        + json("lastError") + ":" + (lastError == null ? "null" : json(lastError))
                        + "}";
            }
        }

        private String startRequestJson() {
            synchronized (lock) {
                List<String> lan = lanUrls();
                return "{"
                        + json("schemaVersion") + ":1,"
                        + json("requestId") + ":" + json("start-" + System.currentTimeMillis()) + ","
                        + json("action") + ":" + json("start") + ","
                        + json("port") + ":" + boundPort + ","
                        + json("requestedPort") + ":" + requestedPort + ","
                        + json("boundPort") + ":" + boundPort + ","
                        + json("bind") + ":" + json(bind) + ","
                        + json("path") + ":" + json(path) + ","
                        + json("localBackendUrl") + ":" + json(localBackendUrl()) + ","
                        + json("lanUrls") + ":" + jsonStrings(lan) + ","
                        + json("wsUrls") + ":" + jsonStrings(wsUrls(lan))
                        + "}";
            }
        }

        private String stopRequestJson() {
            return "{" + json("schemaVersion") + ":1," + json("action") + ":" + json("stop") + "}";
        }

        private static String connectionJson(HostWebSocket.Connection connection) {
            return "{"
                    + json("schemaVersion") + ":1,"
                    + json("connectionId") + ":" + json(connection.id) + ","
                    + json("remoteAddress") + ":" + json(connection.remoteAddress) + ","
                    + json("remotePort") + ":" + connection.remotePort + ","
                    + json("origin") + ":" + json(connection.origin) + ","
                    + json("host") + ":" + json(connection.host) + ","
                    + json("path") + ":" + json(connection.path) + ","
                    + json("query") + ":" + json(connection.query) + ","
                    + json("userAgent") + ":" + json(connection.userAgent) + ","
                    + json("secure") + ":false"
                    + "}";
        }

        private static String messageJson(HostWebSocket.Connection connection, String type, String data, int bytes) {
            return "{"
                    + json("schemaVersion") + ":1,"
                    + json("connectionId") + ":" + json(connection.id) + ","
                    + json("type") + ":" + json(type) + ","
                    + json("data") + ":" + json(data) + ","
                    + json("bytes") + ":" + bytes
                    + "}";
        }

        private static String closeJson(HostWebSocket.Connection connection) {
            return "{" + json("schemaVersion") + ":1," + json("connectionId") + ":" + json(connection.id) + "}";
        }

        private static String errorJson(String message) {
            return "{" + json("schemaVersion") + ":1," + json("message") + ":" + json(message == null ? "" : message) + "}";
        }

        private void setLastError(String message) {
            synchronized (lock) { lastError = trim(message); }
        }

        private static void validateHosting(int port, String bindValue, String pathValue) {
            if (port < 0 || port > 65535) throw new IllegalArgumentException("port must be 0..65535");
            if (!"lan".equals(bindValue) && !"loopback".equals(bindValue)) throw new IllegalArgumentException("bind must be lan or loopback");
            if (pathValue == null || !pathValue.startsWith("/") || pathValue.length() > 128
                    || pathValue.indexOf('?') >= 0 || pathValue.indexOf('#') >= 0 || pathValue.indexOf('\\') >= 0) {
                throw new IllegalArgumentException("path must be an absolute URL path");
            }
        }

        private static int parsePort(String value) {
            if (value == null || value.isEmpty()) return 3000;
            try { return Integer.parseInt(value); } catch (NumberFormatException invalid) { throw new IllegalArgumentException("port must be an integer"); }
        }

        private static String bindAddress(String value) { return "loopback".equals(value) ? "127.0.0.1" : "0.0.0.0"; }

        private boolean sameOptions(int port, String bindValue, String pathValue) {
            return requestedPort == port && bind.equals(bindValue) && path.equals(pathValue);
        }

        private String localBackendUrl() { return boundPort <= 0 ? "" : "http://127.0.0.1:" + boundPort; }

        private String localWsUrl() { return boundPort <= 0 ? "" : "ws://127.0.0.1:" + boundPort + path; }

        private List<String> lanUrls() {
            if (boundPort <= 0 || "loopback".equals(bind)) return Collections.emptyList();
            LinkedHashSet<String> urls = new LinkedHashSet<>();
            try {
                Enumeration<java.net.NetworkInterface> interfaces = java.net.NetworkInterface.getNetworkInterfaces();
                while (interfaces != null && interfaces.hasMoreElements()) {
                    java.net.NetworkInterface network = interfaces.nextElement();
                    if (!network.isUp() || network.isLoopback()) continue;
                    for (java.net.InterfaceAddress address : network.getInterfaceAddresses()) {
                        java.net.InetAddress host = address.getAddress();
                        if (host instanceof java.net.Inet4Address && !host.isLoopbackAddress() && !host.isLinkLocalAddress()) {
                            urls.add("http://" + host.getHostAddress() + ":" + boundPort);
                        }
                    }
                }
            } catch (Exception ignored) { }
            List<String> result = new ArrayList<>(urls);
            Collections.sort(result);
            return result;
        }

        private List<String> wsUrls(List<String> lan) {
            List<String> result = new ArrayList<>();
            if (boundPort > 0) result.add(localWsUrl());
            for (String url : lan) result.add("ws://" + url.substring("http://".length()) + path);
            return result;
        }

        private static boolean isLocalOrigin(Uri uri) {
            return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                    && "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost());
        }

        private static WebResourceResponse response(int status, String reason, String body, String allow) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            java.util.HashMap<String, String> headers = new java.util.HashMap<>();
            headers.put("Content-Type", "application/json; charset=utf-8");
            headers.put("Content-Length", Integer.toString(bytes.length));
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            if (allow != null) headers.put("Allow", allow);
            return new WebResourceResponse("application/json", "UTF-8", status, reason, headers,
                    new ByteArrayInputStream(bytes));
        }

        private static String json(String value) {
            if (value == null) return "null";
            StringBuilder result = new StringBuilder("\"");
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                switch (character) {
                    case '"': result.append("\\\""); break;
                    case '\\': result.append("\\\\"); break;
                    case '\b': result.append("\\b"); break;
                    case '\f': result.append("\\f"); break;
                    case '\n': result.append("\\n"); break;
                    case '\r': result.append("\\r"); break;
                    case '\t': result.append("\\t"); break;
                    default:
                        if (character < 32) result.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                        else result.append(character);
                }
            }
            return result.append('"').toString();
        }

        private static String jsonStrings(List<String> values) {
            StringBuilder result = new StringBuilder("[");
            for (int index = 0; index < values.size(); index++) {
                if (index > 0) result.append(',');
                result.append(json(values.get(index)));
            }
            return result.append(']').toString();
        }

        private static String jsString(String value) {
            return json(value);
        }

        private static String trim(String value) {
            if (value == null) return null;
            return value.length() <= 240 ? value : value.substring(0, 240);
        }

        private final class Bridge {
            @JavascriptInterface public void ready(String status) {
                final String value = status;
                main.post(new Runnable() { @Override public void run() { markReady(value); } });
            }
            @JavascriptInterface public void setState(String status) {
                final String value = status;
                main.post(new Runnable() {
                    @Override public void run() {
                        synchronized (lock) { adapterStatus = trim(value); }
                        if (value != null && value.length() > 0) Log.i("Cocos4Host", value.length() > 1000 ? value.substring(0, 1000) : value);
                    }
                });
            }
            @JavascriptInterface public void sendText(String connectionId, String text) {
                HostWebSocket.Server current;
                synchronized (lock) { current = server; }
                if (current != null) current.sendText(connectionId, text);
            }
            @JavascriptInterface public void sendBinary(String connectionId, String base64) {
                HostWebSocket.Server current;
                synchronized (lock) { current = server; }
                if (current != null) current.sendBinary(connectionId, base64);
            }
            @JavascriptInterface public void close(String connectionId, int code, String reason) {
                HostWebSocket.Server current;
                synchronized (lock) { current = server; }
                if (current != null) current.close(connectionId, code, reason);
            }
            @JavascriptInterface public void ping(String connectionId) {
                HostWebSocket.Server current;
                synchronized (lock) { current = server; }
                if (current != null) current.ping(connectionId);
            }
            @JavascriptInterface public void log(String level, String message) {
                String value = message == null ? "" : (message.length() > 1000 ? message.substring(0, 1000) : message);
                Log.println("error".equalsIgnoreCase(level) ? Log.ERROR : Log.INFO, "Cocos4Host", value);
            }
            @JavascriptInterface public void __hostError(String message) { fail(message); }
        }

        private final class HostWebViewClient extends WebViewClient {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isHostAsset(request.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return hostAsset(request);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (startDispatched) return;
                startDispatched = true;
                callAdapter("onStart", startRequestJson());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                fail("adapter resource failed: " + (error == null ? "unknown" : error.getDescription()));
            }
        }

        private boolean isHostAsset(Uri uri) {
            return isLocalOrigin(uri) && uri.getPath() != null && uri.getPath().startsWith("/__cocos4_host/");
        }

        private WebResourceResponse hostAsset(WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isHostAsset(uri)) return response(403, "Forbidden", "{\"error\":\"FORBIDDEN\"}", null);
            String localPath = uri.getPath();
            if (localPath == null || localPath.indexOf('\\') >= 0 || localPath.indexOf("..") >= 0) {
                return response(400, "Bad Request", "{\"error\":\"BAD_PATH\"}", null);
            }
            try {
                InputStream input = assets.open("www" + localPath, AssetManager.ACCESS_STREAMING);
                String mime = mimeType(localPath);
                return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null, 200, "OK",
                        Collections.<String, String>emptyMap(), input);
            } catch (IOException missing) {
                return response(404, "Not Found", "{\"error\":\"NOT_FOUND\"}", null);
            }
        }

        private static String mimeType(String path) {
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
            if (lower.endsWith(".css")) return "text/css";
            if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
            if (lower.endsWith(".wasm")) return "application/wasm";
            if (lower.endsWith(".svg")) return "image/svg+xml";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".webp")) return "image/webp";
            if (lower.endsWith(".woff2")) return "font/woff2";
            if (lower.endsWith(".ttf")) return "font/ttf";
            return "application/octet-stream";
        }

        private static boolean isText(String mime) {
            return mime.startsWith("text/") || "application/javascript".equals(mime)
                    || "application/json".equals(mime) || "image/svg+xml".equals(mime);
        }
    }
}
`;
}

