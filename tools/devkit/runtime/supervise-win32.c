#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0a00
#endif
#if _WIN32_WINNT < 0x0a00
#error Windows 10 or later is required
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Independent Win10 x64 trusted-code lifetime component, NOT app support or an
 * OS sandbox. Protocol v1 (frozen):
 *   --identity PID
 *   --owner PID CREATION_FILETIME --cwd ABSOLUTE_DIRECTORY -- ABSOLUTE_EXE [args]
 * Identity is {platform:"win32",pid:DWORD,creationTime:"decimal FILETIME"}.
 * stdin must be a pipe: one ASCII G permits start AFTER ready delivery; T stops.
 * EOF, any other byte, repeated G, console cancellation, or owner death stops.
 * Runner stdin is NUL; runner stdout AND stderr go only to helper stderr.
 * stdout is exclusively NDJSON, <=8 records, each <=1024 bytes including LF:
 * {version:1,platform:"win32",type:...}, with these additional fields:
 * identity: process; ready: supervisor,owner,runner (all three identities);
 * started: none; runnerExit: exitCode (unsigned DWORD, never a POSIX signal);
 * stopping: reason (stop/stdinEof/ownerExit/runnerExit/controlError/console/
 *   observationError/readyTimeout/infrastructure);
 * error: operation (fixed ASCII label),errorCode (DWORD);
 * treeClosed: activeProcesses:0; treeNotClosed: activeProcesses (DWORD or null).
 * Normal lifecycle: ready, [started], stopping/runnerExit (either order),
 * treeClosed. Errors may interrupt it. --identity emits only identity or error.
 * ready means creation-time Job association and a STILL SUSPENDED runner.
 * treeClosed requires observed runner exit AND Job accounting ActiveProcesses=0.
 * Cleanup uses TerminateJobObject(0xc000013a), bounded to 5 seconds, then closes
 * the sole noninheritable Job handle even on failure. Helper exit: 0 confirmed
 * cleanup, 125 infrastructure/protocol failure, NOT the runner's exit status.
 * Observation writes are isolated from cleanup; ready delivery has a 2s limit,
 * final flushing a 1s limit. Missing/truncated observations fail callers closed.
 * Forced helper death closes the Job but cannot emit closure evidence. Consumers
 * must independently corroborate that case, never infer closure from pipe EOF.
 * No environment is forwarded: PATH=OS system directory, SystemRoot/WINDIR=OS
 * Windows directory. No shell, PATH executable lookup, IPC, breakaway, guardian,
 * credentials, TEMP, user profile, or application protocol is provided.
 */
enum { RECORDS = 8, RECORD_BYTES = 1024, COMMAND_CHARS = 32767 };
int _dowildcard = 0;
static char records[RECORDS][RECORD_BYTES];
static DWORD record_lengths[RECORDS];
static BOOL record_ready[RECORDS];
static volatile LONG produced, consumed, output_failed, ready_delivered, cancelled;
static HANDLE output_event, output_handle;

