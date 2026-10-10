// Android is a host for an exported HTML5 game. This does not add an engine target.
import { hostRuntimeFiles } from './hosting.mjs';
const javaKeywords = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _').split(' '));

function xml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function java(value) {
    return JSON.stringify(String(value));
}

function groovy(value) {
    return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function integer(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
}

/** Return UTF-8 project files; copy the exported web root to app/src/main/assets/www/. */
export function androidProjectFiles(config) {
    const {
        appId, appName, versionCode = 1, versionName = '1.0.0',
        orientation = 'sensorLandscape', minSdk = 26, targetSdk = 35, compileSdk = 35,
        backendUrl = '', allowCleartext = false, dynamicBackend = false, configGlobal = '', entry = 'index.html', hostingMode = 'connect-only',
    } = config;
    if (typeof appId !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(appId)
        || appId.split('.').some(part => javaKeywords.has(part))) throw new Error('appId must be a Java-compatible Android application ID');
    for (const [name, value] of Object.entries({ appName, versionName })) {
        if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} must be non-empty text without control characters`);
    }
    if (!['sensorLandscape', 'sensorPortrait', 'fullSensor'].includes(orientation)) throw new Error('Unsupported Android orientation');
    integer(versionCode, 'versionCode', 1, 2100000000);
    if (compileSdk !== 35) throw new Error('compileSdk must be 35 for the pinned Android toolchain');
    integer(minSdk, 'minSdk', 26, compileSdk);
    integer(targetSdk, 'targetSdk', minSdk, compileSdk);
    if (typeof entry !== 'string' || !entry || /[\\\u0000-\u001f\u007f?#:]/.test(entry)
        || entry.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('entry must be a relative web asset path');
    if (typeof backendUrl !== 'string' || typeof allowCleartext !== 'boolean' || typeof dynamicBackend !== 'boolean') throw new Error('Invalid backend configuration');
    if (!['connect-only', 'lan-host'].includes(hostingMode)) throw new Error('hostingMode must be connect-only or lan-host');
    if (hostingMode === 'lan-host' && !allowCleartext) throw new Error('lan-host requires allowCleartext:true for the local ws:// listener');
    if (typeof configGlobal !== 'string' || (configGlobal && (!/^[A-Za-z_$][\w$]{0,127}$/.test(configGlobal)
        || ['__proto__', 'constructor', 'prototype', 'location', 'document', 'window', 'globalThis', '__COCOS4_ANDROID__'].includes(configGlobal)))) throw new Error('Invalid config global');
    const backend = backendUrl ? new URL(backendUrl) : null;
    if (backend && (!['https:', 'http:'].includes(backend.protocol) || backend.username || backend.password
        || backend.search || backend.hash || /[\s<>"'\\?#]/.test(backendUrl)
        || backend.hostname.toLowerCase() === 'appassets.androidplatform.net')) throw new Error('backendUrl must be an HTTP(S) origin/path without credentials, query or fragment, distinct from the asset origin');
    const cleartext = backend?.protocol === 'http:' && allowCleartext;
    const dynamicCleartext = dynamicBackend && allowCleartext;
    const mixedContent = hostingMode === 'lan-host' ? 'WebSettings.MIXED_CONTENT_ALWAYS_ALLOW'
        : dynamicCleartext ? 'BuildConfig.DEBUG ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW'
        : cleartext ? 'WebSettings.MIXED_CONTENT_ALWAYS_ALLOW' : 'WebSettings.MIXED_CONTENT_NEVER_ALLOW';
    if (backend?.protocol === 'http:' && !cleartext) throw new Error('HTTP backends require explicit allowCleartext');
    const backendOrigin = backend?.origin || '';
    const websocketOrigin = backendOrigin.replace(/^http/, 'ws');
    const localHostSources = hostingMode === 'lan-host' ? ' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*' : '';
    const contentPolicy = `connect-src 'self' blob: data:${backend ? ` ${backendOrigin} ${websocketOrigin}` : ''}${localHostSources}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'`;
    const androidLabel = `"${appName.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll("'", "\\'")}"`;
    const files = new Map();
    files.set('.gitignore', `.gradle/\nlocal.properties\n**/build/\n*.jks\n*.keystore\n`);
    files.set('settings.gradle', `pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = 'Cocos4WebApp'
include ':app'
`);
    files.set('build.gradle', `plugins {
    id 'com.android.application' version '8.7.3' apply false
}
`);
    files.set('gradle.properties', `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=false
android.nonTransitiveRClass=true
`);
    files.set('app/build.gradle', `plugins { id 'com.android.application' }

android {
    namespace ${groovy(appId)}
    compileSdk ${compileSdk}
    buildToolsVersion '35.0.0'
    defaultConfig {
        applicationId ${groovy(appId)}
        minSdk ${minSdk}
        targetSdk ${targetSdk}
        versionCode ${versionCode}
        versionName ${groovy(versionName)}
    }
    buildFeatures { buildConfig true }
    buildTypes {
        debug { debuggable true }
        release { debuggable false; minifyEnabled false }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
    androidResources { noCompress += ['wasm', 'data', 'bin', 'mp3', 'ogg', 'mp4', 'webm'] }
}
${dynamicBackend ? `
// Runtime backend selection is a debug feature, including when built in Android Studio.
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase(java.util.Locale.ROOT).contains('release') }) {
        throw new GradleException('dynamicBackend supports debug builds only; export a fixed backend for release.')
    }
}
` : ''}
`);
    files.set('app/src/main/AndroidManifest.xml', `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-feature android:glEsVersion="0x00020000" android:required="true" />
    <application
        android:label="@string/app_name"
        android:theme="@style/AppTheme"
        android:allowBackup="false"
        android:fullBackupContent="false"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="false"
        android:networkSecurityConfig="@xml/network_security_config">
        <activity android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="${orientation}"
            android:enableOnBackInvokedCallback="false"
            android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);
    files.set('app/src/main/res/values/strings.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources><string name="app_name" formatted="false">${xml(androidLabel)}</string></resources>
`);
    files.set('app/src/main/res/values/styles.xml', `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:windowActionModeOverlay">true</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowFullscreen">true</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
        <item name="android:colorAccent">#20D9B4</item>
        <item name="android:windowBackground">#101415</item>
    </style>
</resources>
`);
    const fixedCleartextHosts = new Set();
    if (cleartext && !dynamicCleartext && backend) fixedCleartextHosts.add(backend.hostname.replace(/^\[|\]$/g, ''));
    if (hostingMode === 'lan-host' && !dynamicCleartext) { fixedCleartextHosts.add('127.0.0.1'); fixedCleartextHosts.add('localhost'); }
    const cleartextDomains = [...fixedCleartextHosts].map(host => `
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">${xml(host)}</domain>
    </domain-config>`).join('');
    files.set('app/src/main/res/xml/network_security_config.xml', `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="${dynamicCleartext ? 'true' : 'false'}">
        <trust-anchors><certificates src="system" /></trust-anchors>
    </base-config>${cleartextDomains}
</network-security-config>
`);
    const javaRoot = `app/src/main/java/${appId.replaceAll('.', '/')}`;
    files.set(`${javaRoot}/MainActivity.java`, mainActivity({ appId, entry, cleartext, dynamicBackend, dynamicCleartext, mixedContent, hostingMode }));
    files.set(`${javaRoot}/LocalAssetClient.java`, localAssetClient({ appId, entry, backendOrigin, contentPolicy, backendUrl, allowCleartext, dynamicBackend, configGlobal, hostingMode }));
    if (hostingMode === 'lan-host') {
        for (const [name, source] of hostRuntimeFiles(appId)) files.set(`${javaRoot}/${name}`, source);
    }
    return files;
}

