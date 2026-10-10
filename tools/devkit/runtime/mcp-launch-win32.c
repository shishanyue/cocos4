#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0a00
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Fixed MCP launch protocol. Node and CLI paths come from the trusted kit; no shell,
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
static HANDLE standard_handle(DWORD id, DWORD access) {
    HANDLE source = GetStdHandle(id), duplicate = NULL;
    if (source && source != INVALID_HANDLE_VALUE
        && DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) return duplicate;
    SECURITY_ATTRIBUTES attributes = { sizeof(attributes), NULL, TRUE };
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, NULL);
}
static BOOL WINAPI console_handler(DWORD event) {
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
static int reserved(const wchar_t *part, size_t length) {
    size_t stem = 0;
    while (stem < length && part[stem] != L'.') ++stem;
    if (stem == 3 && (!_wcsnicmp(part, L"CON", 3) || !_wcsnicmp(part, L"PRN", 3)
        || !_wcsnicmp(part, L"AUX", 3) || !_wcsnicmp(part, L"NUL", 3))) return 1;
    if (stem == 4 && (!_wcsnicmp(part, L"COM", 3) || !_wcsnicmp(part, L"LPT", 3))
        && ((part[3] >= L'1' && part[3] <= L'9') || part[3] == 0xb9 || part[3] == 0xb2 || part[3] == 0xb3)) return 1;
    return 0;
}
static int absolute(const wchar_t *text) {
    size_t length = wcslen(text), part = 3;
    if (length < 3 || length > 4096 || !((text[0] >= L'A' && text[0] <= L'Z')
        || (text[0] >= L'a' && text[0] <= L'z')) || text[1] != L':' || text[2] != L'\\') return 0;
    for (size_t i = 3; i <= length; ++i) {
        wchar_t value = text[i];
        if (value && (value < 32 || value == 127 || wcschr(L"/:*?\"<>|[]{}", value))) return 0;
        if (!value || value == L'\\') {
            if (length == 3) return 1;
            if (part == i || text[i - 1] == L'.' || text[i - 1] == L' ' || reserved(text + part, i - part)) return 0;
            part = i + 1;
        }
    }
    return 1;
}
static wchar_t *environment(const wchar_t *session) {
    wchar_t windows[PATH_CHARS];
    UINT size = GetSystemWindowsDirectoryW(windows, PATH_CHARS);
    if (!size || size >= PATH_CHARS || !absolute(windows)) return NULL;
    /* Case-insensitively sorted Unicode block, with no inherited provider,
     * OpenCode, Node, loader, certificate or process-injection variables. */
    const wchar_t *keys[] = { L"APPDATA=", L"HOME=", L"LANG=", L"LC_ALL=", L"LOCALAPPDATA=",
        L"PATH=", L"SystemRoot=", L"TEMP=", L"TMP=", L"TMPDIR=", L"USERPROFILE=", L"WINDIR=" };
    const wchar_t *values[] = { session, session, L"C.UTF-8", L"C.UTF-8", session,
        L"", windows, session, session, session, session, windows };
    const wchar_t *suffixes[] = { L"\\mcp-home", L"\\mcp-home", L"", L"", L"\\mcp-home", L"", L"",
        L"\\tmp", L"\\tmp", L"\\tmp", L"\\mcp-home", L"" };
    wchar_t *block = calloc(ENV_CHARS, sizeof(wchar_t)), *next = block;
    if (!block) return NULL;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); ++i) {
        size_t chars = wcslen(keys[i]) + wcslen(values[i]) + wcslen(suffixes[i]) + 1;
        if (chars >= ENV_CHARS - (size_t)(next - block)) { free(block); return NULL; }
        wcscpy(next, keys[i]); wcscat(next, values[i]); wcscat(next, suffixes[i]); next += chars;
    }
    return block;
}
static void diagnostic(const char *message) {
    DWORD written;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, (DWORD)strlen(message), &written, NULL);
}
int wmain(int argc, wchar_t **argv) {
    const wchar_t *keys[] = { L"--node", L"--cli", L"--session", L"--sdk-root", L"--workspace", L"--state-root", L"--mode", L"--preview" };
    int valid = argc == 18;
    if (valid) {
        valid = !wcscmp(argv[1], L"cocos4-mcp-launch-v1");
        for (int i = 0; i < 8; ++i) if (wcscmp(argv[2 + i * 2], keys[i])) valid = 0;
        for (int i = 0; i < 6; ++i) if (!absolute(argv[3 + i * 2])) valid = 0;
        if (wcscmp(argv[15], L"read-only") && wcscmp(argv[15], L"develop")) valid = 0;
        if (wcscmp(argv[17], L"false") && (wcscmp(argv[15], L"develop") || wcscmp(argv[17], L"true"))) valid = 0;
    }
    if (!valid) { diagnostic("cocos4: invalid fixed MCP launch arguments.\n"); return 64; }
    wchar_t *args[] = { argv[3], L"--no-global-search-paths", argv[5], L"mcp", L"--sdk-root", argv[9],
        L"--workspace", argv[11], L"--state-root", argv[13], L"--mode", argv[15], L"--preview", argv[17] };
    wchar_t *env = environment(argv[7]);
    int completed = 0;
    int result = env ? start(argv[3], args, (int)(sizeof(args) / sizeof(args[0])), env, &completed) : 72;
    free(env);
    if (!completed) diagnostic("cocos4: trusted MCP Node could not start; verify the complete Windows x64 kit.\n");
    return result;
}