static LONG load(volatile LONG *value) { return InterlockedCompareExchange(value, 0, 0); }
static DWORD WINAPI writer(void *unused) {
    (void)unused;
    for (;;) {
        LONG index = load(&consumed);
        if (index == load(&produced)) { WaitForSingleObject(output_event, INFINITE); continue; }
        DWORD offset = 0;
        while (offset < record_lengths[index]) {
            DWORD written = 0;
            if (!WriteFile(output_handle, records[index] + offset, record_lengths[index] - offset, &written, NULL) || !written) {
                InterlockedExchange(&output_failed, 1);
                return 0;
            }
            offset += written;
        }
        if (record_ready[index]) InterlockedExchange(&ready_delivered, 1);
        InterlockedIncrement(&consumed);
    }
}
static void observation(BOOL ready, const char *format, ...) {
    LONG index = load(&produced);
    if (index >= RECORDS) { InterlockedExchange(&output_failed, 1); return; }
    int prefix = snprintf(records[index], RECORD_BYTES, "{\"version\":1,\"platform\":\"win32\",");
    va_list args;
    va_start(args, format);
    int size = vsnprintf(records[index] + prefix, RECORD_BYTES - (size_t)prefix, format, args);
    va_end(args);
    if (size < 0 || prefix + size >= RECORD_BYTES) { InterlockedExchange(&output_failed, 1); return; }
    record_lengths[index] = (DWORD)(prefix + size);
    record_ready[index] = ready;
    InterlockedIncrement(&produced);
    SetEvent(output_event);
}
static void error_event(const char *operation, DWORD error) {
    observation(FALSE, "\"type\":\"error\",\"operation\":\"%s\",\"errorCode\":%lu}\n", operation, (unsigned long)error);
}
static int finish(int result) {
    ULONGLONG until = GetTickCount64() + 1000;
    while (!load(&output_failed) && load(&consumed) != load(&produced) && GetTickCount64() < until) Sleep(5);
    if (load(&output_failed) || load(&consumed) != load(&produced)) result = 125;
    /* ExitProcess also ends a writer blocked by a non-reading owner. */
    ExitProcess((UINT)result);
}
static BOOL WINAPI console_handler(DWORD event) {
    (void)event;
    InterlockedExchange(&cancelled, 1);
    return TRUE;
}
static BOOL creation_time(HANDLE process, unsigned long long *value) {
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return FALSE;
    *value = ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime;
    return TRUE;
}
static BOOL number(const wchar_t *text, unsigned long long maximum, unsigned long long *value) {
    *value = 0;
    if (!*text) return FALSE;
    for (; *text; ++text) {
        if (*text < L'0' || *text > L'9' || *value > (maximum - (unsigned)(*text - L'0')) / 10) return FALSE;
        *value = *value * 10 + (unsigned)(*text - L'0');
    }
    return *value != 0;
}
static DWORD parent_pid(void) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    DWORD parent = 0;
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    return parent;
}
static BOOL absolute(const wchar_t *path) {
    size_t length = wcslen(path);
    if (length >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
        && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) return TRUE;
    /* Regular UNC only; reject device namespaces and drive-relative paths. */
    return length > 4 && path[0] == L'\\' && path[1] == L'\\' && path[2] != L'.' && path[2] != L'?'
        && path[2] != L'\\' && wcschr(path + 2, L'\\') != NULL;
}
static BOOL append(wchar_t *buffer, size_t *length, wchar_t value) {
    if (*length >= COMMAND_CHARS - 1) return FALSE;
    buffer[(*length)++] = value;
    buffer[*length] = 0;
    return TRUE;
}
static BOOL command_line(int argc, wchar_t **argv, wchar_t *buffer) {
    size_t length = 0;
    buffer[0] = 0;
    for (int i = 0; i < argc; ++i) {
        if (i && !append(buffer, &length, L' ')) return FALSE;
        if (!append(buffer, &length, L'"')) return FALSE;
        const wchar_t *arg = argv[i];
        for (;;) {
            size_t slashes = 0;
            while (*arg == L'\\') { ++slashes; ++arg; }
            /* CRT/CommandLineToArgvW rule: double slashes before quotes/end. */
            size_t count = (*arg == L'"' || !*arg) ? slashes * 2 : slashes;
            for (size_t j = 0; j < count; ++j) if (!append(buffer, &length, L'\\')) return FALSE;
            if (!*arg) break;
            if (*arg == L'"' && !append(buffer, &length, L'\\')) return FALSE;
            if (!append(buffer, &length, *arg++)) return FALSE;
        }
        if (!append(buffer, &length, L'"')) return FALSE;
    }
    return TRUE;
}
static wchar_t *environment(void) {
    wchar_t windows[COMMAND_CHARS], system[COMMAND_CHARS];
    UINT w = GetSystemWindowsDirectoryW(windows, COMMAND_CHARS);
    UINT s = GetSystemDirectoryW(system, COMMAND_CHARS);
    if (!w || w >= COMMAND_CHARS || !s || s >= COMMAND_CHARS || !absolute(windows) || !absolute(system)) return NULL;
    size_t chars = 5 + s + 1 + 11 + w + 1 + 7 + w + 2;
    wchar_t *block = calloc(chars, sizeof(wchar_t));
    if (!block) return NULL;
    wchar_t *next = block;
    wcscpy(next, L"PATH="); wcscat(next, system); next += wcslen(next) + 1;
    wcscpy(next, L"SystemRoot="); wcscat(next, windows); next += wcslen(next) + 1;
    wcscpy(next, L"WINDIR="); wcscat(next, windows);
    return block;
}
static BOOL noninheritable(HANDLE handle) {
    DWORD flags;
    return handle && handle != INVALID_HANDLE_VALUE && SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)
        && GetHandleInformation(handle, &flags) && !(flags & HANDLE_FLAG_INHERIT);
}