function mainActivity({ appId, entry, cleartext, dynamicBackend, dynamicCleartext, mixedContent, hostingMode }) {
    return `package ${appId};

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

public final class MainActivity extends Activity {
    private WebView webView;
${hostingMode === 'lan-host' ? `    private HostRuntime.Controller hostController;` : ''}

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(16, 20, 21));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setSafeBrowsingEnabled(true);
        settings.setMixedContentMode(${mixedContent});
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        ${hostingMode === 'lan-host' ? `android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.addView(webView, new android.widget.FrameLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));
        hostController = new HostRuntime.Controller(this, getAssets(), root);
        ` : ''}final LocalAssetClient client = new LocalAssetClient(getAssets()${dynamicBackend ? ', getSharedPreferences("cocos4-shell", MODE_PRIVATE)' : ''}${hostingMode === 'lan-host' ? ', hostController' : ''});
        webView.setWebViewClient(client);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        // Service workers use the same local asset and backend policy as document requests.
        ServiceWorkerController workers = ServiceWorkerController.getInstance();
        workers.getServiceWorkerWebSettings().setAllowFileAccess(false);
        workers.getServiceWorkerWebSettings().setAllowContentAccess(false);
        workers.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return client.intercept(request);
            }
        });
        
        enterFullscreen();
        if (state == null || webView.restoreState(state) == null
                || !LocalAssetClient.isLocalUrl(android.net.Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) {
            webView.loadUrl(LocalAssetClient.ORIGIN + ${java(entry.split('/').map(encodeURIComponent).join('/'))});
        }
    }

    private void enterFullscreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) enterFullscreen();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        webView.saveState(state);
        super.onSaveInstanceState(state);
    }
    @Override protected void onPause() {
        webView.onPause();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        enterFullscreen();
    }
    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
    @Override protected void onDestroy() {
${hostingMode === 'lan-host' ? `        if (hostController != null) {
            hostController.destroy();
            hostController = null;
        }
