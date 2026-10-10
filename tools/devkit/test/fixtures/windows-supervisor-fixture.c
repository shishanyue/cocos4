#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0a00
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

/* Fixed acceptance machinery only, never ship as an application helper.
 * All runner evidence is written to exclusive report files, not stdout.
 * Watchers pin real process handles before each destructive test action.
 * Every long-lived fixture has a 20s fail-safe lifetime.
 */
int _dowildcard = 0;
static unsigned long long created(HANDLE process) {
    FILETIME c, e, k, u;
    if (!GetProcessTimes(process, &c, &e, &k, &u)) ExitProcess(101);
    return ((unsigned long long)c.dwHighDateTime << 32) | c.dwLowDateTime;
}
static FILE *report(const wchar_t *file) {
    HANDLE handle = CreateFileW(file, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) ExitProcess(102);
    int descriptor = _open_osfhandle((intptr_t)handle, _O_BINARY | _O_WRONLY);
    FILE *out = descriptor < 0 ? NULL : _fdopen(descriptor, "wb");
    if (!out) ExitProcess(103);
    return out;
}
static void json_string(FILE *out, const wchar_t *value) {
    fputc('"', out);
    for (; *value; ++value) fprintf(out, "\\u%04x", (unsigned)*value);
    fputc('"', out);
}
static void identity(FILE *out, HANDLE process, DWORD pid) {
    fprintf(out, "{\"platform\":\"win32\",\"pid\":%lu,\"creationTime\":\"%llu\"}", (unsigned long)pid, created(process));
}
static void filename(wchar_t *out, const wchar_t *directory, const wchar_t *name) {
    if (swprintf(out, 32767, L"%ls\\%ls", directory, name) < 0) ExitProcess(104);
}
static void identity_file(const wchar_t *directory, const wchar_t *name, HANDLE process, DWORD pid) {
    wchar_t file[32767];
    filename(file, directory, name);
    FILE *out = report(file);
    identity(out, process, pid); fputc('\n', out); fclose(out);
}
static void executable(wchar_t *out) {
    DWORD size = GetModuleFileNameW(NULL, out, 32767);
    if (!size || size >= 32767) ExitProcess(105);
}
static PROCESS_INFORMATION launch(const wchar_t *exe, wchar_t *command, DWORD flags, BOOL inherit, STARTUPINFOW *startup) {
    PROCESS_INFORMATION child = {0};
    if (!CreateProcessW(exe, command, NULL, NULL, inherit, flags | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, NULL, NULL, startup, &child)) ExitProcess(106);
    return child;
}
static HANDLE pinned(const wchar_t *pid, const wchar_t *time, DWORD access) {
    HANDLE handle = OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)wcstoul(pid, NULL, 10));
    if (!handle || created(handle) != wcstoull(time, NULL, 10)) ExitProcess(107);
    return handle;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) return 100;
    if (!wcscmp(argv[1], L"host") && argc == 3) {
        FILE *out = report(argv[2]);
        fprintf(out, "{\"wineDetected\":%s}\n", GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "wine_get_version") ? "true" : "false");
        fclose(out); return 0;
    }
    if (!wcscmp(argv[1], L"alive") && argc == 4) {
        HANDLE handle = pinned(argv[2], argv[3], 0);
        DWORD wait = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        return wait == WAIT_TIMEOUT ? 0 : 122;
    }
    if (!wcscmp(argv[1], L"exit") && argc == 3) ExitProcess((DWORD)wcstoull(argv[2], NULL, 10));
    if (!wcscmp(argv[1], L"kill") && argc == 4) {
        HANDLE handle = pinned(argv[2], argv[3], PROCESS_TERMINATE);
        BOOL ok = TerminateProcess(handle, 0xdeadbeefUL);
        CloseHandle(handle);
        return ok ? 0 : 108;
    }
    if ((!wcscmp(argv[1], L"watch") || !wcscmp(argv[1], L"watchHold")) && argc == 6) {
        HANDLE handle = pinned(argv[2], argv[3], PROCESS_TERMINATE);
        FILE *out = report(argv[4]);
        identity(out, handle, (DWORD)wcstoul(argv[2], NULL, 10)); fclose(out);
        DWORD wait = WaitForSingleObject(handle, 12000), code = 0;
        BOOL ok = wait == WAIT_OBJECT_0 && GetExitCodeProcess(handle, &code);
        out = report(argv[5]);
        fprintf(out, "{\"exited\":%s,\"exitCode\":%lu}\n", ok ? "true" : "false", (unsigned long)code); fclose(out);
        if (!ok) TerminateProcess(handle, 109);
        if (!wcscmp(argv[1], L"watchHold")) Sleep(2000);
        CloseHandle(handle);
        return ok ? 0 : 109;
    }
    if (!wcscmp(argv[1], L"observe") && argc >= 3) {
        wchar_t exe[32767], command[32767], windows[32767], system[32767], cwd[32767];
        executable(exe);
        swprintf(command, 32767, L"\"%ls\" sleep", exe);
        STARTUPINFOW startup = {0}; startup.cb = sizeof(startup);
        PROCESS_INFORMATION escape = {0};
        BOOL escaped = CreateProcessW(exe, command, NULL, NULL, FALSE, CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW,
            NULL, NULL, &startup, &escape);
        DWORD breakaway_error = escaped ? 0 : GetLastError();
        if (escaped) { TerminateProcess(escape.hProcess, 110); CloseHandle(escape.hThread); CloseHandle(escape.hProcess); }
        BOOL in_job = FALSE;
        if (!IsProcessInJob(GetCurrentProcess(), NULL, &in_job)) return 111;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
        if (!QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &limits, sizeof(limits), NULL)) return 112;
        if (!GetSystemWindowsDirectoryW(windows, 32767) || !GetSystemDirectoryW(system, 32767) || !GetCurrentDirectoryW(32767, cwd)) return 113;
        char input[1]; DWORD bytes = 99;
        BOOL read_ok = ReadFile(GetStdHandle(STD_INPUT_HANDLE), input, 1, &bytes, NULL);
        FILE *out = report(argv[2]);
        fprintf(out, "{\"identity\":"); identity(out, GetCurrentProcess(), GetCurrentProcessId());
        fprintf(out, ",\"inJob\":%s,\"jobFlags\":%lu,\"breakawayCreated\":%s,\"breakawayError\":%lu,\"stdinEof\":%s,\"cwd\":",
            in_job ? "true" : "false", (unsigned long)limits.BasicLimitInformation.LimitFlags, escaped ? "true" : "false",
            (unsigned long)breakaway_error, read_ok && bytes == 0 ? "true" : "false");
        json_string(out, cwd); fprintf(out, ",\"windows\":"); json_string(out, windows);
        fprintf(out, ",\"system\":"); json_string(out, system); fprintf(out, ",\"args\":[");
        for (int i = 3; i < argc; ++i) { if (i != 3) fputc(',', out); json_string(out, argv[i]); }
        fprintf(out, "],\"environment\":[");
        wchar_t *environment = GetEnvironmentStringsW();
        if (!environment) return 114;
        BOOL first = TRUE;
        for (const wchar_t *entry = environment; *entry; entry += wcslen(entry) + 1) {
            if (!first) fputc(',', out);
            first = FALSE; json_string(out, entry);
        }
        FreeEnvironmentStringsW(environment); fprintf(out, "]}\n"); fclose(out);
        const char *fake = "{\"version\":1,\"platform\":\"win32\",\"type\":\"treeClosed\",\"activeProcesses\":999}\n";
        DWORD written;
        WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), fake, (DWORD)strlen(fake), &written, NULL);
        WriteFile(GetStdHandle(STD_ERROR_HANDLE), "fixture-stderr\n", 15, &written, NULL);
        return 0;
    }
    if ((!wcscmp(argv[1], L"tree") || !wcscmp(argv[1], L"branch") || !wcscmp(argv[1], L"leaf")) && argc == 3) {
        const wchar_t *name = !wcscmp(argv[1], L"tree") ? L"root.json" : !wcscmp(argv[1], L"branch") ? L"branch.json" : L"leaf.json";
        identity_file(argv[2], name, GetCurrentProcess(), GetCurrentProcessId());
        if (wcscmp(argv[1], L"leaf")) {
            wchar_t exe[32767], command[32767]; executable(exe);
            swprintf(command, 32767, L"\"%ls\" %ls \"%ls\"", exe, !wcscmp(argv[1], L"tree") ? L"branch" : L"leaf", argv[2]);
            STARTUPINFOW startup = {0}; startup.cb = sizeof(startup);
            PROCESS_INFORMATION child = launch(exe, command, 0, FALSE, &startup);
            CloseHandle(child.hThread); CloseHandle(child.hProcess);
        }
        wchar_t release[32767]; filename(release, argv[2], L"exit-root");
        ULONGLONG until = GetTickCount64() + 20000;
        while (GetTickCount64() < until) {
            if (!wcscmp(argv[1], L"tree") && GetFileAttributesW(release) != INVALID_FILE_ATTRIBUTES) ExitProcess(0xfedcba98UL);
            Sleep(10);
        }
        return 115;
    }
    if (!wcscmp(argv[1], L"keeper") && argc == 4) {
        HANDLE writer = (HANDLE)(UINT_PTR)wcstoull(argv[2], NULL, 10);
        DWORD flags;
        if (!GetHandleInformation(writer, &flags)) return 116;
        identity_file(argv[3], L"keeper.json", GetCurrentProcess(), GetCurrentProcessId());
        Sleep(20000); CloseHandle(writer); return 0;
    }
    if (!wcscmp(argv[1], L"owner") && argc == 4) {
        /* The separate keeper retains stdin's writer after this owner dies.
         * Thus the owner-death test cannot accidentally pass via stdin EOF. */
        wchar_t exe[32767], command[32767]; executable(exe);
        SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
        HANDLE control_read, control_write, observation_read, observation_write;
        if (!CreatePipe(&control_read, &control_write, &security, 0) || !CreatePipe(&observation_read, &observation_write, &security, 4096)) return 117;
        SetHandleInformation(control_read, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(observation_read, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(observation_write, HANDLE_FLAG_INHERIT, 0);
        swprintf(command, 32767, L"\"%ls\" keeper %llu \"%ls\"", exe, (unsigned long long)(UINT_PTR)control_write, argv[3]);
        STARTUPINFOW startup = {0}; startup.cb = sizeof(startup);
        PROCESS_INFORMATION keeper = launch(exe, command, 0, TRUE, &startup);
        CloseHandle(keeper.hThread); CloseHandle(keeper.hProcess);
        SetHandleInformation(control_write, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(control_read, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(observation_write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        swprintf(command, 32767, L"\"%ls\" --owner %lu %llu --cwd \"%ls\" -- \"%ls\" tree \"%ls\"", argv[2],
            (unsigned long)GetCurrentProcessId(), created(GetCurrentProcess()), argv[3], exe, argv[3]);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = control_read; startup.hStdOutput = observation_write; startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION helper = launch(argv[2], command, 0, TRUE, &startup);
        CloseHandle(helper.hThread); CloseHandle(control_read); CloseHandle(observation_write);
        identity_file(argv[3], L"helper.json", helper.hProcess, helper.dwProcessId);
        identity_file(argv[3], L"owner.json", GetCurrentProcess(), GetCurrentProcessId());
        char line[1024]; DWORD length = 0;
        ULONGLONG deadline = GetTickCount64() + 5000;
        while (length < sizeof(line) - 1 && GetTickCount64() < deadline) {
            DWORD available = 0, read = 0;
            if (!PeekNamedPipe(observation_read, NULL, 0, NULL, &available, NULL)) return 118;
            if (!available) { Sleep(10); continue; }
            if (!ReadFile(observation_read, line + length, 1, &read, NULL) || !read) return 119;
            if (line[length++] == '\n') break;
        }
        line[length] = 0;
        if (!strstr(line, "\"type\":\"ready\"")) return 120;
        DWORD written;
        if (!WriteFile(control_write, "G", 1, &written, NULL) || written != 1) return 121;
        Sleep(20000);
        CloseHandle(control_write); CloseHandle(observation_read); CloseHandle(helper.hProcess);
        return 0;
    }
    if (!wcscmp(argv[1], L"sleep")) { Sleep(20000); return 0; }
    return 100;
}
