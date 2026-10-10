import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { androidProjectFiles } from '../android/templates.mjs';

const run = promisify(execFile);
const base = { appId: 'com.cocos4.game', appName: '游戏', backendUrl: 'https://game.example:7443' };
const activityPath = 'app/src/main/java/com/cocos4/game/MainActivity.java';
const clientPath = 'app/src/main/java/com/cocos4/game/LocalAssetClient.java';

test('Android project retains HTML5 as the runtime with local assets and explicit backend connectivity', () => {
    const files = androidProjectFiles(base);
    assert.equal(files.size, 11);
    assert.match(files.get('app/build.gradle'), /buildToolsVersion '35\.0\.0'/);
    assert.match(files.get('app/build.gradle'), /minSdk 26/);
    assert.match(files.get('app/build.gradle'), /release \{ debuggable false/);
    assert.match(files.get('app/src/main/AndroidManifest.xml'), /screenOrientation="sensorLandscape"/);
    assert.doesNotMatch(files.get('app/src/main/res/xml/network_security_config.xml'), /cleartextTrafficPermitted="true"/);
    const activity = files.get(activityPath);
    assert.match(activity, /setAllowFileAccess\(false\)/);
    assert.match(activity, /setAllowContentAccess\(false\)/);
    assert.match(activity, /setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/);
    assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
    assert.doesNotMatch(activity, /addJavascriptInterface|SslErrorHandler/);
    const client = files.get(clientPath);
    assert.match(client, /connect-src 'self' blob: data: https:\/\/game\.example:7443 wss:\/\/game\.example:7443/);
    assert.match(client, /"www\/" \+ path\.substring\(1\)/);
    assert.match(client, /if \(isDataSubresource\(uri\.getScheme\(\), request\.isForMainFrame\(\)\)\) return null;/);
    assert.match(client, /if \(!request\.isForMainFrame\(\) && isBackendUrl\(uri\)\) return null;/);
    assert.match(client, /return error\(404, "Not Found", 0, head\);/);
    // connect-only must not reference host transport anywhere in the generated activity.
    assert.doesNotMatch(activity, /hostController|HostRuntime/);
    assert.doesNotMatch(files.get('app/src/main/AndroidManifest.xml'), /__cocos4_host/);
});

test('lan-host activity owns and destroys the host controller while connect-only does not compile it', () => {
    const host = androidProjectFiles({ ...base, backendUrl: 'http://192.168.1.25:3000', allowCleartext: true, hostingMode: 'lan-host' });
    const hostActivity = host.get(activityPath);
    assert.match(hostActivity, /private HostRuntime\.Controller hostController;/);
    assert.match(hostActivity, /hostController = new HostRuntime\.Controller\(this, getAssets\(\), root\);/);
    assert.match(hostActivity, /hostController\.destroy\(\);/);
    assert.match(hostActivity, /new LocalAssetClient\(getAssets\(\), hostController\)/);
    assert.ok(host.has('app/src/main/java/com/cocos4/game/HostRuntime.java'));
    assert.ok(host.has('app/src/main/java/com/cocos4/game/HostWebSocket.java'));
    assert.doesNotMatch(androidProjectFiles(base).get(activityPath), /HostRuntime|hostController/);
});

test('cleartext is opt-in and limited to the configured host and origin', () => {
    assert.throws(() => androidProjectFiles({ ...base, backendUrl: 'http://10.1.2.3:8080' }), /allowCleartext/);
    const files = androidProjectFiles({ ...base, backendUrl: 'http://10.1.2.3:8080', allowCleartext: true });
    const policy = files.get('app/src/main/res/xml/network_security_config.xml');
    assert.match(policy, /<base-config cleartextTrafficPermitted="false">/);
    assert.match(policy, /<domain includeSubdomains="false">10\.1\.2\.3<\/domain>/);
    assert.match(files.get(clientPath), /connect-src 'self' blob: data: http:\/\/10\.1\.2\.3:8080 ws:\/\/10\.1\.2\.3:8080/);
    assert.match(files.get(activityPath), /MIXED_CONTENT_ALWAYS_ALLOW/);
    assert.doesNotMatch(androidProjectFiles({ ...base, allowCleartext: true }).get(activityPath), /MIXED_CONTENT_ALWAYS_ALLOW/);
});

test('dynamic backend selection is guarded by debug builds and cleartext remains opt-in', () => {
    const files = androidProjectFiles({ ...base, dynamicBackend: true, configGlobal: '__SP_CLIENT_CONFIG__' });
    const activity = files.get(activityPath);
    const client = files.get(clientPath);
    assert.match(files.get('app/build.gradle'), /gradle\.taskGraph\.whenReady/);
    assert.match(files.get('app/build.gradle'), /allTasks\.any.*toLowerCase\(java\.util\.Locale\.ROOT\)\.contains\('release'\)/);
    assert.match(files.get('app/build.gradle'), /throw new GradleException\('dynamicBackend supports debug builds only/);
    assert.doesNotMatch(androidProjectFiles(base).get('app/build.gradle'), /taskGraph\.whenReady/);
    assert.match(activity, /getSharedPreferences\("cocos4-shell", MODE_PRIVATE\)/);
    assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
    assert.match(client, /backendSettings = BuildConfig\.DEBUG \? new BackendSettings\(/);
    assert.match(client, /if \(backendSettings == null \|\| request\.isForMainFrame\(\)\) return error\(403/);
    assert.match(client, /if \("GET"\.equalsIgnoreCase\(request\.getMethod\(\)\)\)/);
    assert.match(client, /if \(!"PUT"\.equalsIgnoreCase\(request\.getMethod\(\)\)\)/);
    assert.match(client, /canUpdateBackend\(header\(request\.getRequestHeaders\(\), "Origin"\), request\.isForMainFrame\(\)\)/);
    assert.match(client, /getQueryParameter\("url"\)/);
    assert.match(client, /"\/__cocos4\/backend"\.equals\(localPath\)/);
    assert.match(client, /"\/cocos4-shell-config\.js"\.equals\(localPath\)/);
    assert.match(client, /backendSettings\.configScript\(CONFIG_GLOBAL\)/);
    assert.match(client, /backendPolicy\(backendSettings\.getBackendUrl\(\)\)/);
    assert.match(client, /isBackendOrigin\(uri\.toString\(\), backendSettings == null \? BACKEND : backendSettings\.getBackendUrl\(\)\)/);
    assert.match(client, /values\.put\("Cache-Control", "no-store"\)/);
    assert.match(files.get('app/src/main/res/xml/network_security_config.xml'), /<base-config cleartextTrafficPermitted="false">/);
    for (const backendUrl of [base.backendUrl, 'http://10.1.2.3:8080', '']) {
        const cleartext = androidProjectFiles({ ...base, backendUrl, dynamicBackend: true, allowCleartext: true });
        assert.match(cleartext.get('app/src/main/res/xml/network_security_config.xml'), /<base-config cleartextTrafficPermitted="true">/);
        assert.match(cleartext.get(activityPath), /BuildConfig\.DEBUG \? WebSettings\.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings\.MIXED_CONTENT_NEVER_ALLOW/);
    }
});

test('untrusted configuration cannot inject Android source or escape the web root', () => {
    for (const change of [
        { appId: 'com.example.class' }, { appId: 'x' }, { appId: 'com.example;bad' },
        { versionCode: 0 }, { versionCode: 2147483647 }, { minSdk: 25 }, { targetSdk: 99 }, { compileSdk: 26 },
        { appName: 'x\nvalue' }, { versionName: '1\r0' }, { orientation: 'landscape' },
        { entry: '../index.html' }, { entry: '/index.html' }, { entry: 'a/../../index.html' },
        { entry: 'a\\index.html' }, { entry: 'a//index.html' }, { entry: 'index.html?x' },
        { entry: 'file:index.html' }, { backendUrl: 'file:///index.html' },
        { backendUrl: 'https://user:password@example.com' }, { allowCleartext: 'true' },
        { dynamicBackend: 'true' }, { dynamicBackend: 1 }, { dynamicBackend: null },
        { backendUrl: 'https://example.com/api?key=value' }, { backendUrl: 'https://example.com/api?' },
        { backendUrl: 'https://example.com/api#value' }, { backendUrl: 'https://example.com/api#' },
        { backendUrl: 'https://example.com/\napi' }, { backendUrl: 'https://appassets.androidplatform.net' },
        { configGlobal: 'globalThis.x' }, { configGlobal: '__proto__' }, { configGlobal: '__COCOS4_ANDROID__' },
    ]) assert.throws(() => androidProjectFiles({ ...base, ...change }), JSON.stringify(change));
    const files = androidProjectFiles({ ...base, appName: 'A&B <game> "quote" \'apostrophe\'', versionName: "1.0'$thing", entry: '游戏/index.html' });
    assert.match(files.get('app/src/main/res/values/strings.xml'), /A&amp;B &lt;game&gt;/);
    assert.match(files.get('app/build.gradle'), /versionName '1\.0\\'\$thing'/);
    assert.match(files.get(activityPath), /%E6%B8%B8%E6%88%8F\/index\.html/);
});

const javaHome = process.env.COCOS4_ANDROID_TEST_JAVA_HOME;
const androidJar = process.env.COCOS4_ANDROID_TEST_ANDROID_JAR;
test('generated Java compiles against the Android SDK and exercises paths, byte ranges and bounded streaming', {
    skip: !(javaHome && androidJar) && 'Set COCOS4_ANDROID_TEST_JAVA_HOME and COCOS4_ANDROID_TEST_ANDROID_JAR for the Android SDK check.',
}, async t => {
    const temporaryRoot = await fs.realpath(tmpdir());
    if (process.platform === 'win32') assert.match(temporaryRoot, /^D:\\/i, 'Keep Android verification temporary files on D:');
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'cocos4-android-java-'));
    t.after(async () => {
        const absolute = await fs.realpath(directory);
        assert.equal(path.dirname(absolute), temporaryRoot);
        await fs.rm(absolute, { recursive: true, force: true });
    });
    const files = androidProjectFiles(base);
    const sources = [];
    for (const [name, source] of files) {
        if (!name.endsWith('.java')) continue;
        const destination = path.join(directory, path.basename(name));
        await fs.writeFile(destination, source);
        sources.push(destination);
    }
    const buildConfig = path.join(directory, 'BuildConfig.java');
    await fs.writeFile(buildConfig, 'package com.cocos4.game; public final class BuildConfig { public static final boolean DEBUG = false; }');
    const harness = path.join(directory, 'TemplateChecks.java');
    await fs.writeFile(harness, `
import java.lang.reflect.*;
import java.io.*;
import java.util.*;
public final class TemplateChecks {
    private static Object call(String method, Class<?>[] types, Object... values) throws Exception {
        Method target = Class.forName("com.cocos4.game.LocalAssetClient").getDeclaredMethod(method, types);
        target.setAccessible(true);
        return target.invoke(null, values);
    }
    private static void require(boolean result, String message) { if (!result) throw new AssertionError(message); }
    private static long[] range(String text, long length) throws Exception {
        return (long[]) call("parseRange", new Class<?>[] { String.class, long.class }, text, length);
    }
    public static void main(String[] args) throws Exception {
        for (String scheme : new String[] { "data", "DATA" }) {
            require((Boolean) call("isDataSubresource", new Class<?>[] { String.class, boolean.class }, scheme, false), "blocked embedded data URL");
            require(!(Boolean) call("isDataSubresource", new Class<?>[] { String.class, boolean.class }, scheme, true), "allowed data main frame");
        }
        for (String scheme : new String[] { "https", "http", "file", "content", "javascript", "blob", null })
            require(!(Boolean) call("isDataSubresource", new Class<?>[] { String.class, boolean.class }, scheme, false), "bypassed resource policy " + scheme);
        for (String value : new String[] { "/index.html", "/a/b.wasm", "/a b/中文.png" })
            require((Boolean) call("safePath", new Class<?>[] { String.class }, value), "rejected asset " + value);
        for (String value : new String[] { "index.html", "/../secret", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\\\\b", "/a" + (char) 0 })
            require(!(Boolean) call("safePath", new Class<?>[] { String.class }, value), "accepted unsafe asset " + value);
        require(Arrays.equals(range("bytes=0-3", 10), new long[] { 0, 3 }), "closed range");
        require(Arrays.equals(range("bytes=8-", 10), new long[] { 8, 9 }), "open range");
        require(Arrays.equals(range("bytes=-4", 10), new long[] { 6, 9 }), "suffix range");
        require(Arrays.equals(range("bytes=-99", 10), new long[] { 0, 9 }), "large suffix");
        require(Arrays.equals(range("bytes=8-99", 10), new long[] { 8, 9 }), "clamped range");
        for (String value : new String[] { "bytes=10-11", "bytes=4-3", "bytes=-0", "bytes=-", "bytes=0-1,4-6", "bits=0-1", "bytes=0--1", "bytes=0-9999999999999999999999", "bytes=+1-2" })
            require(range(value, 10) == null, "accepted invalid range " + value);
        require(range("bytes=0-", 0) == null, "empty file range");
        for (String[] value : new String[][] { { "engine.wasm", "application/wasm" }, { "loader.mjs", "application/javascript" }, { "game.WEBP", "image/webp" }, { "font.woff2", "font/woff2" } })
            require(value[1].equals(call("mimeType", new Class<?>[] { String.class }, value[0])), "mime " + value[0]);
        Class<?> streamClass = Class.forName("com.cocos4.game.LocalAssetClient$LimitedInputStream");
        Constructor<?> constructor = streamClass.getDeclaredConstructor(InputStream.class, long.class);
        constructor.setAccessible(true);
        try (InputStream stream = (InputStream) constructor.newInstance(new ByteArrayInputStream(new byte[] { 1, 2, 3, 4, 5 }), 3L)) {
            require(stream.read() == 1, "first byte");
            require(stream.available() == 2, "available bounded");
            require(stream.skip(1) == 1, "skip bounded");
            byte[] bytes = new byte[8];
            require(stream.read(bytes, 0, bytes.length) == 1 && bytes[0] == 3, "read bounded");
            require(stream.read() == -1 && stream.read(bytes, 0, bytes.length) == -1, "range terminates");
            require(stream.read(bytes, 0, 0) == 0, "zero read");
        }
        System.out.println("Android Java API compilation and resource helper checks passed");
    }
}
`);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const environment = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot };
    await run(path.join(javaHome, 'bin', `javac${suffix}`), [
        `-J-Djava.io.tmpdir=${temporaryRoot}`, '--release', '8', '-encoding', 'UTF-8',
        '-classpath', androidJar, '-d', directory, ...sources, buildConfig, harness,
    ], { cwd: directory, env: environment });
    const execution = await run(path.join(javaHome, 'bin', `java${suffix}`), [
        `-Djava.io.tmpdir=${temporaryRoot}`, '-classpath', [directory, androidJar].join(path.delimiter), 'TemplateChecks',
    ], { cwd: directory, env: environment });
    assert.match(execution.stdout, /resource helper checks passed/);
});

// android.jar supplies compile-time APIs; execute only pure helpers and interface proxies on the JVM.
const dynamicChecks = String.raw`
import android.content.SharedPreferences;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
public final class DynamicBackendChecks {
    private static final Class<?> CLIENT;
    private static final Class<?> SETTINGS;
    static {
        try {
            CLIENT = Class.forName("com.cocos4.game.LocalAssetClient");
            SETTINGS = Class.forName("com.cocos4.game.LocalAssetClient$BackendSettings");
        } catch (ClassNotFoundException missing) { throw new ExceptionInInitializerError(missing); }
    }
    private static Object call(String name, Class<?>[] types, Object... values) throws Exception {
        Method method = CLIENT.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(null, values);
    }
    private static Object setting(Object instance, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = SETTINGS.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(instance, values);
    }
    private static Object settings(FakePreferences preferences, String defaultUrl, boolean allowCleartext) throws Exception {
        Constructor<?> constructor = SETTINGS.getDeclaredConstructor(SharedPreferences.class, String.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(preferences.proxy, defaultUrl, allowCleartext);
    }
    private static String normalize(String value, boolean cleartext) throws Exception {
        return (String) call("normalizeBackendUrl", new Class<?>[] { String.class, boolean.class }, value, cleartext);
    }
    private static boolean allowed(String request, String backend) throws Exception {
        return (Boolean) call("isBackendOrigin", new Class<?>[] { String.class, String.class }, request, backend);
    }
    private static String current(Object instance) throws Exception {
        return (String) setting(instance, "getBackendUrl", new Class<?>[0]);
    }
    private static boolean save(Object instance, String value) throws Exception {
        return (Boolean) setting(instance, "save", new Class<?>[] { String.class }, value);
    }
    private static void invalid(String value, boolean cleartext) throws Exception {
        try { normalize(value, cleartext); throw new AssertionError("accepted invalid backend " + value); }
        catch (InvocationTargetException rejected) {
            require(rejected.getCause() instanceof IllegalArgumentException, "wrong invalid URL exception");
        }
    }
    private static void invalidSave(Object instance, String value) throws Exception {
        try { save(instance, value); throw new AssertionError("saved invalid backend " + value); }
        catch (InvocationTargetException rejected) {
            require(rejected.getCause() instanceof IllegalArgumentException, "wrong invalid save exception");
        }
    }
    private static void require(boolean result, String message) { if (!result) throw new AssertionError(message); }
    private static void emit(String name, String value) {
        System.out.println(name + "=" + Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
    }
    private static final class FakePreferences {
        final Map<String, String> values = new HashMap<>();
        final SharedPreferences proxy;
        int edits;
        int writes;
        int removes;
        int commits;
        boolean commitSuccess = true;
        FakePreferences() {
            proxy = (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(),
                new Class<?>[] { SharedPreferences.class }, (object, method, args) -> {
                    switch (method.getName()) {
                        case "getString": return values.containsKey(args[0]) ? values.get(args[0]) : args[1];
                        case "contains": return values.containsKey(args[0]);
                        case "getAll": return new HashMap<>(values);
                        case "edit": edits++; return editor();
                        default: throw new AssertionError("Unexpected preference method " + method.getName());
                    }
                });
        }
        private SharedPreferences.Editor editor() {
            Map<String, String> pending = new HashMap<>();
            Set<String> deleted = new HashSet<>();
            return (SharedPreferences.Editor) Proxy.newProxyInstance(SharedPreferences.Editor.class.getClassLoader(),
                new Class<?>[] { SharedPreferences.Editor.class }, (object, method, args) -> {
                    switch (method.getName()) {
                        case "putString": writes++; pending.put((String) args[0], (String) args[1]); return object;
                        case "remove": removes++; deleted.add((String) args[0]); return object;
                        case "commit":
                            commits++;
                            if (commitSuccess) {
                                for (String key : deleted) values.remove(key);
                                values.putAll(pending);
                            }
                            return commitSuccess;
                        default: throw new AssertionError("Unexpected editor method " + method.getName());
                    }
                });
        }
    }
    public static void main(String[] args) throws Exception {
        for (String[] value : new String[][] {
            { "HTTPS://Game.Example:443/api/", "https://game.example/api" },
            { "https://game.example:7443/api/", "https://game.example:7443/api" },
            { "https://game.example/a//b/", "https://game.example/a//b" },
            { "https://[2001:db8::1]:7443/api/", "https://[2001:db8::1]:7443/api" },
            { "https://game.example/中文/", "https://game.example/%E4%B8%AD%E6%96%87" },
            { "https://game.example/%3f%23%2e/", "https://game.example/%3f%23%2e" },
            { "HTTP://10.1.2.3:80/api/", "http://10.1.2.3/api" },
            { "http://localhost:8080/", "http://localhost:8080" }
        }) require(value[1].equals(normalize(value[0], true)), "normalize " + value[0]);
        for (String value : new String[] {
            null, "", "//example.com", "example.com", "https:", "https:///api",
            "file:///api", "data:text/plain,value", "javascript:alert(1)", "ftp://example.com", "ws://example.com",
            "https://user:secret@example.com", "https://user@example.com", "https://@example.com",
            "https://example.com/api?x=1", "https://example.com/api?", "https://example.com/api#x", "https://example.com/api#",
            "https://example.com:65536", "https://example.com:-1", " https://example.com", "https://example.com ",
            "https://example.com/a b", "https://example.com/a\tb", "https://example.com/a\nb", "https://example.com/a\rb",
            "https://example.com/a\\b", "https://example.com/<script>", "https://example.com/\"x", "https://example.com/'x",
            "https://example.com/" + (char) 0, "https://example.com/" + (char) 127,
            "https://appassets.androidplatform.net", "https://APPASSETS.androidplatform.net:7443/api"
        }) invalid(value, true);
        invalid("http://10.1.2.3:8080", false);
        StringBuilder longest = new StringBuilder("https://long.example/");
        while (longest.length() < 2048) longest.append('a');
        require(normalize(longest.toString(), false).length() == 2048, "rejected maximum URL length");
        invalid(longest.append('a').toString(), false);
        for (String origin : new String[] {
            null, "", "null", "http://appassets.androidplatform.net", "https://APPASSETS.androidplatform.net",
            "https://appassets.androidplatform.net/", "https://appassets.androidplatform.net:443",
            "https://appassets.androidplatform.net:444", "https://appassets.androidplatform.net.",
            "https://sub.appassets.androidplatform.net", "https://appassets.androidplatform.net.evil"
        }) require(!(Boolean) call("canUpdateBackend", new Class<?>[] { String.class, boolean.class }, origin, false), "accepted update origin " + origin);
        require((Boolean) call("canUpdateBackend", new Class<?>[] { String.class, boolean.class }, "https://appassets.androidplatform.net", false), "blocked local update");
        require(!(Boolean) call("canUpdateBackend", new Class<?>[] { String.class, boolean.class }, "https://appassets.androidplatform.net", true), "allowed main-frame update");
        String active = normalize("https://Current.Example:443/prefix/", false);
        require("https://current.example".equals(call("backendOrigin", new Class<?>[] { String.class }, active)), "origin retained prefix");
        for (String request : new String[] { "https://current.example/api?x=1#value", "HTTPS://CURRENT.example:443/another", "https://current.example" })
            require(allowed(request, active), "blocked active origin " + request);
        for (String request : new String[] {
            null, "", "not a URL", "https://old.example", "http://current.example", "https://current.example:444",
            "https://sub.current.example", "https://current.example.evil", "https://user@current.example", "file:///api"
        }) require(!allowed(request, active), "allowed other origin " + request);
        require(!allowed("https://current.example", "") && !allowed("https://current.example", null), "offline allowed network");
        require(allowed("http://localhost:80/api?q=x", normalize("http://localhost", true)), "HTTP effective port");
        require(!allowed("http://localhost:8080", normalize("http://localhost", true)), "HTTP wrong port");
        String suffix = "; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'";
        require(("connect-src 'self' blob: data: https://current.example wss://current.example" + suffix).equals(call("backendPolicy", new Class<?>[] { String.class }, active)), "HTTPS policy");
        require(("connect-src 'self' blob: data: http://localhost:8080 ws://localhost:8080" + suffix).equals(call("backendPolicy", new Class<?>[] { String.class }, normalize("http://localhost:8080/api", true))), "HTTP policy");
        require(("connect-src 'self' blob: data:" + suffix).equals(call("backendPolicy", new Class<?>[] { String.class }, "")), "offline policy");
        FakePreferences preferences = new FakePreferences();
        String defaultUrl = "https://default.example/api";
        Object instance = settings(preferences, "HTTPS://Default.Example:443/api/", false);
        require(defaultUrl.equals(current(instance)), "default configuration");
        require(preferences.edits == 0, "initialization writes settings");
        emit("STATE_INITIAL", (String) setting(instance, "stateJson", new Class<?>[0]));
        require(save(instance, "HTTPS://Changed.Example:7443/service/"), "save failed");
        String changed = "https://changed.example:7443/service";
        require(changed.equals(current(instance)) && changed.equals(preferences.values.get("backendUrl")), "normalized value not persisted");
        require(changed.equals(current(settings(preferences, defaultUrl, false))), "settings did not survive reconstruction");
        require(!allowed("https://default.example/api", current(instance)) && allowed("https://changed.example:7443/any?x=1", current(instance)), "request policy retained old backend");
        emit("STATE_CHANGED", (String) setting(instance, "stateJson", new Class<?>[0]));
        emit("SCRIPT_CHANGED", (String) setting(instance, "configScript", new Class<?>[] { String.class }, "__SP_CLIENT_CONFIG__"));
        emit("SCRIPT_NO_GLOBAL", (String) setting(instance, "configScript", new Class<?>[] { String.class }, ""));
        emit("SCRIPT_TARGET", (String) setting(instance, "configScript", new Class<?>[] { String.class }, "safe\"]; globalThis.INJECTED = true; //"));
        int edits = preferences.edits;
        int writes = preferences.writes;
        int commits = preferences.commits;
        for (String value : new String[] { null, "file:///bad", "http://insecure.example", "https://invalid.example?x=1" }) invalidSave(instance, value);
        require(preferences.edits == edits && preferences.writes == writes && preferences.commits == commits && changed.equals(current(instance)), "invalid save changed preferences");
        preferences.commitSuccess = false;
        require(!save(instance, "https://failed.example") && changed.equals(current(instance)), "failed commit changed active URL");
        require(!save(instance, "") && changed.equals(current(instance)), "failed reset changed active URL");
        preferences.commitSuccess = true;
        int removes = preferences.removes;
        require(save(instance, "") && defaultUrl.equals(current(instance)), "reset did not restore default");
        require(preferences.removes == removes + 1 && !preferences.values.containsKey("backendUrl"), "reset retained saved override");
        require(defaultUrl.equals(current(settings(preferences, defaultUrl, false))), "reset did not survive reconstruction");
        emit("STATE_RESET", (String) setting(instance, "stateJson", new Class<?>[0]));
        preferences.values.put("backendUrl", "https://Saved.Example/api/");
        require("https://saved.example/api".equals(current(settings(preferences, defaultUrl, false))), "valid saved configuration ignored");
        preferences.values.put("backendUrl", "file:///bad");
        require(defaultUrl.equals(current(settings(preferences, defaultUrl, false))), "invalid saved configuration did not fall back");
        preferences.values.put("backendUrl", "http://localhost:8080/api");
        require(defaultUrl.equals(current(settings(preferences, defaultUrl, false))), "unapproved saved HTTP configuration used");
        require("http://localhost:8080/api".equals(current(settings(preferences, defaultUrl, true))), "approved saved HTTP configuration ignored");
        Object offline = settings(new FakePreferences(), "", false);
        require(current(offline).isEmpty(), "empty default added network origin");
        emit("STATE_OFFLINE", (String) setting(offline, "stateJson", new Class<?>[0]));
        Object http = settings(new FakePreferences(), "", true);
        require(save(http, "HTTP://10.1.2.3:80/api/"), "approved HTTP save rejected");
        emit("STATE_HTTP", (String) setting(http, "stateJson", new Class<?>[0]));
        String quoted = "quote\"\\\n\r\t" + (char) 0 + (char) 0x2028 + (char) 0x2029;
        emit("JSON_VALUE", quoted);
        emit("JSON_QUOTED", (String) call("quoteJson", new Class<?>[] { String.class }, quoted));
        System.out.println("Dynamic backend URL, origin, persistence and script helper checks passed");
    }
}
`;

async function compileDynamicChecks(t, debug) {
    const temporaryRoot = await fs.realpath(tmpdir());
    if (process.platform === 'win32') assert.match(temporaryRoot, /^D:\\/i, 'Keep Android verification temporary files on D:');
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'cocos4-android-dynamic-java-'));
    t.after(async () => {
        const absolute = await fs.realpath(directory);
        assert.equal(path.dirname(absolute), temporaryRoot);
        await fs.rm(absolute, { recursive: true, force: true });
    });
    const sources = [];
    const files = androidProjectFiles({ ...base, dynamicBackend: true, allowCleartext: true, configGlobal: '__SP_CLIENT_CONFIG__' });
    for (const [name, source] of files) {
        if (!name.endsWith('.java')) continue;
        const destination = path.join(directory, path.basename(name));
        await fs.writeFile(destination, source);
        sources.push(destination);
    }
    const buildConfig = path.join(directory, 'BuildConfig.java');
    await fs.writeFile(buildConfig, `package com.cocos4.game; public final class BuildConfig { public static final boolean DEBUG = ${debug}; }`);
    const harness = path.join(directory, 'DynamicBackendChecks.java');
    await fs.writeFile(harness, dynamicChecks);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const environment = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot };
    await run(path.join(javaHome, 'bin', `javac${suffix}`), [
        `-J-Djava.io.tmpdir=${temporaryRoot}`, '--release', '8', '-encoding', 'UTF-8',
        '-classpath', androidJar, '-d', directory, ...sources, buildConfig, harness,
    ], { cwd: directory, env: environment });
    const execution = await run(path.join(javaHome, 'bin', `java${suffix}`), [
        `-Djava.io.tmpdir=${temporaryRoot}`, '-classpath', [directory, androidJar].join(path.delimiter), 'DynamicBackendChecks',
    ], { cwd: directory, env: environment });
    assert.match(execution.stdout, /Dynamic backend URL, origin, persistence and script helper checks passed/);
    return Object.fromEntries(execution.stdout.split(/\r?\n/).flatMap(line => {
        const match = /^([A-Z_]+)=(.*)$/.exec(line);
        return match ? [[match[1], Buffer.from(match[2], 'base64').toString('utf8')]] : [];
    }));
}