int wmain(int argc, wchar_t **argv) {
    output_handle = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!noninheritable(output_handle)) return 125;
    output_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!output_event) return 125;
    HANDLE output_thread = CreateThread(NULL, 0, writer, NULL, 0, NULL);
    if (!output_thread) return 125;
    CloseHandle(output_thread);
    if (argc == 3 && !wcscmp(argv[1], L"--identity")) {
        unsigned long long pid, created;
        if (!number(argv[2], MAXDWORD, &pid)) { error_event("identityArguments", ERROR_INVALID_PARAMETER); return finish(125); }
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
        if (!process) { error_event("OpenProcess", GetLastError()); return finish(125); }
        BOOL ok = creation_time(process, &created);
        DWORD error = GetLastError();
        CloseHandle(process);
        if (!ok) { error_event("GetProcessTimes", error); return finish(125); }
        observation(FALSE, "\"type\":\"identity\",\"process\":{\"platform\":\"win32\",\"pid\":%lu,\"creationTime\":\"%llu\"}}\n", (unsigned long)pid, created);
        return finish(0);
    }
    unsigned long long owner_number, expected_created;
    if (argc < 8 || wcscmp(argv[1], L"--owner") || wcscmp(argv[4], L"--cwd") || wcscmp(argv[6], L"--")
        || !number(argv[2], MAXDWORD, &owner_number) || !number(argv[3], ~0ULL, &expected_created)
        || !absolute(argv[5]) || !absolute(argv[7])) {
        error_event("arguments", ERROR_INVALID_PARAMETER); return finish(125);
    }
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE), diagnostic = GetStdHandle(STD_ERROR_HANDLE);
    if (!noninheritable(input) || !noninheritable(diagnostic) || GetFileType(input) != FILE_TYPE_PIPE
        || GetFileType(output_handle) != FILE_TYPE_PIPE) {
        error_event("stdio", ERROR_INVALID_HANDLE); return finish(125);
    }
    if (!SetConsoleCtrlHandler(console_handler, TRUE)) { error_event("SetConsoleCtrlHandler", GetLastError()); return finish(125); }
    HANDLE owner = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)owner_number);
    unsigned long long owner_created, self_created;
    if (!owner || !noninheritable(owner) || parent_pid() != (DWORD)owner_number || !creation_time(owner, &owner_created)
        || owner_created != expected_created || !creation_time(GetCurrentProcess(), &self_created)
        || owner_created > self_created || WaitForSingleObject(owner, 0) != WAIT_TIMEOUT) {
        error_event("ownerIdentity", ERROR_INVALID_PARAMETER);
        if (owner) CloseHandle(owner);
        return finish(125);
    }
    HANDLE job = NULL, child_input = INVALID_HANDLE_VALUE, child_output = NULL;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    BOOL attributes_initialized = FALSE;
    PROCESS_INFORMATION runner = {0};
    wchar_t *env = NULL, *command = NULL;
    const char *operation = "allocation";
    DWORD failure = ERROR_NOT_ENOUGH_MEMORY;
    job = CreateJobObjectW(NULL, NULL);
    if (!job || !noninheritable(job)) { operation = "CreateJobObjectW"; failure = GetLastError(); goto setup_failed; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        operation = "SetInformationJobObject"; failure = GetLastError(); goto setup_failed;
    }
    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
    child_input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, NULL);
    if (child_input == INVALID_HANDLE_VALUE || !DuplicateHandle(GetCurrentProcess(), diagnostic, GetCurrentProcess(), &child_output, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
        operation = "childStdio"; failure = GetLastError(); goto setup_failed;
    }
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 2, 0, &size);
    attributes = malloc(size);
    command = calloc(COMMAND_CHARS, sizeof(wchar_t));
    env = environment();
    if (!attributes || !command || !env) goto setup_failed;
    if (!command_line(argc - 7, argv + 7, command)) { operation = "commandLine"; failure = ERROR_BAD_LENGTH; goto setup_failed; }
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) {
        operation = "InitializeProcThreadAttributeList"; failure = GetLastError(); goto setup_failed;
    }
    attributes_initialized = TRUE;
    HANDLE inherited[] = {child_input, child_output};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)
        || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {
        operation = "UpdateProcThreadAttribute"; failure = GetLastError(); goto setup_failed;
    }
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = child_input;
    startup.StartupInfo.hStdOutput = child_output;
    startup.StartupInfo.hStdError = child_output;
    startup.lpAttributeList = attributes;
    if (WaitForSingleObject(owner, 0) != WAIT_TIMEOUT) { operation = "ownerExitBeforeCreate"; failure = ERROR_PROCESS_ABORTED; goto setup_failed; }
    if (!CreateProcessW(argv[7], command, NULL, NULL, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        env, argv[5], &startup.StartupInfo, &runner)) {
        operation = "CreateProcessW"; failure = GetLastError(); goto setup_failed;
    }
    failure = 0;
