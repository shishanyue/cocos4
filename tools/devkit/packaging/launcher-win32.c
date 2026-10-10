#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0a00
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Windows host tooling only. Node is located beside this executable; no shell,
 * PATH search, runtime compilation or executable argument passthrough is used.
 * Unlike the Linux syscall launcher, PE loading trusts Windows system DLLs. */
enum { COMMAND_CHARS = 32767, PATH_CHARS = 32768, ENV_CHARS = 131072 };
int _dowildcard = 0;

static int append(wchar_t *buffer, size_t *length, wchar_t value) {
    if (*length >= COMMAND_CHARS - 1) return 0;
    buffer[(*length)++] = value; buffer[*length] = 0;
    return 1;
}
static int command_line(int argc, wchar_t **argv, wchar_t *buffer) {
    size_t length = 0;
    for (int i = 0; i < argc; ++i) {
        if (i && !append(buffer, &length, L' ')) return 0;
        if (!append(buffer, &length, L'"')) return 0;
        const wchar_t *arg = argv[i];
        for (;;) {
            size_t slashes = 0;
            while (*arg == L'\\') { ++slashes; ++arg; }
            size_t count = (*arg == L'"' || !*arg) ? slashes * 2 : slashes;
            for (size_t j = 0; j < count; ++j) if (!append(buffer, &length, L'\\')) return 0;
            if (!*arg) break;
            if (*arg == L'"' && !append(buffer, &length, L'\\')) return 0;
            if (!append(buffer, &length, *arg++)) return 0;
        }
        if (!append(buffer, &length, L'"')) return 0;
    }
    return 1;
}
static int compare(const void *left, const void *right) {
    return _wcsicmp(*(const wchar_t *const *)left, *(const wchar_t *const *)right);
}
static int blocked(const wchar_t *entry) {
    const wchar_t *deny[] = { L"NODE_", L"LD_", L"DYLD_", L"BUN_", L"npm_", L"OPENSSL_",
        L"SSLKEYLOGFILE=", L"SystemRoot=", L"WINDIR=", L"=", NULL };
    for (size_t i = 0; deny[i]; ++i) if (!_wcsnicmp(entry, deny[i], wcslen(deny[i]))) return 1;
    return 0;
}
static wchar_t *environment(void) {
    wchar_t windows[PATH_CHARS], root[PATH_CHARS + 12], windir[PATH_CHARS + 8];
    UINT size = GetSystemWindowsDirectoryW(windows, PATH_CHARS);
    if (!size || size >= PATH_CHARS) return NULL;
    wcscpy(root, L"SystemRoot="); wcscat(root, windows);
    wcscpy(windir, L"WINDIR="); wcscat(windir, windows);
    wchar_t *inherited = GetEnvironmentStringsW();
    if (!inherited) return NULL;
    wchar_t **entries = calloc(ENV_CHARS, sizeof(wchar_t *));
    wchar_t *out = calloc(ENV_CHARS, sizeof(wchar_t));
    size_t count = 0, length = wcslen(root) + wcslen(windir) + 3;
    if (!entries || !out) goto failed;
    entries[count++] = root; entries[count++] = windir;
    for (wchar_t *entry = inherited; *entry; entry += wcslen(entry) + 1) {
        if (blocked(entry)) continue;
        size_t chars = wcslen(entry) + 1;
        if (chars >= ENV_CHARS - length || count >= ENV_CHARS - 1) goto failed;
        entries[count++] = entry; length += chars;
    }
    qsort(entries, count, sizeof(wchar_t *), compare);
    wchar_t *next = out;
    for (size_t i = 0; i < count; ++i) {
        size_t chars = wcslen(entries[i]) + 1;
        memcpy(next, entries[i], chars * sizeof(wchar_t)); next += chars;
    }
    free(entries); FreeEnvironmentStringsW(inherited);
    return out;
failed:
    free(entries); free(out); FreeEnvironmentStringsW(inherited);
    return NULL;
}
static HANDLE standard_handle(DWORD id, DWORD access) {
    HANDLE source = GetStdHandle(id), duplicate = NULL;
    if (source && source != INVALID_HANDLE_VALUE
        && DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) return duplicate;
    SECURITY_ATTRIBUTES attributes = { sizeof(attributes), NULL, TRUE };
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, NULL);
}
static BOOL WINAPI console_handler(DWORD event) {
    /* Node receives the same console event. Keep its Job alive while it runs
     * normal interrupt cleanup; forced close/death still closes the Job. */
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}
static int start(const wchar_t *node, wchar_t **args, int argc, wchar_t *env, int *completed) {
    int result = 72;
    HANDLE job = NULL, inherited[3] = { NULL, NULL, NULL };
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    wchar_t *command = calloc(COMMAND_CHARS, sizeof(wchar_t));
    PROCESS_INFORMATION process = {0};
    SIZE_T bytes = 0;
    if (!command || !command_line(argc, args, command) || !SetConsoleCtrlHandler(console_handler, TRUE)
        || !SetDllDirectoryW(L"")) goto done;
    job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto done;
    inherited[0] = standard_handle(STD_INPUT_HANDLE, GENERIC_READ);
    inherited[1] = standard_handle(STD_OUTPUT_HANDLE, GENERIC_WRITE);
    inherited[2] = standard_handle(STD_ERROR_HANDLE, GENERIC_WRITE);
    for (size_t i = 0; i < 3; ++i) if (!inherited[i] || inherited[i] == INVALID_HANDLE_VALUE) goto done;
    InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
    attributes = malloc(bytes);
    if (!attributes || !InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) { free(attributes); attributes = NULL; goto done; }
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)
        || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) goto done;
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes;
    /* Creation-time Job association closes the launch-to-assignment escape.
     * The sole Job handle is not inherited; forced launcher death kills its tree. */
    if (!CreateProcessW(node, command, NULL, NULL, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, env, NULL, &startup.StartupInfo, &process)) goto done;
    for (size_t i = 0; i < 3; ++i) { CloseHandle(inherited[i]); inherited[i] = NULL; }
    DWORD status = 72;
    if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &status)) {
        result = (int)status; *completed = 1;
    }