test('dynamic Android Java compiles with debug and release constants and verifies backend configuration helpers', {
    skip: !(javaHome && androidJar) && 'Set COCOS4_ANDROID_TEST_JAVA_HOME and COCOS4_ANDROID_TEST_ANDROID_JAR for the Android SDK check.',
}, async t => {
    for (const debug of [false, true]) await t.test(`BuildConfig.DEBUG = ${debug}, allowCleartext = true`, async child => {
        const output = await compileDynamicChecks(child, debug);
        const state = (backendUrl, defaultBackendUrl = 'https://default.example/api', allowCleartext = false) => ({
            backendUrl, defaultBackendUrl, dynamicBackend: true, allowCleartext,
            assetOrigin: 'https://appassets.androidplatform.net',
        });
        const changed = state('https://changed.example:7443/service');
        assert.deepEqual(JSON.parse(output.STATE_INITIAL), state('https://default.example/api'));
        assert.deepEqual(JSON.parse(output.STATE_CHANGED), changed);
        assert.deepEqual(JSON.parse(output.STATE_RESET), state('https://default.example/api'));
        assert.deepEqual(JSON.parse(output.STATE_OFFLINE), state('', ''));
        assert.deepEqual(JSON.parse(output.STATE_HTTP), state('http://10.1.2.3/api', '', true));
        assert.equal(JSON.parse(output.JSON_QUOTED), output.JSON_VALUE);
        assert.doesNotMatch(output.JSON_QUOTED, /[\u0000-\u001f\u2028\u2029]/);
        const context = { __SP_CLIENT_CONFIG__: { backendUrl: 'https://old.example', buildUrl: '/client-build.json' } };
        vm.runInNewContext(output.SCRIPT_CHANGED, context);
        assert.deepEqual(JSON.parse(JSON.stringify(context.__COCOS4_ANDROID__)), {
            schemaVersion: 1, platform: 'android-webview', ...changed,
        });
        assert.equal(Object.isFrozen(context.__COCOS4_ANDROID__), true);
        assert.deepEqual(JSON.parse(JSON.stringify(context.__SP_CLIENT_CONFIG__)), {
            backendUrl: changed.backendUrl, buildUrl: '/client-build.json',
        });
        const withoutGlobal = {};
        vm.runInNewContext(output.SCRIPT_NO_GLOBAL, withoutGlobal);
        assert.deepEqual(Object.keys(withoutGlobal), ['__COCOS4_ANDROID__']);
        const escapedTarget = {};
        vm.runInNewContext(output.SCRIPT_TARGET, escapedTarget);
        assert.equal(escapedTarget.INJECTED, undefined);
        assert.equal(escapedTarget['safe"]; globalThis.INJECTED = true; //'].backendUrl, changed.backendUrl);
    });
});