setup_failed:
    if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
    free(attributes); free(command); free(env);
    if (child_input != INVALID_HANDLE_VALUE) CloseHandle(child_input);
    if (child_output) CloseHandle(child_output);
    if (failure) {
        error_event(operation, failure);
        if (job) CloseHandle(job);
        CloseHandle(owner);
        return finish(125);
    }

    unsigned long long runner_created = 0;
    BOOL in_job = FALSE;
    int result = 0;
    const char *reason = NULL;
    if (!noninheritable(runner.hProcess) || !noninheritable(runner.hThread)
        || !creation_time(runner.hProcess, &runner_created) || !IsProcessInJob(runner.hProcess, job, &in_job) || !in_job) {
        error_event("runnerIdentityOrJob", ERROR_INVALID_DATA); result = 125; reason = "infrastructure";
    } else {
        observation(TRUE, "\"type\":\"ready\",\"supervisor\":{\"platform\":\"win32\",\"pid\":%lu,\"creationTime\":\"%llu\"},"
            "\"owner\":{\"platform\":\"win32\",\"pid\":%lu,\"creationTime\":\"%llu\"},"
            "\"runner\":{\"platform\":\"win32\",\"pid\":%lu,\"creationTime\":\"%llu\"}}\n",
            (unsigned long)GetCurrentProcessId(), self_created, (unsigned long)owner_number, owner_created,
            (unsigned long)runner.dwProcessId, runner_created);
    }
    BOOL started = FALSE, exited = FALSE, stopping = FALSE;
    ULONGLONG ready_deadline = GetTickCount64() + 2000, stop_deadline = 0;
    for (;;) {
        if (!reason && WaitForSingleObject(owner, 0) != WAIT_TIMEOUT) reason = "ownerExit";
        if (!reason && load(&cancelled)) reason = "console";
        if (!reason && load(&output_failed)) { reason = "observationError"; result = 125; }
        if (!reason && !load(&ready_delivered) && GetTickCount64() >= ready_deadline) { reason = "readyTimeout"; result = 125; }
        if (!reason) {
            DWORD available = 0;
            if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
                DWORD error = GetLastError();
                reason = (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) ? "stdinEof" : "controlError";
                if (!strcmp(reason, "controlError")) result = 125;
            } else if (available && load(&ready_delivered)) {
                /* Ready can reach the parent before the writer publishes its flag.
                 * Leave fast acknowledgements buffered until that publication. */
                char bytes[64];
                DWORD read = 0;
                if (!ReadFile(input, bytes, available < sizeof(bytes) ? available : sizeof(bytes), &read, NULL) || !read) reason = "stdinEof";
                else {
                    BOOL permit = FALSE;
                    for (DWORD i = 0; i < read && !reason; ++i) {
                        if (bytes[i] == 'T') reason = "stop";
                        else if (bytes[i] == 'G' && !started && !permit && load(&ready_delivered)) permit = TRUE;
                        else { reason = "controlError"; result = 125; }
                    }
                    if (permit && !reason && WaitForSingleObject(owner, 0) == WAIT_TIMEOUT) {
                        DWORD previous = ResumeThread(runner.hThread);
                        if (previous != 1) {
                            error_event("ResumeThread", previous == MAXDWORD ? GetLastError() : ERROR_INVALID_DATA);
                            reason = "infrastructure"; result = 125;
                        } else { started = TRUE; observation(FALSE, "\"type\":\"started\"}\n"); }
                    }
                }
            }
        }
        if (!exited && WaitForSingleObject(runner.hProcess, 0) == WAIT_OBJECT_0) {
            DWORD exit_code;
            if (!GetExitCodeProcess(runner.hProcess, &exit_code)) {
                if (!stopping) error_event("GetExitCodeProcess", GetLastError());
                reason = "infrastructure"; result = 125;
            } else {
                exited = TRUE;
                observation(FALSE, "\"type\":\"runnerExit\",\"exitCode\":%lu}\n", (unsigned long)exit_code);
                if (!reason) reason = "runnerExit";
            }
        }
        if (reason && !stopping) {
            stopping = TRUE;
            stop_deadline = GetTickCount64() + 5000;
            observation(FALSE, "\"type\":\"stopping\",\"reason\":\"%s\"}\n", reason);
            if (!TerminateJobObject(job, 0xc000013aUL)) { error_event("TerminateJobObject", GetLastError()); result = 125; }
        }
        if (stopping) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
            BOOL queried = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL);
            if (queried && accounting.ActiveProcesses == 0 && exited) {
                observation(FALSE, "\"type\":\"treeClosed\",\"activeProcesses\":0}\n");
                break;
            }
            if (GetTickCount64() >= stop_deadline) {
                if (queried) observation(FALSE, "\"type\":\"treeNotClosed\",\"activeProcesses\":%lu}\n", (unsigned long)accounting.ActiveProcesses);
                else observation(FALSE, "\"type\":\"treeNotClosed\",\"activeProcesses\":null}\n");
                result = 125;
                break;
            }
        }
        Sleep(10);
    }
    CloseHandle(runner.hThread); CloseHandle(runner.hProcess);
    CloseHandle(job); CloseHandle(owner);
    return finish(result);
}