done:
    if (process.hThread) CloseHandle(process.hThread);
    if (process.hProcess) CloseHandle(process.hProcess);
    if (attributes) { DeleteProcThreadAttributeList(attributes); free(attributes); }
    for (size_t i = 0; i < 3; ++i) if (inherited[i] && inherited[i] != INVALID_HANDLE_VALUE) CloseHandle(inherited[i]);
    if (job) CloseHandle(job);
    free(command);
    return result;
}
int wmain(int argc, wchar_t **argv) {
    wchar_t executable[PATH_CHARS], node[PATH_CHARS], entry[PATH_CHARS];
    DWORD length = GetModuleFileNameW(NULL, executable, PATH_CHARS);
    int result = 72, completed = 0;
    if (argc > 0 && argc < 32765 && length && length < PATH_CHARS) {
        wchar_t *separator = wcsrchr(executable, L'\\');
        if (separator && (size_t)(separator - executable) + 32 < PATH_CHARS) {
            separator[1] = 0;
            wcscpy(node, executable); wcscat(node, L"runtime\\node.exe");
            wcscpy(entry, executable); wcscat(entry, L"app\\launch.mjs");
            wchar_t **args = calloc((size_t)argc + 3, sizeof(wchar_t *));
            wchar_t *env = environment();
            if (args && env) {
                args[0] = node; args[1] = L"--no-global-search-paths"; args[2] = entry;
                for (int i = 1; i < argc; ++i) args[i + 2] = argv[i];
                result = start(node, args, argc + 2, env, &completed);
            }
            free(args); free(env);
        }
    }
    if (!completed) {
        const char error[] = "cocos4: bundled Node could not start; verify this Windows x64 package and host.\n";
        DWORD written;
        WriteFile(GetStdHandle(STD_ERROR_HANDLE), error, sizeof(error) - 1, &written, NULL);
    }
    return result;
}