` : ''}
        if (webView != null) {
            ((android.view.ViewGroup) webView.getParent()).removeView(webView);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
`;
}

function localAssetClient({ appId, entry, backendOrigin, contentPolicy, backendUrl, allowCleartext, dynamicBackend, configGlobal, hostingMode }) {
    return `package ${appId};

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
${dynamicBackend ? 'import android.content.SharedPreferences;\n' : ''}import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
${dynamicBackend ? 'import java.net.URI;\nimport java.net.URISyntaxException;\n' : ''}import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Serves APK assets over a secure origin. A missing local asset can never fall through to DNS. */
public final class LocalAssetClient extends WebViewClient {
    public static final String ORIGIN = "https://appassets.androidplatform.net/";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ENTRY = ${java(entry)};
    private static final String BACKEND = ${java(backendOrigin)};
    private static final String POLICY = ${java(contentPolicy)};
    private final AssetManager assets;
${hostingMode === 'lan-host' ? `    private final HostRuntime.Controller hostController;
` : ''}${dynamicBackend ? `    private static final String DEFAULT_BACKEND_URL = ${java(backendUrl)};
    private static final boolean ALLOW_CLEARTEXT = ${allowCleartext};
    private static final String CONFIG_GLOBAL = ${java(configGlobal)};
    private final BackendSettings backendSettings;

    public LocalAssetClient(AssetManager assets, SharedPreferences preferences${hostingMode === 'lan-host' ? ', HostRuntime.Controller hostController' : ''}) {
        this.assets = assets;
${hostingMode === 'lan-host' ? '        this.hostController = hostController;\n' : ''}        backendSettings = BuildConfig.DEBUG ? new BackendSettings(preferences, DEFAULT_BACKEND_URL, ALLOW_CLEARTEXT) : null;
    }
` : `
    public LocalAssetClient(AssetManager assets${hostingMode === 'lan-host' ? ', HostRuntime.Controller hostController' : ''}) { this.assets = assets;${hostingMode === 'lan-host' ? ' this.hostController = hostController;' : ''} }
`}

    public static boolean isLocalUrl(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost())
            && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !isLocalUrl(request.getUrl());
    }
    @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return !isLocalUrl(Uri.parse(url));
    }
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return intercept(request);
    }

    private ${dynamicBackend ? '' : 'static '}boolean isBackendUrl(Uri uri) {
${dynamicBackend ? `        return isBackendOrigin(uri.toString(), backendSettings == null ? BACKEND : backendSettings.getBackendUrl());
` : `        if (BACKEND.isEmpty() || uri.getUserInfo() != null) return false;
        Uri allowed = Uri.parse(BACKEND);
        if (!allowed.getScheme().equalsIgnoreCase(uri.getScheme())
                || !allowed.getHost().equalsIgnoreCase(uri.getHost())) return false;
        int defaultPort = "https".equals(allowed.getScheme()) ? 443 : 80;
        int expected = allowed.getPort() < 0 ? defaultPort : allowed.getPort();
        int actual = uri.getPort() < 0 ? defaultPort : uri.getPort();
        return actual == expected;
`}
    }

    private static boolean isDataSubresource(String scheme, boolean mainFrame) {
        return !mainFrame && "data".equalsIgnoreCase(scheme);
    }

    public WebResourceResponse intercept(WebResourceRequest request) {
        Uri uri = request.getUrl();
        // WebView also intercepts data: URLs. Embedded resources need no network access.
        if (isDataSubresource(uri.getScheme(), request.isForMainFrame())) return null;
        if (!isLocalUrl(uri)) {
            // The WebView handles TLS and CORS for the explicitly configured backend.
            if (!request.isForMainFrame() && isBackendUrl(uri)) return null;
            return error(403, "Forbidden", 0, false);
        }
        String method = request.getMethod();
        boolean head = "HEAD".equalsIgnoreCase(method);
        String localPath = uri.getPath();
${hostingMode === 'lan-host' ? `        if (localPath != null && localPath.startsWith("/__cocos4/host/")) {
            if (request.isForMainFrame()) return error(404, "Not Found", 0, false);
            return hostController.handleControl(request);
        }
` : ''}${dynamicBackend ? `        if ("/__cocos4/backend".equals(localPath)) return configureBackend(request);
        if (backendSettings != null && "/cocos4-shell-config.js".equals(localPath)) {
            if (!head && !"GET".equalsIgnoreCase(method)) return error(405, "Method Not Allowed", 0, false);
            return generatedResponse("application/javascript", backendSettings.configScript(CONFIG_GLOBAL), head);
        }
` : ''}        if (!head && !"GET".equalsIgnoreCase(method)) return error(405, "Method Not Allowed", 0, false);
        String path = uri.getPath(); // Android decodes once before segment validation.
        if (path == null || path.equals("/") || path.isEmpty()) path = "/" + ENTRY;
        if (!safePath(path)) return error(400, "Bad Request", 0, head);
        String asset = "www/" + path.substring(1);
        InputStream stream = null;
        try {
            long length = assetLength(asset);
            long start = 0;
            long end = length - 1;
            String requestedRange = head ? null : header(request.getRequestHeaders(), "Range");
            boolean partial = requestedRange != null;
            if (partial) {
                long[] range = parseRange(requestedRange, length);
                if (range == null) return error(416, "Range Not Satisfiable", length, head);
                start = range[0];
                end = range[1];
            }
            long bodyLength = Math.max(0, end - start + 1);
            String mime = mimeType(path);
            Map<String, String> headers = headers(mime, bodyLength);
            headers.put("Accept-Ranges", "bytes");
            if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
            if (head) stream = new ByteArrayInputStream(new byte[0]);
            else {
                stream = assets.open(asset, AssetManager.ACCESS_STREAMING);
                skipExactly(stream, start);
                stream = new LimitedInputStream(stream, bodyLength);
            }
            return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null,
                partial ? 206 : 200, partial ? "Partial Content" : "OK", headers, stream);
        } catch (IOException exception) {
            if (stream != null) try { stream.close(); } catch (IOException ignored) { }
            return error(404, "Not Found", 0, head);
        }
    }

    private static boolean safePath(String path) {
        if (!path.startsWith("/") || path.indexOf('\\\\') >= 0) return false;
        for (int index = 0; index < path.length(); index++) {
            char character = path.charAt(index);
            if (character < 32 || character == 127) return false;
        }
        for (String segment : path.substring(1).split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) return false;
        }
        return true;
    }

    private long assetLength(String asset) throws IOException {
        // Uncompressed audio/WASM supports O(1) lengths; compressed assets are counted without retaining their bytes.
        try (AssetFileDescriptor file = assets.openFd(asset)) { return file.getLength(); }
        catch (IOException compressedOrMissing) {
            try (InputStream stream = assets.open(asset, AssetManager.ACCESS_STREAMING)) {
                long total = 0;
                byte[] buffer = new byte[8192];
                int count;
                while ((count = stream.read(buffer)) != -1) total += count;
                return total;
            }
        }
    }

    private static String header(Map<String, String> values, String name) {
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    // Single HTTP byte ranges cover media seeking. Multiple/invalid ranges return 416.
    private static long[] parseRange(String value, long length) {
        if (length == 0 || !value.startsWith("bytes=") || value.indexOf(',') >= 0) return null;
        String[] parts = value.substring(6).split("-", -1);
        if (parts.length != 2 || (!parts[0].isEmpty() && !parts[0].matches("[0-9]+"))
                || (!parts[1].isEmpty() && !parts[1].matches("[0-9]+"))) return null;
        try {
            long start;
            long end;
            if (parts[0].isEmpty()) {
                long suffix = Long.parseLong(parts[1]);
                if (suffix <= 0) return null;
                start = Math.max(0, length - suffix);
                end = length - 1;
            } else {
                start = Long.parseLong(parts[0]);
                end = parts[1].isEmpty() ? length - 1 : Math.min(Long.parseLong(parts[1]), length - 1);
            }
            return start >= length || end < start ? null : new long[] { start, end };
        } catch (NumberFormatException invalidRange) { return null; }
    }

    private static void skipExactly(InputStream stream, long count) throws IOException {
        while (count > 0) {
            long skipped = stream.skip(count);
            if (skipped > 0) count -= skipped;
            else if (stream.read() == -1) throw new IOException("Unexpected end of asset");
            else count--;
        }
    }

    private static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/javascript")
            || mime.equals("application/json") || mime.equals("application/manifest+json")
            || mime.equals("image/svg+xml") || mime.equals("application/xml");
    }

    private static String mimeType(String path) {
        int dot = path.lastIndexOf('.');
        String extension = dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "html": case "htm": return "text/html";
            case "js": case "mjs": case "cjs": return "application/javascript";
            case "css": return "text/css";
            case "json": case "map": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "wasm": return "application/wasm";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "avif": return "image/avif";
            case "gif": return "image/gif";
            case "ktx": return "image/ktx";
            case "ktx2": return "image/ktx2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "mp3": return "audio/mpeg";
            case "ogg": return "audio/ogg";
            case "wav": return "audio/wav";
            case "m4a": return "audio/mp4";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            case "txt": case "atlas": case "fnt": case "glsl": case "vert": case "frag": return "text/plain";
            default:
                String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return detected == null ? "application/octet-stream" : detected;
        }
    }

    private ${dynamicBackend ? '' : 'static '}Map<String, String> headers(String mime, long length) {
        Map<String, String> values = new HashMap<>();
        values.put("Content-Type", mime + (isText(mime) ? "; charset=utf-8" : ""));
        values.put("Content-Length", Long.toString(length));
        values.put("X-Content-Type-Options", "nosniff");
        values.put("Content-Security-Policy", ${dynamicBackend ? 'backendSettings == null ? POLICY : backendPolicy(backendSettings.getBackendUrl())' : 'POLICY'});
        values.put("Cache-Control", "no-cache");
        values.put("Referrer-Policy", "no-referrer");
        return values;
    }

    private ${dynamicBackend ? '' : 'static '}WebResourceResponse error(int status, String reason, long length, boolean head) {
        byte[] bytes = reason.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Map<String, String> values = headers("text/plain", bytes.length);
        if (status == 416) values.put("Content-Range", "bytes */" + length);
        if (status == 405) values.put("Allow", "GET, HEAD");
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, values,
            new ByteArrayInputStream(head ? new byte[0] : bytes));
    }

${dynamicBackend ? dynamicBackendJava(hostingMode) : ''}
    private static final class LimitedInputStream extends FilterInputStream {
        private long remaining;
        LimitedInputStream(InputStream stream, long length) { super(stream); remaining = length; }
        @Override public int read() throws IOException {
            if (remaining == 0) return -1;
            int value = in.read();
            if (value >= 0) remaining--;
            return value;
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) return -1;
            int count = in.read(bytes, offset, (int) Math.min(length, remaining));
            if (count > 0) remaining -= count;
            return count;
        }
        @Override public long skip(long count) throws IOException {
            long skipped = in.skip(Math.min(Math.max(0, count), remaining));
            remaining -= skipped;
            return skipped;
        }
        @Override public int available() throws IOException { return (int) Math.min(in.available(), remaining); }
    }
}
`;
}

