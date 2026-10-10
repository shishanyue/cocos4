#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0a00
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* Test client only: fixed adjacent JS and explicit Node sidecar, with its child
 * attached at creation to a non-breakaway Job. No shell or PATH lookup. */
int wmain(int argc, wchar_t **argv) {
    if (argc != 1 && (argc != 2 || wcscmp(argv[1], L"--version"))) return 64;
    wchar_t executable[32768], sidecar[32768], node[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length >= 32760) return 72;
    if (swprintf(sidecar, 32768, L"%ls.node", executable) < 0) return 72;
    FILE *file = NULL;
    if (_wfopen_s(&file, sidecar, L"rb") || !file) return 72;
    char utf8[32768];
    size_t bytes = fread(utf8, 1, sizeof(utf8) - 1, file);
    fclose(file); utf8[bytes] = 0;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, node, 32768)
        || wcschr(node, L'"') || wcschr(executable, L'"')) return 72;
    if (swprintf(command, 32768, L"\"%ls\" \"%ls.cjs\"%ls", node, executable,
        argc == 2 ? L" --version" : L"") < 0) return 72;
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 72;
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &attributeBytes);
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = malloc(attributeBytes);
    if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)
        || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) return 72;
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process = {0};
    DWORD status = 72;
    if (CreateProcessW(node, command, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT,
        NULL, NULL, &startup.StartupInfo, &process)) {
        if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &status);
        CloseHandle(process.hThread); CloseHandle(process.hProcess);
    }
    DeleteProcThreadAttributeList(attributes); free(attributes); CloseHandle(job);
    return (int)status;
}
