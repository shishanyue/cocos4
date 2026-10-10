#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

/* Parent-only v1 protocol: VERSION SOURCE_PIN_COUNT NAME, then PATH DEV INO
 * MODE for two complete, local drive-rooted chains. The application validates
 * content and ownership before this helper runs. Windows cannot inherit Node
 * directory descriptors: reopen each component without delete sharing, verify
 * its identity, and retain every handle through the atomic rename. */
#define MAX_PINS 196
#define MAX_PATH_CHARS 4096

static int number(const wchar_t *text, uint64_t *result) {
    size_t length = wcslen(text);
    uint64_t value = 0;
    if (!length || length > 20 || (length > 1 && *text == L'0')) return 0;
    for (size_t i = 0; i < length; ++i) {
        if (text[i] < L'0' || text[i] > L'9') return 0;
        unsigned int digit = (unsigned int) (text[i] - L'0');
        if (value > (UINT64_MAX - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    *result = value;
    return 1;
}

static int component(const wchar_t *name) {
    size_t length = wcslen(name);
    if (!length || length > 255 || name[length - 1] == L'.' || name[length - 1] == L' ') return 0;
    for (size_t i = 0; i < length; ++i) {
        wchar_t c = name[i];
        if (c < 32 || c == 127 || wcschr(L"/\\:<>\"|?*", c)) return 0;
    }
    size_t stem = wcscspn(name, L".");
    while (stem && name[stem - 1] == L' ') --stem;
    if ((stem == 3 && (!_wcsnicmp(name, L"con", 3) || !_wcsnicmp(name, L"prn", 3)
        || !_wcsnicmp(name, L"aux", 3) || !_wcsnicmp(name, L"nul", 3)))
        || (stem == 6 && !_wcsnicmp(name, L"conin$", 6))
        || (stem == 7 && !_wcsnicmp(name, L"conout$", 7))
        || (stem == 6 && !_wcsnicmp(name, L"clock$", 6))) return 0;
    if (stem == 4 && (!_wcsnicmp(name, L"com", 3) || !_wcsnicmp(name, L"lpt", 3))) {
        wchar_t digit = name[3];
        if ((digit >= L'1' && digit <= L'9') || digit == 0x00b9 || digit == 0x00b2 || digit == 0x00b3) return 0;
    }
    return 1;
}

static int root(const wchar_t *value) {
    return wcslen(value) == 3 && ((value[0] >= L'A' && value[0] <= L'Z')
        || (value[0] >= L'a' && value[0] <= L'z')) && value[1] == L':' && value[2] == L'\\';
}

static int child_path(const wchar_t *parent, const wchar_t *child) {
    size_t prefix = wcslen(parent), length = wcslen(child);
    if (!prefix || prefix >= length || wcsncmp(parent, child, prefix)) return 0;
    if (parent[prefix - 1] != L'\\') {
        if (child[prefix] != L'\\') return 0;
        ++prefix;
    }
    return component(child + prefix);
}

static HANDLE open_pin(const wchar_t *path, int source, uint64_t dev, uint64_t ino, uint64_t mode) {
    wchar_t extended[MAX_PATH_CHARS + 5], expanded[MAX_PATH_CHARS + 5], actual[MAX_PATH_CHARS + 5];
    size_t length = wcslen(path);
    if (length >= MAX_PATH_CHARS) return INVALID_HANDLE_VALUE;
    memcpy(extended, L"\\\\?\\", 4 * sizeof(wchar_t));
    memcpy(extended + 4, path, (length + 1) * sizeof(wchar_t));
    /* Metadata-only handles do not participate in share-mode accounting.
     * Ancestors need data access; the rename source is already pinned by DELETE.
     * Ancestors permit writes so the kernel can add the renamed directory entry. */
    HANDLE handle = CreateFileW(extended, source ? FILE_READ_ATTRIBUTES | DELETE : GENERIC_READ,
        FILE_SHARE_READ | (source ? 0 : FILE_SHARE_WRITE), NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return handle;
    BY_HANDLE_FILE_INFORMATION info;
    DWORD chars = GetFinalPathNameByHandleW(handle, actual, MAX_PATH_CHARS + 5, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    /* TEMP commonly contains an 8.3 user-directory name. Expand that spelling
     * only while its complete parent chain is locked. Identity and reparse
     * checks remain authoritative, including on case-sensitive NTFS folders. */
    DWORD expanded_chars = GetLongPathNameW(extended, expanded, MAX_PATH_CHARS + 5);
    if (!GetFileInformationByHandle(handle, &info) || !chars || chars >= MAX_PATH_CHARS + 5
        || !expanded_chars || expanded_chars >= MAX_PATH_CHARS + 5
        || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
        || info.dwVolumeSerialNumber != dev
        || (((uint64_t) info.nFileIndexHigh << 32) | info.nFileIndexLow) != ino
        || ((uint64_t) 0040000 | 0444 | ((info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) ? 0 : 0222)) != mode
        || _wcsicmp(actual, expanded)) {
        CloseHandle(handle);
        SetLastError(ERROR_INVALID_DATA);
        return INVALID_HANDLE_VALUE;
    }
    return handle;
}

int wmain(int argc, wchar_t **argv) {
    HANDLE pins[MAX_PINS];
    int opened = 0, result = 64;
    if (argc < 16 || (argc - 4) % 4 || (argc - 4) / 4 > MAX_PINS) return result;
    int prepare = !wcscmp(argv[1], L"cocos4-prepare-publish-v1");
    if (!prepare && wcscmp(argv[1], L"cocos4-publish-v1")) return result;
    int count = (argc - 4) / 4;
    uint64_t source_count;
    if (!number(argv[2], &source_count) || source_count < (prepare ? 2U : 3U)
        || source_count >= (uint64_t) count || !component(argv[3])) return result;
    int split = (int) source_count;
    for (int i = 0; i < count; ++i) {
        const wchar_t *current = argv[4 + i * 4];
        uint64_t dev, ino, mode;
        if (!number(argv[5 + i * 4], &dev) || !number(argv[6 + i * 4], &ino)
            || !number(argv[7 + i * 4], &mode) || wcslen(current) >= MAX_PATH_CHARS) goto done;
        if (i == 0 || i == split) {
            if (!root(current)) goto done;
        } else if (!child_path(argv[4 + (i - 1) * 4], current)) goto done;
        if (i == split - 1 && !prepare) {
            const wchar_t *basename = wcsrchr(current, L'\\');
            if (!basename || wcscmp(basename + 1, L"output")) goto done;
        }
        pins[i] = open_pin(current, i == split - 1, dev, ino, mode);
        if (pins[i] == INVALID_HANDLE_VALUE) { result = 73; goto done; }
        ++opened;
    }
    const wchar_t *parent = argv[4 + (count - 1) * 4];
    if (prepare && wcscmp(argv[4 + (split - 2) * 4], parent)) goto done;
    size_t parent_length = wcslen(parent), name_length = wcslen(argv[3]);
    size_t separator = parent[parent_length - 1] == L'\\' ? 0 : 1;
    size_t length = parent_length + separator + name_length;
    if (length >= MAX_PATH_CHARS) goto done;
    /* Extended absolute destination plus locked complete parent chain is deliberate:
     * Win32 FileRenameInfo does not portably accept RootDirectory-relative names.
     * The DOS namespace prefix also avoids MAX_PATH truncation during conversion.
     * ReplaceIfExists is FALSE in this single kernel rename. No copy, ordinary
     * MoveFileEx, check-then-rename, or cross-volume fallback is permitted. */
    size_t prefix_length = 4;
    size_t allocation = offsetof(FILE_RENAME_INFO, FileName) + (prefix_length + length + 1) * sizeof(wchar_t);
    FILE_RENAME_INFO *rename = (FILE_RENAME_INFO *) calloc(1, allocation);
    if (!rename) { result = 72; goto done; }
    rename->ReplaceIfExists = FALSE;
    rename->RootDirectory = NULL;
    rename->FileNameLength = (DWORD) ((prefix_length + length) * sizeof(wchar_t));
    memcpy(rename->FileName, L"\\\\?\\", prefix_length * sizeof(wchar_t));
    memcpy(rename->FileName + prefix_length, parent, parent_length * sizeof(wchar_t));
    if (separator) rename->FileName[prefix_length + parent_length] = L'\\';
    memcpy(rename->FileName + prefix_length + parent_length + separator, argv[3], (name_length + 1) * sizeof(wchar_t));
    if (SetFileInformationByHandle(pins[split - 1], FileRenameInfo, rename, (DWORD) allocation)) result = 0;
    else {
        DWORD error = GetLastError();
        result = error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS ? 70
            : error == ERROR_ACCESS_DENIED || error == ERROR_PRIVILEGE_NOT_HELD ? 74 : 72;
    }
    free(rename);
done:
    while (opened) CloseHandle(pins[--opened]);
    return result;
}