function dynamicBackendJava(hostingMode) {
    return `    private WebResourceResponse configureBackend(WebResourceRequest request) {
        if (backendSettings == null || request.isForMainFrame()) return error(403, "Forbidden", 0, false);
        if ("GET".equalsIgnoreCase(request.getMethod())) {
            return generatedResponse("application/json", backendSettings.stateJson(), false);
        }
        if (!"PUT".equalsIgnoreCase(request.getMethod())) {
            WebResourceResponse response = error(405, "Method Not Allowed", 0, false);
            response.getResponseHeaders().put("Allow", "GET, PUT");
            return response;
        }
        if (!canUpdateBackend(header(request.getRequestHeaders(), "Origin"), request.isForMainFrame())) {
            return error(403, "Forbidden", 0, false);
        }
        try {
            // WebResourceRequest does not expose request bodies, so the URL is a query parameter.
            String value = request.getUrl().getQueryParameter("url");
            if (value == null) return error(400, "Bad Request", 0, false);
            if (!backendSettings.save(value)) return error(500, "Internal Server Error", 0, false);
            return generatedResponse("application/json", backendSettings.stateJson(), false);
        } catch (IllegalArgumentException invalidBackend) {
            return error(400, "Bad Request", 0, false);
        }
    }

    private WebResourceResponse generatedResponse(String mime, String source, boolean head) {
        byte[] bytes = source.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Map<String, String> values = headers(mime, bytes.length);
        values.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, "UTF-8", 200, "OK", values,
            new ByteArrayInputStream(head ? new byte[0] : bytes));
    }

    private static boolean canUpdateBackend(String origin, boolean mainFrame) {
        return !mainFrame && "https://appassets.androidplatform.net".equals(origin);
    }

    private static String normalizeBackendUrl(String value, boolean allowCleartext) {
        if (value == null || value.isEmpty() || value.length() > 2048) throw new IllegalArgumentException("Invalid backend URL");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 32 || character == 127 || Character.isWhitespace(character)
                    || character == '<' || character == '>' || character == '"' || character == 39 || character == '\\\\') {
                throw new IllegalArgumentException("Invalid backend URL character");
            }
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ((!"https".equals(scheme) && !(allowCleartext && "http".equals(scheme)))
                    || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || uri.getPort() > 65535
                    || "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())) {
                throw new IllegalArgumentException("Backend must be an allowed HTTP(S) origin/path");
            }
            String authority = uri.getHost().toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if (port >= 0 && !("https".equals(scheme) && port == 443) && !("http".equals(scheme) && port == 80)) {
                authority += ":" + port;
            }
            String rawPath = uri.getRawPath() == null ? "" : uri.getRawPath();
            String normalized = new URI(scheme + "://" + authority + rawPath).toASCIIString();
            return normalized.endsWith("/") ? normalized.substring(0, normalized.length() - 1) : normalized;
        } catch (URISyntaxException invalidUrl) {
            throw new IllegalArgumentException("Invalid backend URL", invalidUrl);
        }
    }

    private static String backendOrigin(String value) {
        if (value.isEmpty()) return "";
        try {
            URI uri = new URI(value);
            return uri.getScheme() + "://" + uri.getRawAuthority();
        } catch (URISyntaxException invalidUrl) {
            throw new IllegalArgumentException("Invalid backend URL", invalidUrl);
        }
    }

    private static boolean isBackendOrigin(String requestUrl, String configuredBackendUrl) {
        if (requestUrl == null || configuredBackendUrl == null || configuredBackendUrl.isEmpty()) return false;
        try {
            URI request = new URI(requestUrl);
            URI allowed = new URI(configuredBackendUrl);
            if (request.getRawUserInfo() != null || request.getHost() == null || allowed.getHost() == null
                    || !allowed.getScheme().equalsIgnoreCase(request.getScheme())
                    || !allowed.getHost().equalsIgnoreCase(request.getHost())) return false;
            int defaultPort = "https".equalsIgnoreCase(allowed.getScheme()) ? 443 : 80;
            int expected = allowed.getPort() < 0 ? defaultPort : allowed.getPort();
            int actual = request.getPort() < 0 ? defaultPort : request.getPort();
            return actual == expected;
        } catch (URISyntaxException invalidUrl) { return false; }
    }

    private static String backendPolicy(String value) {
        String origin = backendOrigin(value);
        String websocket = origin.replaceFirst("^http", "ws");
        return "connect-src 'self' blob: data:" + (origin.isEmpty() ? "" : " " + origin + " " + websocket)
            + (${hostingMode === 'lan-host' ? 'true' : 'false'} ? " http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*" : "")
            + "; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
    }

    private static String quoteJson(String value) {
        StringBuilder result = new StringBuilder("\\\"");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '"' || character == '\\\\') result.append('\\\\').append(character);
            else if (character < 32 || character == 0x2028 || character == 0x2029) {
                result.append(String.format(Locale.ROOT, "\\\\u%04x", (int) character));
            } else result.append(character);
        }
        return result.append('"').toString();
    }

    private static final class BackendSettings {
        private static final String KEY = "backendUrl";
        private final SharedPreferences preferences;
        private final String defaultBackendUrl;
        private final boolean allowCleartext;
        private volatile String backendUrl;

        BackendSettings(SharedPreferences preferences, String defaultBackendUrl, boolean allowCleartext) {
            this.preferences = preferences;
            this.allowCleartext = allowCleartext;
            this.defaultBackendUrl = defaultBackendUrl.isEmpty() ? "" : normalizeBackendUrl(defaultBackendUrl, allowCleartext);
            String saved = preferences.getString(KEY, "");
            try { backendUrl = saved.isEmpty() ? this.defaultBackendUrl : normalizeBackendUrl(saved, allowCleartext); }
            catch (IllegalArgumentException invalidSavedValue) { backendUrl = this.defaultBackendUrl; }
        }

        String getBackendUrl() { return backendUrl; }

        synchronized boolean save(String value) {
            if (value == null) throw new IllegalArgumentException("Missing backend URL");
            String updated = value.isEmpty() ? defaultBackendUrl : normalizeBackendUrl(value, allowCleartext);
            SharedPreferences.Editor editor = preferences.edit();
            if (value.isEmpty()) editor.remove(KEY);
            else editor.putString(KEY, updated);
            if (!editor.commit()) return false;
            backendUrl = updated;
            return true;
        }

        synchronized String stateJson() {
            return "{\\\"backendUrl\\\":" + quoteJson(backendUrl)
                + ",\\\"defaultBackendUrl\\\":" + quoteJson(defaultBackendUrl)
                + ",\\\"dynamicBackend\\\":true,\\\"allowCleartext\\\":" + allowCleartext
                + ",\\\"assetOrigin\\\":\\\"https://appassets.androidplatform.net\\\"}";
        }

        synchronized String configScript(String configGlobal) {
            String shell = "{\\\"schemaVersion\\\":1,\\\"platform\\\":\\\"android-webview\\\"," + stateJson().substring(1);
            String source = "'use strict';\\nglobalThis.__COCOS4_ANDROID__ = Object.freeze(" + shell + ");\\n";
            if (!configGlobal.isEmpty()) {
                String target = "globalThis[" + quoteJson(configGlobal) + "]";
                source += target + " = Object.assign({}, " + target + ", {backendUrl: " + quoteJson(backendUrl) + "});\\n";
            }
            return source;
        }
    }
`;
}







